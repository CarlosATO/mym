-- M1: Al cancelar una jornada, terminalizar las task_locations que quedaron OPEN.
--
-- Garantias:
-- 1. Es una migracion forward solida: redefine cancel_inventory_session con el
--    mismo cuerpo funcional y agrega, dentro de la MISMA transaccion, un bloque
--    que recorre las task_locations OPEN de las tareas de la jornada, las cierra
--    (status='CLOSED', closed_at, closed_by) y registra un evento LOCATION_CLOSED.
-- 2. Idempotencia de eventos: la idempotency_key del LOCATION_CLOSED se deriva
--    del idempotency_key de la operacion + id de la task_location, por lo que un
--    reintento de cancel_inventory_session (misma key) no duplica eventos.
-- 3. No toca conteos, propuestas ni incidentes (se preservan como ya hacia el RPC).
-- 4. Solo se cierran las OPEN; las ya CLOSED quedan intactas.

BEGIN;

CREATE OR REPLACE FUNCTION inventarios.cancel_inventory_session(
    p_company_id uuid,
    p_session_id uuid,
    p_reason text,
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid; v_operation jsonb; v_operation_id uuid;
    v_reason text; v_session_status text;
    v_cancelled_at timestamptz;
    v_task_row record; v_assignment_row record; v_recount_row record;
    v_task_location_row record;
    v_task_event_idempotency_key uuid;
    v_location_event_idempotency_key uuid;
    v_response jsonb; v_payload jsonb;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL OR p_reason IS NULL
       OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_reason := pg_catalog.btrim(p_reason);
    IF v_reason = '' OR pg_catalog.char_length(v_reason) < 5 OR pg_catalog.char_length(v_reason) > 1000 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.cancel');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.cancel_inventory_session'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_session_id::text));
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.cancel','company_id',p_company_id,
        'session_id',p_session_id,'reason',v_reason);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.session.cancel',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    SELECT s.status INTO v_session_status
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.id = p_session_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;
    IF v_session_status = 'APPROVED' OR v_session_status = 'EXPORTED'
       OR v_session_status = 'RECONCILED' OR v_session_status = 'CANCELLED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no es cancelable en su estado actual.','retryable',false,'session_status',v_session_status)::text;
    END IF;
    IF v_session_status NOT IN ('DRAFT','PREPARED','COUNTING','UNDER_REVIEW') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no permite esta operacion en su estado actual.','retryable',false,'session_status',v_session_status)::text;
    END IF;
    PERFORM inventarios.require_session_participant(p_company_id, p_session_id, 'ADMINISTRATOR');
    v_cancelled_at := pg_catalog.now();
    FOR v_task_row IN
        SELECT t.id, t.session_zone_id, t.status, t.version, t.validation_cycle,
               t.current_assignment_id, t.active_user_id
        FROM inventarios.tasks t
        WHERE t.company_id = p_company_id AND t.session_id = p_session_id
          AND t.cancelled_at IS NULL AND t.cancelled_by IS NULL
          AND t.status IN ('ASSIGNED','IN_PROGRESS','PAUSED')
        ORDER BY t.id
        FOR UPDATE
    LOOP
        FOR v_assignment_row IN
            SELECT ta.id, ta.user_id
            FROM inventarios.task_assignments ta
            WHERE ta.company_id = p_company_id AND ta.session_id = p_session_id
              AND ta.task_id = v_task_row.id AND ta.released_at IS NULL
            ORDER BY ta.id
            FOR UPDATE
        LOOP
            UPDATE inventarios.task_assignments ta
            SET released_at = v_cancelled_at, released_by = v_actor_id,
                release_reason = v_reason
            WHERE ta.company_id = p_company_id AND ta.id = v_assignment_row.id;
        END LOOP;
        v_task_event_idempotency_key := (pg_catalog.md5(
            p_idempotency_key::text || ':' || v_task_row.id::text || ':CANCELLED'
        ))::uuid;
        INSERT INTO inventarios.task_events (
            company_id, session_id, session_zone_id,
            task_id, event_type, actor_id, previous_user_id, next_user_id, cycle,
            occurred_at, reason, idempotency_key, technical_metadata, created_by
        ) VALUES (
            p_company_id, p_session_id, v_task_row.session_zone_id, v_task_row.id,
            'CANCELLED', v_actor_id, v_task_row.active_user_id, NULL::uuid,
            v_task_row.validation_cycle, v_cancelled_at, v_reason, v_task_event_idempotency_key,
            pg_catalog.jsonb_build_object('session_cancelled', true,
                'previous_assignment_id', v_task_row.current_assignment_id,
                'previous_user_id', v_task_row.active_user_id),
            v_actor_id
        );
        -- Transicion atomica: el estado sale de IN_PROGRESS/PAUSED en la misma
        -- sentencia que libera active_user_id, cumpliendo
        -- chk_inventarios_tasks_active_user. El estado ASSIGNED con flags de
        -- cancelacion es la representacion terminal permitida por
        -- chk_inventarios_tasks_status.
        UPDATE inventarios.tasks t
        SET status = 'ASSIGNED',
            cancelled_at = v_cancelled_at, cancelled_by = v_actor_id,
            current_assignment_id = NULL, active_user_id = NULL,
            version = t.version + 1, updated_at = v_cancelled_at, updated_by = v_actor_id
        WHERE t.company_id = p_company_id AND t.id = v_task_row.id
          AND t.status = v_task_row.status
          AND t.version = v_task_row.version;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
                DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
        END IF;
    END LOOP;
    -- M1: terminalizar las task_locations OPEN de la jornada en la misma
    -- transaccion. Solo las OPEN; las CLOSED quedan intactas.
    FOR v_task_location_row IN
        SELECT tl.id, tl.session_zone_id, tl.task_id, t.validation_cycle
        FROM inventarios.task_locations tl
        JOIN inventarios.tasks t
          ON t.company_id = tl.company_id AND t.id = tl.task_id
        WHERE tl.company_id = p_company_id AND tl.session_id = p_session_id
          AND tl.status = 'OPEN'
        ORDER BY tl.id
        FOR UPDATE OF tl
    LOOP
        UPDATE inventarios.task_locations tl
        SET status = 'CLOSED',
            closed_at = v_cancelled_at,
            closed_by = v_actor_id
        WHERE tl.company_id = p_company_id AND tl.id = v_task_location_row.id
          AND tl.status = 'OPEN';
        IF FOUND THEN
            v_location_event_idempotency_key := (pg_catalog.md5(
                p_idempotency_key::text || ':' || v_task_location_row.id::text || ':LOCATION_CLOSED'
            ))::uuid;
            INSERT INTO inventarios.task_events (
                company_id, session_id, session_zone_id,
                task_id, event_type, actor_id, cycle,
                occurred_at, reason, idempotency_key, source,
                technical_metadata, created_by
            ) VALUES (
                p_company_id, p_session_id, v_task_location_row.session_zone_id,
                v_task_location_row.task_id, 'LOCATION_CLOSED', v_actor_id,
                v_task_location_row.validation_cycle, v_cancelled_at, v_reason,
                v_location_event_idempotency_key, 'WEB',
                pg_catalog.jsonb_build_object('session_cancelled', true,
                    'terminal_status','CLOSED'),
                v_actor_id
            )
            ON CONFLICT (company_id, idempotency_key)
            WHERE idempotency_key IS NOT NULL
            DO NOTHING;
        END IF;
    END LOOP;
    FOR v_recount_row IN
        SELECT rr.id, rr.status, rr.cycle_number
        FROM inventarios.recount_requests rr
        WHERE rr.company_id = p_company_id AND rr.session_id = p_session_id
          AND rr.status IN ('REQUESTED','ASSIGNED','IN_PROGRESS')
          AND rr.cancelled_at IS NULL AND rr.cancelled_by IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM inventarios.recount_decisions rd
              WHERE rd.company_id = rr.company_id AND rd.recount_request_id = rr.id
          )
        ORDER BY rr.id
        FOR UPDATE
    LOOP
        UPDATE inventarios.recount_requests rr
        SET status = 'CANCELLED', cancelled_at = v_cancelled_at,
            cancelled_by = v_actor_id, cancellation_reason = v_reason,
            updated_at = v_cancelled_at, updated_by = v_actor_id
        WHERE rr.company_id = p_company_id AND rr.id = v_recount_row.id
          AND rr.status = v_recount_row.status
          AND rr.cancelled_at IS NULL AND rr.cancelled_by IS NULL
          AND rr.completed_at IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
                DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
        END IF;
    END LOOP;
    UPDATE inventarios.sessions s
    SET status = 'CANCELLED', cancelled_at = v_cancelled_at,
        cancelled_by = v_actor_id, cancellation_reason = v_reason,
        updated_at = v_cancelled_at, updated_by = v_actor_id
    WHERE s.company_id = p_company_id AND s.id = p_session_id
      AND s.status NOT IN ('APPROVED','EXPORTED','RECONCILED','CANCELLED');
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
            DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;
    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.cancel','entity_id',p_session_id,
        'state','CANCELLED','version',NULL::integer,'cycle_number',NULL::integer,
        'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,
        'occurred_at',v_cancelled_at,
        'data',pg_catalog.jsonb_build_object('cancelled_at',v_cancelled_at,
            'cancelled_by',v_actor_id,'reason',v_reason,
            'preserved_snapshot',true,'preserved_counts',true,
            'preserved_incidents',true));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_session_id, v_response);
END;
$function$;

COMMIT;
