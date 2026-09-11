-- Migration: 20260908130000_inventarios_supplemental_findings_drafts.sql
-- Description: Registro acumulativo y editable de HALLAZGOS COMPLEMENTARIOS en
--              borrador para una campaña de inventario IN_PROGRESS.
--
-- Alcance mínimo aprobado:
--   * los hallazgos se registran ANTES de crear/congelar el snapshot
--     SUPPLEMENTAL_FINDINGS y permanecen en status DRAFT (o REMOVED);
--   * NO se crean sesiones SUPPLEMENTAL_FINDINGS, snapshots, zonas, tareas,
--     assignments ni count_entries en este bloque;
--   * las sesiones/snapshots NORMAL no se modifican;
--   * un hallazgo NO está limitado a los productos de la teórica canónica:
--     cualquier producto resoluble en la maestra puede guardarse en borrador;
--   * la clasificación es dinámica (estado efectivo actual) y un producto puede
--     seguir apareciendo en ubicaciones distintas de la misma campaña.
--
-- Estados mínimos utilizados: DRAFT / REMOVED. CONSOLIDATED queda reservado
-- para el bloque posterior de consolidación.
-- Author: Assistant

-- ============================================================================
-- 1. TABLA DEDICADA
-- ============================================================================
CREATE TABLE inventarios.inventory_campaign_supplemental_findings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    inventory_site_id uuid NOT NULL,
    inventory_site_location_id uuid NOT NULL,
    product_id uuid NOT NULL,
    bsale_variant_id integer,
    quantity numeric(14,3) NOT NULL,
    status text NOT NULL DEFAULT 'DRAFT',
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid,
    removed_at timestamptz,
    removed_by uuid,

    CONSTRAINT fk_supplemental_findings_company
        FOREIGN KEY (company_id)
        REFERENCES core.companies(id) ON DELETE RESTRICT,
    CONSTRAINT fk_supplemental_findings_created_by
        FOREIGN KEY (created_by)
        REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_supplemental_findings_updated_by
        FOREIGN KEY (updated_by)
        REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_supplemental_findings_removed_by
        FOREIGN KEY (removed_by)
        REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_supplemental_findings_product
        FOREIGN KEY (product_id)
        REFERENCES adquisiciones.products(id) ON DELETE RESTRICT,
    CONSTRAINT fk_supplemental_findings_campaign_site
        FOREIGN KEY (company_id, campaign_id, inventory_site_id)
        REFERENCES inventarios.inventory_campaign_sites(company_id, campaign_id, inventory_site_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_supplemental_findings_site_location
        FOREIGN KEY (company_id, inventory_site_id, inventory_site_location_id)
        REFERENCES inventarios.inventory_site_locations(company_id, inventory_site_id, id)
        ON DELETE RESTRICT,

    CONSTRAINT chk_supplemental_findings_status
        CHECK (status IN ('DRAFT', 'CONSOLIDATED', 'REMOVED')),
    CONSTRAINT chk_supplemental_findings_quantity
        CHECK (quantity > 0),
    CONSTRAINT chk_supplemental_findings_removed
        CHECK (
            (status <> 'REMOVED' AND removed_at IS NULL AND removed_by IS NULL)
            OR (status = 'REMOVED' AND removed_at IS NOT NULL AND removed_by IS NOT NULL)
        ),
    CONSTRAINT chk_supplemental_findings_updated_by
        CHECK ((updated_by IS NULL) OR (updated_by IS NOT NULL AND updated_at IS NOT NULL))
);

-- Máximo UN DRAFT activo para la identidad:
--   company + campaign + inventory_site + inventory_site_location + product.
-- El mismo producto SÍ puede aparecer en ubicaciones distintas.
CREATE UNIQUE INDEX uq_supplemental_findings_draft_key
    ON inventarios.inventory_campaign_supplemental_findings
    (company_id, campaign_id, inventory_site_id, inventory_site_location_id, product_id)
    WHERE status = 'DRAFT';

CREATE INDEX idx_supplemental_findings_campaign_status
    ON inventarios.inventory_campaign_supplemental_findings (company_id, campaign_id, status);

CREATE INDEX idx_supplemental_findings_site
    ON inventarios.inventory_campaign_supplemental_findings (company_id, inventory_site_id);

