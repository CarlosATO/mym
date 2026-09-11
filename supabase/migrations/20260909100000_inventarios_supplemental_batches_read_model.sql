-- Read model for SUPPLEMENTAL_FINDINGS batches available to the ERP.
-- This function is read-only; it does not prepare sessions or write operational data.

CREATE OR REPLACE FUNCTION inventarios.list_inventory_campaign_supplemental_batches(
    p_company_id uuid,
    p_campaign_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_campaign_status text;
    v_batches jsonb;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object(
                'message', 'La solicitud no tiene el formato requerido.',
                'retryable', false
            )::text;
    END IF;

    -- Supplemental operations are restricted to the same SUPER_USUARIO guard.
    v_actor_id := inventarios.require_supplemental_findings_super_user(p_company_id);

    SELECT c.status
    INTO v_campaign_status
    FROM inventarios.inventory_campaigns c
    WHERE c.company_id = p_company_id
      AND c.id = p_campaign_id;

    IF v_campaign_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
            DETAIL = pg_catalog.jsonb_build_object(
                'message', 'El inventario no existe.',
                'retryable', false
            )::text;
    END IF;

    WITH batches AS (
        SELECT
            s.id AS session_id,
            s.status AS session_status,
            s.inventory_site_id,
            site.name AS site_name,
            os.id AS snapshot_id,
            os.completion_status AS snapshot_status,
            os.content_hash,
            fs.consolidated_finding_count,
            fs.pending_count_record_count,
            fs.recorded_count,
            fs.consolidated_physical_quantity,
            fs.pending_physical_quantity,
            COALESCE(ts.task_count, 0) AS task_count,
            ts.task_id,
            ts.task_status,
            COALESCE(zc.enabled_zone_count, 0) AS enabled_zone_count,
            COALESCE(sc.scope_count, 0) AS scope_count,
            ts.current_assignment_id
        FROM inventarios.sessions s
        JOIN inventarios.operational_snapshots os
          ON os.company_id = s.company_id
         AND os.session_id = s.id
        JOIN inventarios.inventory_sites site
          ON site.company_id = s.company_id
         AND site.id = s.inventory_site_id
        JOIN (
            SELECT
                f.supplemental_session_id AS session_id,
                f.supplemental_snapshot_id AS snapshot_id,
                pg_catalog.count(*) AS consolidated_finding_count,
                pg_catalog.count(*) FILTER (WHERE f.count_entry_id IS NULL) AS pending_count_record_count,
                pg_catalog.count(*) FILTER (WHERE f.count_entry_id IS NOT NULL) AS recorded_count,
                COALESCE(pg_catalog.sum(f.quantity), 0) AS consolidated_physical_quantity,
                COALESCE(pg_catalog.sum(f.quantity) FILTER (WHERE f.count_entry_id IS NULL), 0) AS pending_physical_quantity
            FROM inventarios.inventory_campaign_supplemental_findings f
            WHERE f.company_id = p_company_id
              AND f.campaign_id = p_campaign_id
              AND f.status = 'CONSOLIDATED'
              AND f.supplemental_session_id IS NOT NULL
              AND f.supplemental_snapshot_id IS NOT NULL
            GROUP BY f.supplemental_session_id, f.supplemental_snapshot_id
        ) fs
          ON fs.session_id = s.id
         AND fs.snapshot_id = os.id
        LEFT JOIN LATERAL (
            SELECT
                pg_catalog.count(*) AS task_count,
                (pg_catalog.array_agg(t.id ORDER BY t.id) FILTER (WHERE t.task_kind = 'PRIMARY'))[1] AS task_id,
                pg_catalog.max(t.status) FILTER (WHERE t.task_kind = 'PRIMARY') AS task_status,
                (pg_catalog.array_agg(t.current_assignment_id ORDER BY t.current_assignment_id) FILTER (WHERE t.task_kind = 'PRIMARY'))[1] AS current_assignment_id
            FROM inventarios.tasks t
            WHERE t.company_id = s.company_id
              AND t.session_id = s.id
              AND t.task_kind = 'PRIMARY'
              AND t.cancelled_at IS NULL
              AND t.superseded_at IS NULL
              AND t.invalidated_at IS NULL
        ) ts ON true
        LEFT JOIN LATERAL (
            SELECT pg_catalog.count(*) AS enabled_zone_count
            FROM inventarios.session_zones z
            WHERE z.company_id = s.company_id
              AND z.session_id = s.id
              AND z.is_enabled = true
        ) zc ON true
        LEFT JOIN LATERAL (
            SELECT pg_catalog.count(*) AS scope_count
            FROM inventarios.session_product_scopes scope
            WHERE scope.company_id = s.company_id
              AND scope.session_id = s.id
        ) sc ON true
        WHERE s.company_id = p_company_id
          AND s.campaign_id = p_campaign_id
          AND s.session_purpose = 'SUPPLEMENTAL_FINDINGS'
          AND os.company_id = p_company_id
          AND fs.consolidated_finding_count > 0
    ),
    resolved AS (
        SELECT
            b.*,
            (
                b.session_status = 'PREPARED'
                AND v_campaign_status = 'IN_PROGRESS'
                AND b.snapshot_status = 'COMPLETED'
                AND b.content_hash IS NOT NULL
                AND b.pending_count_record_count > 0
                AND b.task_count = 1
                AND b.task_status = 'ASSIGNED'
                AND b.current_assignment_id IS NOT NULL
                AND b.enabled_zone_count > 0
                AND b.scope_count = 0
                AND EXISTS (
                    SELECT 1
                    FROM inventarios.task_assignments ta
                    WHERE ta.company_id = p_company_id
                      AND ta.session_id = b.session_id
                      AND ta.task_id = b.task_id
                      AND ta.id = b.current_assignment_id
                      AND ta.user_id = v_actor_id
                      AND ta.released_at IS NULL
                )
                AND EXISTS (
                    SELECT 1
                    FROM inventarios.session_participants participant
                    WHERE participant.company_id = p_company_id
                      AND participant.session_id = b.session_id
                      AND participant.user_id = v_actor_id
                      AND participant.functional_role = 'COUNTER'
                      AND participant.active_from <= pg_catalog.now()
                      AND participant.revoked_at IS NULL
                )
                AND NOT EXISTS (
                    SELECT 1
                    FROM inventarios.tasks other_task
                    JOIN inventarios.task_assignments other_assignment
                      ON other_assignment.company_id = other_task.company_id
                     AND other_assignment.session_id = other_task.session_id
                     AND other_assignment.task_id = other_task.id
                     AND other_assignment.released_at IS NULL
                    WHERE other_assignment.user_id = v_actor_id
                      AND other_task.status = 'IN_PROGRESS'
                      AND other_task.id <> b.task_id
                      AND other_task.cancelled_at IS NULL
                      AND other_task.superseded_at IS NULL
                      AND other_task.invalidated_at IS NULL
                )
            ) AS can_record_counts
        FROM batches b
    )
    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'supplemental_session_id', r.session_id,
                'supplemental_snapshot_id', r.snapshot_id,
                'session_status', r.session_status,
                'inventory_site_id', r.inventory_site_id,
                'site_name', r.site_name,
                'consolidated_finding_count', r.consolidated_finding_count,
                'pending_count_record_count', r.pending_count_record_count,
                'recorded_count', r.recorded_count,
                'consolidated_physical_quantity', r.consolidated_physical_quantity,
                'pending_physical_quantity', r.pending_physical_quantity,
                'can_record_counts', r.can_record_counts,
                'task_id', r.task_id,
                'task_status', r.task_status
            ) ORDER BY r.site_name, r.session_id
        ),
        '[]'::jsonb
    )
    INTO v_batches
    FROM resolved r;

    RETURN pg_catalog.jsonb_build_object(
        'campaign_id', p_campaign_id,
        'batch_count', pg_catalog.jsonb_array_length(v_batches),
        'batches', v_batches
    );
END;
$function$;

ALTER FUNCTION inventarios.list_inventory_campaign_supplemental_batches(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.list_inventory_campaign_supplemental_batches(uuid, uuid)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.list_inventory_campaign_supplemental_batches(uuid, uuid)
    TO authenticated, service_role;
