-- =========================================================================================
-- MIGRATION M2-FIX2: 20260811390040_inventarios_mobile_count_ownership_fix.sql
-- =========================================================================================
-- Brecha detectada: correct_my_counting_quantity e invalidate_my_counting_record NO
-- validaban explícitamente que el count_entry origen pertenezca al COUNTER autenticado
-- (contaban con el contexto task/zone/location, que es insuficiente frente a reasignaciones
-- o conteos de otro COUNTER en la misma ubicacion).
-- Ademas, correct_my_counting_quantity sobrescribia v_actor_id con ce.counted_by del
-- current (bug): el replacement quedaba con counted_by/created_by del dueño del current en
-- vez del actor autenticado que ejecuta la correccion.
-- Correcciones (solo esquema inventarios):
--  1) En ambas RPC: validar ce.counted_by = v_actor_id en el root y en el current efectivo,
--     rechazando con INV_ACCESS_DENIED si no coincide.
--  2) En correct: no pisar v_actor_id; usar variable v_current_counted_by; el replacement
--     se crea con counted_by/created_by/session_participant_id del root (el COUNTER original
--     que, por la guarda, es el mismo actor) y corrected_by = actor autenticado.
-- No se cambian firmas, envelopes, permisos ni comportamiento de otras RPC.

CREATE OR REPLACE FUNCTION inventarios.correct_my_counting_quantity(p_zone_id uuid, p_location_id uuid, p_root_count_entry_id uuid, p_expected_current_count_entry_id uuid, p_physical_quantity numeric, p_reason text, p_idempotency_key uuid, p_device_id text, p_captured_at timestamptz)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_company_id uuid;
    v_session_id uuid;
    v_snapshot_id uuid;
    v_session_zone_id uuid;
    v_task_id uuid;
    v_task_cycle integer;
    v_assignment_id uuid;
    v_is_authorized boolean := false;
    v_szl_id uuid;
    v_snapshot_location_id uuid;
    v_reason text;
    v_devid text;
    v_current_id uuid;
    v_prev_correction_id uuid;
    v_prev_revision integer;
    v_revision_number integer;
    v_root_inv_at timestamptz;
    v_eff_inv_at timestamptz;
    v_pid uuid; v_vid integer; v_lid uuid; v_rid uuid; v_sid uuid; v_szid uuid; v_tid uuid; v_cyc integer;
    v_participant_id uuid;
    v_aid uuid;
    v_eff_ident text; v_eff_scanned text; v_eff_recount uuid;
    v_root_counted_by uuid;
    v_current_counted_by uuid;
    v_phys numeric(14,3);
    v_avail numeric(14,3); v_dam numeric(14,3); v_exp numeric(14,3); v_blk numeric(14,3); v_oth numeric(14,3);
    v_new_avail numeric(14,3);
    v_occ timestamptz; v_cap timestamptz;
    v_repl uuid;
    v_payload jsonb; v_request_hash text;
    v_operation jsonb; v_operation_id uuid;
    v_response jsonb;
