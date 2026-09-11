-- Migration: 20260904000000_inventarios_campaign_close_canonical_theoretical.sql
-- Description: Las 3 funciones criticas del cierre obtienen el teorico canonico
--              via inventarios.get_campaign_theoretical_stock (MATERIALIZED ->
--              IMPORT_FALLBACK) en lugar de leer directamente
--              inventory_campaign_theoretical_stocks + inventory_campaign_snapshot.
--              Asi la cadena no interpreta teorico = 0 cuando la campana aun no
--              tiene inventory_campaign_snapshot materializado.
--
-- Alcance (solo fuente de teorico; no se toca nada mas):
--   * get_inventory_campaign_review_summary
--   * list_inventory_campaign_variances
--   * get_inventory_campaign_close_readiness
--
-- Se mantienen: firmas, permisos (EXECUTE), SECURITY DEFINER, search_path,
-- paginacion/filtros/orden, estructura JSON de salida, calculos existentes y
-- comportamiento fisico actual (physical proviene de count_entries /
-- official_version_items, sin cambios).
--
-- NO toca count_entries, snapshots, importacion, tareas, sesiones, auditorias,
-- reconteos, breakdown/export/readiness_detail ni UI.

BEGIN;

-- ============================================================================
-- 1. get_inventory_campaign_close_readiness
--    Solo el conteo productos_out_of_snapshot pasa a resolver el teorico desde
--    la fuente canonica (antes leia inventory_campaign_theoretical_stocks +
--    inventory_campaign_snapshot, vacio cuando no hay snapshot -> universos y
--    warnings incorrectos).
-- ============================================================================
CREATE OR REPLACE FUNCTION inventarios.get_inventory_campaign_close_readiness(
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
    v_sessions_draft bigint := 0;
    v_sessions_prepared bigint := 0;
    v_sessions_counting bigint := 0;
    v_sessions_review bigint := 0;
    v_sessions_approved bigint := 0;
    v_tasks_assigned bigint := 0;
    v_tasks_in_progress bigint := 0;
    v_tasks_paused bigint := 0;
    v_locations_open bigint := 0;
    v_locations_never_visited bigint := 0;
    v_locations_visited_no_counts bigint := 0;
    v_zones_not_started bigint := 0;
    v_zones_incomplete bigint := 0;
    v_blocking_incidents bigint := 0;
    v_pending_recounts bigint := 0;
    v_pending_barcodes bigint := 0;
    v_out_of_snapshot bigint := 0;
    v_locations_total bigint := 0;
    v_locations_visited bigint := 0;
    v_zones_total bigint := 0;
    v_zones_completed bigint := 0;
    v_can_close boolean;
    v_warnings jsonb;
    v_role_name text;
    v_is_super boolean := false;
    v_is_campaign_admin boolean := false;
    v_can_close_authorized boolean := false;
    v_undecided_recount bigint := 0;
    v_blocker_count bigint := 0;
    v_warning_count bigint := 0;
    v_blockers jsonb;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');

    v_can_close_authorized := core.has_permission_for_company(v_actor_id, p_company_id, 'inventarios.campaigns.manage');

    SELECT ic.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id;
    IF v_campaign_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario no existe.','retryable',false)::text;
    END IF;

    SELECT
        pg_catalog.count(*) FILTER (WHERE status = 'DRAFT'),
        pg_catalog.count(*) FILTER (WHERE status = 'PREPARED'),
        pg_catalog.count(*) FILTER (WHERE status = 'COUNTING'),
        pg_catalog.count(*) FILTER (WHERE status = 'UNDER_REVIEW'),
        pg_catalog.count(*) FILTER (WHERE status = 'APPROVED')
    INTO v_sessions_draft, v_sessions_prepared, v_sessions_counting, v_sessions_review, v_sessions_approved
    FROM inventarios.sessions s WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id;

    SELECT
        pg_catalog.count(*) FILTER (WHERE t.status = 'ASSIGNED'),
        pg_catalog.count(*) FILTER (WHERE t.status = 'IN_PROGRESS'),
        pg_catalog.count(*) FILTER (WHERE t.status = 'PAUSED')
    INTO v_tasks_assigned, v_tasks_in_progress, v_tasks_paused
    FROM inventarios.tasks t
    JOIN inventarios.sessions s ON s.company_id = t.company_id AND s.id = t.session_id
    WHERE s.campaign_id = p_campaign_id AND t.cancelled_at IS NULL AND t.superseded_at IS NULL;

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
        pg_catalog.count(*) FILTER (WHERE task_status = 'ASSIGNED'),
        pg_catalog.count(*) FILTER (WHERE task_status IN ('IN_PROGRESS','PAUSED'))
    INTO v_zones_total, v_zones_completed, v_zones_not_started, v_zones_incomplete
    FROM z;

    SELECT pg_catalog.count(*) INTO v_blocking_incidents
    FROM inventarios.incidents i
    JOIN inventarios.sessions s ON s.company_id = i.company_id AND s.id = i.session_id
    WHERE s.campaign_id = p_campaign_id AND i.is_blocking = true AND i.status IN ('OPEN','UNDER_REVIEW');

    SELECT pg_catalog.count(*) INTO v_pending_recounts
    FROM inventarios.recount_requests rr
    JOIN inventarios.sessions s ON s.company_id = rr.company_id AND s.id = rr.session_id
    WHERE s.campaign_id = p_campaign_id AND rr.status IN ('REQUESTED','ASSIGNED','IN_PROGRESS');

    SELECT pg_catalog.count(*) INTO v_undecided_recount
    FROM inventarios.recount_requests rr
    JOIN inventarios.sessions s ON s.company_id = rr.company_id AND s.id = rr.session_id
    WHERE s.campaign_id = p_campaign_id AND rr.status = 'COMPLETED'
      AND NOT EXISTS (
          SELECT 1 FROM inventarios.recount_decisions rd
          WHERE rd.company_id = rr.company_id AND rd.recount_request_id = rr.id
      );

    SELECT pg_catalog.count(*) INTO v_pending_barcodes
    FROM inventarios.product_barcode_proposals pbp
    JOIN inventarios.sessions s ON s.company_id = pbp.company_id AND s.id = pbp.session_id
    WHERE s.campaign_id = p_campaign_id AND pbp.status = 'PENDING_REVIEW';

    -- Teorico canonico (MATERIALIZED -> IMPORT_FALLBACK): productos con teorico
    -- que NO estan presentes en ningun snapshot de las secciones de la campana.
    SELECT pg_catalog.count(*) INTO v_out_of_snapshot
    FROM inventarios.get_campaign_theoretical_stock(p_company_id, p_campaign_id) t
    WHERE t.bsale_variant_id IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM inventarios.snapshot_products sp
          JOIN inventarios.operational_snapshots os ON os.id = sp.snapshot_id AND os.company_id = sp.company_id
          JOIN inventarios.sessions s ON s.company_id = os.company_id AND s.id = os.session_id
          WHERE s.campaign_id = p_campaign_id AND sp.bsale_variant_id = t.bsale_variant_id
      );

    v_blocker_count := 0;
    IF v_blocking_incidents > 0 OR v_undecided_recount > 0 THEN
        v_blocker_count := v_blocker_count + 1;
    END IF;

    v_warning_count := 0;
    IF v_sessions_draft > 0 OR v_sessions_prepared > 0 OR v_sessions_counting > 0
       OR v_sessions_review > 0 OR v_locations_open > 0 OR v_locations_never_visited > 0
       OR v_locations_visited_no_counts > 0 OR v_zones_not_started > 0
       OR v_zones_incomplete > 0 OR v_pending_barcodes > 0 OR v_out_of_snapshot > 0 THEN
        v_warning_count := v_warning_count + 1;
    END IF;

    v_can_close := (
        v_blocker_count = 0
        AND v_warning_count = 0
    );

    v_warnings := pg_catalog.jsonb_build_object(
        'sessions_draft', v_sessions_draft,
        'sessions_prepared', v_sessions_prepared,
        'sessions_counting', v_sessions_counting,
        'sessions_under_review', v_sessions_review,
        'tasks_assigned', v_tasks_assigned,
        'tasks_in_progress', v_tasks_in_progress,
        'tasks_paused', v_tasks_paused,
        'locations_open', v_locations_open,
        'locations_never_visited', v_locations_never_visited,
        'locations_visited_without_counts', v_locations_visited_no_counts,
        'zones_not_started', v_zones_not_started,
        'zones_incomplete', v_zones_incomplete,
        'blocking_incident_count', v_blocking_incidents,
        'pending_recount_count', v_pending_recounts,
        'pending_barcode_proposals', v_pending_barcodes,
        'products_out_of_snapshot', v_out_of_snapshot
    );

    v_blockers := pg_catalog.jsonb_build_object(
        'blocking_incident_count', v_blocking_incidents,
        'undecided_recount_count', v_undecided_recount
    );

    RETURN pg_catalog.jsonb_build_object(
        'campaign_id', p_campaign_id,
        'campaign_status', v_campaign_status,
        'can_close', v_can_close,
        'can_close_authorized', v_can_close_authorized,
        'warning_count', v_warning_count,
        'blocker_count', v_blocker_count,
        'blockers', v_blockers,
        'summary', pg_catalog.jsonb_build_object(
            'sessions_total', v_sessions_draft + v_sessions_prepared + v_sessions_counting + v_sessions_review + v_sessions_approved,
            'sessions_approved', v_sessions_approved,
            'zones_total', v_zones_total,
            'zones_completed', v_zones_completed,
            'locations_total', v_locations_total,
            'locations_visited', v_locations_visited
        ),
        'warnings', v_warnings
    );
