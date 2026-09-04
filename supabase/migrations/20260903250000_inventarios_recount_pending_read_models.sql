-- Migration: 20260903250000_inventarios_recount_pending_read_models.sql
-- Hace tolerante a un recount_request en REQUESTED/ASSIGNED/IN_PROGRESS los read-models
-- de campaña/auditoría, sin romper las guardas de escritura. El reconteo pendiente deja de
-- elevar INV_RECOUNT_PENDING y simplemente no aporta como contribución efectiva.
--
-- get_applicable_recount_decisions(...) recibe p_strict (DEFAULT true). Con p_strict=false
-- omite las validaciones/RAISE (INV_RECOUNT_PENDING / INV_CONCURRENT_MODIFICATION /
-- INV_RECOUNT_COUNT_NOT_EFFECTIVE) y devuelve únicamente los reconteos prevalecientes
-- COMPLETED con decisión vigente. get_effective_task_contributions() lo propaga.
-- Los read-models de lectura pasan p_strict=false; los validadotes de escritura (validate/
-- approve/close/admin_close) siguen usando la firma de 3 args -> p_strict=true -> RAISE.
--
-- NO modifica: reject_inventory_barcode, creación/asignación de recount_requests, Mobile,
-- UI ERP, reglas de cierre, idempotencia, invalidación del count_entry, RPC de escritura de
-- recount, estados de campaña.

BEGIN;

