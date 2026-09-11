-- Migration: 20260908143900_inventarios_supplemental_findings_consolidation.sql
-- Description: Consolidación por bodega de los hallazgos complementarios DRAFT
--              elegibles hacia lotes SUPPLEMENTAL_FINDINGS PREPARED, permitiendo
--              múltiples lotes sucesivos para la misma campaña + bodega.
--
-- Alcance mínimo aprobado:
--   * los DRAFT elegibles (ELIGIBLE_CANONICAL y ELIGIBLE_OUT_OF_THEORETICAL)
--     de una bodega se consolidan en UN lote SUPPLEMENTAL_FINDINGS PREPARED;
--   * los BLOCKED_* permanecen exactamente en DRAFT;
--   * una campaña + site puede tener MÚLTIPLES sesiones SUPPLEMENTAL_FINDINGS
--     históricas (lotes), pero como máximo 1 DRAFT simultáneo;
--   * los lotes anteriores (PREPARED/COUNTING/...) y sus snapshots NO se tocan;
--   * los productos FUERA del teórico se admiten (su teórico conceptual es 0);
--   * NO se crean count_entries; NO se cierra ni aprueba sesiones;
--   * NO se consume ni modifica la importación teórica.
-- Author: Assistant

-- ============================================================================
-- 1. MULTI-LOTE SUPPLEMENTAL_FINDINGS POR CAMPAÑA + SITE
--    Se reemplaza el índice único que permitía como máximo 1 sesión
--    SUPPLEMENTAL_FINDINGS por campaña+site por un índice parcial que permite
--    múltiples sesiones históricas pero SOLO 1 DRAFT simultáneo.
--    La unicidad de sesiones NORMAL se mantiene intacta.
-- ============================================================================
DROP INDEX IF EXISTS inventarios.uq_inventarios_sessions_campaign_site_supplemental;

CREATE UNIQUE INDEX uq_inventarios_sessions_campaign_site_supplemental_draft
    ON inventarios.sessions (company_id, campaign_id, inventory_site_id)
    WHERE campaign_id IS NOT NULL
      AND inventory_site_id IS NOT NULL
      AND session_purpose = 'SUPPLEMENTAL_FINDINGS'
      AND status = 'DRAFT';