BEGIN
    IF p_zone_id IS NULL OR p_location_id IS NULL OR p_root_count_entry_id IS NULL
       OR p_expected_current_count_entry_id IS NULL
       OR p_physical_quantity IS NULL OR p_physical_quantity < 0
       OR p_reason IS NULL OR p_idempotency_key IS NULL OR p_captured_at IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;
    v_reason := pg_catalog.btrim(p_reason);
    IF v_reason = '' OR pg_catalog.length(v_reason) < 5 OR pg_catalog.length(v_reason) > 500 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;
    IF p_device_id IS NOT NULL THEN
        v_devid := pg_catalog.btrim(p_device_id);
        IF v_devid = '' THEN v_devid := NULL; END IF;
    END IF;
    IF v_devid IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'Device ID es obligatorio.', 'retryable', false)::text;
    END IF;

    v_actor_id := inventarios.require_actor();

    SELECT z.company_id, t.id, z.session_id, z.snapshot_id, z.id, t.validation_cycle, a.id, true
    INTO v_company_id, v_task_id, v_session_id, v_snapshot_id, v_session_zone_id, v_task_cycle, v_assignment_id, v_is_authorized
    FROM inventarios.task_assignments a
    JOIN inventarios.tasks t ON t.id = a.task_id
    JOIN inventarios.session_zones z ON z.id = t.session_zone_id
    JOIN inventarios.sessions s ON s.id = z.session_id
    JOIN inventarios.session_participants p ON p.id = a.session_participant_id
    WHERE z.id = p_zone_id
      AND a.user_id = v_actor_id
      AND a.released_at IS NULL
      AND p.user_id = v_actor_id
      AND p.functional_role = 'COUNTER'
      AND p.active_from <= pg_catalog.now()
      AND p.revoked_at IS NULL
      AND s.status = 'COUNTING'
      AND z.is_enabled = true
      AND t.status = 'IN_PROGRESS'
      AND t.active_user_id = v_actor_id
      AND t.cancelled_at IS NULL
      AND t.superseded_at IS NULL
      AND t.invalidated_at IS NULL;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;
    PERFORM inventarios.require_company_access(v_company_id);

    SELECT szl.id, szl.snapshot_location_id
    INTO v_szl_id, v_snapshot_location_id
    FROM inventarios.session_zone_locations szl
    WHERE szl.company_id = v_company_id
      AND szl.session_id = v_session_id
      AND szl.session_zone_id = p_zone_id
      AND szl.location_id = p_location_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta ubicación.', 'retryable', false)::text;
    END IF;

    v_payload := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.mobile.count.correct',
        'zone_id', p_zone_id,
        'location_id', p_location_id,
        'root_count_entry_id', p_root_count_entry_id,
        'expected_current_count_entry_id', p_expected_current_count_entry_id,
        'physical_quantity', p_physical_quantity,
        'reason', v_reason,
        'device_id', v_devid,
        'captured_at', p_captured_at
    );
    v_request_hash := inventarios.compute_request_hash(v_payload);
    v_operation := inventarios.begin_idempotent_operation(v_company_id, 'inventarios.mobile.count.correct', p_idempotency_key, v_request_hash);
    IF v_operation ->> 'mode' = 'REPLAY' THEN
        RETURN v_operation -> 'response_payload';
    END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.mobile.count.correct'),
        pg_catalog.hashtext(v_company_id::text || ':' || p_root_count_entry_id::text)
    );

    -- Root: contexto, PROPIEDAD del actor, ubicacion y no invalidado
    SELECT ce.session_id, ce.snapshot_id, ce.session_zone_id, ce.task_id, ce.task_cycle,
           ce.snapshot_product_id, ce.bsale_variant_id, ce.snapshot_location_id, ce.invalidated_at,
           ce.session_participant_id, ce.counted_by
    INTO v_sid, v_szid, v_rid, v_tid, v_cyc, v_pid, v_vid, v_lid, v_root_inv_at,
         v_participant_id, v_root_counted_by
    FROM inventarios.count_entries ce
    WHERE ce.company_id = v_company_id AND ce.id = p_root_count_entry_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
    END IF;
    IF v_tid IS DISTINCT FROM v_task_id OR v_rid IS DISTINCT FROM v_session_zone_id
       OR v_lid IS DISTINCT FROM v_snapshot_location_id OR v_sid IS DISTINCT FROM v_session_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta ubicación.', 'retryable', false)::text;
    END IF;
    -- Propiedad individual obligatoria: solo el COUNTER que creó el conteo puede corregirlo.
    IF v_root_counted_by IS DISTINCT FROM v_actor_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a este registro de conteo.', 'retryable', false)::text;
    END IF;
    IF v_root_inv_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_COUNT_ALREADY_INVALIDATED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El conteo ya ha sido invalidado.', 'retryable', false, 'count_entry_id', p_root_count_entry_id)::text;
    END IF;

    -- Correccion activa previa y current efectivo
    SELECT cec.id, cec.revision_number, cec.replacement_count_entry_id
    INTO v_prev_correction_id, v_prev_revision, v_current_id
    FROM inventarios.count_entry_corrections cec
    WHERE cec.company_id = v_company_id AND cec.root_count_entry_id = p_root_count_entry_id AND cec.superseded_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
        v_current_id := p_root_count_entry_id;
        v_prev_correction_id := NULL;
        v_prev_revision := NULL;
    END IF;
    IF v_current_id IS DISTINCT FROM p_expected_current_count_entry_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
            DETAIL = pg_catalog.jsonb_build_object('message', 'Se detecto una modificacion concurrente.', 'retryable', true, 'current_count_entry_id', v_current_id)::text;
    END IF;

    -- Current efectivo: vigencia, distribucion y PROPIEDAD (debe derivar del mismo root/actor)
    SELECT ce.invalidated_at, ce.available_quantity, ce.damaged_quantity, ce.expired_quantity,
           ce.blocked_quantity, ce.other_unavailable_quantity, ce.identification_method,
           ce.scanned_code, ce.recount_request_id, ce.counted_by, ce.session_participant_id
    INTO v_eff_inv_at, v_avail, v_dam, v_exp, v_blk, v_oth, v_eff_ident,
         v_eff_scanned, v_eff_recount, v_current_counted_by, v_participant_id
    FROM inventarios.count_entries ce
    WHERE ce.company_id = v_company_id AND ce.id = v_current_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
    END IF;
    IF v_eff_inv_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_COUNT_ALREADY_INVALIDATED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El conteo ya ha sido invalidado.', 'retryable', false, 'count_entry_id', v_current_id)::text;
    END IF;
    -- El current efectivo debe conservar la propiedad del COUNTER original.
    IF v_current_counted_by IS DISTINCT FROM v_actor_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a este registro de conteo.', 'retryable', false)::text;
    END IF;

    IF v_dam > 0 OR v_exp > 0 OR v_blk > 0 OR v_oth > 0 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_COUNT_DISTRIBUTION_NOT_SIMPLE',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El conteo posee cantidades en estados que no pueden corregirse con la captura simple Mobile.', 'retryable', false)::text;
    END IF;

    v_new_avail := p_physical_quantity;
    v_phys := v_new_avail + 0 + 0 + 0 + 0;
    IF v_avail = v_new_avail AND v_dam = 0 AND v_exp = 0 AND v_blk = 0 AND v_oth = 0 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_COUNT_QUANTITY_MISMATCH',
            DETAIL = pg_catalog.jsonb_build_object('message', 'Las cantidades ingresadas no son validas para esta operacion.', 'retryable', false)::text;
    END IF;

    IF v_prev_revision IS NULL THEN v_revision_number := 1; ELSE v_revision_number := v_prev_revision + 1; END IF;

    v_occ := pg_catalog.now();
    v_cap := p_captured_at;
    IF v_cap > v_occ THEN v_cap := v_occ; END IF;

    -- Replacement: conserva la propiedad del COUNTER original (counted_by/created_by = actor,
    -- quien por la guarda es el mismo COUNTER que creó el conteo) y el participante de sesion.
    INSERT INTO inventarios.count_entries (
        company_id, session_id, snapshot_id, session_zone_id, task_id, task_cycle,
        session_participant_id, counted_by, snapshot_product_id, snapshot_location_id,
        bsale_variant_id, identification_method, scanned_code, capture_source,
        offline_id, device_id, captured_at, server_received_at, synced_at, synced_by,
        physical_quantity, available_quantity, damaged_quantity, expired_quantity,
        blocked_quantity, other_unavailable_quantity, recount_request_id, created_by
    ) VALUES (
        v_company_id, v_sid, v_szid, v_rid, v_tid, v_cyc,
        v_participant_id, v_actor_id, v_pid, v_lid, v_vid,
        v_eff_ident, v_eff_scanned, 'MOBILE',
        p_idempotency_key, v_devid, v_cap, v_occ, v_occ, v_actor_id,
        v_phys, v_new_avail, 0, 0, 0, 0, v_eff_recount, v_actor_id
    ) RETURNING id INTO v_repl;

    IF v_prev_correction_id IS NOT NULL THEN
        UPDATE inventarios.count_entry_corrections SET superseded_at = v_occ
        WHERE id = v_prev_correction_id AND company_id = v_company_id AND superseded_at IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
                DETAIL = pg_catalog.jsonb_build_object('message', 'Se detecto una modificacion concurrente.', 'retryable', true)::text;
        END IF;
    END IF;

    INSERT INTO inventarios.count_entry_corrections (
        company_id, session_id, task_id, snapshot_product_id, root_count_entry_id,
        previous_count_entry_id, replacement_count_entry_id, supersedes_correction_id,
        revision_number, reason, corrected_by, corrected_at
    ) VALUES (
        v_company_id, v_sid, v_tid, v_pid, p_root_count_entry_id,
        v_current_id, v_repl, v_prev_correction_id,
        v_revision_number, v_reason, v_actor_id, v_occ
    );

    v_response := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.mobile.count.correct',
        'entity_id', v_repl,
        'state', NULL::text,
        'version', NULL::integer,
        'cycle_number', v_cyc,
        'assignment_id', v_assignment_id,
        'event_id', NULL::uuid,
        'replayed', false,
        'occurred_at', v_occ,
        'data', pg_catalog.jsonb_build_object(
            'root_count_entry_id', p_root_count_entry_id,
            'previous_count_entry_id', v_current_id,
            'current_count_entry_id', v_repl,
            'revision_number', v_revision_number,
            'physical_quantity', v_phys,
            'available_quantity', v_new_avail,
            'captured_at', v_cap
        )
    );
    RETURN inventarios.complete_idempotent_operation(v_company_id, v_operation_id, v_repl, v_response);