ALTER TABLE inventarios.inventory_campaign_supplemental_findings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE inventarios.inventory_campaign_supplemental_findings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE inventarios.inventory_campaign_supplemental_findings TO service_role;

-- ============================================================================
-- 2. GUARDA DE AUTORIZACIÓN: SUPER_USUARIO con acceso de empresa
-- ============================================================================
CREATE OR REPLACE FUNCTION inventarios.require_supplemental_findings_super_user(
    p_company_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_role_name text;
BEGIN
    v_actor_id := inventarios.require_company_access(p_company_id);
    SELECT r.name INTO v_role_name
    FROM portal.users u
    JOIN portal.roles r ON r.id = u.role_id
    WHERE u.id = v_actor_id AND u.is_active = true;
    IF coalesce(v_role_name, '') <> 'SUPER_USUARIO' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PERMISSION_REQUIRED',
            DETAIL=pg_catalog.jsonb_build_object('message','Solo SUPER_USUARIO puede usar la gestión de hallazgos complementarios.','retryable',false)::text;
    END IF;
    RETURN v_actor_id;
END;
$function$;

ALTER FUNCTION inventarios.require_supplemental_findings_super_user(uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.require_supplemental_findings_super_user(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================================
-- 3. CLASIFICACIÓN DINÁMICA DE UN HALLAZGO
--    Calcula el estado efectivo actual (no un texto congelado):
--      ELIGIBLE_CANONICAL              -> en teórica canónica, ausente de snapshots NORMAL
--      ELIGIBLE_OUT_OF_THEORETICAL     -> en maestra con bsale_variant_id utilizable,
--                                          fuera de teórica, ausente de snapshots NORMAL
--      BLOCKED_ALREADY_IN_NORMAL_SNAPSHOT -> aparece en algún snapshot de sesión NORMAL
--      BLOCKED_MISSING_BSALE_VARIANT   -> resuelto en maestra sin bsale_variant_id utilizable
-- ============================================================================
CREATE OR REPLACE FUNCTION inventarios.classify_supplemental_finding(
    p_company_id uuid,
    p_campaign_id uuid,
    p_product_id uuid,
    p_bsale_variant_id integer
)
RETURNS TABLE (
    classification text,
    in_canonical_theoretical boolean,
    in_normal_snapshot boolean,
    can_consolidate boolean
)
LANGUAGE plpgsql
VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_in_theoretical boolean := false;
    v_in_normal boolean := false;
    v_classification text;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM inventarios.get_campaign_theoretical_stock(p_company_id, p_campaign_id) t
        WHERE t.product_id = p_product_id
           OR (p_bsale_variant_id IS NOT NULL AND t.bsale_variant_id = p_bsale_variant_id)
    ) INTO v_in_theoretical;

    SELECT EXISTS (
        SELECT 1
        FROM inventarios.snapshot_products sp
        JOIN inventarios.operational_snapshots os
          ON os.company_id = sp.company_id AND os.id = sp.snapshot_id
        JOIN inventarios.sessions s
          ON s.company_id = os.company_id AND s.id = os.session_id
        WHERE s.company_id = p_company_id
          AND s.campaign_id = p_campaign_id
          AND s.session_purpose = 'NORMAL'
          AND (
              (p_bsale_variant_id IS NOT NULL AND sp.bsale_variant_id = p_bsale_variant_id)
              OR sp.product_id = p_product_id
          )
    ) INTO v_in_normal;

    IF v_in_normal THEN
        v_classification := 'BLOCKED_ALREADY_IN_NORMAL_SNAPSHOT';
    ELSIF p_bsale_variant_id IS NULL THEN
        v_classification := 'BLOCKED_MISSING_BSALE_VARIANT';
    ELSIF v_in_theoretical THEN
        v_classification := 'ELIGIBLE_CANONICAL';
    ELSE
        v_classification := 'ELIGIBLE_OUT_OF_THEORETICAL';
    END IF;

    RETURN QUERY
    SELECT v_classification, v_in_theoretical, v_in_normal,
           (v_classification IN ('ELIGIBLE_CANONICAL','ELIGIBLE_OUT_OF_THEORETICAL'));
END;
$function$;

ALTER FUNCTION inventarios.classify_supplemental_finding(uuid, uuid, uuid, integer) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.classify_supplemental_finding(uuid, uuid, uuid, integer) FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================================
-- 4. BÚSQUEDA DE PRODUCTOS CANDIDATOS (MAESTRA, no solo teórica)
-- ============================================================================
CREATE OR REPLACE FUNCTION inventarios.search_inventory_campaign_supplemental_finding_products(
    p_company_id uuid,
    p_campaign_id uuid,
    p_query text,
    p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_clean_query text;
    v_limit integer;
    v_results jsonb;
    v_campaign_status text;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_supplemental_findings_super_user(p_company_id);

    v_clean_query := pg_catalog.btrim(coalesce(p_query, ''));
    IF pg_catalog.length(v_clean_query) < 1 THEN
        RETURN '[]'::jsonb;
    END IF;

    v_limit := coalesce(p_limit, 20);
    v_limit := LEAST(100, GREATEST(1, v_limit));

    SELECT ic.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id;
    IF v_campaign_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario no existe.','retryable',false)::text;
    END IF;

    WITH master AS (
        SELECT
            p.id AS product_id,
            p.bsale_variant_id AS bsale_variant_id,
            p.sku AS sku,
            p.barcode AS barcode,
            coalesce(
                NULLIF(pg_catalog.btrim(p.description), ''),
                NULLIF(pg_catalog.btrim(p.short_description), ''),
                NULLIF(pg_catalog.btrim(p.sku), ''),
                'Producto sin descripción') AS name
        FROM adquisiciones.products p
        WHERE p.company_id = p_company_id AND p.is_active = true
          AND (
              p.sku ILIKE '%' || v_clean_query || '%'
              OR p.barcode ILIKE '%' || v_clean_query || '%'
              OR p.description ILIKE '%' || v_clean_query || '%'
              OR p.short_description ILIKE '%' || v_clean_query || '%'
          )
    ),
    classified AS (
        SELECT
            m.product_id,
            m.bsale_variant_id,
            m.sku,
            m.barcode,
            m.name,
            c.classification,
            c.in_canonical_theoretical,
            c.in_normal_snapshot,
            c.can_consolidate
        FROM master m
        CROSS JOIN LATERAL inventarios.classify_supplemental_finding(
            p_company_id, p_campaign_id, m.product_id, m.bsale_variant_id) c
        ORDER BY m.sku, m.product_id
        LIMIT v_limit
    )
    SELECT coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'product_id', cf.product_id,
            'bsale_variant_id', cf.bsale_variant_id,
            'sku', cf.sku,
            'barcode', cf.barcode,
            'name', cf.name,
            'classification', cf.classification,
            'in_canonical_theoretical', cf.in_canonical_theoretical,
            'in_normal_snapshot', cf.in_normal_snapshot,
            'can_consolidate', cf.can_consolidate
        ) ORDER BY cf.sku, cf.product_id
    ), '[]'::jsonb)
    INTO v_results
    FROM classified cf;

    RETURN v_results;