-- ============================================================================
-- 2. get_or_create ... SUPPLEMENTAL_FINDINGS (multi-lote)
--    Reutiliza únicamente una sesión SUPPLEMENTAL_FINDINGS DRAFT existente de ese
--    campaign + site; nunca reutiliza PREPARED/COUNTING/otra sesión congelada.
--    Si no hay DRAFT, crea una nueva. Maneja la carrera concurrente mediante el
--    índice parcial DRAFT (unique_violation => re-leer el DRAFT concurrente).
-- ============================================================================
CREATE OR REPLACE FUNCTION inventarios.get_or_create_inventory_campaign_supplemental_findings_session(
    p_company_id uuid,
    p_campaign_id uuid,
    p_inventory_site_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_role_name text;
    v_campaign_status text;
    v_campaign_name text;
    v_site_name text;
    v_warehouse_id uuid;
    v_existing_id uuid;
    v_session_id uuid;
    v_session_number integer;
    v_occurred_at timestamptz;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_inventory_site_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    -- ---------- Autorización estricta: SUPER_USUARIO ----------
    v_actor_id := inventarios.require_company_access(p_company_id);
    SELECT r.name INTO v_role_name
    FROM portal.users u
    JOIN portal.roles r ON r.id = u.role_id
    WHERE u.id = v_actor_id AND u.is_active = true;
    IF coalesce(v_role_name, '') <> 'SUPER_USUARIO' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PERMISSION_REQUIRED',
            DETAIL=pg_catalog.jsonb_build_object('message','Solo SUPER_USUARIO puede crear la sesión de hallazgos complementarios.','retryable',false)::text;
    END IF;

    v_occurred_at := pg_catalog.now();

    -- ---------- Campaña debe existir y estar IN_PROGRESS ----------
    SELECT ic.status, ic.name INTO v_campaign_status, v_campaign_name
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id;
    IF v_campaign_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario no existe.','retryable',false)::text;
    END IF;
    IF v_campaign_status <> 'IN_PROGRESS' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La campaña debe estar en IN_PROGRESS.','retryable',false,'status',v_campaign_status)::text;
    END IF;

    -- ---------- El inventory_site debe ser participante de la campaña ----------
    SELECT is2.name, is2.warehouse_id INTO v_site_name, v_warehouse_id
    FROM inventarios.inventory_campaign_sites ics
    JOIN inventarios.inventory_sites is2
      ON is2.company_id = ics.company_id AND is2.id = ics.inventory_site_id
    WHERE ics.company_id = p_company_id
      AND ics.campaign_id = p_campaign_id
      AND ics.inventory_site_id = p_inventory_site_id;
    IF v_site_name IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La unidad no participa en la campaña.','retryable',false)::text;
    END IF;

    -- ---------- Reutilizar únicamente una sesión DRAFT existente ----------
    SELECT s.id INTO v_existing_id
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id
      AND s.campaign_id = p_campaign_id
      AND s.inventory_site_id = p_inventory_site_id
      AND s.session_purpose = 'SUPPLEMENTAL_FINDINGS'
      AND s.status = 'DRAFT';
    IF v_existing_id IS NOT NULL THEN
        RETURN pg_catalog.jsonb_build_object(
            'campaign_id', p_campaign_id,
            'inventory_site_id', p_inventory_site_id,
            'session_id', v_existing_id,
            'session_purpose', 'SUPPLEMENTAL_FINDINGS',
            'created', false,
            'state', (SELECT s2.status FROM inventarios.sessions s2 WHERE s2.id = v_existing_id)
        );
    END IF;

    -- ---------- Crear sesión DRAFT (nuevo lote) ----------
    SELECT coalesce(pg_catalog.max(session_number), 0) + 1
    INTO v_session_number
    FROM inventarios.sessions
    WHERE company_id = p_company_id;

    BEGIN
        INSERT INTO inventarios.sessions (
            company_id, session_number, name, inventory_type, status,
            warehouse_id, bsale_office_id, scope_mode, responsible_user_id,
            campaign_id, inventory_site_id, session_purpose,
            created_at, created_by, updated_at, updated_by)
        VALUES (
            p_company_id, v_session_number,
            v_campaign_name || ' - ' || v_site_name || ' - Hallazgos', 'GENERAL', 'DRAFT',
            v_warehouse_id, NULL, 'GENERAL', v_actor_id,
            p_campaign_id, p_inventory_site_id, 'SUPPLEMENTAL_FINDINGS',
            v_occurred_at, v_actor_id, v_occurred_at, v_actor_id)
        RETURNING id INTO v_session_id;
    EXCEPTION WHEN unique_violation THEN
        SELECT s.id INTO v_session_id
        FROM inventarios.sessions s
        WHERE s.company_id = p_company_id
          AND s.campaign_id = p_campaign_id
          AND s.inventory_site_id = p_inventory_site_id
          AND s.session_purpose = 'SUPPLEMENTAL_FINDINGS'
          AND s.status = 'DRAFT';
        IF v_session_id IS NULL THEN RAISE; END IF;
    END;

    RETURN pg_catalog.jsonb_build_object(
        'campaign_id', p_campaign_id,
        'inventory_site_id', p_inventory_site_id,
        'session_id', v_session_id,
        'session_purpose', 'SUPPLEMENTAL_FINDINGS',
        'created', true,
        'state', 'DRAFT',
        'session_number', v_session_number,
        'warehouse_id', v_warehouse_id
    );
END;
$function$;

ALTER FUNCTION inventarios.get_or_create_inventory_campaign_supplemental_findings_session(uuid, uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.get_or_create_inventory_campaign_supplemental_findings_session(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.get_or_create_inventory_campaign_supplemental_findings_session(uuid, uuid, uuid) TO authenticated, service_role;

-- ============================================================================
-- 3. TRAZABILIDAD DE CONSOLIDACIÓN en inventory_campaign_supplemental_findings
--    DRAFT  -> consolidated_* NULL
--    REMOVED-> consolidated_* NULL (no consolidado)
--    CONSOLIDATED -> consolidated_* NOT NULL, removed_* NULL
--    Las columnas se conservan como histórico; no se borra información.
-- ============================================================================
ALTER TABLE inventarios.inventory_campaign_supplemental_findings
    ADD COLUMN IF NOT EXISTS consolidated_at timestamptz,
    ADD COLUMN IF NOT EXISTS consolidated_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS supplemental_session_id uuid REFERENCES inventarios.sessions(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS supplemental_snapshot_id uuid REFERENCES inventarios.operational_snapshots(id) ON DELETE RESTRICT;

ALTER TABLE inventarios.inventory_campaign_supplemental_findings
    ADD CONSTRAINT chk_supplemental_findings_consolidation
    CHECK (
        (status <> 'CONSOLIDATED'
            AND consolidated_at IS NULL AND consolidated_by IS NULL
            AND supplemental_session_id IS NULL AND supplemental_snapshot_id IS NULL)
        OR (status = 'CONSOLIDATED'
            AND consolidated_at IS NOT NULL AND consolidated_by IS NOT NULL
            AND supplemental_session_id IS NOT NULL AND supplemental_snapshot_id IS NOT NULL)
    );

-- ============================================================================
-- 4. PREPARAR LOTE ADMITIENDO PRODUCTOS FUERA DEL TEÓRICO
--    A) CANÓNICO: presente en get_campaign_theoretical_stock (comportamiento actual).
--    B) FUERA DEL TEÓRICO: NO presente en la teórica, pero existe activo en
--       adquisiciones.products con bsale_variant_id ACTUAL no nulo, coincide con
--       el payload y no figura (product_id ni bsale_variant_id) en ningún snapshot
--       de sesión NORMAL de la campaña. NO se inserta stock teórico ni se toca la
--       importación; su teórico conceptual es 0.
-- ============================================================================
CREATE OR REPLACE FUNCTION inventarios.prepare_supplemental_findings_session(
    p_company_id uuid,
    p_session_id uuid,
    p_findings jsonb,
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_role_name text;
    v_operation jsonb;
    v_operation_id uuid;
    v_campaign_id uuid;
    v_inventory_site_id uuid;
    v_warehouse_id uuid;
    v_session_status text;
    v_session_purpose text;
    v_campaign_status text;
    v_location_scope text;
    v_snapshot_id uuid;
    v_snapshot_status text;
    v_payload jsonb;
    v_findings jsonb;
    v_finding record;
    v_product_count bigint;
    v_location_count bigint;
    v_hash text;
    v_occurred_at timestamptz;
    v_response jsonb;
    v_out_variant integer;
    v_out_active boolean;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL OR p_idempotency_key IS NULL
       OR p_findings IS NULL OR pg_catalog.jsonb_typeof(p_findings) <> 'array'
       OR pg_catalog.jsonb_array_length(p_findings) < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    -- ---------- Autorización estricta: SUPER_USUARIO ----------
    v_actor_id := inventarios.require_company_access(p_company_id);
    SELECT r.name INTO v_role_name
    FROM portal.users u
    JOIN portal.roles r ON r.id = u.role_id
    WHERE u.id = v_actor_id AND u.is_active = true;
    IF coalesce(v_role_name, '') <> 'SUPER_USUARIO' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PERMISSION_REQUIRED',
            DETAIL=pg_catalog.jsonb_build_object('message','Solo SUPER_USUARIO puede preparar la sesión de hallazgos complementarios.','retryable',false)::text;
    END IF;

    v_occurred_at := pg_catalog.now();

    -- ---------- Validación de estructura y normalización de hallazgos ----------
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_findings) e
        WHERE pg_catalog.jsonb_typeof(e) <> 'object'
           OR pg_catalog.jsonb_typeof(e -> 'product_id') <> 'string'
           OR pg_catalog.jsonb_typeof(e -> 'bsale_variant_id') <> 'number'
           OR pg_catalog.jsonb_typeof(e -> 'inventory_site_location_id') <> 'string'
           OR NULLIF(pg_catalog.btrim(e ->> 'product_id'), '') IS NULL
           OR NULLIF(pg_catalog.btrim(e ->> 'inventory_site_location_id'), '') IS NULL
           OR e ->> 'bsale_variant_id' IS NULL
           OR (e ->> 'bsale_variant_id') !~ '^[0-9]+$'
    ) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','Los hallazgos no tienen la estructura requerida (product_id, bsale_variant_id, inventory_site_location_id).','retryable',false)::text;
    END IF;

    WITH raw AS (
        SELECT (e ->> 'product_id')::uuid AS product_id,
               (e ->> 'bsale_variant_id')::int AS bsale_variant_id,
               (e ->> 'inventory_site_location_id')::uuid AS inventory_site_location_id
        FROM pg_catalog.jsonb_array_elements(p_findings) e
    )
    SELECT coalesce(
               pg_catalog.jsonb_agg(
                   pg_catalog.jsonb_build_object(
                       'product_id', f.product_id,
                       'bsale_variant_id', f.bsale_variant_id,
                       'inventory_site_location_id', f.inventory_site_location_id
                   ) ORDER BY f.bsale_variant_id, f.inventory_site_location_id
               ),
               '[]'::jsonb)
    INTO v_findings
    FROM (SELECT DISTINCT product_id, bsale_variant_id, inventory_site_location_id FROM raw) f;

    -- ---------- Idempotencia (replay / conflicto) ----------
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.supplemental.prepare','company_id',p_company_id,
        'session_id',p_session_id,'findings',v_findings);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.supplemental.prepare',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    -- ---------- Sesión (bloqueada) ----------
    SELECT s.campaign_id, s.inventory_site_id, s.warehouse_id, s.status, s.session_purpose
    INTO v_campaign_id, v_inventory_site_id, v_warehouse_id, v_session_status, v_session_purpose
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.id = p_session_id
    FOR UPDATE OF s;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;
    IF v_session_purpose <> 'SUPPLEMENTAL_FINDINGS' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La sesión no es una sesión de hallazgos complementarios.','retryable',false)::text;
    END IF;
    IF v_campaign_id IS NULL OR v_inventory_site_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La sesión no pertenece a una campaña con unidad.','retryable',false)::text;
    END IF;
    IF v_warehouse_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La unidad no tiene bodega vinculada.','retryable',false)::text;
    END IF;

    -- ---------- Campaña IN_PROGRESS ----------
    SELECT ic.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = v_campaign_id;
    IF v_campaign_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario no existe.','retryable',false)::text;
    END IF;
    IF v_campaign_status <> 'IN_PROGRESS' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La campaña debe estar en IN_PROGRESS.','retryable',false,'status',v_campaign_status)::text;
    END IF;

    -- ---------- Estado de la sesión (DRAFT para congelar; PREPARED => inmutable) ----------
    IF v_session_status NOT IN ('DRAFT', 'PREPARED') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La sesión no permite esta operación en su estado actual.','retryable',false,'status',v_session_status)::text;
    END IF;
    IF v_session_status = 'PREPARED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_ALREADY_PREPARED',
            DETAIL=pg_catalog.jsonb_build_object('message','La sesión ya fue preparada; el contenido es inmutable.','retryable',false)::text;
    END IF;

    -- Snapshot existente de la sesión (ninguno para SUPPLEMENTAL recién creada)
    SELECT os.id, os.completion_status INTO v_snapshot_id, v_snapshot_status
    FROM inventarios.operational_snapshots os
    WHERE os.company_id = p_company_id AND os.session_id = p_session_id;
    IF v_snapshot_id IS NOT NULL AND v_snapshot_status = 'COMPLETED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_ALREADY_PREPARED',
            DETAIL=pg_catalog.jsonb_build_object('message','El snapshot ya está completado; el contenido es inmutable.','retryable',false)::text;
    END IF;

    -- ---------- Alcance de ubicaciones de la unidad (campaña/site) ----------
    SELECT ics.location_scope INTO v_location_scope
    FROM inventarios.inventory_campaign_sites ics
    WHERE ics.company_id = p_company_id AND ics.campaign_id = v_campaign_id
      AND ics.inventory_site_id = v_inventory_site_id;
    IF v_location_scope IS NULL THEN v_location_scope := 'ALL'; END IF;
    IF v_location_scope NOT IN ('ALL', 'SELECTED') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','El alcance de la unidad no es válido.','retryable',false)::text;
    END IF;

    -- ---------- Validación de cada hallazgo ----------
    FOR v_finding IN
        SELECT (f ->> 'product_id')::uuid AS product_id,
               (f ->> 'bsale_variant_id')::int AS bsale_variant_id,
               (f ->> 'inventory_site_location_id')::uuid AS inventory_site_location_id
        FROM pg_catalog.jsonb_array_elements(v_findings) f
    LOOP
        -- Ubicación del mismo inventory_site, activa y con referencia logística
        IF NOT EXISTS (
            SELECT 1 FROM inventarios.inventory_site_locations isl
            WHERE isl.company_id = p_company_id
              AND isl.inventory_site_id = v_inventory_site_id
              AND isl.id = v_finding.inventory_site_location_id
              AND isl.is_active = true
              AND isl.source_logistics_location_id IS NOT NULL
        ) THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
                DETAIL=pg_catalog.jsonb_build_object('message','La ubicación no pertenece a la unidad de la sesión, está inactiva o no tiene referencia logística.','retryable',false,
                    'inventory_site_location_id',v_finding.inventory_site_location_id)::text;
        END IF;
        -- Alcance seleccionado: la ubicación debe estar materializada en la campaña
        IF v_location_scope = 'SELECTED' AND NOT EXISTS (
            SELECT 1
            FROM inventarios.inventory_campaign_site_locations icl
            JOIN inventarios.inventory_campaign_sites ics
              ON ics.company_id = icl.company_id AND ics.id = icl.campaign_site_id
            WHERE ics.company_id = p_company_id
              AND ics.campaign_id = v_campaign_id
              AND ics.inventory_site_id = v_inventory_site_id
              AND icl.inventory_site_location_id = v_finding.inventory_site_location_id
        ) THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
                DETAIL=pg_catalog.jsonb_build_object('message','La ubicación no está en el alcance seleccionado de la campaña.','retryable',false,
                    'inventory_site_location_id',v_finding.inventory_site_location_id)::text;
        END IF;

        -- Origen A: canónico (producto en la fuente teórica, identidad consistente)
        IF EXISTS (
            SELECT 1
            FROM inventarios.get_campaign_theoretical_stock(p_company_id, v_campaign_id) t
            WHERE t.product_id = v_finding.product_id
              AND t.bsale_variant_id = v_finding.bsale_variant_id
        ) THEN
            -- Ausente de TODOS los snapshots de sesiones NORMAL de la campaña (evita doble conteo)
            IF EXISTS (
                SELECT 1
                FROM inventarios.operational_snapshots os
                JOIN inventarios.sessions s ON s.company_id = os.company_id AND s.id = os.session_id
                JOIN inventarios.snapshot_products sp ON sp.company_id = os.company_id AND sp.snapshot_id = os.id
                WHERE os.company_id = p_company_id
                  AND s.campaign_id = v_campaign_id
                  AND s.session_purpose = 'NORMAL'
                  AND sp.bsale_variant_id = v_finding.bsale_variant_id
            ) THEN
                RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
                    DETAIL=pg_catalog.jsonb_build_object('message','El producto ya figura en un snapshot de una sesión NORMAL; se evita el doble conteo.','retryable',false,
                        'bsale_variant_id',v_finding.bsale_variant_id)::text;
            END IF;
        ELSE
            -- Origen B: fuera del teórico
            SELECT pr.bsale_variant_id, pr.is_active INTO v_out_variant, v_out_active
            FROM adquisiciones.products pr
            WHERE pr.company_id = p_company_id AND pr.id = v_finding.product_id;
            IF v_out_active IS NULL OR NOT v_out_active THEN
                RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
                    DETAIL=pg_catalog.jsonb_build_object('message','El producto no existe activo en la maestra.','retryable',false,
                        'product_id',v_finding.product_id)::text;
            END IF;
            IF v_out_variant IS NULL OR v_out_variant <> v_finding.bsale_variant_id THEN
                RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
                    DETAIL=pg_catalog.jsonb_build_object('message','El producto no tiene bsale_variant_id actual o no coincide con la variante de la maestra; no se permite consolidar sin bsale_variant_id.','retryable',false,
                        'product_id',v_finding.product_id,'bsale_variant_id',v_finding.bsale_variant_id)::text;
            END IF;
            -- Ausente por product_id ni bsale_variant_id en snapshots NORMAL de la campaña
            IF EXISTS (
                SELECT 1
                FROM inventarios.operational_snapshots os
                JOIN inventarios.sessions s ON s.company_id = os.company_id AND s.id = os.session_id
                JOIN inventarios.snapshot_products sp ON sp.company_id = os.company_id AND sp.snapshot_id = os.id
                WHERE os.company_id = p_company_id
                  AND s.campaign_id = v_campaign_id
                  AND s.session_purpose = 'NORMAL'
                  AND (sp.product_id = v_finding.product_id OR sp.bsale_variant_id = v_finding.bsale_variant_id)
            ) THEN
                RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
                    DETAIL=pg_catalog.jsonb_build_object('message','El producto ya figura en un snapshot de una sesión NORMAL; se evita el doble conteo.','retryable',false,
                        'product_id',v_finding.product_id,'bsale_variant_id',v_finding.bsale_variant_id)::text;
            END IF;
        END IF;
    END LOOP;

    -- ---------- Crear el snapshot (uno por sesión) ----------
    IF v_snapshot_id IS NULL THEN
        INSERT INTO inventarios.operational_snapshots
            (company_id, session_id, snapshot_version, completion_status, captured_at, captured_by, created_at, created_by)
        VALUES (p_company_id, p_session_id, 1, 'PENDING', v_occurred_at, v_actor_id, v_occurred_at, v_actor_id)
        RETURNING id INTO v_snapshot_id;
    END IF;

    -- ---------- Congelar productos recibidos (canónico o fuera del teórico) ----------
    INSERT INTO inventarios.snapshot_products
        (company_id, snapshot_id, product_id, bsale_variant_id, sku, barcode, name, created_at, created_by)
    SELECT DISTINCT
           p_company_id, v_snapshot_id, src.product_id, src.bsale_variant_id, src.sku,
           src.barcode, src.name, v_occurred_at, v_actor_id
    FROM pg_catalog.jsonb_array_elements(v_findings) f
    JOIN LATERAL (
        -- Origen canónico
        SELECT t.product_id, t.bsale_variant_id, t.sku,
               coalesce(bv.bar_code, pr.barcode) AS barcode,
               coalesce(NULLIF(pg_catalog.btrim(coalesce(bv.description, pr.description)), ''), t.sku) AS name
        FROM inventarios.get_campaign_theoretical_stock(p_company_id, v_campaign_id) t
        LEFT JOIN integraciones.bsale_variants bv
          ON bv.company_id = p_company_id AND bv.bsale_id = t.bsale_variant_id
        LEFT JOIN adquisiciones.products pr
          ON pr.id = t.product_id
        WHERE t.product_id = (f ->> 'product_id')::uuid
          AND t.bsale_variant_id = (f ->> 'bsale_variant_id')::int
        UNION ALL
        -- Origen fuera del teórico
        SELECT pr.id, pr.bsale_variant_id, pr.sku,
               coalesce(NULLIF(pg_catalog.btrim(pr.barcode), ''), NULL) AS barcode,
               coalesce(NULLIF(pg_catalog.btrim(pr.description), ''), NULLIF(pg_catalog.btrim(pr.short_description), ''), NULLIF(pg_catalog.btrim(pr.sku), ''), 'Producto sin descripción') AS name
        FROM adquisiciones.products pr
        WHERE pr.company_id = p_company_id
          AND pr.id = (f ->> 'product_id')::uuid
          AND pr.is_active = true
          AND pr.bsale_variant_id = (f ->> 'bsale_variant_id')::int
          AND NOT EXISTS (
              SELECT 1 FROM inventarios.get_campaign_theoretical_stock(p_company_id, v_campaign_id) t2
              WHERE t2.product_id = pr.id AND t2.bsale_variant_id = pr.bsale_variant_id
          )
        LIMIT 1
    ) src ON true
    ON CONFLICT (company_id, snapshot_id, bsale_variant_id) DO NOTHING;

    -- ---------- Congelar ubicaciones recibidas ----------
    INSERT INTO inventarios.snapshot_locations
        (company_id, snapshot_id, inventory_site_location_id, source_logistics_location_id,
         location_id, warehouse_id, code, name, aisle, rack, level, position, is_active, created_at, created_by)
    SELECT DISTINCT
           p_company_id, v_snapshot_id, isl.id, isl.source_logistics_location_id,
           isl.source_logistics_location_id, v_warehouse_id,
           isl.code, isl.name, isl.aisle, isl.rack, isl.level, isl.position, isl.is_active,
           v_occurred_at, v_actor_id
    FROM pg_catalog.jsonb_array_elements(v_findings) f
    JOIN inventarios.inventory_site_locations isl
      ON isl.company_id = p_company_id
     AND isl.inventory_site_id = v_inventory_site_id
     AND isl.id = (f ->> 'inventory_site_location_id')::uuid
    ON CONFLICT (company_id, snapshot_id, inventory_site_location_id)
        WHERE inventory_site_location_id IS NOT NULL DO NOTHING;

    SELECT pg_catalog.count(*) INTO v_product_count
    FROM inventarios.snapshot_products sp
    WHERE sp.company_id = p_company_id AND sp.snapshot_id = v_snapshot_id;
    IF v_product_count < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SNAPSHOT_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','No se congeló ningún producto en el snapshot.','retryable',false)::text;
    END IF;
    SELECT pg_catalog.count(*) INTO v_location_count
    FROM inventarios.snapshot_locations sl
    WHERE sl.company_id = p_company_id AND sl.snapshot_id = v_snapshot_id;
    IF v_location_count < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SNAPSHOT_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','No se congeló ninguna ubicación en el snapshot.','retryable',false)::text;
    END IF;

    -- ---------- content_hash determinístico (contrato de prepare_inventory_session_from_import) ----------
    SELECT pg_catalog.encode(
        extensions.digest(
            pg_catalog.convert_to(pg_catalog.string_agg(t.line, E'\n' ORDER BY t.line), 'UTF8'),
            'sha256'
        ),
        'hex'
    )
    INTO v_hash
    FROM (
        SELECT 'P:' || sp.product_id::text || '|' || coalesce(sp.sku,'') AS line
        FROM inventarios.snapshot_products sp
        WHERE sp.company_id = p_company_id AND sp.snapshot_id = v_snapshot_id
        UNION ALL
        SELECT 'L:' || sl.inventory_site_location_id::text || '|' || coalesce(sl.code,'')
        FROM inventarios.snapshot_locations sl
        WHERE sl.company_id = p_company_id AND sl.snapshot_id = v_snapshot_id
    ) AS t;

    UPDATE inventarios.operational_snapshots AS os
    SET completion_status = 'COMPLETED',
        content_hash = v_hash,
        captured_at = v_occurred_at,
        captured_by = v_actor_id,
        inventory_site_id = v_inventory_site_id,
        warehouse_id = v_warehouse_id
    WHERE os.company_id = p_company_id AND os.id = v_snapshot_id;

    UPDATE inventarios.sessions AS s
    SET status = 'PREPARED',
        prepared_at = v_occurred_at,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE s.company_id = p_company_id AND s.id = p_session_id
      AND s.status = 'DRAFT';
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
            DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.supplemental.prepare','entity_id',p_session_id,
        'state','PREPARED','version',NULL::integer,'cycle_number',NULL::integer,
        'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object('snapshot_id',v_snapshot_id,
            'completion_status','COMPLETED','content_hash',v_hash,
            'prepared_at',v_occurred_at,'prepared_by',v_actor_id,
            'product_count',v_product_count,'location_count',v_location_count,
            'findings_count',pg_catalog.jsonb_array_length(v_findings)));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_session_id, v_response);