-- Retira las firmas de 3 args para que las llamadas de escritura resuelvan a la firma de 4
-- args (p_strict default true) y mantengan el bloqueo por recount pendiente.
DROP FUNCTION IF EXISTS inventarios.get_applicable_recount_decisions(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS inventarios.get_effective_task_contributions(uuid, uuid, uuid);

-- 1. get_applicable_recount_decisions(..., p_strict boolean DEFAULT true)
CREATE OR REPLACE FUNCTION inventarios.get_applicable_recount_decisions(
    p_company_id uuid,
    p_session_id uuid,
    p_task_id uuid,
    p_strict boolean DEFAULT true
)
RETURNS TABLE (
    recount_request_id uuid,
    recount_request_ordinal integer,
    recount_decision_id uuid,
    selected_root_count_entry_id uuid,
    selected_count_entry_id uuid,
    company_id uuid,
    session_id uuid,
    snapshot_id uuid,
    session_zone_id uuid,
    snapshot_location_id uuid,
    snapshot_product_id uuid,
    source_task_id uuid,
    task_cycle integer,
    decided_at timestamptz
)
LANGUAGE plpgsql
STABLE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_status text;
    v_req_id uuid;
    v_task_id uuid;
    v_cycle integer;
    v_dec_count integer;
    v_eff_count integer;
    v_tie integer;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    PERFORM 1 FROM inventarios.sessions s WHERE s.company_id = p_company_id AND s.id = p_session_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
        DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF p_task_id IS NOT NULL THEN
        PERFORM 1 FROM inventarios.tasks t WHERE t.company_id = p_company_id AND t.session_id = p_session_id AND t.id = p_task_id;
        IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    END IF;
    IF p_strict THEN
        FOR v_status, v_req_id, v_task_id, v_cycle IN
            WITH active_tasks AS (
                SELECT t.id, t.session_zone_id, t.validation_cycle
                FROM inventarios.tasks t
                WHERE t.company_id = p_company_id AND t.session_id = p_session_id
                  AND (p_task_id IS NULL OR t.id = p_task_id)
                  AND t.cancelled_at IS NULL AND t.cancelled_by IS NULL
            ),
            eligible_requests AS (
                SELECT rr.id, rr.session_zone_id, rr.snapshot_product_id, rr.source_task_id,
                       rr.cycle_number, rr.ordinal, rr.status
                FROM inventarios.recount_requests rr
                WHERE rr.company_id = p_company_id AND rr.session_id = p_session_id
                  AND rr.cancelled_at IS NULL AND rr.cancelled_by IS NULL AND rr.cancellation_reason IS NULL
                  AND EXISTS (SELECT 1 FROM active_tasks t
                              WHERE t.id = rr.source_task_id AND t.validation_cycle = rr.cycle_number
                                AND t.session_zone_id = rr.session_zone_id)
            ),
            ranked AS (
                SELECT er.*, ROW_NUMBER() OVER (
                    PARTITION BY er.session_zone_id, er.snapshot_product_id, er.source_task_id, er.cycle_number
                    ORDER BY er.ordinal DESC
                ) AS rn
                FROM eligible_requests er
            )
            SELECT r.status, r.id, r.source_task_id, r.cycle_number
            FROM ranked r WHERE r.rn = 1
            ORDER BY r.source_task_id, r.cycle_number, r.session_zone_id, r.snapshot_product_id
        LOOP
            IF v_status IN ('REQUESTED','ASSIGNED','IN_PROGRESS') THEN
                RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_RECOUNT_PENDING',
                    DETAIL=pg_catalog.jsonb_build_object('message','Existe una solicitud de recuento pendiente.','retryable',false,'request_status',v_status)::text;
            END IF;
            IF v_status = 'COMPLETED' THEN
                SELECT count(*) INTO v_dec_count FROM inventarios.recount_decisions rd
                WHERE rd.company_id = p_company_id AND rd.recount_request_id = v_req_id AND rd.superseded_at IS NULL;
                IF v_dec_count = 0 THEN
                    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_RECOUNT_PENDING',
                        DETAIL=pg_catalog.jsonb_build_object('message','Existe una solicitud de recuento pendiente.','retryable',false,'request_status','COMPLETED','decision_status','MISSING')::text;
                END IF;
                IF v_dec_count > 1 THEN
                    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
                        DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',false)::text;
                END IF;
                SELECT count(*) INTO v_eff_count FROM (
                    SELECT rd.selected_count_entry_id
                    FROM inventarios.recount_decisions rd
                    WHERE rd.company_id = p_company_id AND rd.recount_request_id = v_req_id AND rd.superseded_at IS NULL
                      AND rd.selected_count_entry_id IN (
                          SELECT ec.effective_count_entry_id
                          FROM inventarios.get_effective_count_entries(p_company_id, p_session_id, v_task_id, v_req_id) ec
                      )
                ) eff;
                IF v_eff_count = 0 THEN
                    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_RECOUNT_COUNT_NOT_EFFECTIVE',
                        DETAIL=pg_catalog.jsonb_build_object('message','El conteo seleccionado no es un aporte efectivo valido.','retryable',false)::text;
                END IF;
            END IF;
        END LOOP;
    END IF;

    RETURN QUERY
    WITH active_tasks AS (
        SELECT t.id, t.session_zone_id, t.validation_cycle
        FROM inventarios.tasks t
        WHERE t.company_id = p_company_id AND t.session_id = p_session_id
          AND (p_task_id IS NULL OR t.id = p_task_id)
          AND t.cancelled_at IS NULL AND t.cancelled_by IS NULL
    ),
    eligible_requests AS (
        SELECT rr.id, rr.session_zone_id, rr.snapshot_product_id, rr.source_task_id,
               rr.cycle_number, rr.ordinal, rr.snapshot_id, rr.status
        FROM inventarios.recount_requests rr
        WHERE rr.company_id = p_company_id AND rr.session_id = p_session_id
          AND rr.cancelled_at IS NULL AND rr.cancelled_by IS NULL AND rr.cancellation_reason IS NULL
          AND EXISTS (SELECT 1 FROM active_tasks t
                      WHERE t.id = rr.source_task_id AND t.validation_cycle = rr.cycle_number
                        AND t.session_zone_id = rr.session_zone_id)
    ),
    ranked AS (
        SELECT er.*, ROW_NUMBER() OVER (
            PARTITION BY er.session_zone_id, er.snapshot_product_id, er.source_task_id, er.cycle_number
            ORDER BY er.ordinal DESC
        ) AS rn
        FROM eligible_requests er
    ),
    prevailing AS (
        SELECT r.* FROM ranked r WHERE r.rn = 1 AND r.status = 'COMPLETED'
    ),
    vigent_decisions AS (
        SELECT rd.recount_request_id, rd.id AS decision_id,
               rd.selected_count_entry_id, rd.cycle_number, rd.decided_at
        FROM inventarios.recount_decisions rd
        WHERE rd.company_id = p_company_id AND rd.superseded_at IS NULL
          AND rd.recount_request_id IN (SELECT id FROM prevailing)
    ),
    effective_scope AS (
        SELECT pv.id AS req_id,
               (SELECT rr.ordinal FROM inventarios.recount_requests rr WHERE rr.id = pv.id) AS ordinal,
               dd.decision_id, dd.selected_count_entry_id,
               ec.root_count_entry_id, ec.effective_count_entry_id,
               ec.session_id, ec.snapshot_id, ec.session_zone_id,
               ec.snapshot_location_id, ec.snapshot_product_id,
               ec.task_id, ec.task_cycle,
               dd.decided_at, dd.recount_request_id AS dec_req_id
        FROM prevailing pv
        JOIN vigent_decisions dd ON dd.recount_request_id = pv.id
        CROSS JOIN LATERAL inventarios.get_effective_count_entries(
            p_company_id, p_session_id, pv.source_task_id, pv.id
        ) ec
        WHERE ec.effective_count_entry_id = dd.selected_count_entry_id
    )
    SELECT es.req_id, es.ordinal, es.decision_id,
           es.root_count_entry_id, es.effective_count_entry_id,
           p_company_id, es.session_id, es.snapshot_id, es.session_zone_id,
           es.snapshot_location_id, es.snapshot_product_id,
           es.task_id, es.task_cycle, es.decided_at
    FROM effective_scope es
    ORDER BY es.task_id, es.task_cycle, es.session_zone_id, es.snapshot_product_id, es.ordinal, es.req_id;
END;
$$;

-- 2. get_effective_task_contributions(..., p_strict boolean DEFAULT true)
CREATE OR REPLACE FUNCTION inventarios.get_effective_task_contributions(p_company_id uuid, p_session_id uuid, p_task_id uuid, p_strict boolean DEFAULT true)
 RETURNS TABLE(contribution_count_entry_id uuid, contribution_source text, root_count_entry_id uuid, recount_request_id uuid, recount_decision_id uuid, company_id uuid, session_id uuid, snapshot_id uuid, session_zone_id uuid, snapshot_location_id uuid, snapshot_product_id uuid, task_id uuid, task_cycle integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_cancelled_at timestamptz;
    v_cancelled_by uuid;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL OR p_task_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    PERFORM 1 FROM inventarios.sessions s WHERE s.company_id = p_company_id AND s.id = p_session_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
        DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    SELECT t.cancelled_at, t.cancelled_by INTO v_cancelled_at, v_cancelled_by
    FROM inventarios.tasks t WHERE t.company_id = p_company_id AND t.session_id = p_session_id AND t.id = p_task_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
        DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF (v_cancelled_at IS NULL AND v_cancelled_by IS NOT NULL)
       OR (v_cancelled_at IS NOT NULL AND v_cancelled_by IS NULL) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
            DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',false)::text;
    END IF;
    IF v_cancelled_at IS NOT NULL AND v_cancelled_by IS NOT NULL THEN
        RETURN;
    END IF;
    RETURN QUERY
    WITH task_info AS (
        SELECT t.validation_cycle FROM inventarios.tasks t
        WHERE t.id = p_task_id
    ),
    audit_replaced_ids AS (
        SELECT rc.replaced_count_entry_id
        FROM inventarios.inventory_audit_resolution_replaced_contributions rc
        WHERE rc.company_id = p_company_id
    ),
    approved_audit_scopes AS (
        SELECT DISTINCT i.session_id, i.session_zone_id, ce.snapshot_product_id
        FROM inventarios.inventory_audit_resolution_items i
        JOIN inventarios.inventory_audit_resolutions r ON r.id = i.resolution_id
        JOIN inventarios.count_entries ce ON ce.id = i.synthetic_count_entry_id
        WHERE r.company_id = p_company_id AND r.decision = 'APPROVED' AND r.superseded_at IS NULL
          AND i.session_id IS NOT NULL AND i.synthetic_count_entry_id IS NOT NULL
    ),
    normal_counts AS (
        SELECT ec.effective_count_entry_id AS contribution_count_entry_id,
               'NORMAL'::text AS source,
               ec.root_count_entry_id, ec.recount_request_id,
               NULL::uuid AS recount_decision_id,
               ec.company_id, ec.session_id, ec.snapshot_id, ec.session_zone_id,
               ec.snapshot_location_id, ec.snapshot_product_id,
               ec.task_id, ec.task_cycle
        FROM inventarios.get_effective_count_entries(p_company_id, p_session_id, p_task_id, NULL) ec
        JOIN task_info ti ON ec.task_cycle = ti.validation_cycle
    ),
    recount_scopes AS (
        SELECT rd.recount_request_id, rd.recount_decision_id,
               rd.selected_count_entry_id, rd.selected_root_count_entry_id,
               rd.session_zone_id, rd.snapshot_product_id,
               rd.source_task_id, rd.task_cycle,
               rd.session_id, rd.snapshot_id, rd.snapshot_location_id
        FROM inventarios.get_applicable_recount_decisions(p_company_id, p_session_id, p_task_id, p_strict) rd
    ),
    replaced_scopes AS (
        SELECT DISTINCT rs.session_zone_id, rs.snapshot_product_id, rs.task_cycle
        FROM recount_scopes rs
    ),
    filtered_normal AS (
        SELECT nc.* FROM normal_counts nc
        WHERE NOT EXISTS (
            SELECT 1 FROM replaced_scopes rs
            WHERE rs.session_zone_id = nc.session_zone_id
              AND rs.snapshot_product_id = nc.snapshot_product_id
              AND rs.task_cycle = nc.task_cycle
        )
          AND NOT EXISTS (
              SELECT 1 FROM audit_replaced_ids ar
              WHERE ar.replaced_count_entry_id = nc.contribution_count_entry_id
          )
    ),
    recount_contributions AS (
        SELECT rs.selected_count_entry_id AS contribution_count_entry_id,
               'RECOUNT'::text AS source,
               rs.selected_root_count_entry_id AS root_count_entry_id,
               rs.recount_request_id, rs.recount_decision_id,
               p_company_id, rs.session_id, rs.snapshot_id, rs.session_zone_id,
               rs.snapshot_location_id, rs.snapshot_product_id,
               rs.source_task_id AS task_id, rs.task_cycle
        FROM recount_scopes rs
        WHERE NOT EXISTS (
            SELECT 1 FROM audit_replaced_ids ar
            WHERE ar.replaced_count_entry_id = rs.selected_count_entry_id
        )
          AND NOT EXISTS (
              SELECT 1 FROM approved_audit_scopes aas
              WHERE aas.session_id = rs.session_id
                AND aas.session_zone_id = rs.session_zone_id
                AND aas.snapshot_product_id = rs.snapshot_product_id
          )
    ),
    audit_contributions AS (
        SELECT ce.id AS contribution_count_entry_id,
               'AUDIT'::text AS source,
               ce.id AS root_count_entry_id,
               NULL::uuid AS recount_request_id,
               NULL::uuid AS recount_decision_id,
               ce.company_id, ce.session_id, ce.snapshot_id, ce.session_zone_id,
               ce.snapshot_location_id, ce.snapshot_product_id,
               ce.task_id, ce.task_cycle
        FROM inventarios.count_entries ce
        WHERE ce.company_id = p_company_id
          AND ce.capture_source = 'AUDIT'
          AND ce.task_id = p_task_id
          AND ce.invalidated_at IS NULL AND ce.invalidated_by IS NULL AND ce.invalidation_reason IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM audit_replaced_ids ar
              WHERE ar.replaced_count_entry_id = ce.id
          )
    ),
    combined AS (
        SELECT * FROM filtered_normal
        UNION ALL
        SELECT * FROM recount_contributions
        UNION ALL
        SELECT * FROM audit_contributions
    )
    SELECT c.contribution_count_entry_id, c.source, c.root_count_entry_id,
           c.recount_request_id, c.recount_decision_id,
           c.company_id, c.session_id, c.snapshot_id, c.session_zone_id,
           c.snapshot_location_id, c.snapshot_product_id,
           c.task_id, c.task_cycle
    FROM combined c
    WHERE EXISTS (
        SELECT 1 FROM inventarios.count_entries ce WHERE ce.id = c.contribution_count_entry_id
          AND ce.company_id = p_company_id
          AND ce.physical_quantity = ce.available_quantity + ce.damaged_quantity + ce.expired_quantity + ce.blocked_quantity + ce.other_unavailable_quantity
          AND ce.invalidated_at IS NULL AND ce.invalidated_by IS NULL AND ce.invalidation_reason IS NULL
    )
    ORDER BY c.task_cycle, c.session_zone_id, c.snapshot_product_id, c.source, c.root_count_entry_id, c.contribution_count_entry_id;
END;
$function$;

-- 3. Read-models: lectura tolerante a reconteo pendiente (p_strict=false)
-- 3.1
CREATE OR REPLACE FUNCTION inventarios.list_inventory_campaign_variances(
    p_company_id uuid,
    p_campaign_id uuid,
    p_search text DEFAULT NULL,
    p_variance_status text DEFAULT NULL,
    p_coverage_status text DEFAULT NULL,
    p_page integer DEFAULT 1,
    p_page_size integer DEFAULT 50,
    p_sort_by text DEFAULT NULL,
    p_sort_direction text DEFAULT 'ASC'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_campaign_status text;
    v_search text := btrim(coalesce(p_search, ''));
    v_var_status text := upper(btrim(coalesce(p_variance_status, '')));
    v_cov_status text := upper(btrim(coalesce(p_coverage_status, '')));
    v_sort_by text := upper(btrim(coalesce(p_sort_by, '')));
    v_sort_dir text := upper(btrim(coalesce(p_sort_direction, 'ASC')));
    v_page integer := greatest(coalesce(p_page, 1), 1);
    v_page_size integer := least(greatest(coalesce(p_page_size, 50), 1), 100);
    v_offset integer;
    v_total bigint;
    v_is_final boolean;
    v_items jsonb;
    v_prod_total bigint;
    v_prod_faltante bigint;
    v_prod_sobrante bigint;
    v_prod_sin_dif bigint;
    v_prod_out_snap bigint;
    v_prod_counted bigint;
    v_sum_theo numeric;
    v_sum_phys numeric;
    v_units_faltante numeric;
    v_units_sobrante numeric;
    v_net_val numeric;
    v_abs_val numeric;
BEGIN
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');
    IF v_sort_by NOT IN ('', 'SKU', 'NAME', 'THEORETICAL', 'PHYSICAL', 'DIFFERENCE', 'VARIANCE_STATUS', 'COVERAGE_STATUS', 'UNIT_COST', 'DIFFERENCE_VALUE') THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD';
    END IF;
    IF v_sort_dir NOT IN ('ASC', 'DESC') THEN v_sort_dir := 'ASC'; END IF;
    v_offset := (v_page - 1) * v_page_size;

    SELECT ic.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id;
    IF v_campaign_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND';
    END IF;
    SELECT count(*) = 0 INTO v_is_final
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id
      AND s.status IN ('DRAFT', 'PREPARED', 'COUNTING', 'UNDER_REVIEW');

    WITH campaign_sessions AS (
        SELECT s.id AS session_id FROM inventarios.sessions s
        WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id
    ),
    campaign_tasks AS (
        SELECT t.id AS task_id, t.session_id FROM inventarios.tasks t
        JOIN campaign_sessions cs ON cs.session_id = t.session_id
        WHERE t.cancelled_at IS NULL AND t.superseded_at IS NULL
    ),
    physical AS (
        SELECT ce.bsale_variant_id, sum(ce.physical_quantity) AS physical_quantity,
               count(*) AS contribution_count
        FROM campaign_tasks ct
        CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id, false) g
        JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
        WHERE ce.company_id = p_company_id AND ce.bsale_variant_id IS NOT NULL
        GROUP BY ce.bsale_variant_id
    ),
    universe_ranked AS (
        SELECT r.product_id, r.bsale_variant_id, r.sku, r.entered_description,
               r.theoretical_quantity, r.unit_cost,
               row_number() OVER (PARTITION BY r.product_id ORDER BY r.row_index, r.id) AS product_rank
        FROM inventarios.stock_import_rows r
        JOIN inventarios.stock_imports si ON si.id = r.import_id
        WHERE si.company_id = p_company_id AND si.campaign_id = p_campaign_id
          AND si.status = 'VALIDATED' AND si.theoretical_scope = 'TOTAL_CAMPAIGN'
          AND r.company_id = p_company_id AND r.row_status = 'VALID'
          AND r.product_id IS NOT NULL AND r.bsale_variant_id IS NOT NULL
          AND r.sku IS NOT NULL AND btrim(r.sku) <> '' AND r.theoretical_quantity IS NOT NULL
    ),
    theoretical AS (
        SELECT product_id, bsale_variant_id, sku,
               coalesce(nullif(btrim(entered_description), ''), sku) AS name,
               theoretical_quantity, unit_cost
        FROM universe_ranked WHERE product_rank = 1
    ),
    base AS (
        SELECT t.bsale_variant_id, t.product_id, t.sku, t.name, true AS in_theoretical_stock,
               t.theoretical_quantity, t.unit_cost
        FROM theoretical t
        UNION ALL
        SELECT ph.bsale_variant_id, sp.product_id, sp.sku,
               coalesce(nullif(inventarios.campaign_product_display_name(ph.bsale_variant_id), ''), sp.name),
               false, 0::numeric, NULL::numeric
        FROM physical ph
        LEFT JOIN LATERAL (
            SELECT sp.product_id, sp.sku, sp.name FROM inventarios.snapshot_products sp
            WHERE sp.company_id = p_company_id AND sp.bsale_variant_id = ph.bsale_variant_id
            ORDER BY sp.sku NULLS LAST LIMIT 1
        ) sp ON true
        WHERE NOT EXISTS (SELECT 1 FROM theoretical t WHERE t.bsale_variant_id = ph.bsale_variant_id)
    ),
    computed AS (
        SELECT b.*, ph.physical_quantity, coalesce(ph.contribution_count, 0) AS contribution_count,
               (ph.bsale_variant_id IS NOT NULL) AS in_any_snapshot,
               CASE WHEN ph.contribution_count > 0 THEN ph.physical_quantity - b.theoretical_quantity END AS difference_quantity,
               CASE WHEN NOT b.in_theoretical_stock THEN 'OUT_OF_SNAPSHOT'
                    WHEN ph.contribution_count > 0 THEN 'COUNTED' ELSE 'NOT_COUNTED' END AS coverage_status,
               CASE WHEN ph.contribution_count IS NULL THEN 'SIN_CONTEO'
                    WHEN ph.physical_quantity - b.theoretical_quantity < 0 THEN 'FALTANTE'
                    WHEN ph.physical_quantity - b.theoretical_quantity > 0 THEN 'SOBRANTE'
                    ELSE 'SIN_DIFERENCIA' END AS variance_status
        FROM base b LEFT JOIN physical ph ON ph.bsale_variant_id = b.bsale_variant_id
    ),
    filtered AS (
        SELECT c.* FROM computed c
        WHERE (v_search = '' OR c.sku ILIKE '%' || v_search || '%' OR c.name ILIKE '%' || v_search || '%')
          AND (v_var_status = '' OR c.variance_status = v_var_status)
          AND (v_cov_status = '' OR c.coverage_status = v_cov_status)
    )
    SELECT count(*) INTO v_total FROM filtered;

    WITH campaign_sessions AS (
        SELECT s.id AS session_id FROM inventarios.sessions s
        WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id
    ), campaign_tasks AS (
        SELECT t.id AS task_id, t.session_id FROM inventarios.tasks t
        JOIN campaign_sessions cs ON cs.session_id = t.session_id
        WHERE t.cancelled_at IS NULL AND t.superseded_at IS NULL
    ), physical AS (
        SELECT ce.bsale_variant_id, sum(ce.physical_quantity) AS physical_quantity, count(*) AS contribution_count
        FROM campaign_tasks ct
        CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id, false) g
        JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
        WHERE ce.company_id = p_company_id AND ce.bsale_variant_id IS NOT NULL
        GROUP BY ce.bsale_variant_id
    ), universe_ranked AS (
        SELECT r.*, row_number() OVER (PARTITION BY r.product_id ORDER BY r.row_index, r.id) AS product_rank
        FROM inventarios.stock_import_rows r JOIN inventarios.stock_imports si ON si.id = r.import_id
        WHERE si.company_id = p_company_id AND si.campaign_id = p_campaign_id AND si.status = 'VALIDATED'
          AND si.theoretical_scope = 'TOTAL_CAMPAIGN' AND r.company_id = p_company_id AND r.row_status = 'VALID'
          AND r.product_id IS NOT NULL AND r.bsale_variant_id IS NOT NULL AND r.sku IS NOT NULL
          AND btrim(r.sku) <> '' AND r.theoretical_quantity IS NOT NULL
    ), theoretical AS (
        SELECT product_id, bsale_variant_id, sku, coalesce(nullif(btrim(entered_description), ''), sku) AS name, theoretical_quantity, unit_cost
        FROM universe_ranked WHERE product_rank = 1
    ), base AS (
        SELECT t.bsale_variant_id, t.product_id, t.sku, t.name, true AS in_theoretical_stock, t.theoretical_quantity, t.unit_cost FROM theoretical t
        UNION ALL
        SELECT ph.bsale_variant_id, sp.product_id, sp.sku, coalesce(nullif(inventarios.campaign_product_display_name(ph.bsale_variant_id), ''), sp.name), false, 0::numeric, NULL::numeric
        FROM physical ph LEFT JOIN LATERAL (SELECT sp.product_id, sp.sku, sp.name FROM inventarios.snapshot_products sp WHERE sp.company_id = p_company_id AND sp.bsale_variant_id = ph.bsale_variant_id ORDER BY sp.sku NULLS LAST LIMIT 1) sp ON true
        WHERE NOT EXISTS (SELECT 1 FROM theoretical t WHERE t.bsale_variant_id = ph.bsale_variant_id)
    ), computed AS (
        SELECT b.*, ph.physical_quantity, coalesce(ph.contribution_count, 0) AS contribution_count,
               CASE WHEN ph.contribution_count > 0 THEN ph.physical_quantity - b.theoretical_quantity END AS difference_quantity,
               CASE WHEN NOT b.in_theoretical_stock THEN 'OUT_OF_SNAPSHOT' WHEN ph.contribution_count > 0 THEN 'COUNTED' ELSE 'NOT_COUNTED' END AS coverage_status,
               CASE WHEN ph.contribution_count IS NULL THEN 'SIN_CONTEO' WHEN ph.physical_quantity - b.theoretical_quantity < 0 THEN 'FALTANTE' WHEN ph.physical_quantity - b.theoretical_quantity > 0 THEN 'SOBRANTE' ELSE 'SIN_DIFERENCIA' END AS variance_status
        FROM base b LEFT JOIN physical ph ON ph.bsale_variant_id = b.bsale_variant_id
    )
    SELECT count(*), count(*) FILTER (WHERE variance_status = 'FALTANTE'), count(*) FILTER (WHERE variance_status = 'SOBRANTE'),
           count(*) FILTER (WHERE variance_status = 'SIN_DIFERENCIA'), count(*) FILTER (WHERE coverage_status = 'OUT_OF_SNAPSHOT'),
           count(*) FILTER (WHERE contribution_count > 0), coalesce(sum(theoretical_quantity), 0), coalesce(sum(physical_quantity), 0),
           coalesce(sum(CASE WHEN variance_status = 'FALTANTE' THEN abs(difference_quantity) ELSE 0 END), 0),
           coalesce(sum(CASE WHEN variance_status = 'SOBRANTE' THEN difference_quantity ELSE 0 END), 0),
           coalesce(sum(coalesce(difference_quantity, 0) * coalesce(unit_cost, 0)), 0),
           coalesce(sum(abs(coalesce(difference_quantity, 0) * coalesce(unit_cost, 0))), 0)
    INTO v_prod_total, v_prod_faltante, v_prod_sobrante, v_prod_sin_dif, v_prod_out_snap, v_prod_counted,
         v_sum_theo, v_sum_phys, v_units_faltante, v_units_sobrante, v_net_val, v_abs_val
    FROM computed;

    WITH campaign_sessions AS (
        SELECT s.id AS session_id FROM inventarios.sessions s WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id
    ), campaign_tasks AS (
        SELECT t.id AS task_id, t.session_id FROM inventarios.tasks t JOIN campaign_sessions cs ON cs.session_id = t.session_id WHERE t.cancelled_at IS NULL AND t.superseded_at IS NULL
    ), physical AS (
        SELECT ce.bsale_variant_id, sum(ce.physical_quantity) AS physical_quantity, count(*) AS contribution_count
        FROM campaign_tasks ct CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id, false) g
        JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id WHERE ce.company_id = p_company_id AND ce.bsale_variant_id IS NOT NULL GROUP BY ce.bsale_variant_id
    ), universe_ranked AS (
        SELECT r.*, row_number() OVER (PARTITION BY r.product_id ORDER BY r.row_index, r.id) AS product_rank
        FROM inventarios.stock_import_rows r JOIN inventarios.stock_imports si ON si.id = r.import_id
        WHERE si.company_id = p_company_id AND si.campaign_id = p_campaign_id AND si.status = 'VALIDATED' AND si.theoretical_scope = 'TOTAL_CAMPAIGN' AND r.company_id = p_company_id AND r.row_status = 'VALID' AND r.product_id IS NOT NULL AND r.bsale_variant_id IS NOT NULL AND r.sku IS NOT NULL AND btrim(r.sku) <> '' AND r.theoretical_quantity IS NOT NULL
    ), theoretical AS (
        SELECT product_id, bsale_variant_id, sku, coalesce(nullif(btrim(entered_description), ''), sku) AS name, theoretical_quantity, unit_cost FROM universe_ranked WHERE product_rank = 1
    ), base AS (
        SELECT t.bsale_variant_id, t.product_id, t.sku, t.name, true AS in_theoretical_stock, t.theoretical_quantity, t.unit_cost FROM theoretical t
        UNION ALL SELECT ph.bsale_variant_id, sp.product_id, sp.sku, coalesce(nullif(inventarios.campaign_product_display_name(ph.bsale_variant_id), ''), sp.name), false, 0::numeric, NULL::numeric FROM physical ph LEFT JOIN LATERAL (SELECT sp.product_id, sp.sku, sp.name FROM inventarios.snapshot_products sp WHERE sp.company_id = p_company_id AND sp.bsale_variant_id = ph.bsale_variant_id ORDER BY sp.sku NULLS LAST LIMIT 1) sp ON true WHERE NOT EXISTS (SELECT 1 FROM theoretical t WHERE t.bsale_variant_id = ph.bsale_variant_id)
    ), computed AS (
        SELECT b.*, ph.physical_quantity, coalesce(ph.contribution_count, 0) AS contribution_count, CASE WHEN ph.contribution_count > 0 THEN ph.physical_quantity - b.theoretical_quantity END AS difference_quantity, CASE WHEN NOT b.in_theoretical_stock THEN 'OUT_OF_SNAPSHOT' WHEN ph.contribution_count > 0 THEN 'COUNTED' ELSE 'NOT_COUNTED' END AS coverage_status, CASE WHEN ph.contribution_count IS NULL THEN 'SIN_CONTEO' WHEN ph.physical_quantity - b.theoretical_quantity < 0 THEN 'FALTANTE' WHEN ph.physical_quantity - b.theoretical_quantity > 0 THEN 'SOBRANTE' ELSE 'SIN_DIFERENCIA' END AS variance_status FROM base b LEFT JOIN physical ph ON ph.bsale_variant_id = b.bsale_variant_id
    ), filtered AS (
        SELECT c.* FROM computed c WHERE (v_search = '' OR c.sku ILIKE '%' || v_search || '%' OR c.name ILIKE '%' || v_search || '%') AND (v_var_status = '' OR c.variance_status = v_var_status) AND (v_cov_status = '' OR c.coverage_status = v_cov_status)
    ), paged AS (
        SELECT f.* FROM filtered f
        ORDER BY CASE WHEN v_sort_dir = 'ASC' AND v_sort_by = 'SKU' THEN f.sku END ASC NULLS LAST,
                 CASE WHEN v_sort_dir = 'DESC' AND v_sort_by = 'SKU' THEN f.sku END DESC NULLS LAST,
                 f.sku, f.bsale_variant_id
        LIMIT v_page_size OFFSET v_offset
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object('product_key', f.bsale_variant_id::text, 'bsale_variant_id', f.bsale_variant_id, 'product_id', f.product_id, 'sku', f.sku, 'name', f.name, 'in_theoretical_stock', f.in_theoretical_stock, 'in_any_snapshot', f.in_theoretical_stock, 'theoretical_quantity', f.theoretical_quantity, 'physical_quantity', f.physical_quantity, 'contribution_count', f.contribution_count, 'difference_quantity', f.difference_quantity, 'unit_cost', f.unit_cost, 'difference_value', CASE WHEN f.difference_quantity IS NULL THEN NULL ELSE f.difference_quantity * f.unit_cost END, 'variance_status', f.variance_status, 'coverage_status', f.coverage_status) ORDER BY f.sku, f.bsale_variant_id), '[]'::jsonb)
    INTO v_items FROM paged f;

    RETURN jsonb_build_object('campaign_id', p_campaign_id, 'campaign_status', v_campaign_status, 'is_final', v_is_final,
        'summary', jsonb_build_object('total_products', v_prod_total, 'faltantes', v_prod_faltante, 'sobrantes', v_prod_sobrante, 'sin_diferencia', v_prod_sin_dif, 'out_of_snapshot', v_prod_out_snap, 'contados', v_prod_counted, 'total_theoretical', v_sum_theo, 'total_physical', v_sum_phys, 'total_faltante_units', v_units_faltante, 'total_sobrante_units', v_units_sobrante, 'net_valuation', v_net_val, 'absolute_valuation', v_abs_val),
        'total', v_total, 'page', v_page, 'page_size', v_page_size, 'has_more', v_offset + jsonb_array_length(v_items) < v_total, 'items', v_items);