END;
$function$;

ALTER FUNCTION inventarios.search_inventory_campaign_supplemental_finding_products(uuid, uuid, text, integer) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.search_inventory_campaign_supplemental_finding_products(uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.search_inventory_campaign_supplemental_finding_products(uuid, uuid, text, integer) TO authenticated, service_role;

-- ============================================================================
-- 5. CREAR HALLAZGO DRAFT
--    Permite guardar también ELIGIBLE_OUT_OF_THEORETICAL,
--    BLOCKED_ALREADY_IN_NORMAL_SNAPSHOT y BLOCKED_MISSING_BSALE_VARIANT.
--    La clasificación NO es motivo para perder el hallazgo.
--    Idempotente; si ya existe un DRAFT activo para producto + ubicación
--    responde INV_SUPPLEMENTAL_FINDING_ALREADY_EXISTS (no suma ni duplica).
-- ============================================================================
CREATE OR REPLACE FUNCTION inventarios.create_inventory_campaign_supplemental_finding(
    p_company_id uuid,
    p_campaign_id uuid,
    p_inventory_site_id uuid,
    p_inventory_site_location_id uuid,
    p_product_id uuid,
    p_quantity numeric,
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_operation jsonb;
    v_operation_id uuid;
    v_payload jsonb;
    v_campaign_status text;
    v_campaign_name text;
    v_campaign_site_id uuid;
    v_location_scope text;
    v_isl_active boolean;
    v_source_loc uuid;
    v_in_scope boolean := false;
    v_bsale_variant_id integer;
    v_sku text;
    v_barcode text;
    v_product_name text;
    v_found_id uuid;
    v_constraint_name text;
    v_finding_id uuid;
    v_occurred_at timestamptz;
    v_response jsonb;
    v_cls text;
    v_cls_theo boolean;
    v_cls_normal boolean;
    v_cls_consolidate boolean;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_inventory_site_id IS NULL
       OR p_inventory_site_location_id IS NULL OR p_product_id IS NULL
       OR p_quantity IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    IF p_quantity <= 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_QUANTITY',
            DETAIL=pg_catalog.jsonb_build_object('message','La cantidad debe ser mayor a cero.','retryable',false,'quantity',p_quantity)::text;
    END IF;

    v_actor_id := inventarios.require_supplemental_findings_super_user(p_company_id);
    v_occurred_at := pg_catalog.now();

    -- ---------- Idempotencia ----------
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.supplemental.create_finding','company_id',p_company_id,
        'campaign_id',p_campaign_id,'inventory_site_id',p_inventory_site_id,
        'inventory_site_location_id',p_inventory_site_location_id,'product_id',p_product_id,
        'quantity',p_quantity);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.supplemental.create_finding',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    -- ---------- Campaña debe existir, pertenecer a la empresa y estar IN_PROGRESS ----------
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

    -- ---------- Site participante de la campaña + location_scope ----------
    SELECT ics.id, ics.location_scope INTO v_campaign_site_id, v_location_scope
    FROM inventarios.inventory_campaign_sites ics
    WHERE ics.company_id = p_company_id AND ics.campaign_id = p_campaign_id
      AND ics.inventory_site_id = p_inventory_site_id;
    IF v_campaign_site_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La unidad no participa en la campaña.','retryable',false)::text;
    END IF;

    -- ---------- Ubicación válida: misma empresa, del site, activa, con logística ----------
    SELECT isl.is_active, isl.source_logistics_location_id INTO v_isl_active, v_source_loc
    FROM inventarios.inventory_site_locations isl
    WHERE isl.company_id = p_company_id AND isl.inventory_site_id = p_inventory_site_id
      AND isl.id = p_inventory_site_location_id;
    IF v_isl_active IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La ubicación no existe.','retryable',false)::text;
    END IF;
    IF NOT v_isl_active THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La ubicación no está activa.','retryable',false)::text;
    END IF;
    IF v_source_loc IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La ubicación no tiene una ubicación logística válida.','retryable',false)::text;
    END IF;

    -- ---------- Alcance de ubicaciones SELECTED ----------
    IF v_location_scope = 'SELECTED' THEN
        SELECT EXISTS (
            SELECT 1
            FROM inventarios.inventory_campaign_site_locations icl
            WHERE icl.company_id = p_company_id AND icl.campaign_site_id = v_campaign_site_id
              AND icl.inventory_site_location_id = p_inventory_site_location_id
        ) INTO v_in_scope;
        IF NOT v_in_scope THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
                DETAIL=pg_catalog.jsonb_build_object('message','La ubicación no está dentro del alcance de la campaña.','retryable',false)::text;
        END IF;
    END IF;

    -- ---------- Producto resoluble en la maestra ----------
    -- La existencia se determina por la fila activa de adquisiciones.products, no por
    -- la presencia de un nombre. Un producto activo sin descripción pero con SKU sigue
    -- siendo resoluble.
    SELECT p.id, p.bsale_variant_id, p.sku, p.barcode,
           coalesce(
               NULLIF(pg_catalog.btrim(p.description), ''),
               NULLIF(pg_catalog.btrim(p.short_description), ''),
               NULLIF(pg_catalog.btrim(p.sku), ''),
               'Producto sin descripción') AS name
    INTO v_found_id, v_bsale_variant_id, v_sku, v_barcode, v_product_name
    FROM adquisiciones.products p
    WHERE p.company_id = p_company_id AND p.id = p_product_id AND p.is_active = true;
    IF v_found_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El producto no existe en la maestra.','retryable',false)::text;
    END IF;

    -- ---------- Máximo un DRAFT activo para producto + ubicación ----------
    IF EXISTS (
        SELECT 1
        FROM inventarios.inventory_campaign_supplemental_findings f
        WHERE f.company_id = p_company_id AND f.campaign_id = p_campaign_id
          AND f.inventory_site_id = p_inventory_site_id
          AND f.inventory_site_location_id = p_inventory_site_location_id
          AND f.product_id = p_product_id AND f.status = 'DRAFT'
    ) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SUPPLEMENTAL_FINDING_ALREADY_EXISTS',
            DETAIL=pg_catalog.jsonb_build_object('message','Ya existe un hallazgo complementario en borrador para este producto en esta ubicación. La cantidad se corrige con el RPC de actualización.','retryable',false)::text;
    END IF;

    -- ---------- Crear DRAFT ----------
    -- Si dos escrituras concurrentes llegan al INSERT, la segunda golpea el índice único
    -- parcial uq_supplemental_findings_draft_key. Se traduce ese 23505 al mismo contrato
    -- de duplicado ya expuesto por la validación previa, sin alterar otros errores.
    BEGIN
        INSERT INTO inventarios.inventory_campaign_supplemental_findings (
            company_id, campaign_id, inventory_site_id, inventory_site_location_id,
            product_id, bsale_variant_id, quantity, status,
            created_at, created_by, updated_at, updated_by)
        VALUES (
            p_company_id, p_campaign_id, p_inventory_site_id, p_inventory_site_location_id,
            p_product_id, v_bsale_variant_id, p_quantity, 'DRAFT',
            v_occurred_at, v_actor_id, v_occurred_at, v_actor_id)
        RETURNING id INTO v_finding_id;
    EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
        IF v_constraint_name <> 'uq_supplemental_findings_draft_key' THEN RAISE; END IF;
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SUPPLEMENTAL_FINDING_ALREADY_EXISTS',
            DETAIL=pg_catalog.jsonb_build_object('message','Ya existe un hallazgo complementario en borrador para este producto en esta ubicación. La cantidad se corrige con el RPC de actualización.','retryable',false)::text;
    END;

    -- ---------- Clasificación efectiva actual ----------
    SELECT c.classification, c.in_canonical_theoretical, c.in_normal_snapshot, c.can_consolidate
    INTO v_cls, v_cls_theo, v_cls_normal, v_cls_consolidate
    FROM inventarios.classify_supplemental_finding(
        p_company_id, p_campaign_id, p_product_id, v_bsale_variant_id) c;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.supplemental.create_finding',
        'entity_id', v_finding_id,
        'state','DRAFT',
        'version',1,
        'cycle_number',1,
        'assignment_id',NULL::uuid,
        'event_id',NULL::uuid,
        'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object(
            'finding_id',v_finding_id,
            'campaign_id',p_campaign_id,
            'inventory_site_id',p_inventory_site_id,
            'inventory_site_location_id',p_inventory_site_location_id,
            'product_id',p_product_id,
            'bsale_variant_id',v_bsale_variant_id,
            'sku',v_sku,
            'barcode',v_barcode,
            'name',v_product_name,
            'quantity',p_quantity,
            'status','DRAFT',
            'classification',v_cls,
            'in_canonical_theoretical',v_cls_theo,
            'in_normal_snapshot',v_cls_normal,
            'can_consolidate',v_cls_consolidate,
            'created_at',v_occurred_at,
            'created_by',v_actor_id,
            'updated_at',v_occurred_at,
            'updated_by',v_actor_id));

    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, v_finding_id, v_response);