END;
$function$;

ALTER FUNCTION inventarios.prepare_supplemental_findings_session(uuid, uuid, jsonb, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.prepare_supplemental_findings_session(uuid, uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.prepare_supplemental_findings_session(uuid, uuid, jsonb, uuid) TO authenticated, service_role;

-- ============================================================================
-- 5. RPC DE CONSOLIDACIÓN POR BODEGA
--    Traduce los DRAFT elegibles del site a un lote SUPPLEMENTAL_FINDINGS
--    PREPARED (sesión + snapshot + contexto operacional). Los BLOCKED_* quedan
--    en DRAFT. Idempotente por clave. Múltiples lotes sucesivos en la misma
--    campaña + site sin modificar los lotes anteriores.
-- ============================================================================
CREATE OR REPLACE FUNCTION inventarios.consolidate_inventory_campaign_supplemental_findings(
    p_company_id uuid,
    p_campaign_id uuid,
    p_inventory_site_id uuid,
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_role_name text;
    v_campaign_status text;
    v_campaign_name text;
    v_site_name text;
    v_warehouse_id uuid;
    v_operation jsonb;
    v_operation_id uuid;
    v_payload jsonb;
    v_occurred_at timestamptz;
    v_session_resp jsonb;
    v_session_id uuid;
    v_prepare_resp jsonb;
    v_snapshot_id uuid;
    v_hash text;
    v_setup_resp jsonb;
    v_zone_id uuid;
    v_task_id uuid;
    v_assignment_id uuid;
    v_draft_total bigint := 0;
    v_canonical_count bigint := 0;
    v_out_count bigint := 0;
    v_consolidated_count bigint := 0;
    v_blocked_count bigint := 0;
    v_findings_filtered jsonb := '[]'::jsonb;
    v_finding_ids uuid[] := '{}'::uuid[];
    v_frec record;
    v_response jsonb;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_inventory_site_id IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_supplemental_findings_super_user(p_company_id);
    v_occurred_at := pg_catalog.now();

    -- Seriación por campaña+site para evitar lotes concurrentes del mismo par
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.supplemental.consolidate'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_campaign_id::text || ':' || p_inventory_site_id::text));

    -- ---------- Idempotencia ----------
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.supplemental.consolidate','company_id',p_company_id,
        'campaign_id',p_campaign_id,'inventory_site_id',p_inventory_site_id);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.supplemental.consolidate',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    -- ---------- Campaña IN_PROGRESS ----------
    SELECT ic.status, ic.name INTO v_campaign_status, v_campaign_name
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id;
    IF v_campaign_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario no existe.','retryable',false)::text;
    END IF;
    IF v_campaign_status <> 'IN_PROGRESS' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La campaña debe estar en IN_PROGRESS.','retryable',false,'status',v_campaign_status)::text;
    END IF;

    -- ---------- Site participante de la campaña ----------
    SELECT is2.name, is2.warehouse_id INTO v_site_name, v_warehouse_id
    FROM inventarios.inventory_campaign_sites ics
    JOIN inventarios.inventory_sites is2
      ON is2.company_id = ics.company_id AND is2.id = ics.inventory_site_id
    WHERE ics.company_id = p_company_id
      AND ics.campaign_id = p_campaign_id
      AND ics.inventory_site_id = p_inventory_site_id;
    IF v_site_name IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La unidad no participa en la campaña.','retryable',false)::text;
    END IF;

    -- ---------- Bloquear el conjunto DRAFT del site (evita consolidaciones concurrentes) ----------
    FOR v_frec IN
        SELECT f.id AS finding_id
        FROM inventarios.inventory_campaign_supplemental_findings f
        WHERE f.company_id = p_company_id
          AND f.campaign_id = p_campaign_id
          AND f.inventory_site_id = p_inventory_site_id
          AND f.status = 'DRAFT'
        ORDER BY f.id
        FOR UPDATE OF f
    LOOP
        NULL;
    END LOOP;

    -- ---------- Clasificación EFECTIVA (producto/variante/teórica/snapshots actuales) ----------
    FOR v_frec IN
        SELECT f.id AS finding_id, f.product_id, f.inventory_site_location_id,
               pr.bsale_variant_id AS bsale_variant_id,
               c.classification
        FROM inventarios.inventory_campaign_supplemental_findings f
        LEFT JOIN adquisiciones.products pr
          ON pr.company_id = f.company_id AND pr.id = f.product_id
        CROSS JOIN LATERAL inventarios.classify_supplemental_finding(
            p_company_id, p_campaign_id, f.product_id, pr.bsale_variant_id) c
        WHERE f.company_id = p_company_id
          AND f.campaign_id = p_campaign_id
          AND f.inventory_site_id = p_inventory_site_id
          AND f.status = 'DRAFT'
        ORDER BY f.id
    LOOP
        v_draft_total := v_draft_total + 1;
        IF v_frec.classification IN ('ELIGIBLE_CANONICAL','ELIGIBLE_OUT_OF_THEORETICAL') THEN
            IF v_frec.classification = 'ELIGIBLE_CANONICAL' THEN
                v_canonical_count := v_canonical_count + 1;
            ELSE
                v_out_count := v_out_count + 1;
            END IF;
            v_findings_filtered := v_findings_filtered || pg_catalog.jsonb_build_array(
                pg_catalog.jsonb_build_object(
                    'product_id', v_frec.product_id,
                    'bsale_variant_id', v_frec.bsale_variant_id,
                    'inventory_site_location_id', v_frec.inventory_site_location_id));
            v_finding_ids := pg_catalog.array_append(v_finding_ids, v_frec.finding_id);
        END IF;
    END LOOP;

    v_consolidated_count := v_canonical_count + v_out_count;
    v_blocked_count := v_draft_total - v_consolidated_count;

    IF v_consolidated_count < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NO_ELIGIBLE_SUPPLEMENTAL_FINDINGS',
            DETAIL=pg_catalog.jsonb_build_object('message','No hay hallazgos complementarios elegibles para consolidar en esta bodega.','retryable',false,'draft_count',v_draft_total)::text;
    END IF;

    -- ---------- A. Sesión DRAFT (nuevo lote o reutilización de DRAFT pendiente) ----------
    v_session_resp := inventarios.get_or_create_inventory_campaign_supplemental_findings_session(
        p_company_id, p_campaign_id, p_inventory_site_id);
    v_session_id := (v_session_resp ->> 'session_id')::uuid;

    -- ---------- C. Congelar lote (productos + ubicaciones) ----------
    v_prepare_resp := inventarios.prepare_supplemental_findings_session(
        p_company_id, v_session_id, v_findings_filtered, p_idempotency_key);
    v_snapshot_id := (v_prepare_resp -> 'data' ->> 'snapshot_id')::uuid;
    v_hash := v_prepare_resp -> 'data' ->> 'content_hash';

    -- ---------- D. Contexto operacional (sigue PREPARED) ----------
    v_setup_resp := inventarios.setup_supplemental_findings_operational_context(
        p_company_id, v_session_id, p_idempotency_key);
    v_zone_id := (v_setup_resp -> 'data' ->> 'zone_id')::uuid;
    v_task_id := (v_setup_resp -> 'data' ->> 'task_id')::uuid;
    v_assignment_id := (v_setup_resp -> 'data' ->> 'task_assignment_id')::uuid;

    -- ---------- E. Marcar CONSOLIDATED solo si todo lo anterior terminó bien ----------
    UPDATE inventarios.inventory_campaign_supplemental_findings
    SET status = 'CONSOLIDATED',
        consolidated_at = v_occurred_at,
        consolidated_by = v_actor_id,
        supplemental_session_id = v_session_id,
        supplemental_snapshot_id = v_snapshot_id,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE company_id = p_company_id
      AND campaign_id = p_campaign_id
      AND inventory_site_id = p_inventory_site_id
      AND status = 'DRAFT'
      AND id = ANY(v_finding_ids);

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.supplemental.consolidate',
        'entity_id', v_session_id,
        'state','PREPARED',
        'version',1,
        'cycle_number',1,
        'assignment_id', v_assignment_id,
        'event_id',NULL::uuid,
        'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object(
            'campaign_id', p_campaign_id,
            'inventory_site_id', p_inventory_site_id,
            'supplemental_session_id', v_session_id,
            'supplemental_snapshot_id', v_snapshot_id,
            'zone_id', v_zone_id,
            'task_id', v_task_id,
            'task_assignment_id', v_assignment_id,
            'warehouse_id', v_warehouse_id,
            'consolidated_count', v_consolidated_count,
            'eligible_canonical_count', v_canonical_count,
            'eligible_out_of_theoretical_count', v_out_count,
            'blocked_draft_count', v_blocked_count,
            'content_hash', v_hash));

    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, v_session_id, v_response);
END;
$function$;

ALTER FUNCTION inventarios.consolidate_inventory_campaign_supplemental_findings(uuid, uuid, uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.consolidate_inventory_campaign_supplemental_findings(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.consolidate_inventory_campaign_supplemental_findings(uuid, uuid, uuid, uuid) TO authenticated, service_role;