END;
$function$;

-- 3.2
CREATE OR REPLACE FUNCTION inventarios.get_inventory_campaign_review_summary(
    p_company_id uuid,
    p_campaign_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_campaign_status text;
    v_stock jsonb;
    v_operation jsonb;
    v_sessions_total bigint := 0;
    v_sessions_draft bigint := 0;
    v_sessions_prepared bigint := 0;
    v_sessions_counting bigint := 0;
    v_sessions_review bigint := 0;
    v_sessions_approved bigint := 0;
    v_zones_total bigint := 0;
    v_zones_completed bigint := 0;
    v_zones_in_progress bigint := 0;
    v_zones_not_started bigint := 0;
    v_locations_total bigint := 0;
    v_locations_visited bigint := 0;
    v_locations_open bigint := 0;
    v_locations_visited_no_counts bigint := 0;
    v_locations_never_visited bigint := 0;
    v_pending_barcodes bigint := 0;
    v_blocking_incidents bigint := 0;
    v_pending_recounts bigint := 0;
    v_products_theoretical bigint := 0;
    v_products_counted bigint := 0;
    v_products_with_difference bigint := 0;
    v_faltantes bigint := 0;
    v_sobrantes bigint := 0;
    v_sin_diferencia bigint := 0;
    v_out_of_snapshot bigint := 0;
    v_units_faltante numeric := 0;
    v_units_sobrante numeric := 0;
    v_net_valuation numeric := 0;
    v_abs_valuation numeric := 0;
    v_is_final boolean;
    v_active_sessions bigint := 0;
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

    -- ---------- Operación ----------
    SELECT pg_catalog.count(*) INTO v_sessions_total
    FROM inventarios.sessions s WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id;

    SELECT
        pg_catalog.count(*) FILTER (WHERE status = 'DRAFT'),
        pg_catalog.count(*) FILTER (WHERE status = 'PREPARED'),
        pg_catalog.count(*) FILTER (WHERE status = 'COUNTING'),
        pg_catalog.count(*) FILTER (WHERE status = 'UNDER_REVIEW'),
        pg_catalog.count(*) FILTER (WHERE status = 'APPROVED')
    INTO v_sessions_draft, v_sessions_prepared, v_sessions_counting, v_sessions_review, v_sessions_approved
    FROM inventarios.sessions s WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id;

    v_active_sessions := v_sessions_draft + v_sessions_prepared + v_sessions_counting + v_sessions_review;
    v_is_final := (v_active_sessions = 0);

    WITH z AS (
        SELECT sz.id, coalesce(max(t.status), 'ASSIGNED') AS task_status
        FROM inventarios.session_zones sz
        JOIN inventarios.sessions s ON s.company_id = sz.company_id AND s.id = sz.session_id
        LEFT JOIN inventarios.tasks t ON t.company_id = sz.company_id AND t.session_id = sz.session_id
            AND t.session_zone_id = sz.id AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
        WHERE s.campaign_id = p_campaign_id
        GROUP BY sz.id
    )
    SELECT
        pg_catalog.count(*),
        pg_catalog.count(*) FILTER (WHERE task_status = 'COMPLETED'),
        pg_catalog.count(*) FILTER (WHERE task_status IN ('IN_PROGRESS','PAUSED')),
        pg_catalog.count(*) FILTER (WHERE task_status = 'ASSIGNED')
    INTO v_zones_total, v_zones_completed, v_zones_in_progress, v_zones_not_started
    FROM z;

    SELECT pg_catalog.count(*) INTO v_locations_total
    FROM inventarios.session_zone_locations szl
    JOIN inventarios.sessions s ON s.company_id = szl.company_id AND s.id = szl.session_id
    WHERE s.campaign_id = p_campaign_id;

    SELECT pg_catalog.count(*) INTO v_locations_visited
    FROM inventarios.task_locations tl
    JOIN inventarios.sessions s ON s.company_id = tl.company_id AND s.id = tl.session_id
    WHERE s.campaign_id = p_campaign_id;

    SELECT pg_catalog.count(*) INTO v_locations_open
    FROM inventarios.task_locations tl
    JOIN inventarios.sessions s ON s.company_id = tl.company_id AND s.id = tl.session_id
    WHERE s.campaign_id = p_campaign_id AND tl.status = 'OPEN';

    SELECT pg_catalog.count(*) INTO v_locations_visited_no_counts
    FROM (
        SELECT tl.id
        FROM inventarios.task_locations tl
        JOIN inventarios.sessions s ON s.company_id = tl.company_id AND s.id = tl.session_id
        WHERE s.campaign_id = p_campaign_id
          AND NOT EXISTS (
              SELECT 1
              FROM inventarios.count_entries ce
              JOIN inventarios.session_zone_locations szl2
                ON szl2.company_id = ce.company_id
               AND szl2.session_id = ce.session_id
               AND szl2.session_zone_id = ce.session_zone_id
               AND szl2.snapshot_location_id = ce.snapshot_location_id
              WHERE ce.company_id = tl.company_id AND ce.session_id = tl.session_id
                AND szl2.id = tl.session_zone_location_id
                AND ce.invalidated_at IS NULL AND ce.invalidated_by IS NULL AND ce.invalidation_reason IS NULL
          )
    ) x;

    v_locations_never_visited := GREATEST(v_locations_total - v_locations_visited, 0);

    SELECT pg_catalog.count(*) INTO v_pending_barcodes
    FROM inventarios.product_barcode_proposals pbp
    JOIN inventarios.sessions s ON s.company_id = pbp.company_id AND s.id = pbp.session_id
    WHERE s.campaign_id = p_campaign_id AND pbp.status = 'PENDING_REVIEW';

    SELECT pg_catalog.count(*) INTO v_blocking_incidents
    FROM inventarios.incidents i
    JOIN inventarios.sessions s ON s.company_id = i.company_id AND s.id = i.session_id
    WHERE s.campaign_id = p_campaign_id AND i.is_blocking = true AND i.status IN ('OPEN','UNDER_REVIEW');

    SELECT pg_catalog.count(*) INTO v_pending_recounts
    FROM inventarios.recount_requests rr
    JOIN inventarios.sessions s ON s.company_id = rr.company_id AND s.id = rr.session_id
    WHERE s.campaign_id = p_campaign_id AND rr.status IN ('REQUESTED','ASSIGNED','IN_PROGRESS');

    v_operation := pg_catalog.jsonb_build_object(
        'total_sessions', v_sessions_total,
        'sessions_by_status', pg_catalog.jsonb_build_object(
            'DRAFT', v_sessions_draft, 'PREPARED', v_sessions_prepared,
            'COUNTING', v_sessions_counting, 'UNDER_REVIEW', v_sessions_review,
            'APPROVED', v_sessions_approved),
        'zones_total', v_zones_total,
        'zones_completed', v_zones_completed,
        'zones_in_progress', v_zones_in_progress,
        'zones_not_started', v_zones_not_started,
        'locations_total', v_locations_total,
        'locations_visited', v_locations_visited,
        'locations_open', v_locations_open,
        'locations_visited_without_counts', v_locations_visited_no_counts,
        'locations_never_visited', v_locations_never_visited,
        'pending_barcode_proposals', v_pending_barcodes,
        'blocking_incident_count', v_blocking_incidents,
        'pending_recount_count', v_pending_recounts
    );

    -- ---------- Stock / diferencias ----------
    SELECT pg_catalog.count(*) INTO v_products_theoretical
    FROM inventarios.inventory_campaign_theoretical_stocks icts
    JOIN inventarios.inventory_campaign_snapshots cs
      ON cs.company_id = icts.company_id AND cs.id = icts.campaign_snapshot_id AND cs.campaign_id = p_campaign_id
    WHERE icts.company_id = p_company_id AND icts.scope_level = 'TOTAL_CAMPAIGN';

    WITH campaign_sessions AS (
        SELECT s.id AS session_id FROM inventarios.sessions s
        WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id
    ),
    campaign_tasks AS (
        SELECT t.id AS task_id, t.session_id
        FROM inventarios.tasks t JOIN campaign_sessions cs ON cs.session_id = t.session_id
        WHERE t.cancelled_at IS NULL AND t.superseded_at IS NULL
    ),
    physical AS (
        SELECT ovi.bsale_variant_id, pg_catalog.sum(ovi.physical_quantity) AS physical_quantity
        FROM inventarios.official_version_items ovi
        JOIN inventarios.sessions s ON s.company_id = ovi.company_id AND s.id = ovi.session_id
        WHERE ovi.company_id = p_company_id AND s.campaign_id = p_campaign_id
          AND s.status = 'APPROVED' AND v_campaign_status = 'APPROVED'
        GROUP BY ovi.bsale_variant_id
        UNION ALL
        SELECT ce.bsale_variant_id, pg_catalog.sum(ce.physical_quantity) AS physical_quantity
        FROM campaign_tasks ct
        CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id, false) g
        JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
        WHERE ce.bsale_variant_id IS NOT NULL
          AND coalesce(v_campaign_status, '') <> 'APPROVED'
        GROUP BY ce.bsale_variant_id
    ),
    snapshot_coverage AS (
        SELECT DISTINCT sp.bsale_variant_id
        FROM inventarios.snapshot_products sp
        JOIN inventarios.operational_snapshots os ON os.session_id = sp.snapshot_id AND os.company_id = sp.company_id
        JOIN campaign_sessions cs ON cs.session_id = os.session_id
        WHERE sp.bsale_variant_id IS NOT NULL
    ),
    theoretical AS (
        SELECT csp.bsale_variant_id, icts.theoretical_quantity, icts.unit_cost
        FROM inventarios.inventory_campaign_theoretical_stocks icts
        JOIN inventarios.inventory_campaign_snapshots cs
          ON cs.company_id = icts.company_id AND cs.id = icts.campaign_snapshot_id AND cs.campaign_id = p_campaign_id
        JOIN inventarios.inventory_campaign_snapshot_products csp
          ON csp.company_id = icts.company_id AND csp.campaign_snapshot_id = icts.campaign_snapshot_id AND csp.id = icts.snapshot_product_id
        WHERE icts.company_id = p_company_id AND icts.scope_level = 'TOTAL_CAMPAIGN'
    ),
    base AS (
        SELECT t.bsale_variant_id, t.theoretical_quantity, t.unit_cost, true AS in_theoretical_stock
        FROM theoretical t
        UNION ALL
        SELECT ph.bsale_variant_id, 0::numeric, NULL::numeric, false
        FROM physical ph
        WHERE NOT EXISTS (SELECT 1 FROM theoretical t2 WHERE t2.bsale_variant_id = ph.bsale_variant_id)
    ),
    dataset AS (
        SELECT b.bsale_variant_id, b.theoretical_quantity,
               coalesce(ph.physical_quantity, 0) AS physical_quantity,
               (EXISTS (SELECT 1 FROM snapshot_coverage sc2 WHERE sc2.bsale_variant_id = b.bsale_variant_id)) AS in_any_snapshot,
               b.unit_cost
        FROM base b LEFT JOIN physical ph ON ph.bsale_variant_id = b.bsale_variant_id
    ),
    computed AS (
        SELECT d.*,
               (d.physical_quantity - d.theoretical_quantity) AS difference_quantity,
               CASE WHEN d.physical_quantity > 0 THEN 'COUNTED'
                    WHEN d.in_any_snapshot THEN 'NOT_COUNTED'
                    ELSE 'OUT_OF_SNAPSHOT' END AS coverage_status,
               CASE WHEN (d.physical_quantity - d.theoretical_quantity) < 0 THEN 'FALTANTE'
                    WHEN (d.physical_quantity - d.theoretical_quantity) > 0 THEN 'SOBRANTE'
                    ELSE 'SIN_DIFERENCIA' END AS variance_status
        FROM dataset d
    )
    SELECT
        pg_catalog.count(*) FILTER (WHERE c.physical_quantity > 0),
        pg_catalog.count(*) FILTER (WHERE c.variance_status <> 'SIN_DIFERENCIA'),
        pg_catalog.count(*) FILTER (WHERE c.variance_status = 'FALTANTE'),
        pg_catalog.count(*) FILTER (WHERE c.variance_status = 'SOBRANTE'),
        pg_catalog.count(*) FILTER (WHERE c.variance_status = 'SIN_DIFERENCIA'),
        pg_catalog.count(*) FILTER (WHERE c.coverage_status = 'OUT_OF_SNAPSHOT'),
        coalesce(pg_catalog.sum(CASE WHEN c.variance_status = 'FALTANTE' THEN pg_catalog.abs(c.difference_quantity) ELSE 0::numeric END), 0::numeric),
        coalesce(pg_catalog.sum(CASE WHEN c.variance_status = 'SOBRANTE' THEN c.difference_quantity ELSE 0::numeric END), 0::numeric),
        coalesce(pg_catalog.sum(coalesce(c.difference_quantity, 0::numeric) * coalesce(c.unit_cost, 0::numeric)), 0::numeric),
        coalesce(pg_catalog.sum(pg_catalog.abs(coalesce(c.difference_quantity, 0::numeric) * coalesce(c.unit_cost, 0::numeric))), 0::numeric)
    INTO v_products_counted, v_products_with_difference, v_faltantes, v_sobrantes,
         v_sin_diferencia, v_out_of_snapshot, v_units_faltante, v_units_sobrante,
         v_net_valuation, v_abs_valuation
    FROM computed c;

    v_stock := pg_catalog.jsonb_build_object(
        'products_theoretical', v_products_theoretical,
        'products_counted', v_products_counted,
        'products_with_difference', v_products_with_difference,
        'faltantes', v_faltantes,
        'sobrantes', v_sobrantes,
        'sin_diferencia', v_sin_diferencia,
        'out_of_snapshot', v_out_of_snapshot,
        'units_faltante', v_units_faltante,
        'units_sobrante', v_units_sobrante,
        'net_valuation', v_net_valuation,
        'absolute_valuation', v_abs_valuation
    );

    RETURN pg_catalog.jsonb_build_object(
        'campaign_id', p_campaign_id,
        'campaign_status', v_campaign_status,
        'is_final', v_is_final,
        'stock', v_stock,
        'operation', v_operation
    );
