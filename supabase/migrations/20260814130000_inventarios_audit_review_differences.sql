-- =========================================================================================
-- MIGRATION: M1.5F - Revisar diferencias / Auditoria de productos con diferencia
-- =========================================================================================
-- Objetivo:
--   Permitir que un administrador revise los productos con diferencia del Informe Global
--   y asigne una tarea de auditoria a un participante apto (COUNTER activo) del Inventario.
--
-- Alcance de este bloque:
--   * Vista ERP de candidatos (solo difference_quantity <> 0) con estado de auditoria.
--   * Creacion atomica de una auditoria (varios productos, un auditor) con snapshot del
--     resultado efectivo previo y scope de ubicaciones por producto.
--   * Prevencion de auditorias activas duplicadas por producto (indice parcial unico).
--   * Contrato CIEGO para Mobile (list_my_inventory_audits) sin exponer teorico, fisico
--     previo ni diferencia.
--   * Resolucion explicita del caso theoretical > 0 / physical = 0 sin ubicacion previa:
--     scope_status = 'NO_PREVIOUS_LOCATION' (jamas se inventa una ubicacion).
--
-- NO se implementa aun: captura Mobile, recepcion del nuevo conteo, aprobacion/rechazo,
-- reemplazo del conteo anterior ni segunda ronda. Ese ciclo usara los estados definidos
-- aqui (PENDING/ASSIGNED -> IN_PROGRESS -> SUBMITTED -> APPROVED/REJECTED/CANCELLED).
--
-- Esquema afectado EXCLUSIVAMENTE: inventarios.
-- Solo DDL/DML en inventarios. Otros schemas se consultan en modo read-only.
-- =========================================================================================

BEGIN;

-- ============================================================
-- 1. MODELO DE AUDITORIA
-- ============================================================