END;
$function$;

ALTER FUNCTION inventarios.correct_my_counting_quantity(uuid, uuid, uuid, uuid, numeric, text, uuid, text, timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.correct_my_counting_quantity(uuid, uuid, uuid, uuid, numeric, text, uuid, text, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.correct_my_counting_quantity(uuid, uuid, uuid, uuid, numeric, text, uuid, text, timestamptz) TO authenticated;


CREATE OR REPLACE FUNCTION inventarios.invalidate_my_counting_record(p_zone_id uuid, p_location_id uuid, p_root_count_entry_id uuid, p_expected_current_count_entry_id uuid, p_reason text, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_company_id uuid;
    v_session_id uuid;
    v_session_zone_id uuid;
    v_task_id uuid;
    v_assignment_id uuid;
    v_is_authorized boolean := false;
    v_szl_id uuid;
    v_snapshot_location_id uuid;
    v_reason text;
    v_current_id uuid;
    v_active_correction_id uuid;
    v_root_inv_at timestamptz;
    v_eff_inv_at timestamptz;
    v_eff_inv_by uuid;
    v_eff_inv_rs text;
    v_sid uuid; v_rid uuid; v_tid uuid; v_cyc integer;
    v_root_counted_by uuid;
    v_current_counted_by uuid;
    v_invalidated_at timestamptz;
    v_payload jsonb; v_request_hash text;
    v_operation jsonb; v_operation_id uuid;
    v_response jsonb;
BEGIN
    IF p_zone_id IS NULL OR p_location_id IS NULL OR p_root_count_entry_id IS NULL
       OR p_expected_current_count_entry_id IS NULL
       OR p_reason IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;
    v_reason := pg_catalog.btrim(p_reason);
    IF v_reason = '' OR pg_catalog.length(v_reason) < 5 OR pg_catalog.length(v_reason) > 500 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;

    v_actor_id := inventarios.require_actor();

    SELECT z.company_id, t.id, z.session_id, z.id, a.id, true
    INTO v_company_id, v_task_id, v_session_id, v_session_zone_id, v_assignment_id, v_is_authorized
    FROM inventarios.task_assignments a
    JOIN inventarios.tasks t ON t.id = a.task_id
    JOIN inventarios.session_zones z ON z.id = t.session_zone_id
    JOIN inventarios.sessions s ON s.id = z.session_id
    JOIN inventarios.session_participants p ON p.id = a.session_participant_id
    WHERE z.id = p_zone_id
      AND a.user_id = v_actor_id
      AND a.released_at IS NULL
      AND p.user_id = v_actor_id
      AND p.functional_role = 'COUNTER'
      AND p.active_from <= pg_catalog.now()
      AND p.revoked_at IS NULL
      AND s.status = 'COUNTING'
      AND z.is_enabled = true
      AND t.status = 'IN_PROGRESS'
      AND t.active_user_id = v_actor_id
      AND t.cancelled_at IS NULL
      AND t.superseded_at IS NULL
      AND t.invalidated_at IS NULL;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;
    PERFORM inventarios.require_company_access(v_company_id);

    SELECT szl.id, szl.snapshot_location_id
    INTO v_szl_id, v_snapshot_location_id
    FROM inventarios.session_zone_locations szl
    WHERE szl.company_id = v_company_id
      AND szl.session_id = v_session_id
      AND szl.session_zone_id = p_zone_id
      AND szl.location_id = p_location_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta ubicación.', 'retryable', false)::text;
    END IF;

    v_payload := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.mobile.count.invalidate',
        'zone_id', p_zone_id,
        'location_id', p_location_id,
        'root_count_entry_id', p_root_count_entry_id,
        'expected_current_count_entry_id', p_expected_current_count_entry_id,
        'reason', v_reason
    );
    v_request_hash := inventarios.compute_request_hash(v_payload);
    v_operation := inventarios.begin_idempotent_operation(v_company_id, 'inventarios.mobile.count.invalidate', p_idempotency_key, v_request_hash);
    IF v_operation ->> 'mode' = 'REPLAY' THEN
        RETURN v_operation -> 'response_payload';
    END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.mobile.count.invalidate'),
        pg_catalog.hashtext(v_company_id::text || ':' || p_root_count_entry_id::text)
    );

    -- Root: contexto, PROPIEDAD del actor y no invalidado
    SELECT ce.session_id, ce.session_zone_id, ce.task_id, ce.task_cycle, ce.invalidated_at, ce.counted_by
    INTO v_sid, v_rid, v_tid, v_cyc, v_root_inv_at, v_root_counted_by
    FROM inventarios.count_entries ce
    WHERE ce.company_id = v_company_id AND ce.id = p_root_count_entry_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
    END IF;
    IF v_tid IS DISTINCT FROM v_task_id OR v_rid IS DISTINCT FROM v_session_zone_id
       OR v_sid IS DISTINCT FROM v_session_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta ubicación.', 'retryable', false)::text;
    END IF;
    -- Propiedad individual obligatoria: solo el COUNTER que creó el conteo puede anularlo.
    IF v_root_counted_by IS DISTINCT FROM v_actor_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a este registro de conteo.', 'retryable', false)::text;
    END IF;
    IF v_root_inv_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_COUNT_ALREADY_INVALIDATED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El conteo ya ha sido invalidado.', 'retryable', false, 'count_entry_id', p_root_count_entry_id)::text;
    END IF;

    SELECT cec.id, cec.replacement_count_entry_id
    INTO v_active_correction_id, v_current_id
    FROM inventarios.count_entry_corrections cec
    WHERE cec.company_id = v_company_id AND cec.root_count_entry_id = p_root_count_entry_id AND cec.superseded_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
        v_current_id := p_root_count_entry_id;
        v_active_correction_id := NULL;
    END IF;
    IF v_current_id IS DISTINCT FROM p_expected_current_count_entry_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
            DETAIL = pg_catalog.jsonb_build_object('message', 'Se detecto una modificacion concurrente.', 'retryable', true, 'current_count_entry_id', v_current_id)::text;
    END IF;

    SELECT ce.invalidated_at, ce.invalidated_by, ce.invalidation_reason, ce.counted_by
    INTO v_eff_inv_at, v_eff_inv_by, v_eff_inv_rs, v_current_counted_by
    FROM inventarios.count_entries ce WHERE ce.company_id = v_company_id AND ce.id = v_current_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
    END IF;
    -- El current efectivo debe conservar la propiedad del COUNTER original.
    IF v_current_counted_by IS DISTINCT FROM v_actor_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a este registro de conteo.', 'retryable', false)::text;
    END IF;
    IF v_eff_inv_at IS NOT NULL AND v_eff_inv_by IS NOT NULL AND v_eff_inv_rs IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_COUNT_ALREADY_INVALIDATED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El conteo ya ha sido invalidado.', 'retryable', false, 'count_entry_id', v_current_id)::text;
    END IF;
    IF v_eff_inv_at IS NOT NULL OR v_eff_inv_by IS NOT NULL OR v_eff_inv_rs IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
            DETAIL = pg_catalog.jsonb_build_object('message', 'Se detecto una modificacion concurrente.', 'retryable', true)::text;
    END IF;

    v_invalidated_at := pg_catalog.now();
    -- invalidated_by queda con el actor autenticado (nunca un UUID enviado por Mobile).
    UPDATE inventarios.count_entries
    SET invalidated_at = v_invalidated_at, invalidated_by = v_actor_id, invalidation_reason = v_reason
    WHERE company_id = v_company_id AND id = v_current_id
      AND invalidated_at IS NULL AND invalidated_by IS NULL AND invalidation_reason IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
            DETAIL = pg_catalog.jsonb_build_object('message', 'Se detecto una modificacion concurrente.', 'retryable', true)::text;
    END IF;

    v_response := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.mobile.count.invalidate',
        'entity_id', v_current_id,
        'state', NULL::text,
        'version', NULL::integer,
        'cycle_number', v_cyc,
        'assignment_id', v_assignment_id,
        'event_id', NULL::uuid,
        'replayed', false,
        'occurred_at', v_invalidated_at,
        'data', pg_catalog.jsonb_build_object(
            'root_count_entry_id', p_root_count_entry_id,
            'count_entry_id', v_current_id,
            'active_correction_id', v_active_correction_id,
            'invalidated_at', v_invalidated_at,
            'reason', v_reason
        )
    );
    RETURN inventarios.complete_idempotent_operation(v_company_id, v_operation_id, v_current_id, v_response);
END;
$function$;

ALTER FUNCTION inventarios.invalidate_my_counting_record(uuid, uuid, uuid, uuid, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.invalidate_my_counting_record(uuid, uuid, uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.invalidate_my_counting_record(uuid, uuid, uuid, uuid, text, uuid) TO authenticated;
