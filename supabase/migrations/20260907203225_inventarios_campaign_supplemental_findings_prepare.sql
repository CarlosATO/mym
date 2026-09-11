-- Migration: 20260907180000_inventarios_campaign_supplemental_findings_prepare.sql
-- Description: Preparación mínima e inmutable de una sesión SUPPLEMENTAL_FINDINGS.
--              Congela en un operational_snapshot únicamente los productos y
--              ubicaciones recibidos (hallazgos) y pasa la sesión a PREPARED.
--
-- Reglas:
--   * solo SUPER_USUARIO;
--   * campaña IN_PROGRESS;
--   * la sesión es de la campaña, session_purpose = 'SUPPLEMENTAL_FINDINGS' y está en DRAFT;
--   * los hallazgos validan ubicación (mismo inventory_site, activa, según alcance
--     campaña/site) y producto (existe en get_campaign_theoretical_stock con
--     product_id + bsale_variant_id de la misma identidad y ausente de cualquier
--     snapshot de sesión NORMAL de la campaña);
--   * se crea UN operational_snapshot y se congelan snapshot_products + snapshot_locations;
--   * NO se crean snapshot_stocks, snapshot_theoretical_stocks, inventory_campaign_snapshot
--     ni theoretical stocks de campaña;
--   * NO se consume ni modifica stock_imports ni stock_import_rows;
--   * una vez COMPLETED el snapshot es inmutable (idempotencia por la misma clave,
--     rechazo de cualquier intento posterior de re-congelar).
-- Author: Assistant

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
    SELECT pg_catalog.coalesce(
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
        -- Producto en la fuente teórica canónica con identidad consistente
        IF NOT EXISTS (
            SELECT 1
            FROM inventarios.get_campaign_theoretical_stock(p_company_id, v_campaign_id) t
            WHERE t.product_id = v_finding.product_id
              AND t.bsale_variant_id = v_finding.bsale_variant_id
        ) THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
                DETAIL=pg_catalog.jsonb_build_object('message','El producto no existe en la fuente teórica o product_id/bsale_variant_id no corresponden a la misma identidad.','retryable',false,
                    'product_id',v_finding.product_id,'bsale_variant_id',v_finding.bsale_variant_id)::text;
        END IF;
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
    END LOOP;

    -- ---------- Crear el snapshot (uno por sesión) ----------
    IF v_snapshot_id IS NULL THEN
        INSERT INTO inventarios.operational_snapshots
            (company_id, session_id, snapshot_version, completion_status, captured_at, captured_by, created_at, created_by)
        VALUES (p_company_id, p_session_id, 1, 'PENDING', v_occurred_at, v_actor_id, v_occurred_at, v_actor_id)
        RETURNING id INTO v_snapshot_id;
    END IF;

    -- ---------- Congelar productos recibidos ----------
    INSERT INTO inventarios.snapshot_products
        (company_id, snapshot_id, product_id, bsale_variant_id, sku, barcode, name, created_at, created_by)
    SELECT DISTINCT
           p_company_id, v_snapshot_id, t.product_id, t.bsale_variant_id, t.sku,
           pg_catalog.coalesce(bv.bar_code, pr.barcode),
           pg_catalog.coalesce(NULLIF(pg_catalog.btrim(pg_catalog.coalesce(bv.description, pr.description)), ''), t.sku),
           v_occurred_at, v_actor_id
    FROM pg_catalog.jsonb_array_elements(v_findings) f
    JOIN LATERAL (
        SELECT t.product_id, t.bsale_variant_id, t.sku
        FROM inventarios.get_campaign_theoretical_stock(p_company_id, v_campaign_id) t
        WHERE t.product_id = (f ->> 'product_id')::uuid
          AND t.bsale_variant_id = (f ->> 'bsale_variant_id')::int
        LIMIT 1
    ) t ON true
    LEFT JOIN integraciones.bsale_variants bv
      ON bv.company_id = p_company_id AND bv.bsale_id = t.bsale_variant_id
    LEFT JOIN adquisiciones.products pr
      ON pr.id = t.product_id
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