-- 1.1 Auditoria (tarea de auditoria a nivel campana)
CREATE TABLE inventarios.inventory_audits (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    campaign_id uuid NOT NULL,
    audit_number integer NOT NULL,
    status text NOT NULL DEFAULT 'ASSIGNED',
    assigned_participant_id uuid NOT NULL,
    assigned_user_id uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    started_at timestamptz,
    submitted_at timestamptz,
    approved_at timestamptz,
    approved_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    rejected_at timestamptz,
    rejected_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    rejection_reason text,
    cancelled_at timestamptz,
    cancelled_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    cancellation_reason text,
    CONSTRAINT chk_inventarios_audits_status
        CHECK (status IN ('PENDING','ASSIGNED','IN_PROGRESS','SUBMITTED','APPROVED','REJECTED','CANCELLED')),
    CONSTRAINT chk_inventarios_audits_timestamps
        CHECK (
            (started_at IS NULL OR status <> 'PENDING')
            AND (approved_at IS NULL OR (approved_by IS NOT NULL AND status = 'APPROVED'))
            AND (rejected_at IS NULL OR (rejected_by IS NOT NULL AND status = 'REJECTED'
                 AND pg_catalog.btrim(coalesce(rejection_reason,'')) <> ''))
            AND (cancelled_at IS NULL OR (cancelled_by IS NOT NULL AND status = 'CANCELLED'))
            AND (cancellation_reason IS NULL OR pg_catalog.btrim(cancellation_reason) <> '')
        ),
    CONSTRAINT fk_inventarios_audits_campaign
        FOREIGN KEY (company_id, campaign_id)
        REFERENCES inventarios.inventory_campaigns(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_audits_participant
        FOREIGN KEY (assigned_participant_id)
        REFERENCES inventarios.inventory_campaign_participants(id)
        ON DELETE RESTRICT
);

COMMENT ON TABLE inventarios.inventory_audits IS
    'Tarea de auditoria de productos con diferencia a nivel campana. Una auditoria tiene un unico auditor asignado y puede cubrir varios productos.';

CREATE UNIQUE INDEX uq_inventarios_audits_company_number
    ON inventarios.inventory_audits (company_id, campaign_id, audit_number);

CREATE INDEX idx_inventarios_audits_campaign
    ON inventarios.inventory_audits (company_id, campaign_id, status);

CREATE INDEX idx_inventarios_audits_assignee
    ON inventarios.inventory_audits (assigned_user_id, status);

ALTER TABLE inventarios.inventory_audits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inventarios.inventory_audits FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE inventarios.inventory_audits TO service_role;

-- 1.2 Producto en auditoria (snapshot del resultado efectivo previo + scope)
CREATE TABLE inventarios.inventory_audit_products (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    campaign_id uuid NOT NULL,
    audit_id uuid NOT NULL,
    bsale_variant_id integer NOT NULL,
    product_id uuid REFERENCES adquisiciones.products(id) ON DELETE RESTRICT,
    sku text,
    name text,
    barcode text,
    -- Snapshot del resultado efectivo EXISTENTE al momento de asignar la auditoria.
    -- Es trazabilidad administrativa; NUNCA se entrega al contrato ciego de Mobile.
    theoretical_quantity numeric(14,3) NOT NULL DEFAULT 0,
    physical_quantity numeric(14,3) NOT NULL DEFAULT 0,
    difference_quantity numeric(14,3) NOT NULL DEFAULT 0,
    variance_status text NOT NULL,
    unit_cost numeric(14,3),
    difference_value numeric(14,3),
    -- Resolucion explicita del alcance de ubicaciones del producto.
    -- LOCATIONS_RESOLVED   -> hay ubicaciones concretas para recorrer (conteos previos o
    --                         stock teorico por ubicacion BY_LOCATION).
    -- NO_PREVIOUS_LOCATION -> theoretical > 0 y physical = 0 sin occurrence anterior ni
    --                         teorico por ubicacion fiable. No se fabrica ubicacion.
    scope_status text NOT NULL DEFAULT 'LOCATIONS_RESOLVED',
    status text NOT NULL DEFAULT 'ASSIGNED',
    CONSTRAINT chk_inventarios_audit_products_variance
        CHECK (variance_status IN ('FALTANTE','SOBRANTE','SIN_DIFERENCIA')),
    CONSTRAINT chk_inventarios_audit_products_scope
        CHECK (scope_status IN ('LOCATIONS_RESOLVED','NO_PREVIOUS_LOCATION')),
    CONSTRAINT chk_inventarios_audit_products_status
        CHECK (status IN ('PENDING','ASSIGNED','IN_PROGRESS','SUBMITTED','APPROVED','REJECTED','CANCELLED')),
    CONSTRAINT fk_inventarios_audit_products_audit
        FOREIGN KEY (audit_id)
        REFERENCES inventarios.inventory_audits(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_inventarios_audit_products_campaign
        FOREIGN KEY (company_id, campaign_id)
        REFERENCES inventarios.inventory_campaigns(company_id, id)
        ON DELETE RESTRICT
);

COMMENT ON TABLE inventarios.inventory_audit_products IS
    'Producto cubierto por una auditoria con snapshot del resultado efectivo previo (teorico, fisico y diferencia al momento de asignar) y el estado de alcance de ubicaciones.';

-- Prevencion de auditorias activas duplicadas por producto y campana a nivel base de datos.
-- Un producto solo puede tener una auditoria activa (PENDING/ASSIGNED/IN_PROGRESS/SUBMITTED).
-- Al cerrar la auditoria (APPROVED/REJECTED/CANCELLED) el status del producto pasa a un
-- estado terminal y la fila deja de ocupar el indice, habilitando una futura ronda.
CREATE UNIQUE INDEX uq_inventarios_audit_products_active
    ON inventarios.inventory_audit_products (company_id, campaign_id, bsale_variant_id)
    WHERE status IN ('PENDING','ASSIGNED','IN_PROGRESS','SUBMITTED');

CREATE INDEX idx_inventarios_audit_products_audit
    ON inventarios.inventory_audit_products (audit_id);

CREATE INDEX idx_inventarios_audit_products_variant
    ON inventarios.inventory_audit_products (company_id, campaign_id, bsale_variant_id);

ALTER TABLE inventarios.inventory_audit_products ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inventarios.inventory_audit_products FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE inventarios.inventory_audit_products TO service_role;

-- 1.3 Ubicaciones dentro del alcance de un producto auditado
CREATE TABLE inventarios.inventory_audit_locations (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    audit_id uuid NOT NULL,
    audit_product_id uuid NOT NULL,
    session_id uuid,
    snapshot_location_id uuid,
    location_id uuid REFERENCES logistica.locations(id) ON DELETE RESTRICT,
    location_code text,
    location_name text,
    CONSTRAINT fk_inventarios_audit_locations_audit
        FOREIGN KEY (audit_id)
        REFERENCES inventarios.inventory_audits(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_inventarios_audit_locations_product
        FOREIGN KEY (audit_product_id)
        REFERENCES inventarios.inventory_audit_products(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_inventarios_audit_locations_snapshot_location
        FOREIGN KEY (snapshot_location_id)
        REFERENCES inventarios.snapshot_locations(id)
        ON DELETE RESTRICT
);

COMMENT ON TABLE inventarios.inventory_audit_locations IS
    'Ubicaciones fisicas que el auditor debe recorrer para un producto auditado. Se derivan de conteos efectivos previos o, en su defecto, del stock teorico por ubicacion (BY_LOCATION). Nunca se inventa una ubicacion.';

CREATE INDEX idx_inventarios_audit_locations_product
    ON inventarios.inventory_audit_locations (audit_product_id);

CREATE INDEX idx_inventarios_audit_locations_audit
    ON inventarios.inventory_audit_locations (audit_id);

ALTER TABLE inventarios.inventory_audit_locations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inventarios.inventory_audit_locations FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE inventarios.inventory_audit_locations TO service_role;

-- ============================================================
-- 2. HELPER: SNAPSHOT EFECTIVO DEL CAMPAIGN (solo lectura)
--    Replica EXACTAMENTE la semantica de list_inventory_campaign_variances
--    (mismas fuentes: get_effective_task_contributions / official_version_items),
--    para que la auditoria trabaje sobre el mismo resultado efectivo del Informe
--    Global y para garantizar el criterio "crear la tarea NO modifica el fisico efectivo".
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios._inventarios_campaign_effective_snapshot(
    p_company_id uuid,
    p_campaign_id uuid
)
RETURNS TABLE (
    bsale_variant_id integer,
    product_id uuid,
    sku text,
    name text,
    in_theoretical_stock boolean,
    in_any_snapshot boolean,
    theoretical_quantity numeric,
    physical_quantity numeric,
    contribution_count bigint,
    unit_cost numeric,
    difference_quantity numeric,
    variance_status text,
    coverage_status text
)
LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
WITH campaign_status AS (
    SELECT status FROM inventarios.inventory_campaigns
    WHERE company_id = p_company_id AND id = p_campaign_id
    LIMIT 1
),
campaign_sessions AS (
    SELECT s.id AS session_id
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id
),
campaign_tasks AS (
    SELECT t.id AS task_id, t.session_id
    FROM inventarios.tasks t
    JOIN campaign_sessions cs ON cs.session_id = t.session_id
    WHERE t.cancelled_at IS NULL AND t.superseded_at IS NULL
),
physical AS (
    SELECT ovi.bsale_variant_id,
           pg_catalog.sum(ovi.physical_quantity) AS physical_quantity,
           pg_catalog.count(*) AS contribution_count
    FROM inventarios.official_version_items ovi
    JOIN inventarios.sessions s ON s.company_id = ovi.company_id AND s.id = ovi.session_id
    WHERE ovi.company_id = p_company_id AND s.campaign_id = p_campaign_id
      AND s.status = 'APPROVED' AND (SELECT status FROM campaign_status) = 'APPROVED'
    GROUP BY ovi.bsale_variant_id
    UNION ALL
    SELECT ce.bsale_variant_id,
           pg_catalog.sum(ce.physical_quantity) AS physical_quantity,
           pg_catalog.count(*) AS contribution_count
    FROM campaign_tasks ct
    CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id) g
    JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
    WHERE ce.bsale_variant_id IS NOT NULL
      AND coalesce((SELECT status FROM campaign_status), '') <> 'APPROVED'
    GROUP BY ce.bsale_variant_id
),
snapshot_coverage AS (
    SELECT DISTINCT sp.bsale_variant_id
    FROM inventarios.snapshot_products sp
    JOIN inventarios.operational_snapshots os ON os.id = sp.snapshot_id AND os.company_id = sp.company_id
    JOIN campaign_sessions cs ON cs.session_id = os.session_id
    WHERE sp.bsale_variant_id IS NOT NULL
),
theoretical AS (
    SELECT csp.bsale_variant_id, csp.product_id, csp.sku, csp.name,
           icts.theoretical_quantity, icts.unit_cost
    FROM inventarios.inventory_campaign_theoretical_stocks icts
    JOIN inventarios.inventory_campaign_snapshots cs
      ON cs.company_id = icts.company_id AND cs.id = icts.campaign_snapshot_id
     AND cs.campaign_id = p_campaign_id
    JOIN inventarios.inventory_campaign_snapshot_products csp
      ON csp.company_id = icts.company_id
     AND csp.campaign_snapshot_id = icts.campaign_snapshot_id
     AND csp.id = icts.snapshot_product_id
    WHERE icts.company_id = p_company_id
      AND icts.scope_level = 'TOTAL_CAMPAIGN'
),
base AS (
    SELECT t.bsale_variant_id, t.product_id, t.sku, t.name,
           true AS in_theoretical_stock, t.theoretical_quantity, t.unit_cost
    FROM theoretical t
    UNION ALL
    SELECT ph.bsale_variant_id,
           sv.snapshot_product_id, sv.snapshot_sku, sv.snapshot_name,
           false, 0::numeric, NULL::numeric
    FROM physical ph
    LEFT JOIN LATERAL (
        SELECT sp.product_id AS snapshot_product_id, sp.sku AS snapshot_sku,
               coalesce(NULLIF(inventarios.campaign_product_display_name(sp.bsale_variant_id), ''), sp.name) AS snapshot_name
        FROM inventarios.snapshot_products sp
        WHERE sp.bsale_variant_id = ph.bsale_variant_id
        ORDER BY sp.sku NULLS LAST
        LIMIT 1
    ) sv ON true
    WHERE NOT EXISTS (SELECT 1 FROM theoretical t2 WHERE t2.bsale_variant_id = ph.bsale_variant_id)
),
dataset AS (
    SELECT b.bsale_variant_id, b.product_id, b.sku, b.name, b.in_theoretical_stock,
           coalesce(b.theoretical_quantity, 0) AS theoretical_quantity,
           coalesce(ph.physical_quantity, 0) AS physical_quantity,
           coalesce(ph.contribution_count, 0) AS contribution_count,
           (EXISTS (SELECT 1 FROM snapshot_coverage sc2 WHERE sc2.bsale_variant_id = b.bsale_variant_id)) AS in_any_snapshot,
           b.unit_cost
    FROM base b
    LEFT JOIN physical ph ON ph.bsale_variant_id = b.bsale_variant_id
)
SELECT d.bsale_variant_id,
       d.product_id,
       d.sku,
       d.name,
       d.in_theoretical_stock,
       d.in_any_snapshot,
       d.theoretical_quantity,
       d.physical_quantity,
       d.contribution_count,
       d.unit_cost,
       (d.physical_quantity - d.theoretical_quantity) AS difference_quantity,
       CASE
           WHEN (d.physical_quantity - d.theoretical_quantity) < 0 THEN 'FALTANTE'
           WHEN (d.physical_quantity - d.theoretical_quantity) > 0 THEN 'SOBRANTE'
           ELSE 'SIN_DIFERENCIA'
       END AS variance_status,
       CASE
           WHEN d.physical_quantity > 0 THEN 'COUNTED'
           WHEN d.in_any_snapshot THEN 'NOT_COUNTED'
           ELSE 'OUT_OF_SNAPSHOT'
       END AS coverage_status
FROM dataset d;
$function$;

ALTER FUNCTION inventarios._inventarios_campaign_effective_snapshot(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios._inventarios_campaign_effective_snapshot(uuid, uuid)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios._inventarios_campaign_effective_snapshot(uuid, uuid) TO authenticated, service_role;

-- ============================================================
-- 3. RPC: CANDIDATOS A AUDITORIA (Informe de diferencias para revision)
--    Solo productos con difference_quantity <> 0, con estado de auditoria por producto
--    y resumen de auditorias activas.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.list_inventory_audit_candidates(
    p_company_id uuid,
    p_campaign_id uuid,
    p_search text DEFAULT NULL,
    p_variance_status text DEFAULT NULL,
    p_page integer DEFAULT 1,
    p_page_size integer DEFAULT 50,
    p_sort_by text DEFAULT NULL,
    p_sort_direction text DEFAULT 'ASC'
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_campaign_status text;
    v_search text;
    v_var text;
    v_sort_by text;
    v_sort_dir text;
    v_page integer;
    v_page_size integer;
    v_offset integer;
    v_total bigint := 0;
    v_faltantes bigint := 0;
    v_sobrantes bigint := 0;
    v_audited bigint := 0;
    v_items jsonb;
    v_audits jsonb;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');

    SELECT ic.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id;
    IF v_campaign_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario no existe.','retryable',false)::text;
    END IF;

    v_search := pg_catalog.btrim(coalesce(p_search, ''));
    v_var := pg_catalog.upper(pg_catalog.btrim(coalesce(p_variance_status, '')));
    IF v_var <> '' AND v_var NOT IN ('FALTANTE','SOBRANTE') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_sort_by := pg_catalog.upper(pg_catalog.btrim(coalesce(p_sort_by, 'SKU')));
    IF v_sort_by <> '' AND v_sort_by NOT IN ('SKU','NAME','VARIANCE_STATUS','THEORETICAL','PHYSICAL','DIFFERENCE') THEN
        v_sort_by := 'SKU';
    END IF;
    v_sort_dir := pg_catalog.upper(pg_catalog.btrim(coalesce(p_sort_direction, 'ASC')));
    IF v_sort_dir NOT IN ('ASC','DESC') THEN v_sort_dir := 'ASC'; END IF;
    v_page := coalesce(p_page, 1);
    v_page_size := coalesce(p_page_size, 50);
    IF v_page < 1 THEN v_page := 1; END IF;
    IF v_page_size < 1 THEN v_page_size := 50; END IF;
    IF v_page_size > 100 THEN v_page_size := 100; END IF;
    v_offset := (v_page - 1) * v_page_size;

    -- Dataset efectivo filtrado (diferencias <> 0) en tabla temporal para paginar
    -- y resumir sobre una sola evaluacion del snapshot efectivo.
    DROP TABLE IF EXISTS _inventarios_audit_candidates;
    CREATE TEMP TABLE _inventarios_audit_candidates ON COMMIT DROP AS
    SELECT d.bsale_variant_id, d.product_id, d.sku, d.name,
           d.in_theoretical_stock, d.theoretical_quantity, d.physical_quantity,
           d.contribution_count, d.unit_cost, d.difference_quantity,
           d.variance_status, d.coverage_status
    FROM inventarios._inventarios_campaign_effective_snapshot(p_company_id, p_campaign_id) d
    WHERE d.difference_quantity <> 0
      AND (v_search = '' OR d.sku ILIKE '%' || v_search || '%' OR d.name ILIKE '%' || v_search || '%')
      AND (v_var = '' OR d.variance_status = v_var);

    SELECT pg_catalog.count(*),
           pg_catalog.count(*) FILTER (WHERE variance_status = 'FALTANTE'),
           pg_catalog.count(*) FILTER (WHERE variance_status = 'SOBRANTE')
    INTO v_total, v_faltantes, v_sobrantes
    FROM _inventarios_audit_candidates;

    -- Cantidad de productos con auditoria activa dentro del set candidato.
    SELECT pg_catalog.count(*)
    INTO v_audited
    FROM _inventarios_audit_candidates c
    WHERE EXISTS (
        SELECT 1
        FROM inventarios.inventory_audit_products ap
        JOIN inventarios.inventory_audits a ON a.id = ap.audit_id
        WHERE ap.company_id = p_company_id AND ap.campaign_id = p_campaign_id
          AND ap.bsale_variant_id = c.bsale_variant_id
          AND a.status IN ('PENDING','ASSIGNED','IN_PROGRESS','SUBMITTED')
    );

    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'product_key', c.bsale_variant_id::text,
                'bsale_variant_id', c.bsale_variant_id,
                'product_id', c.product_id,
                'sku', c.sku,
                'name', c.name,
                'theoretical_quantity', c.theoretical_quantity,
                'physical_quantity', c.physical_quantity,
                'difference_quantity', c.difference_quantity,
                'unit_cost', c.unit_cost,
                'difference_value', coalesce(c.difference_quantity, 0::numeric) * coalesce(c.unit_cost, 0::numeric),
                'variance_status', c.variance_status,
                'coverage_status', c.coverage_status,
                'audit_id', aud.audit_id,
                'audit_number', aud.audit_number,
                'audit_status', aud.audit_status,
                'auditor_user_id', aud.auditor_user_id,
                'auditor_name', aud.auditor_name,
                'selectable', (aud.audit_id IS NULL)
            ) ORDER BY
                CASE WHEN v_sort_dir = 'ASC' AND v_sort_by = 'SKU' THEN c.sku END ASC NULLS LAST,
                CASE WHEN v_sort_dir = 'DESC' AND v_sort_by = 'SKU' THEN c.sku END DESC NULLS LAST,
                CASE WHEN v_sort_dir = 'ASC' AND v_sort_by = 'NAME' THEN c.name END ASC NULLS LAST,
                CASE WHEN v_sort_dir = 'DESC' AND v_sort_by = 'NAME' THEN c.name END DESC NULLS LAST,
                CASE WHEN v_sort_dir = 'ASC' AND v_sort_by = 'VARIANCE_STATUS' THEN c.variance_status END ASC NULLS LAST,
                CASE WHEN v_sort_dir = 'DESC' AND v_sort_by = 'VARIANCE_STATUS' THEN c.variance_status END DESC NULLS LAST,
                CASE WHEN v_sort_dir = 'ASC' AND v_sort_by = 'THEORETICAL' THEN c.theoretical_quantity END ASC NULLS LAST,
                CASE WHEN v_sort_dir = 'DESC' AND v_sort_by = 'THEORETICAL' THEN c.theoretical_quantity END DESC NULLS LAST,
                CASE WHEN v_sort_dir = 'ASC' AND v_sort_by = 'PHYSICAL' THEN c.physical_quantity END ASC NULLS LAST,
                CASE WHEN v_sort_dir = 'DESC' AND v_sort_by = 'PHYSICAL' THEN c.physical_quantity END DESC NULLS LAST,
                CASE WHEN v_sort_dir = 'ASC' AND v_sort_by = 'DIFFERENCE' THEN c.difference_quantity END ASC NULLS LAST,
                CASE WHEN v_sort_dir = 'DESC' AND v_sort_by = 'DIFFERENCE' THEN c.difference_quantity END DESC NULLS LAST,
                c.sku, c.bsale_variant_id
        )
    END
    INTO v_items
    FROM _inventarios_audit_candidates c
    LEFT JOIN LATERAL (
        SELECT a.id AS audit_id, a.audit_number, a.status AS audit_status,
               a.assigned_user_id AS auditor_user_id, pu.nombre AS auditor_name
        FROM inventarios.inventory_audit_products ap2
        JOIN inventarios.inventory_audits a ON a.id = ap2.audit_id
        LEFT JOIN portal.users pu ON pu.id = a.assigned_user_id
        WHERE ap2.company_id = p_company_id AND ap2.campaign_id = p_campaign_id
          AND ap2.bsale_variant_id = c.bsale_variant_id
          AND a.status IN ('PENDING','ASSIGNED','IN_PROGRESS','SUBMITTED')
        LIMIT 1
    ) aud ON true
    LIMIT v_page_size OFFSET v_offset;

    -- Resumen de auditorias activas de la campana (para la pantalla ERP).
    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'audit_id', a.id,
                'audit_number', a.audit_number,
                'status', a.status,
                'assigned_user_id', a.assigned_user_id,
                'auditor_name', pu.nombre,
                'product_count', (SELECT pg_catalog.count(*) FROM inventarios.inventory_audit_products ap WHERE ap.audit_id = a.id),
                'location_count', (SELECT pg_catalog.count(*) FROM inventarios.inventory_audit_locations l WHERE l.audit_id = a.id),
                'created_at', a.created_at,
                'created_by', a.created_by
            ) ORDER BY a.audit_number
        )
    END
    INTO v_audits
    FROM inventarios.inventory_audits a
    LEFT JOIN portal.users pu ON pu.id = a.assigned_user_id
    WHERE a.company_id = p_company_id AND a.campaign_id = p_campaign_id
      AND a.status IN ('PENDING','ASSIGNED','IN_PROGRESS','SUBMITTED');

    RETURN pg_catalog.jsonb_build_object(
        'campaign_id', p_campaign_id,
        'campaign_status', v_campaign_status,
        'summary', pg_catalog.jsonb_build_object(
            'total_differences', v_total,
            'faltantes', v_faltantes,
            'sobrantes', v_sobrantes,
            'audited_products', v_audited
        ),
        'total', v_total,
        'page', v_page,
        'page_size', v_page_size,
        'has_more', v_offset + pg_catalog.jsonb_array_length(CASE WHEN v_items IS NULL THEN '[]'::jsonb ELSE v_items END) < v_total,
        'items', CASE WHEN v_items IS NULL THEN '[]'::jsonb ELSE v_items END,
        'active_audits', coalesce(v_audits, '[]'::jsonb)
    );
END;
$function$;

ALTER FUNCTION inventarios.list_inventory_audit_candidates(uuid, uuid, text, text, integer, integer, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.list_inventory_audit_candidates(uuid, uuid, text, text, integer, integer, text, text)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.list_inventory_audit_candidates(uuid, uuid, text, text, integer, integer, text, text) TO authenticated, service_role;

-- ============================================================
-- 4. RPC: PARTICIPANTES APTOS PARA AUDITORIA
--    Participantes ACTIVOS del Inventario aptos para realizar conteo fisico.
--    Alineado con las reglas operativas actuales de asignacion/conteo:
--    assign_inventory_counting_zone y assign_inventory_recount exigen COUNTER activo.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.list_inventory_audit_eligible_participants(
    p_company_id uuid,
    p_campaign_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_participants jsonb;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');

    IF NOT EXISTS (
        SELECT 1 FROM inventarios.inventory_campaigns c
        WHERE c.company_id = p_company_id AND c.id = p_campaign_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;

    SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'participant_id', p.id,
            'user_id', p.user_id,
            'user_name', u.nombre,
            'email', u.email,
            'participant_role', p.participant_role,
            'active_from', p.active_from,
            'created_by', p.created_by
        )
        ORDER BY u.nombre, p.user_id
    )
    INTO v_participants
    FROM inventarios.inventory_campaign_participants p
    LEFT JOIN portal.users u ON u.id = p.user_id
    WHERE p.company_id = p_company_id
      AND p.campaign_id = p_campaign_id
      AND p.participant_role = 'COUNTER'
      AND p.revoked_at IS NULL
      AND p.active_from <= pg_catalog.now()
      AND (u.is_active IS NOT NULL AND u.is_active = true)
      AND u.deleted_at IS NULL;

    RETURN pg_catalog.jsonb_build_object(
        'campaign_id', p_campaign_id,
        'participants', coalesce(v_participants, '[]'::jsonb)
    );
END;
$function$;

ALTER FUNCTION inventarios.list_inventory_audit_eligible_participants(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.list_inventory_audit_eligible_participants(uuid, uuid)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.list_inventory_audit_eligible_participants(uuid, uuid) TO authenticated, service_role;

-- ============================================================
-- 5. RPC: CREAR AUDITORIA
--    Crea UNA auditoria (un auditor) con N productos. Por cada producto:
--      - valida diferencia <> 0 en el resultado efectivo actual;
--      - valida que NO exista una auditoria activa del producto;
--      - persiste el snapshot del resultado previo (trazabilidad);
--      - resuelve y persiste el alcance de ubicaciones;
--      - distingue de forma segura el caso physical = 0 sin ubicacion previa
--        (scope_status = 'NO_PREVIOUS_LOCATION').
--    No modifica count_entries ni el resultado efectivo.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.create_inventory_audit(
    p_company_id uuid,
    p_campaign_id uuid,
    p_assigned_participant_id uuid,
    p_bsale_variant_ids bigint[],
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_operation jsonb;
    v_operation_id uuid;
    v_campaign_status text;
    v_participant_user_id uuid;
    v_participant_ok boolean;
    v_audit_number integer;
    v_audit_id uuid;
    v_payload jsonb;
    v_variant bigint;
    v_product_id uuid;
    v_sku text;
    v_name text;
    v_barcode text;
    v_theo numeric;
    v_phys numeric;
    v_diff numeric;
    v_unit_cost numeric;
    v_var text;
    v_scope_status text;
    v_audit_product_id uuid;
    v_location_count integer;
    v_products jsonb := '[]'::jsonb;
    v_product_meta jsonb;
    v_has_locations boolean;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL
       OR p_assigned_participant_id IS NULL OR p_idempotency_key IS NULL
       OR p_bsale_variant_ids IS NULL OR pg_catalog.array_length(p_bsale_variant_ids, 1) = 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.manage');

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('inventarios.create_inventory_audit.idempotency'), pg_catalog.hashtext(p_company_id::text || ':' || p_idempotency_key::text));
    v_payload := pg_catalog.jsonb_build_object('operation','inventarios.audit.create','company_id',p_company_id,'campaign_id',p_campaign_id,'assigned_participant_id',p_assigned_participant_id,'bsale_variant_ids',p_bsale_variant_ids);
    v_operation := inventarios.begin_idempotent_operation(p_company_id,'inventarios.audit.create',p_idempotency_key,inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    -- Serializa la creacion por campana (protege audit_number y la unicidad de auditorias activas).
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('inventarios.create_inventory_audit'), pg_catalog.hashtext(p_company_id::text || ':' || p_campaign_id::text));

    SELECT ic.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id
    FOR UPDATE;
    IF v_campaign_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario no existe.','retryable',false)::text;
    END IF;
    IF v_campaign_status = 'CANCELLED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_CANCELLED',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario esta cancelado y no admite nuevas auditorias.','retryable',false)::text;
    END IF;

    -- Participante apto: COUNTER activo de la campana (regla de conteo operativa actual).
    SELECT p.user_id INTO v_participant_user_id
    FROM inventarios.inventory_campaign_participants p
    LEFT JOIN portal.users u ON u.id = p.user_id
    WHERE p.company_id = p_company_id
      AND p.campaign_id = p_campaign_id
      AND p.id = p_assigned_participant_id
      AND p.participant_role = 'COUNTER'
      AND p.revoked_at IS NULL
      AND p.active_from <= pg_catalog.now()
      AND (u.is_active IS NOT NULL AND u.is_active = true)
      AND u.deleted_at IS NULL
    FOR SHARE;
    IF v_participant_user_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_PARTICIPANT_NOT_ELIGIBLE',
            DETAIL=pg_catalog.jsonb_build_object('message','El participante seleccionado no esta activo o no es apto para realizar el conteo.','retryable',false)::text;
    END IF;

    -- Numero de auditoria correlativo por campana.
    SELECT coalesce(pg_catalog.max(audit_number), 0) + 1
    INTO v_audit_number
    FROM inventarios.inventory_audits
    WHERE company_id = p_company_id AND campaign_id = p_campaign_id;

    -- Prevencion de auditorias activas duplicadas: ningun producto del conjunto puede
    -- tener una auditoria activa (PENDING/ASSIGNED/IN_PROGRESS/SUBMITTED).
    -- El indice parcial unico uq_inventarios_audit_products_active queda como respaldo
    -- ante concurrencia, pero el error de negocio comprensible se emite aqui.
    SELECT ap.bsale_variant_id
    INTO v_variant
    FROM inventarios.inventory_audit_products ap
    JOIN inventarios.inventory_audits a ON a.id = ap.audit_id
    WHERE ap.company_id = p_company_id AND ap.campaign_id = p_campaign_id
      AND ap.bsale_variant_id = ANY(p_bsale_variant_ids)
      AND a.status IN ('PENDING','ASSIGNED','IN_PROGRESS','SUBMITTED')
    LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_PRODUCT_ALREADY_ASSIGNED',
            DETAIL=pg_catalog.jsonb_build_object('message','Uno de los productos seleccionados ya tiene una auditoria activa.','retryable',false,'bsale_variant_id',v_variant)::text;
    END IF;

    INSERT INTO inventarios.inventory_audits (
        company_id, campaign_id, audit_number, status,
        assigned_participant_id, assigned_user_id, created_by
    )
    VALUES (
        p_company_id, p_campaign_id, v_audit_number, 'ASSIGNED',
        p_assigned_participant_id, v_participant_user_id, v_actor_id
    )
    RETURNING id INTO v_audit_id;

    -- Por cada producto seleccionado.
    FOR v_variant IN SELECT DISTINCT v FROM pg_catalog.unnest(p_bsale_variant_ids) AS t(v) LOOP
        SELECT d.product_id, d.sku, d.name, d.theoretical_quantity, d.physical_quantity,
               d.difference_quantity, d.unit_cost, d.variance_status
        INTO v_product_id, v_sku, v_name, v_theo, v_phys, v_diff, v_unit_cost, v_var
        FROM inventarios._inventarios_campaign_effective_snapshot(p_company_id, p_campaign_id) d
        WHERE d.bsale_variant_id = v_variant::integer;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_PRODUCT_NOT_FOUND',
                DETAIL=pg_catalog.jsonb_build_object('message','Uno de los productos seleccionados no existe en el resultado del inventario.','retryable',false,'bsale_variant_id',v_variant)::text;
        END IF;
        IF v_diff = 0 THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_PRODUCT_NO_DIFFERENCE',
                DETAIL=pg_catalog.jsonb_build_object('message','Uno de los productos seleccionados no tiene diferencia y no puede auditarse.','retryable',false,'bsale_variant_id',v_variant)::text;
        END IF;

        -- Barcode congelado del snapshot de campana para resolucion Mobile.
        SELECT csp.barcode INTO v_barcode
        FROM inventarios.inventory_campaign_snapshot_products csp
        JOIN inventarios.inventory_campaign_snapshots cs
          ON cs.id = csp.campaign_snapshot_id AND cs.company_id = csp.company_id
         AND cs.campaign_id = p_campaign_id
        WHERE csp.company_id = p_company_id AND csp.bsale_variant_id = v_variant::integer
        LIMIT 1;

        INSERT INTO inventarios.inventory_audit_products (
            company_id, campaign_id, audit_id, bsale_variant_id, product_id, sku, name, barcode,
            theoretical_quantity, physical_quantity, difference_quantity, variance_status,
            unit_cost, difference_value, scope_status, status
        )
        VALUES (
            p_company_id, p_campaign_id, v_audit_id, v_variant::integer, v_product_id, v_sku, v_name, v_barcode,
            v_theo, v_phys, v_diff, v_var, v_unit_cost,
            coalesce(v_diff, 0::numeric) * coalesce(v_unit_cost, 0::numeric),
            'LOCATIONS_RESOLVED', 'ASSIGNED'
        )
        RETURNING id INTO v_audit_product_id;

        -- Alcance de ubicaciones: 1) conteos efectivos previos del producto.
        WITH campaign_tasks AS (
            SELECT t.id AS task_id, t.session_id
            FROM inventarios.tasks t
            JOIN inventarios.sessions s ON s.company_id = t.company_id AND s.id = t.session_id
            WHERE t.company_id = p_company_id AND s.campaign_id = p_campaign_id
              AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
        ),
        counted_locs AS (
            SELECT DISTINCT ce.snapshot_location_id, ce.session_id
            FROM campaign_tasks ct
            CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id) g
            JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
            WHERE ce.bsale_variant_id = v_variant::integer AND ce.snapshot_location_id IS NOT NULL
        )
        INSERT INTO inventarios.inventory_audit_locations (
            company_id, audit_id, audit_product_id, session_id, snapshot_location_id,
            location_id, location_code, location_name
        )
        SELECT p_company_id, v_audit_id, v_audit_product_id,
               cl.session_id, cl.snapshot_location_id,
               sl.location_id, sl.code, sl.name
        FROM counted_locs cl
        JOIN inventarios.snapshot_locations sl
          ON sl.company_id = p_company_id AND sl.id = cl.snapshot_location_id;

        GET DIAGNOSTICS v_location_count = ROW_COUNT;

        -- 2) Si no hay conteos previos: stock teorico por ubicacion (BY_LOCATION) del snapshot.
        IF v_location_count = 0 THEN
            WITH theoretical_locs AS (
                SELECT DISTINCT isl.source_logistics_location_id AS location_id,
                       isl.code AS location_code, isl.name AS location_name
                FROM inventarios.inventory_campaign_theoretical_stocks icts
                JOIN inventarios.inventory_campaign_snapshots cs
                  ON cs.id = icts.campaign_snapshot_id AND cs.company_id = icts.company_id
                 AND cs.campaign_id = p_campaign_id
                JOIN inventarios.inventory_campaign_snapshot_products csp
                  ON csp.id = icts.snapshot_product_id AND csp.company_id = icts.company_id
                 AND csp.bsale_variant_id = v_variant::integer
                JOIN inventarios.inventory_site_locations isl
                  ON isl.id = icts.inventory_site_location_id AND isl.company_id = icts.company_id
                WHERE icts.company_id = p_company_id
                  AND icts.scope_level = 'BY_LOCATION'
                  AND icts.theoretical_quantity > 0
            )
            INSERT INTO inventarios.inventory_audit_locations (
                company_id, audit_id, audit_product_id, session_id, snapshot_location_id,
                location_id, location_code, location_name
            )
            SELECT p_company_id, v_audit_id, v_audit_product_id,
                   NULL::uuid, NULL::uuid,
                   tl.location_id, tl.location_code, tl.location_name
            FROM theoretical_locs tl;

            GET DIAGNOSTICS v_location_count = ROW_COUNT;
        END IF;

        -- 3) Sin ubicacion previa fiable: estado contractual seguro, sin fabricar datos.
        IF v_location_count = 0 THEN
            UPDATE inventarios.inventory_audit_products
            SET scope_status = 'NO_PREVIOUS_LOCATION'
            WHERE id = v_audit_product_id;
            v_scope_status := 'NO_PREVIOUS_LOCATION';
        ELSE
            v_scope_status := 'LOCATIONS_RESOLVED';
        END IF;

        v_product_meta := pg_catalog.jsonb_build_object(
            'bsale_variant_id', v_variant,
            'variance_status', v_var,
            'difference_quantity', v_diff,
            'scope_status', v_scope_status,
            'location_count', v_location_count
        );
        v_products := v_products || v_product_meta;
    END LOOP;

    RETURN inventarios.complete_idempotent_operation(
        p_company_id,
        v_operation_id,
        v_audit_id,
        pg_catalog.jsonb_build_object(
            'operation','inventarios.audit.create',
            'entity_id', v_audit_id,
            'state','ASSIGNED',
            'version', NULL::integer,
            'cycle_number', NULL::integer,
            'assignment_id', NULL::uuid,
            'event_id', NULL::uuid,
            'replayed', false,
            'occurred_at', pg_catalog.now(),
            'data', pg_catalog.jsonb_build_object(
                'audit_id', v_audit_id,
                'audit_number', v_audit_number,
                'campaign_id', p_campaign_id,
                'assigned_participant_id', p_assigned_participant_id,
                'assigned_user_id', v_participant_user_id,
                'products', v_products
            )
        )
    );
