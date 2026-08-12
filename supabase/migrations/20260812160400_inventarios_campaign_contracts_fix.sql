-- Corrección de contratos del Informe Global del Inventario (V1).
--
-- Reemplaza get_inventory_campaign_review_summary y
-- get_inventory_campaign_close_readiness para resolver "ubicaciones visitadas
-- sin registros" mediante el vínculo correcto entre task_locations y
-- count_entries (vía session_zone_locations.snapshot_location_id), ya que
-- count_entries no posee session_zone_location_id.
--
-- Esquema afectado EXCLUSIVAMENTE: inventarios.

BEGIN;

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
        SELECT ce.bsale_variant_id, pg_catalog.sum(ce.physical_quantity) AS physical_quantity
        FROM campaign_tasks ct
        CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id) g
        JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
        WHERE ce.bsale_variant_id IS NOT NULL
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
        pg_catalog.coalesce(pg_catalog.sum(CASE WHEN c.variance_status = 'FALTANTE' THEN pg_catalog.abs(c.difference_quantity) ELSE 0 END), 0),
        pg_catalog.coalesce(pg_catalog.sum(CASE WHEN c.variance_status = 'SOBRANTE' THEN c.difference_quantity ELSE 0 END), 0),
        pg_catalog.coalesce(pg_catalog.sum(coalesce(c.difference_quantity,0) * coalesce(c.unit_cost,0)), 0),
        pg_catalog.coalesce(pg_catalog.sum(pg_catalog.abs(coalesce(c.difference_quantity,0) * coalesce(c.unit_cost,0))), 0)
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

    SELECT pg_catalog.count(*) INTO v_pending_barcodes
    FROM inventarios.product_barcode_proposals pbp
    JOIN inventarios.sessions s ON s.company_id = pbp.company_id AND s.id = pbp.session_id
    WHERE s.campaign_id = p_campaign_id AND pbp.status = 'PENDING_REVIEW';

    SELECT pg_catalog.count(*) INTO v_out_of_snapshot
    FROM inventarios.inventory_campaign_theoretical_stocks icts
    JOIN inventarios.inventory_campaign_snapshots cs
      ON cs.company_id = icts.company_id AND cs.id = icts.campaign_snapshot_id AND cs.campaign_id = p_campaign_id
    JOIN inventarios.inventory_campaign_snapshot_products csp
      ON csp.company_id = icts.company_id AND csp.campaign_snapshot_id = icts.campaign_snapshot_id AND csp.id = icts.snapshot_product_id
    WHERE icts.company_id = p_company_id AND icts.scope_level = 'TOTAL_CAMPAIGN'
      AND NOT EXISTS (
          SELECT 1 FROM inventarios.snapshot_products sp
          JOIN inventarios.operational_snapshots os ON os.session_id = sp.snapshot_id AND os.company_id = sp.company_id
          JOIN inventarios.sessions s ON s.company_id = os.company_id AND s.id = os.session_id
          WHERE s.campaign_id = p_campaign_id AND sp.bsale_variant_id = csp.bsale_variant_id
      );

    v_can_close := (
        v_sessions_draft = 0
        AND v_sessions_prepared = 0
        AND v_sessions_counting = 0
        AND v_sessions_review = 0
        AND v_blocking_incidents = 0
        AND v_pending_recounts = 0
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

    RETURN pg_catalog.jsonb_build_object(
        'campaign_id', p_campaign_id,
        'campaign_status', v_campaign_status,
        'can_close', v_can_close,
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

COMMIT;