END;
$function$;

-- 3.3
CREATE OR REPLACE FUNCTION inventarios.get_inventory_campaign_export(
    p_company_id uuid,
    p_campaign_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_campaign_status text;
    v_contributions jsonb;
    v_operational jsonb;
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

    -- Contribuciones efectivas con contexto.
    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'sku', sp.sku,
                'name', coalesce(NULLIF(inventarios.campaign_product_display_name(sp.bsale_variant_id), ''), NULLIF(pg_catalog.btrim(sp.name), ''), 'PRODUCTO ' || ce.bsale_variant_id::text),
                'session_name', s.name,
                'session_status', s.status,
                'zone_code', sz.zone_code,
                'zone_name', sz.display_name,
                'location_code', sl.code,
                'location_name', sl.name,
                'counted_by', ce.counted_by,
                'counted_by_name', inventarios.user_display_name(ce.counted_by),
                'physical_quantity', ce.physical_quantity,
                'identification_method', ce.identification_method,
                'scanned_code', ce.scanned_code,
                'captured_at', ce.captured_at,
                'contribution_source', g.contribution_source
            ) ORDER BY s.name, sz.zone_code, sl.code, ce.captured_at
        )
    END
    INTO v_contributions
    FROM (
        SELECT t.id AS task_id, t.session_id
        FROM inventarios.tasks t
        JOIN inventarios.sessions s ON s.company_id = t.company_id AND s.id = t.session_id
        WHERE s.campaign_id = p_campaign_id AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
    ) ct
    CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id, false) g
    JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
    JOIN inventarios.sessions s ON s.company_id = ce.company_id AND s.id = ce.session_id
    LEFT JOIN inventarios.snapshot_products sp ON sp.company_id = ce.company_id AND sp.snapshot_id = ce.snapshot_id AND sp.id = ce.snapshot_product_id
    LEFT JOIN inventarios.session_zones sz ON sz.company_id = ce.company_id AND sz.session_id = ce.session_id AND sz.id = ce.session_zone_id
    LEFT JOIN inventarios.snapshot_locations sl ON sl.company_id = ce.company_id AND sl.snapshot_id = ce.snapshot_id AND sl.id = ce.snapshot_location_id;

    -- Filas de auditoría del estado operacional.
    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'tipo', r.tipo,
                'seccion', r.seccion,
                'zona', r.zona,
                'ubicacion', r.ubicacion,
                'estado', r.estado,
                'detalle', r.detalle
            ) ORDER BY r.tipo, r.seccion, r.zona, r.ubicacion
        )
    END
    INTO v_operational
    FROM (
        -- Secciones por estado
        SELECT 'Sección' AS tipo, s.name AS seccion, NULL::text AS zona, NULL::text AS ubicacion,
               CASE s.status
                   WHEN 'DRAFT' THEN 'Pendiente'
                   WHEN 'PREPARED' THEN 'Preparada'
                   WHEN 'COUNTING' THEN 'En conteo'
                   WHEN 'UNDER_REVIEW' THEN 'En revisión'
                   WHEN 'APPROVED' THEN 'Terminada'
                   ELSE s.status
               END AS estado,
               'Sección de conteo' AS detalle
        FROM inventarios.sessions s
        WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id

        UNION ALL
        -- Zonas por estado de su tarea activa
        SELECT 'Zona', s.name, sz.zone_code, NULL,
               CASE coalesce(max(t.status), 'ASSIGNED')
                   WHEN 'COMPLETED' THEN 'Completada'
                   WHEN 'IN_PROGRESS' THEN 'En curso'
                   WHEN 'PAUSED' THEN 'En pausa'
                   WHEN 'ASSIGNED' THEN 'No iniciada'
                   ELSE coalesce(max(t.status), 'ASSIGNED')
               END,
               sz.display_name
        FROM inventarios.session_zones sz
        JOIN inventarios.sessions s ON s.company_id = sz.company_id AND s.id = sz.session_id
        LEFT JOIN inventarios.tasks t ON t.company_id = sz.company_id AND t.session_id = sz.session_id
            AND t.session_zone_id = sz.id AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
        WHERE s.campaign_id = p_campaign_id
        GROUP BY sz.id, s.name, sz.zone_code, sz.display_name

        UNION ALL
        -- Tareas pendientes
        SELECT 'Tarea', s.name, NULL, NULL,
               CASE t.status
                   WHEN 'IN_PROGRESS' THEN 'En curso'
                   WHEN 'PAUSED' THEN 'En pausa'
                   ELSE t.status
               END,
               'Tarea de conteo'
        FROM inventarios.tasks t
        JOIN inventarios.sessions s ON s.company_id = t.company_id AND s.id = t.session_id
        WHERE s.campaign_id = p_campaign_id AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
          AND t.status IN ('IN_PROGRESS','PAUSED')

        UNION ALL
        -- Ubicaciones abiertas
        SELECT 'Ubicación', s.name, sz.zone_code, sl.code, 'Abierta', 'Ubicación con tarea abierta'
        FROM inventarios.task_locations tl
        JOIN inventarios.sessions s ON s.company_id = tl.company_id AND s.id = tl.session_id
        LEFT JOIN inventarios.session_zones sz ON sz.company_id = tl.company_id AND sz.session_id = tl.session_id AND sz.id = tl.session_zone_id
        LEFT JOIN inventarios.session_zone_locations szl ON szl.company_id = tl.company_id AND szl.session_id = tl.session_id AND szl.id = tl.session_zone_location_id
        LEFT JOIN inventarios.snapshot_locations sl ON sl.company_id = tl.company_id AND sl.snapshot_id = szl.snapshot_id AND sl.id = szl.snapshot_location_id
        WHERE s.campaign_id = p_campaign_id AND tl.status = 'OPEN'

        UNION ALL
        -- Ubicaciones visitadas sin registros
        SELECT 'Ubicación', s.name, sz.zone_code, sl.code, 'Sin registros', 'Visitada sin conteos efectivos'
        FROM inventarios.task_locations tl
        JOIN inventarios.sessions s ON s.company_id = tl.company_id AND s.id = tl.session_id
        LEFT JOIN inventarios.session_zones sz ON sz.company_id = tl.company_id AND sz.session_id = tl.session_id AND sz.id = tl.session_zone_id
        LEFT JOIN inventarios.session_zone_locations szl ON szl.company_id = tl.company_id AND szl.session_id = tl.session_id AND szl.id = tl.session_zone_location_id
        LEFT JOIN inventarios.snapshot_locations sl ON sl.company_id = tl.company_id AND sl.snapshot_id = szl.snapshot_id AND sl.id = szl.snapshot_location_id
        WHERE s.campaign_id = p_campaign_id
          AND NOT EXISTS (
              SELECT 1
              FROM inventarios.count_entries ce
              JOIN inventarios.session_zone_locations szl2
                ON szl2.company_id = ce.company_id AND szl2.session_id = ce.session_id
               AND szl2.session_zone_id = ce.session_zone_id AND szl2.snapshot_location_id = ce.snapshot_location_id
              WHERE ce.company_id = tl.company_id AND ce.session_id = tl.session_id
                AND szl2.id = tl.session_zone_location_id
                AND ce.invalidated_at IS NULL AND ce.invalidated_by IS NULL AND ce.invalidation_reason IS NULL
          )

        UNION ALL
        -- Productos no incluidos para conteo
        SELECT 'Producto', NULL, NULL, NULL, 'No incluido para conteo',
               csp.sku || ' · ' || coalesce(NULLIF(pg_catalog.btrim(csp.name), ''), 'PRODUCTO ' || csp.bsale_variant_id::text)
        FROM inventarios.inventory_campaign_theoretical_stocks icts
        JOIN inventarios.inventory_campaign_snapshots cs
          ON cs.company_id = icts.company_id AND cs.id = icts.campaign_snapshot_id AND cs.campaign_id = p_campaign_id
        JOIN inventarios.inventory_campaign_snapshot_products csp
          ON csp.company_id = icts.company_id AND csp.campaign_snapshot_id = icts.campaign_snapshot_id AND csp.id = icts.snapshot_product_id
        WHERE icts.company_id = p_company_id AND icts.scope_level = 'TOTAL_CAMPAIGN'
          AND NOT EXISTS (
              SELECT 1 FROM inventarios.snapshot_products sp
              JOIN inventarios.operational_snapshots os ON os.id = sp.snapshot_id AND os.company_id = sp.company_id
              JOIN inventarios.sessions s ON s.company_id = os.company_id AND s.id = os.session_id
              WHERE s.campaign_id = p_campaign_id AND sp.bsale_variant_id = csp.bsale_variant_id
          )

        UNION ALL
        -- Códigos pendientes de revisión
        SELECT 'Código pendiente', s.name, NULL, NULL, 'Pendiente de revisión',
               pbp.scanned_code
        FROM inventarios.product_barcode_proposals pbp
        JOIN inventarios.sessions s ON s.company_id = pbp.company_id AND s.id = pbp.session_id
        WHERE s.campaign_id = p_campaign_id AND pbp.status = 'PENDING_REVIEW'
    ) r;

    RETURN pg_catalog.jsonb_build_object(
        'campaign_id', p_campaign_id,
        'campaign_status', v_campaign_status,
        'contributions', CASE WHEN v_contributions IS NULL THEN '[]'::jsonb ELSE v_contributions END,
        'operational_rows', CASE WHEN v_operational IS NULL THEN '[]'::jsonb ELSE v_operational END
    );