END;
$function$;

ALTER FUNCTION inventarios.create_inventory_audit(uuid, uuid, uuid, bigint[], uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.create_inventory_audit(uuid, uuid, uuid, bigint[], uuid)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.create_inventory_audit(uuid, uuid, uuid, bigint[], uuid) TO authenticated, service_role;

-- ============================================================
-- 6. RPC: CONTRATO CIEGO PARA MOBILE
--    Lista las auditorias activas asignadas al usuario autenticado.
--    El payload destinado al auditor NO expone cantidad contada anteriormente,
--    diferencia anterior, stock teorico ni cantidad esperada.
--    Incluye solo lo necesario: tarea, producto, SKU, barcode y ubicaciones.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.list_my_inventory_audits()
RETURNS jsonb
LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_audits jsonb;
BEGIN
    v_actor_id := inventarios.require_actor();

    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'audit_id', t.id,
                'audit_number', t.audit_number,
                'status', t.status,
                'campaign_id', t.campaign_id,
                'campaign_name', t.campaign_name,
                'assigned_at', t.created_at,
                'product_count', t.product_count,
                'products', t.products
            ) ORDER BY t.audit_number
        )
    END
    INTO v_audits
    FROM (
        SELECT a.id, a.audit_number, a.status, a.campaign_id,
               ic.name AS campaign_name, a.created_at,
               (SELECT pg_catalog.count(*) FROM inventarios.inventory_audit_products ap WHERE ap.audit_id = a.id) AS product_count,
               (SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
                    ELSE pg_catalog.jsonb_agg(
                        pg_catalog.jsonb_build_object(
                            'audit_product_id', ap.id,
                            'bsale_variant_id', ap.bsale_variant_id,
                            'product_id', ap.product_id,
                            'sku', ap.sku,
                            'name', ap.name,
                            'barcode', ap.barcode,
                            'scope_status', ap.scope_status,
                            'locations', (SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
                                           ELSE pg_catalog.jsonb_agg(
                                                pg_catalog.jsonb_build_object(
                                                    'location_id', l.location_id,
                                                    'location_code', l.location_code,
                                                    'location_name', l.location_name
                                                )
                                           )
                                         END
                                         FROM inventarios.inventory_audit_locations l WHERE l.audit_product_id = ap.id)
                        ) ORDER BY ap.bsale_variant_id
                    )
                END
                FROM inventarios.inventory_audit_products ap WHERE ap.audit_id = a.id) AS products
        FROM inventarios.inventory_audits a
        JOIN inventarios.inventory_campaigns ic ON ic.id = a.campaign_id AND ic.company_id = a.company_id
        WHERE a.assigned_user_id = v_actor_id
          AND a.status IN ('ASSIGNED','IN_PROGRESS','SUBMITTED')
          AND EXISTS (
              SELECT 1 FROM core.user_company_access uca
              WHERE uca.user_id = v_actor_id AND uca.company_id = a.company_id AND uca.is_active = true
          )
        ORDER BY a.created_at
    ) t;

    RETURN pg_catalog.jsonb_build_object(
        'actor_user_id', v_actor_id,
        'audits', coalesce(v_audits, '[]'::jsonb)
    );
END;
$function$;

ALTER FUNCTION inventarios.list_my_inventory_audits() OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.list_my_inventory_audits() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.list_my_inventory_audits() TO authenticated, service_role;

COMMIT;
