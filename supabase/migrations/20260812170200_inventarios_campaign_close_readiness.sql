-- Cierre Global del Inventario (V1) — Readiness ampliada.
--
-- get_inventory_campaign_close_readiness entrega ahora:
--   * can_close_authorized (SUPER_USUARIO OR ADMINISTRATOR activo del campaign);
--   * warnings / warning_count (cobertura incompleta, permitida con confirmación);
--   * blockers / blocker_count (incidentes críticos, recount completado sin
--     decisión) — no permiten cierre.
--
-- Esquema afectado EXCLUSIVAMENTE: inventarios.

BEGIN;

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

    SELECT r.name INTO v_role_name
    FROM portal.users u
    JOIN portal.roles r ON r.id = u.role_id
    WHERE u.id = v_actor_id AND u.is_active = true;
    v_is_super := coalesce(v_role_name = 'SUPER_USUARIO', false);

    SELECT EXISTS (
        SELECT 1 FROM inventarios.inventory_campaign_participants icp
        WHERE icp.company_id = p_company_id
          AND icp.campaign_id = p_campaign_id
          AND icp.user_id = v_actor_id
          AND icp.participant_role = 'ADMINISTRATOR'
          AND icp.active_from <= pg_catalog.now()
          AND icp.revoked_at IS NULL
    ) INTO v_is_campaign_admin;

    v_can_close_authorized := (v_is_super OR v_is_campaign_admin);

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

    SELECT pg_catalog.count(*) INTO v_out_of_snapshot
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

COMMIT;
