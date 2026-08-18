-- =========================================================================================
-- MIGRATION: M1.5H fix - Overlay AUDIT: snapshot_product_id via count sintetico
-- =========================================================================================
-- El CTE approved_audit_scopes de get_effective_task_contributions referenciaba
-- i.snapshot_product_id, columna que no existe en inventory_audit_resolution_items.
-- El snapshot_product_id del scope aprobado se obtiene del count sintetico AUDIT
-- (synthetic_count_entry_id -> count_entries.snapshot_product_id), que si lo tiene.
-- Esquema afectado EXCLUSIVAMENTE: inventarios.
-- =========================================================================================

BEGIN;

CREATE OR REPLACE FUNCTION inventarios.get_effective_task_contributions(p_company_id uuid, p_session_id uuid, p_task_id uuid)
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
        FROM inventarios.get_applicable_recount_decisions(p_company_id, p_session_id, p_task_id) rd
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

ALTER FUNCTION inventarios.get_effective_task_contributions(uuid, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.get_effective_task_contributions(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.get_effective_task_contributions(uuid, uuid, uuid) TO authenticated;

COMMIT;