END;
$function$;

ALTER FUNCTION inventarios.create_inventory_campaign_supplemental_finding(uuid, uuid, uuid, uuid, uuid, numeric, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.create_inventory_campaign_supplemental_finding(uuid, uuid, uuid, uuid, uuid, numeric, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.create_inventory_campaign_supplemental_finding(uuid, uuid, uuid, uuid, uuid, numeric, uuid) TO authenticated, service_role;

-- ============================================================================
-- 6. ACTUALIZAR CANTIDAD DE UN HALLAZGO DRAFT
-- ============================================================================
CREATE OR REPLACE FUNCTION inventarios.update_inventory_campaign_supplemental_finding_quantity(
    p_company_id uuid,
    p_finding_id uuid,
    p_quantity numeric,
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_operation jsonb;
    v_operation_id uuid;
    v_payload jsonb;
    v_campaign_id uuid;
    v_finding_status text;
    v_campaign_status text;
    v_occurred_at timestamptz;
    v_response jsonb;
BEGIN
    IF p_company_id IS NULL OR p_finding_id IS NULL OR p_quantity IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    IF p_quantity <= 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_QUANTITY',
            DETAIL=pg_catalog.jsonb_build_object('message','La cantidad debe ser mayor a cero.','retryable',false,'quantity',p_quantity)::text;
    END IF;

    v_actor_id := inventarios.require_supplemental_findings_super_user(p_company_id);
    v_occurred_at := pg_catalog.now();

    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.supplemental.update_finding_quantity','company_id',p_company_id,
        'finding_id',p_finding_id,'quantity',p_quantity);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.supplemental.update_finding_quantity',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT f.campaign_id, f.status INTO v_campaign_id, v_finding_status
    FROM inventarios.inventory_campaign_supplemental_findings f
    WHERE f.company_id = p_company_id AND f.id = p_finding_id
    FOR UPDATE OF f;
    IF v_finding_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El hallazgo no existe.','retryable',false)::text;
    END IF;
    IF v_finding_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','Solo se puede actualizar la cantidad de un hallazgo en DRAFT.','retryable',false,'status',v_finding_status)::text;
    END IF;

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

    UPDATE inventarios.inventory_campaign_supplemental_findings
    SET quantity = p_quantity,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE company_id = p_company_id AND id = p_finding_id;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.supplemental.update_finding_quantity',
        'entity_id', p_finding_id,
        'state','DRAFT',
        'version',1,
        'cycle_number',1,
        'assignment_id',NULL::uuid,
        'event_id',NULL::uuid,
        'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object(
            'finding_id',p_finding_id,
            'quantity',p_quantity,
            'status','DRAFT',
            'updated_at',v_occurred_at,
            'updated_by',v_actor_id));

    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_finding_id, v_response);
