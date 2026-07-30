CREATE OR REPLACE FUNCTION inventarios.get_applicable_recount_decisions(
    p_company_id uuid,
    p_session_id uuid,
    p_task_id uuid
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
ALTER FUNCTION inventarios.get_applicable_recount_decisions(uuid, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.get_applicable_recount_decisions(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
