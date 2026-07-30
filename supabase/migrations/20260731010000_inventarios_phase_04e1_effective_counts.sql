CREATE FUNCTION inventarios.get_effective_count_entries(
    p_company_id uuid,
    p_session_id uuid,
    p_task_id uuid,
    p_recount_request_id uuid
)
RETURNS TABLE (
    root_count_entry_id uuid,
    effective_count_entry_id uuid,
    company_id uuid,
    session_id uuid,
    snapshot_id uuid,
    session_zone_id uuid,
    snapshot_location_id uuid,
    snapshot_product_id uuid,
    task_id uuid,
    task_cycle integer,
    recount_request_id uuid
)
LANGUAGE plpgsql
STABLE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    PERFORM 1 FROM inventarios.sessions s WHERE s.company_id = p_company_id AND s.id = p_session_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;
    IF p_task_id IS NOT NULL THEN
        PERFORM 1 FROM inventarios.tasks t WHERE t.company_id = p_company_id AND t.session_id = p_session_id AND t.id = p_task_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
                DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
        END IF;
    END IF;
    IF p_recount_request_id IS NOT NULL THEN
        PERFORM 1 FROM inventarios.recount_requests rr
        WHERE rr.company_id = p_company_id AND rr.session_id = p_session_id AND rr.id = p_recount_request_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
                DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
        END IF;
        IF p_task_id IS NOT NULL THEN
            PERFORM 1 FROM inventarios.recount_requests rr
            WHERE rr.id = p_recount_request_id AND rr.source_task_id = p_task_id;
            IF NOT FOUND THEN
                RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
                    DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
            END IF;
        END IF;
    END IF;
    PERFORM 1 FROM (
        SELECT 1 FROM inventarios.count_entries ce
        WHERE ce.company_id = p_company_id AND ce.session_id = p_session_id
          AND (p_task_id IS NULL OR ce.task_id = p_task_id)
          AND (
              (p_recount_request_id IS NULL AND ce.recount_request_id IS NULL)
              OR (p_recount_request_id IS NOT NULL AND ce.recount_request_id = p_recount_request_id)
          )
          AND (
              (ce.invalidated_at IS NULL AND ce.invalidated_by IS NOT NULL)
              OR (ce.invalidated_at IS NOT NULL AND ce.invalidated_by IS NULL)
              OR (ce.invalidated_at IS NULL AND ce.invalidation_reason IS NOT NULL)
              OR (ce.invalidated_at IS NOT NULL AND ce.invalidation_reason IS NULL)
              OR (ce.invalidated_by IS NULL AND ce.invalidation_reason IS NOT NULL)
              OR (ce.invalidated_by IS NOT NULL AND ce.invalidation_reason IS NULL)
          )
        LIMIT 1
    ) partial;
    IF FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
            DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',false)::text;
    END IF;
    RETURN QUERY
    WITH scope_entries AS (
        SELECT ce.id, ce.company_id, ce.session_id, ce.snapshot_id, ce.session_zone_id,
               ce.snapshot_location_id, ce.snapshot_product_id, ce.task_id, ce.task_cycle,
               ce.recount_request_id,
               ce.physical_quantity, ce.available_quantity, ce.damaged_quantity,
               ce.expired_quantity, ce.blocked_quantity, ce.other_unavailable_quantity,
               ce.invalidated_at, ce.invalidated_by, ce.invalidation_reason
        FROM inventarios.count_entries ce
        WHERE ce.company_id = p_company_id
          AND ce.session_id = p_session_id
          AND (p_task_id IS NULL OR ce.task_id = p_task_id)
          AND (
              (p_recount_request_id IS NULL AND ce.recount_request_id IS NULL)
              OR (p_recount_request_id IS NOT NULL AND ce.recount_request_id = p_recount_request_id)
          )
    ),
    roots AS (
        SELECT se.*
        FROM scope_entries se
        WHERE NOT EXISTS (
            SELECT 1 FROM inventarios.count_entry_corrections cec
            WHERE cec.company_id = p_company_id AND cec.replacement_count_entry_id = se.id
        )
    ),
    active_corrections AS (
        SELECT cec.root_count_entry_id, cec.replacement_count_entry_id
        FROM inventarios.count_entry_corrections cec
        WHERE cec.company_id = p_company_id
          AND cec.superseded_at IS NULL
          AND cec.root_count_entry_id IN (SELECT r.id FROM roots r)
    ),
    candidates AS (
        SELECT r.id AS root_id,
               COALESCE(ac.replacement_count_entry_id, r.id) AS candidate_id,
               r.company_id, r.session_id, r.snapshot_id, r.session_zone_id,
               r.snapshot_location_id, r.snapshot_product_id,
               r.task_id, r.task_cycle, r.recount_request_id
        FROM roots r
        LEFT JOIN active_corrections ac ON ac.root_count_entry_id = r.id
    ),
    validated AS (
        SELECT c.root_id, c.candidate_id, c.company_id, c.session_id, c.snapshot_id,
               c.session_zone_id, c.snapshot_location_id, c.snapshot_product_id,
               c.task_id, c.task_cycle, c.recount_request_id
        FROM candidates c
        JOIN inventarios.count_entries ce ON ce.id = c.candidate_id AND ce.company_id = p_company_id
        WHERE ce.invalidated_at IS NULL
          AND ce.invalidated_by IS NULL
          AND ce.invalidation_reason IS NULL
          AND ce.session_id = c.session_id
          AND ce.snapshot_id = c.snapshot_id
          AND ce.session_zone_id = c.session_zone_id
          AND ce.snapshot_location_id = c.snapshot_location_id
          AND ce.snapshot_product_id = c.snapshot_product_id
          AND ce.task_id = c.task_id
          AND ce.task_cycle = c.task_cycle
          AND ce.recount_request_id IS NOT DISTINCT FROM c.recount_request_id
          AND ce.physical_quantity = ce.available_quantity + ce.damaged_quantity
              + ce.expired_quantity + ce.blocked_quantity + ce.other_unavailable_quantity
    )
    SELECT v.root_id, v.candidate_id, v.company_id, v.session_id, v.snapshot_id,
           v.session_zone_id, v.snapshot_location_id, v.snapshot_product_id,
           v.task_id, v.task_cycle, v.recount_request_id
    FROM validated v
    ORDER BY v.task_id, v.task_cycle, v.session_zone_id, v.snapshot_product_id, v.root_id;
END;
$$;
ALTER FUNCTION inventarios.get_effective_count_entries(uuid, uuid, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.get_effective_count_entries(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