END;
$function$;

ALTER FUNCTION inventarios.update_inventory_campaign_supplemental_finding_quantity(uuid, uuid, numeric, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.update_inventory_campaign_supplemental_finding_quantity(uuid, uuid, numeric, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.update_inventory_campaign_supplemental_finding_quantity(uuid, uuid, numeric, uuid) TO authenticated, service_role;

-- ============================================================================
-- 7. RETIRAR UN HALLAZGO (REMOVED, sin DELETE físico)
-- ============================================================================
CREATE OR REPLACE FUNCTION inventarios.remove_inventory_campaign_supplemental_finding(
    p_company_id uuid,
    p_finding_id uuid,
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_operation jsonb;
    v_operation_id uuid;
    v_payload jsonb;
    v_campaign_id uuid;
    v_finding_status text;
    v_campaign_status text;
    v_occurred_at timestamptz;
    v_response jsonb;
BEGIN
    IF p_company_id IS NULL OR p_finding_id IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_supplemental_findings_super_user(p_company_id);
    v_occurred_at := pg_catalog.now();

    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.supplemental.remove_finding','company_id',p_company_id,
        'finding_id',p_finding_id);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.supplemental.remove_finding',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT f.campaign_id, f.status INTO v_campaign_id, v_finding_status
    FROM inventarios.inventory_campaign_supplemental_findings f
    WHERE f.company_id = p_company_id AND f.id = p_finding_id
    FOR UPDATE OF f;
    IF v_finding_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El hallazgo no existe.','retryable',false)::text;
    END IF;
    IF v_finding_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','Solo se puede retirar un hallazgo en DRAFT.','retryable',false,'status',v_finding_status)::text;
    END IF;

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

    UPDATE inventarios.inventory_campaign_supplemental_findings
    SET status = 'REMOVED',
        removed_at = v_occurred_at,
        removed_by = v_actor_id,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE company_id = p_company_id AND id = p_finding_id;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.supplemental.remove_finding',
        'entity_id', p_finding_id,
        'state','REMOVED',
        'version',1,
        'cycle_number',1,
        'assignment_id',NULL::uuid,
        'event_id',NULL::uuid,
        'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object(
            'finding_id',p_finding_id,
            'status','REMOVED',
            'removed_at',v_occurred_at,
            'removed_by',v_actor_id,
            'updated_at',v_occurred_at,
            'updated_by',v_actor_id));

    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_finding_id, v_response);