END;
$function$;

GRANT EXECUTE ON FUNCTION inventarios.get_inventory_campaign_close_readiness(uuid, uuid) TO authenticated, service_role;

-- ============================================================================
-- 2. get_inventory_campaign_review_summary
--    El conteo products_theoretical y el CTE theoretical ahora se resuelven
--    desde la fuente canonica; el resto (fisico, base, computed, JSON) no cambia.
-- ============================================================================
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
    FROM inventarios.get_campaign_theoretical_stock(p_company_id, p_campaign_id) t
    WHERE t.bsale_variant_id IS NOT NULL AND t.theoretical_quantity IS NOT NULL;

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
        SELECT t.bsale_variant_id, t.theoretical_quantity, t.unit_cost
        FROM inventarios.get_campaign_theoretical_stock(p_company_id, p_campaign_id) t
        WHERE t.bsale_variant_id IS NOT NULL AND t.theoretical_quantity IS NOT NULL
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

GRANT EXECUTE ON FUNCTION inventarios.get_inventory_campaign_review_summary(uuid, uuid) TO authenticated, service_role;

-- ============================================================================
-- 3. list_inventory_campaign_variances
--    El universo teorico (CTE theoretical, antes construido leyendo
--    stock_import_rows con row_status='VALID' y dedupe por product_id) pasa a
--    resolverse desde la fuente canonica. El nombre se resuelve con el helper
--    canonico de display y el resto (fisico, base, computed, filtros, orden,
--    paginacion, JSON) no cambia.
-- ============================================================================
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
    theoretical AS (
        SELECT t.bsale_variant_id, t.product_id, t.sku,
               coalesce(nullif(btrim(ed.entered_description), ''), t.sku) AS name,
               t.theoretical_quantity, t.unit_cost
        FROM inventarios.get_campaign_theoretical_stock(p_company_id, p_campaign_id) t
        LEFT JOIN LATERAL (
            SELECT r.entered_description
            FROM inventarios.stock_import_rows r
            JOIN inventarios.stock_imports si ON si.id = r.import_id
            WHERE si.company_id = p_company_id AND si.campaign_id = p_campaign_id
              AND si.status = 'VALIDATED' AND si.theoretical_scope = 'TOTAL_CAMPAIGN'
              AND r.company_id = p_company_id AND r.bsale_variant_id = t.bsale_variant_id
              AND r.row_status IN ('VALID', 'WARNING')
            ORDER BY r.row_index, r.id
            LIMIT 1
        ) ed ON true
        WHERE t.bsale_variant_id IS NOT NULL AND t.theoretical_quantity IS NOT NULL
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
    ), theoretical AS (
        SELECT t.bsale_variant_id, t.product_id, t.sku,
               coalesce(nullif(btrim(ed.entered_description), ''), t.sku) AS name,
               t.theoretical_quantity, t.unit_cost
        FROM inventarios.get_campaign_theoretical_stock(p_company_id, p_campaign_id) t
        LEFT JOIN LATERAL (
            SELECT r.entered_description
            FROM inventarios.stock_import_rows r
            JOIN inventarios.stock_imports si ON si.id = r.import_id
            WHERE si.company_id = p_company_id AND si.campaign_id = p_campaign_id
              AND si.status = 'VALIDATED' AND si.theoretical_scope = 'TOTAL_CAMPAIGN'
              AND r.company_id = p_company_id AND r.bsale_variant_id = t.bsale_variant_id
              AND r.row_status IN ('VALID', 'WARNING')
            ORDER BY r.row_index, r.id
            LIMIT 1
        ) ed ON true
        WHERE t.bsale_variant_id IS NOT NULL AND t.theoretical_quantity IS NOT NULL
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
    ), theoretical AS (
        SELECT t.bsale_variant_id, t.product_id, t.sku,
               coalesce(nullif(btrim(ed.entered_description), ''), t.sku) AS name,
               t.theoretical_quantity, t.unit_cost
        FROM inventarios.get_campaign_theoretical_stock(p_company_id, p_campaign_id) t
        LEFT JOIN LATERAL (
            SELECT r.entered_description
            FROM inventarios.stock_import_rows r
            JOIN inventarios.stock_imports si ON si.id = r.import_id
            WHERE si.company_id = p_company_id AND si.campaign_id = p_campaign_id
              AND si.status = 'VALIDATED' AND si.theoretical_scope = 'TOTAL_CAMPAIGN'
              AND r.company_id = p_company_id AND r.bsale_variant_id = t.bsale_variant_id
              AND r.row_status IN ('VALID', 'WARNING')
            ORDER BY r.row_index, r.id
            LIMIT 1
        ) ed ON true
        WHERE t.bsale_variant_id IS NOT NULL AND t.theoretical_quantity IS NOT NULL
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

GRANT EXECUTE ON FUNCTION inventarios.list_inventory_campaign_variances(uuid, uuid, text, text, text, integer, integer, text, text) TO authenticated, service_role;

COMMIT;
