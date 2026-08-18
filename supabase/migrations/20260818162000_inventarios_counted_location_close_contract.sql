-- Unify normal counted-location closes and expose the Mobile contract.
-- Schema affected exclusively: inventarios.

BEGIN;

CREATE OR REPLACE FUNCTION inventarios._close_my_counting_location_core(
    p_zone_id uuid,
    p_location_id uuid,
    p_resolution_status text,
    p_reason text,
    p_event_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_company_id uuid;
    v_session_id uuid;
    v_task_id uuid;
    v_task_cycle integer;
    v_assignment_id uuid;
    v_task_location_id uuid;
    v_snapshot_location_id uuid;
    v_event_id uuid;
    v_occurred_at timestamptz := pg_catalog.now();
    v_event_type text;
    v_has_effective_count boolean;
BEGIN
    IF p_zone_id IS NULL OR p_location_id IS NULL OR p_event_key IS NULL
       OR p_resolution_status IS NOT NULL
          AND p_resolution_status NOT IN ('COUNTED', 'EMPTY_REVIEWED', 'OPENED_BY_MISTAKE') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_actor();
    SELECT z.company_id, z.session_id, t.id, t.validation_cycle, a.id
    INTO v_company_id, v_session_id, v_task_id, v_task_cycle, v_assignment_id
    FROM inventarios.task_assignments a
    JOIN inventarios.tasks t ON t.id = a.task_id
    JOIN inventarios.session_zones z ON z.id = t.session_zone_id
    JOIN inventarios.sessions s ON s.id = z.session_id
    JOIN inventarios.session_participants p ON p.id = a.session_participant_id
    WHERE z.id = p_zone_id
      AND a.user_id = v_actor_id
      AND a.released_at IS NULL
      AND p.user_id = v_actor_id
      AND p.active_from <= pg_catalog.now()
      AND p.revoked_at IS NULL
      AND s.status = 'COUNTING'
      AND z.is_enabled
      AND t.status = 'IN_PROGRESS'
      AND t.active_user_id = v_actor_id
      AND t.cancelled_at IS NULL
      AND t.superseded_at IS NULL
      AND t.invalidated_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_ACCESS_DENIED',
            DETAIL=pg_catalog.jsonb_build_object('message','No tienes acceso a esta zona o la sesión no es válida.','retryable',false)::text;
    END IF;
    PERFORM inventarios.require_company_access(v_company_id);

    SELECT tl.id, szl.snapshot_location_id
    INTO v_task_location_id, v_snapshot_location_id
    FROM inventarios.task_locations tl
    JOIN inventarios.session_zone_locations szl ON szl.id = tl.session_zone_location_id
    WHERE tl.company_id = v_company_id
      AND tl.task_id = v_task_id
      AND tl.opened_by = v_actor_id
      AND tl.status = 'OPEN'
      AND szl.session_zone_id = p_zone_id
      AND szl.location_id = p_location_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_LOCATION_NOT_OPEN',
            DETAIL=pg_catalog.jsonb_build_object('message','La ubicación no está abierta por este usuario.','retryable',false)::text;
    END IF;

    IF p_resolution_status = 'COUNTED' THEN
        SELECT EXISTS (
            SELECT 1
            FROM inventarios.count_entries ce
            WHERE ce.company_id = v_company_id
              AND ce.session_id = v_session_id
              AND ce.task_id = v_task_id
              AND ce.task_cycle = v_task_cycle
              AND ce.snapshot_location_id = v_snapshot_location_id
              AND ce.invalidated_at IS NULL
              AND ce.invalidated_by IS NULL
              AND ce.invalidation_reason IS NULL
              AND ce.physical_quantity = ce.available_quantity + ce.damaged_quantity
                  + ce.expired_quantity + ce.blocked_quantity + ce.other_unavailable_quantity
        ) INTO v_has_effective_count;
        IF NOT v_has_effective_count THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_LOCATION_NO_EFFECTIVE_COUNTS',
                DETAIL=pg_catalog.jsonb_build_object('message','Debes registrar al menos un conteo efectivo antes de cerrar la ubicación.','retryable',false)::text;
        END IF;
    END IF;

    v_event_type := CASE WHEN p_resolution_status = 'OPENED_BY_MISTAKE' THEN 'CANCELLED' ELSE 'LOCATION_CLOSED' END;
    UPDATE inventarios.task_locations
    SET status = 'CLOSED',
        closed_at = v_occurred_at,
        closed_by = v_actor_id,
        resolution_status = p_resolution_status
    WHERE id = v_task_location_id AND status = 'OPEN';

    INSERT INTO inventarios.task_events(
        company_id, session_id, session_zone_id, task_id, event_type, reason,
        actor_id, cycle, occurred_at, idempotency_key, source,
        technical_metadata, created_at, created_by
    )
    VALUES(
        v_company_id, v_session_id, p_zone_id, v_task_id, v_event_type,
        pg_catalog.btrim(coalesce(p_reason, p_resolution_status)),
        v_actor_id, v_task_cycle, v_occurred_at, p_event_key, 'ANDROID',
        pg_catalog.jsonb_build_object(
            'task_location_id', v_task_location_id,
            'location_id', p_location_id,
            'zone_id', p_zone_id,
            'resolution_status', p_resolution_status,
            'reason', p_reason
        ),
        v_occurred_at, v_actor_id
    )
    ON CONFLICT (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL
    DO NOTHING
    RETURNING id INTO v_event_id;

    IF v_event_id IS NULL THEN
        SELECT te.id INTO v_event_id
        FROM inventarios.task_events te
        WHERE te.company_id = v_company_id AND te.idempotency_key = p_event_key;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'company_id', v_company_id,
        'session_id', v_session_id,
        'task_id', v_task_id,
        'task_cycle', v_task_cycle,
        'assignment_id', v_assignment_id,
        'task_location_id', v_task_location_id,
        'event_id', v_event_id,
        'occurred_at', v_occurred_at,
        'resolution_status', p_resolution_status,
        'location_id', p_location_id
    );
END;
$function$;

CREATE OR REPLACE FUNCTION inventarios._resolve_my_counting_location(
    p_zone_id uuid,
    p_location_id uuid,
    p_resolution_status text,
    p_reason text,
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_company_id uuid;
    v_operation_name text;
    v_operation jsonb;
    v_operation_id uuid;
    v_close jsonb;
    v_response jsonb;
BEGIN
    IF p_zone_id IS NULL OR p_location_id IS NULL OR p_idempotency_key IS NULL
       OR p_resolution_status NOT IN ('COUNTED', 'EMPTY_REVIEWED', 'OPENED_BY_MISTAKE') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    IF p_resolution_status = 'OPENED_BY_MISTAKE'
       AND pg_catalog.char_length(pg_catalog.btrim(coalesce(p_reason,''))) < 5 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_REASON_REQUIRED',
            DETAIL=pg_catalog.jsonb_build_object('message','Debes indicar el motivo de la apertura accidental.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_actor();
    SELECT z.company_id INTO v_company_id
    FROM inventarios.task_assignments a
    JOIN inventarios.tasks t ON t.id = a.task_id
    JOIN inventarios.session_zones z ON z.id = t.session_zone_id
    JOIN inventarios.sessions s ON s.id = z.session_id
    JOIN inventarios.session_participants p ON p.id = a.session_participant_id
    WHERE z.id = p_zone_id AND a.user_id = v_actor_id AND a.released_at IS NULL
      AND p.user_id = v_actor_id AND p.active_from <= pg_catalog.now()
      AND p.revoked_at IS NULL AND s.status = 'COUNTING' AND z.is_enabled
      AND t.status = 'IN_PROGRESS' AND t.active_user_id = v_actor_id
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL AND t.invalidated_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_ACCESS_DENIED',
            DETAIL=pg_catalog.jsonb_build_object('message','No tienes acceso a esta zona o la sesión no es válida.','retryable',false)::text;
    END IF;
    PERFORM inventarios.require_company_access(v_company_id);

    v_operation_name := CASE WHEN p_resolution_status = 'COUNTED'
        THEN 'inventarios.complete_my_counting_location'
        ELSE 'inventarios.resolve_my_counting_location' END;
    v_operation := inventarios.begin_idempotent_operation(
        v_company_id, v_operation_name, p_idempotency_key,
        inventarios.compute_request_hash(pg_catalog.jsonb_build_object(
            'zone_id', p_zone_id, 'location_id', p_location_id,
            'resolution_status', p_resolution_status, 'reason', p_reason)));
    IF v_operation->>'mode' = 'REPLAY' THEN
        RETURN v_operation->'response_payload';
    END IF;
    v_operation_id := (v_operation->>'operation_id')::uuid;

    v_close := inventarios._close_my_counting_location_core(
        p_zone_id, p_location_id, p_resolution_status, p_reason,
        (pg_catalog.md5(p_idempotency_key::text || ':LOCATION_RESOLVED'))::uuid);
    v_response := pg_catalog.jsonb_build_object(
        'operation', v_operation_name,
        'entity_id', v_close->'task_location_id',
        'state', 'CLOSED',
        'version', NULL::integer,
        'cycle_number', v_close->'task_cycle',
        'assignment_id', v_close->'assignment_id',
        'event_id', v_close->'event_id',
        'replayed', false,
        'occurred_at', v_close->'occurred_at',
        'data', pg_catalog.jsonb_build_object(
            'zone_id', p_zone_id,
            'location_id', p_location_id,
            'task_location_id', v_close->'task_location_id',
            'status', 'CLOSED',
            'resolution_status', p_resolution_status,
            'reason', p_reason,
            'physically_visited', p_resolution_status <> 'OPENED_BY_MISTAKE'
        ));
    RETURN inventarios.complete_idempotent_operation(v_company_id, v_operation_id, (v_close->>'task_location_id')::uuid, v_response);
END;
$function$;

CREATE OR REPLACE FUNCTION inventarios.complete_my_counting_location(
    p_zone_id uuid,
    p_location_id uuid,
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    RETURN inventarios._resolve_my_counting_location(
        p_zone_id, p_location_id, 'COUNTED', 'COUNTED', p_idempotency_key);
END;
$function$;

ALTER FUNCTION inventarios._close_my_counting_location_core(uuid,uuid,text,text,uuid) OWNER TO postgres;
ALTER FUNCTION inventarios._resolve_my_counting_location(uuid,uuid,text,text,uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.complete_my_counting_location(uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios._close_my_counting_location_core(uuid,uuid,text,text,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios._resolve_my_counting_location(uuid,uuid,text,text,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.complete_my_counting_location(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.complete_my_counting_location(uuid,uuid,uuid) TO authenticated;

-- Make switch use the same close mutation and event path. Its outer operation
-- owns idempotency; the core deliberately does not start a nested operation.
DO $migration$
DECLARE
    v_definition text;
    v_new text;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'inventarios.switch_my_counting_location(uuid,uuid,uuid)'::regprocedure
    ) INTO v_definition;
    v_definition := pg_catalog.replace(v_definition, 'v_response jsonb;', E'v_response jsonb;\n     v_close_result jsonb;');
    v_new := $new$
    IF v_cur_tl_id IS NOT NULL THEN
        v_close_result := inventarios._close_my_counting_location_core(
            p_zone_id,
            (SELECT location_id FROM inventarios.session_zone_locations WHERE id = v_cur_szl_id),
            CASE WHEN EXISTS (
                SELECT 1
                FROM inventarios.count_entries ce
                WHERE ce.company_id = v_company_id
                  AND ce.session_id = v_session_id
                  AND ce.task_id = v_task_id
                  AND ce.task_cycle = v_task_cycle
                  AND ce.snapshot_location_id = (SELECT snapshot_location_id FROM inventarios.session_zone_locations WHERE id = v_cur_szl_id)
                  AND ce.invalidated_at IS NULL
                  AND ce.invalidated_by IS NULL
                  AND ce.invalidation_reason IS NULL
                  AND ce.physical_quantity = ce.available_quantity + ce.damaged_quantity
                      + ce.expired_quantity + ce.blocked_quantity + ce.other_unavailable_quantity
            ) THEN 'COUNTED' ELSE NULL END,
            NULL,
            (pg_catalog.md5(p_idempotency_key::text || ':LOCATION_CLOSED'))::uuid
        );
        v_close_event_id := (v_close_result->>'event_id')::uuid;
    END IF;
    $new$;
    IF pg_catalog.strpos(v_definition, 'v_close_event_id') = 0 THEN
        RAISE EXCEPTION 'switch close block not found';
    END IF;
    v_definition := pg_catalog.regexp_replace(
        v_definition,
        E'(?s)IF v_cur_tl_id IS NOT NULL THEN.*?RETURNING id INTO v_close_event_id;\\s*END IF;',
        v_new,
        'n'
    );
    IF pg_catalog.strpos(v_definition, '_close_my_counting_location_core') = 0 THEN
        RAISE EXCEPTION 'switch close block replacement failed';
    END IF;
    EXECUTE v_definition;
END;
$migration$;

-- Zone completion uses the same normal close mutation before completing the zone.
DO $migration$
DECLARE
    v_definition text;
    v_new text;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'inventarios.complete_my_counting_zone(uuid,uuid)'::regprocedure
    ) INTO v_definition;
    v_definition := pg_catalog.replace(v_definition, 'v_response jsonb;', E'v_response jsonb;\n     v_close_result jsonb;');
    v_new := $new$
    -- Cerrar ubicacion OPEN actual del actor (si existe)
    SELECT tl.id, szl.id, sl.code, sl.name
    INTO v_cur_tl_id, v_cur_szl_id, v_cur_code, v_cur_name
    FROM inventarios.task_locations tl
    JOIN inventarios.session_zone_locations szl ON szl.id = tl.session_zone_location_id
    JOIN inventarios.snapshot_locations sl ON sl.id = szl.snapshot_location_id
    WHERE tl.company_id = v_company_id
      AND tl.task_id = v_task_id
      AND tl.opened_by = v_actor_id
      AND tl.status = 'OPEN'
    LIMIT 1;

    IF v_cur_tl_id IS NOT NULL THEN
        v_close_result := inventarios._close_my_counting_location_core(
            p_zone_id,
            (SELECT location_id FROM inventarios.session_zone_locations WHERE id = v_cur_szl_id),
            'COUNTED',
            'ZONE_COMPLETION',
            (pg_catalog.md5(p_idempotency_key::text || ':ZONE_LOCATION_CLOSED'))::uuid
        );
        v_event_id := (v_close_result->>'event_id')::uuid;
    END IF;
    $new$;
    IF pg_catalog.strpos(v_definition, 'v_event_id') = 0 THEN
        RAISE EXCEPTION 'complete_my_counting_zone close block not found';
    END IF;
    v_definition := pg_catalog.regexp_replace(
        v_definition,
        E'(?s)IF v_cur_tl_id IS NOT NULL THEN.*?RETURNING id INTO v_event_id;\\s*END IF;',
        v_new,
        'n'
    );
    IF pg_catalog.strpos(v_definition, '_close_my_counting_location_core') = 0 THEN
        RAISE EXCEPTION 'complete_my_counting_zone close block replacement failed';
    END IF;
    EXECUTE v_definition;
END;
$migration$;

COMMIT;