END;
$function$;

-- 3.4
CREATE OR REPLACE FUNCTION inventarios.get_inventory_campaign_product_breakdown(
    p_company_id uuid,
    p_campaign_id uuid,
    p_bsale_variant_id integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_campaign_status text;
    v_header jsonb;
    v_contributions jsonb;
    v_is_final boolean;
    v_active_sessions bigint;
    v_sku text;
    v_name text;
    v_product_id uuid;
    v_theoretical_quantity numeric := 0;
    v_physical_quantity numeric := 0;
    v_unit_cost numeric;
    v_difference_quantity numeric := 0;
    v_in_theoretical_stock boolean := false;
    v_in_any_snapshot boolean := false;
    v_coverage_status text;
    v_variance_status text;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_bsale_variant_id IS NULL THEN
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

    SELECT pg_catalog.count(*) INTO v_active_sessions
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id
      AND s.status IN ('DRAFT','PREPARED','COUNTING','UNDER_REVIEW');
    v_is_final := (v_active_sessions = 0);

    -- Cabecera: teorico global oficial (fuente canonica MATERIALIZED -> IMPORT_FALLBACK).
    SELECT t.theoretical_quantity, t.unit_cost,
           t.sku,
           COALESCE(NULLIF(inventarios.campaign_product_display_name(t.bsale_variant_id), ''), t.sku) AS name,
           t.product_id
    INTO v_theoretical_quantity, v_unit_cost, v_sku, v_name, v_product_id
    FROM inventarios.get_campaign_theoretical_stock(p_company_id, p_campaign_id) t
    WHERE t.bsale_variant_id = p_bsale_variant_id;

    IF FOUND THEN
        v_in_theoretical_stock := true;
    ELSE
        v_theoretical_quantity := 0;
        v_unit_cost := NULL;
        -- Sobrante sin teorico: resolver identidad desde el snapshot de las secciones.
        SELECT sp2.sku, coalesce(NULLIF(inventarios.campaign_product_display_name(sp2.bsale_variant_id), ''), sp2.name), sp2.product_id
        INTO v_sku, v_name, v_product_id
        FROM inventarios.snapshot_products sp2
        WHERE sp2.bsale_variant_id = p_bsale_variant_id
        ORDER BY sp2.sku NULLS LAST
        LIMIT 1;
    END IF;
    IF v_name IS NULL THEN
        v_name := 'PRODUCTO ' || p_bsale_variant_id::text;
    END IF;

    -- ¿Está en algún snapshot de las secciones?
    SELECT EXISTS (
        SELECT 1
        FROM inventarios.snapshot_products sp
        JOIN inventarios.operational_snapshots os ON os.id = sp.snapshot_id AND os.company_id = sp.company_id
        JOIN inventarios.sessions s ON s.company_id = os.company_id AND s.id = os.session_id
        WHERE s.campaign_id = p_campaign_id AND sp.bsale_variant_id = p_bsale_variant_id
    ) INTO v_in_any_snapshot;

    -- Físico efectivo global.
    SELECT coalesce(sum(x.physical_quantity), 0) INTO v_physical_quantity
    FROM (
        SELECT ovi.physical_quantity
        FROM inventarios.official_version_items ovi
        JOIN inventarios.sessions s ON s.company_id = ovi.company_id AND s.id = ovi.session_id
        WHERE ovi.company_id = p_company_id AND s.campaign_id = p_campaign_id
          AND s.status = 'APPROVED' AND v_campaign_status = 'APPROVED'
          AND ovi.bsale_variant_id = p_bsale_variant_id
        UNION ALL
        SELECT ce.physical_quantity
        FROM (
            SELECT t.id AS task_id, t.session_id
            FROM inventarios.tasks t
            JOIN inventarios.sessions s ON s.company_id = t.company_id AND s.id = t.session_id
            WHERE s.campaign_id = p_campaign_id AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
        ) ct
        CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id, false) g
        JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
        WHERE ce.bsale_variant_id = p_bsale_variant_id
          AND coalesce(v_campaign_status, '') <> 'APPROVED'
    ) x;

    IF v_physical_quantity IS NULL THEN v_physical_quantity := 0; END IF;
    v_difference_quantity := v_physical_quantity - v_theoretical_quantity;

    v_coverage_status := CASE
        WHEN v_physical_quantity > 0 THEN 'COUNTED'
        WHEN v_in_any_snapshot THEN 'NOT_COUNTED'
        ELSE 'OUT_OF_SNAPSHOT' END;
    v_variance_status := CASE
        WHEN v_difference_quantity < 0 THEN 'FALTANTE'
        WHEN v_difference_quantity > 0 THEN 'SOBRANTE'
        ELSE 'SIN_DIFERENCIA' END;

    -- Contribuciones detalladas.
    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'session_id', s.id,
                'session_name', s.name,
                'session_status', s.status,
                'zone_code', sz.zone_code,
                'zone_name', sz.display_name,
                'location_code', sl.code,
                'location_name', sl.name,
                'counted_by', ce.counted_by,
                'counted_by_name', inventarios.user_display_name(ce.counted_by),
                'physical_quantity', ce.physical_quantity,
                'identification_method', ce.identification_method,
                'scanned_code', ce.scanned_code,
                'captured_at', ce.captured_at,
                'contribution_source', g.contribution_source,
                'task_cycle', ce.task_cycle
            ) ORDER BY ce.captured_at, s.name, sz.zone_code, sl.code
        )
    END
    INTO v_contributions
    FROM (
        SELECT t.id AS task_id, t.session_id
        FROM inventarios.tasks t
        JOIN inventarios.sessions s ON s.company_id = t.company_id AND s.id = t.session_id
        WHERE s.campaign_id = p_campaign_id AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
    ) ct
    CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id, false) g
    JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
    JOIN inventarios.sessions s ON s.company_id = ce.company_id AND s.id = ce.session_id
    LEFT JOIN inventarios.session_zones sz ON sz.company_id = ce.company_id AND sz.session_id = ce.session_id AND sz.id = ce.session_zone_id
    LEFT JOIN inventarios.snapshot_locations sl ON sl.company_id = ce.company_id AND sl.snapshot_id = ce.snapshot_id AND sl.id = ce.snapshot_location_id
    WHERE ce.bsale_variant_id = p_bsale_variant_id;

    RETURN pg_catalog.jsonb_build_object(
        'campaign_id', p_campaign_id,
        'campaign_status', v_campaign_status,
        'is_final', v_is_final,
        'header', pg_catalog.jsonb_build_object(
            'bsale_variant_id', p_bsale_variant_id,
            'sku', v_sku,
            'name', v_name,
            'product_id', v_product_id,
            'in_theoretical_stock', v_in_theoretical_stock,
            'in_any_snapshot', v_in_any_snapshot,
            'theoretical_quantity', v_theoretical_quantity,
            'physical_quantity', v_physical_quantity,
            'difference_quantity', v_difference_quantity,
            'unit_cost', v_unit_cost,
            'difference_value', coalesce(v_difference_quantity, 0) * coalesce(v_unit_cost, 0),
            'variance_status', v_variance_status,
            'coverage_status', v_coverage_status
        ),
        'contributions', CASE WHEN v_contributions IS NULL THEN '[]'::jsonb ELSE v_contributions END
    );