END;
$function$;

ALTER FUNCTION inventarios.remove_inventory_campaign_supplemental_finding(uuid, uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.remove_inventory_campaign_supplemental_finding(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.remove_inventory_campaign_supplemental_finding(uuid, uuid, uuid) TO authenticated, service_role;

-- ============================================================================
-- 8. LISTAR HALLAZGOS DRAFT (clasificación dinámica)
-- ============================================================================
CREATE OR REPLACE FUNCTION inventarios.list_inventory_campaign_supplemental_findings(
    p_company_id uuid,
    p_campaign_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_campaign_status text;
    v_results jsonb;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_supplemental_findings_super_user(p_company_id);

    SELECT ic.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id;
    IF v_campaign_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario no existe.','retryable',false)::text;
    END IF;

    WITH d AS (
        SELECT
            f.id,
            f.company_id,
            f.campaign_id,
            f.inventory_site_id,
            f.inventory_site_location_id,
            f.product_id,
            p.bsale_variant_id AS bsale_variant_id,
            p.sku AS sku,
            p.barcode AS barcode,
            coalesce(
                NULLIF(pg_catalog.btrim(p.description), ''),
                NULLIF(pg_catalog.btrim(p.short_description), ''),
                NULLIF(pg_catalog.btrim(p.sku), ''),
                'Producto sin descripción') AS name,
            f.quantity,
            f.status,
            f.created_at,
            f.created_by,
            f.updated_at,
            f.updated_by,
            is2.code AS site_code,
            is2.name AS site_name,
            isl.code AS location_code,
            isl.name AS location_name
        FROM inventarios.inventory_campaign_supplemental_findings f
        JOIN inventarios.inventory_sites is2
          ON is2.company_id = f.company_id AND is2.id = f.inventory_site_id
        JOIN inventarios.inventory_site_locations isl
          ON isl.company_id = f.company_id AND isl.inventory_site_id = f.inventory_site_id
         AND isl.id = f.inventory_site_location_id
        LEFT JOIN adquisiciones.products p
          ON p.company_id = f.company_id AND p.id = f.product_id
        WHERE f.company_id = p_company_id AND f.campaign_id = p_campaign_id
          AND f.status = 'DRAFT'
    )
    SELECT coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'finding_id', d.id,
            'campaign_id', d.campaign_id,
            'inventory_site_id', d.inventory_site_id,
            'site_code', d.site_code,
            'site_name', d.site_name,
            'inventory_site_location_id', d.inventory_site_location_id,
            'location_code', d.location_code,
            'location_name', d.location_name,
            'product_id', d.product_id,
            'bsale_variant_id', d.bsale_variant_id,
            'sku', d.sku,
            'barcode', d.barcode,
            'name', d.name,
            'quantity', d.quantity,
            'status', d.status,
            'classification', c.classification,
            'in_canonical_theoretical', c.in_canonical_theoretical,
            'in_normal_snapshot', c.in_normal_snapshot,
            'can_consolidate', c.can_consolidate,
            'created_at', d.created_at,
            'created_by', d.created_by,
            'updated_at', d.updated_at,
            'updated_by', d.updated_by
        ) ORDER BY d.created_at, d.id
    ), '[]'::jsonb)
    INTO v_results
    FROM d
    CROSS JOIN LATERAL inventarios.classify_supplemental_finding(
        d.company_id, d.campaign_id, d.product_id, d.bsale_variant_id) c;

    RETURN v_results;
END;
$function$;

ALTER FUNCTION inventarios.list_inventory_campaign_supplemental_findings(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.list_inventory_campaign_supplemental_findings(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.list_inventory_campaign_supplemental_findings(uuid, uuid) TO authenticated, service_role;