END;
$function$;

-- 3.5
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

    -- Variantes con ubicacion determinable (conteos efectivos o teorico BY_LOCATION).
    -- Replica exactamente la resolucion de create_inventory_audit.
    DROP TABLE IF EXISTS _inventarios_audit_resolved_variants;
    CREATE TEMP TABLE _inventarios_audit_resolved_variants ON COMMIT DROP AS
    WITH campaign_tasks AS (
        SELECT t.id AS task_id, t.session_id
        FROM inventarios.tasks t
        JOIN inventarios.sessions s ON s.company_id = t.company_id AND s.id = t.session_id
        WHERE t.company_id = p_company_id AND s.campaign_id = p_campaign_id
          AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
    ),
    counted AS (
        SELECT DISTINCT ce.bsale_variant_id
        FROM campaign_tasks ct
        CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id, false) g
        JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
        WHERE ce.bsale_variant_id IS NOT NULL AND ce.snapshot_location_id IS NOT NULL
    ),
    theoretical AS (
        SELECT DISTINCT csp.bsale_variant_id
        FROM inventarios.inventory_campaign_theoretical_stocks icts
        JOIN inventarios.inventory_campaign_snapshots cs
          ON cs.id = icts.campaign_snapshot_id AND cs.company_id = icts.company_id
         AND cs.campaign_id = p_campaign_id
        JOIN inventarios.inventory_campaign_snapshot_products csp
          ON csp.id = icts.snapshot_product_id AND csp.company_id = icts.company_id
        JOIN inventarios.inventory_site_locations isl
          ON isl.id = icts.inventory_site_location_id AND isl.company_id = icts.company_id
        WHERE icts.company_id = p_company_id
          AND icts.scope_level = 'BY_LOCATION'
          AND icts.theoretical_quantity > 0
    )
    SELECT bsale_variant_id FROM counted
    UNION
    SELECT bsale_variant_id FROM theoretical;

    -- Dataset efectivo filtrado (diferencias <> 0) en tabla temporal para paginar
    -- y resumir sobre una sola evaluacion del snapshot efectivo.
    -- Teorico desde la fuente canonica (MATERIALIZED -> IMPORT_FALLBACK).
    DROP TABLE IF EXISTS _inventarios_audit_candidates;
    CREATE TEMP TABLE _inventarios_audit_candidates ON COMMIT DROP AS
    WITH effective AS (
        SELECT d.bsale_variant_id, d.product_id, d.sku, d.name,
               d.physical_quantity, d.contribution_count, d.in_any_snapshot
        FROM inventarios._inventarios_campaign_effective_snapshot(p_company_id, p_campaign_id) d
    ),
    canonical AS (
        SELECT t.bsale_variant_id, t.product_id, t.sku, t.theoretical_quantity, t.unit_cost,
               COALESCE(NULLIF(inventarios.campaign_product_display_name(t.bsale_variant_id), ''), t.sku) AS display_name
        FROM inventarios.get_campaign_theoretical_stock(p_company_id, p_campaign_id) t
    ),
    base AS (
        SELECT c.bsale_variant_id, c.product_id, c.sku,
               COALESCE(NULLIF(e.ef_name, ''), c.display_name) AS name,
               true AS in_theoretical_stock,
               c.theoretical_quantity, c.unit_cost,
               COALESCE(e.physical_quantity, 0) AS physical_quantity,
               COALESCE(e.contribution_count, 0) AS contribution_count,
               COALESCE(e.in_any_snapshot, false) AS in_any_snapshot
        FROM canonical c
        LEFT JOIN (
            SELECT b.bsale_variant_id, b.name AS ef_name, b.physical_quantity,
                   b.contribution_count, b.in_any_snapshot
            FROM effective b
        ) e ON e.bsale_variant_id = c.bsale_variant_id
        UNION ALL
        SELECT ph.bsale_variant_id, ph.product_id, ph.sku, ph.name,
               false, 0::numeric, NULL::numeric,
               ph.physical_quantity, ph.contribution_count, ph.in_any_snapshot
        FROM effective ph
        WHERE NOT EXISTS (SELECT 1 FROM canonical c2 WHERE c2.bsale_variant_id = ph.bsale_variant_id)
    ),
    dataset AS (
        SELECT b.bsale_variant_id, b.product_id, b.sku, b.name, b.in_theoretical_stock,
               b.theoretical_quantity, b.physical_quantity, b.contribution_count, b.unit_cost,
               (b.physical_quantity - b.theoretical_quantity) AS difference_quantity,
               CASE WHEN (b.physical_quantity - b.theoretical_quantity) < 0 THEN 'FALTANTE'
                    WHEN (b.physical_quantity - b.theoretical_quantity) > 0 THEN 'SOBRANTE'
                    ELSE 'SIN_DIFERENCIA' END AS variance_status,
               CASE WHEN b.physical_quantity > 0 THEN 'COUNTED'
                    WHEN b.in_any_snapshot THEN 'NOT_COUNTED'
                    ELSE 'OUT_OF_SNAPSHOT' END AS coverage_status
        FROM base b
    )
    SELECT d.bsale_variant_id, d.product_id, d.sku, d.name,
           d.in_theoretical_stock, d.theoretical_quantity, d.physical_quantity,
           d.contribution_count, d.unit_cost, d.difference_quantity,
           d.variance_status, d.coverage_status,
           CASE WHEN EXISTS (
               SELECT 1 FROM _inventarios_audit_resolved_variants rv
               WHERE rv.bsale_variant_id = d.bsale_variant_id
           ) THEN 'LOCATIONS_RESOLVED' ELSE 'NO_PREVIOUS_LOCATION' END AS scope_status
    FROM dataset d
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
                'scope_status', c.scope_status,
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
                'search_scope_count', (SELECT pg_catalog.count(*) FROM inventarios.inventory_audit_search_scopes sc WHERE sc.audit_id = a.id),
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

-- 4. Prioridades (OWNER/REVOKE/GRANT) de las firmas nuevas
ALTER FUNCTION inventarios.get_applicable_recount_decisions(uuid, uuid, uuid, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.get_applicable_recount_decisions(uuid, uuid, uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION inventarios.get_effective_task_contributions(uuid, uuid, uuid, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.get_effective_task_contributions(uuid, uuid, uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.get_effective_task_contributions(uuid, uuid, uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.list_inventory_campaign_variances(uuid, uuid, text, text, text, integer, integer, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.get_inventory_campaign_review_summary(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.get_inventory_campaign_export(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.get_inventory_campaign_product_breakdown(uuid, uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.list_inventory_audit_candidates(uuid, uuid, text, text, integer, integer, text, text) TO authenticated, service_role;
COMMIT;
