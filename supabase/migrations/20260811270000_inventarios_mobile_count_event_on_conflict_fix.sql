-- =========================================================================================
-- MIGRATION: M1.5E.9 - Corregir ON CONFLICT de evento COUNT_RECORDED en submit_my_mobile_count
-- =========================================================================================
-- Error 42P10: "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification".
-- Causa: submit_my_mobile_count inserta en task_events con
--     ON CONFLICT (company_id, idempotency_key) DO NOTHING
-- pero el unico indice unico que cubre esa clave es PARCIAL:
--     uq_inventarios_events_idempotency (company_id, idempotency_key)
--     WHERE (idempotency_key IS NOT NULL)
-- PostgreSQL no infiere un arbitro a partir de un indice parcial salvo que el
-- ON CONFLICT declare el mismo predicado. Correccion minima (opcion B): agregar
--     WHERE idempotency_key IS NOT NULL
-- al target del ON CONFLICT, coincidiendo con el indice unico parcial existente.
-- La semantica de idempotencia del evento COUNT_RECORDED (clave derivada
-- md5(idempotency_key:COUNT_RECORDED)) queda intacta; no se alteran permisos,
-- autorizacion COUNTER, sesion/tarea/ubicacion/snapshot, idempotencia, locks
-- ni auditoria.

CREATE OR REPLACE FUNCTION inventarios.submit_my_mobile_count(p_zone_id uuid, p_location_id uuid, p_snapshot_product_id uuid, p_physical_quantity numeric, p_identification_method text, p_scanned_code text, p_idempotency_key uuid, p_captured_at timestamp with time zone, p_device_id text)
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
    v_is_open boolean := false;
    v_snapshot_location_id uuid;
    v_quantities_payload jsonb;
    v_request_payload jsonb;
    v_request_hash text;
    v_operation jsonb;
    v_operation_id uuid;
    v_count_result jsonb;
    v_count_entry_id uuid;
    v_count_event_id uuid;
    v_count_event_key uuid;
    v_count_event_payload jsonb;
    v_actual_barcode text;
    v_actual_sku text;
    v_clean_scanned_code text;
    v_clean_device_id text;
    v_count_occurred_at timestamptz;
    v_response jsonb;
    v_replay_payload jsonb;
BEGIN
    IF p_snapshot_product_id IS NULL OR p_physical_quantity IS NULL OR p_physical_quantity < 0 OR p_idempotency_key IS NULL OR p_captured_at IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;
    v_clean_device_id := pg_catalog.btrim(p_device_id);
    IF v_clean_device_id IS NULL OR v_clean_device_id = '' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'Device ID es obligatorio.', 'retryable', false)::text;
    END IF;
    IF p_identification_method IS NULL OR p_identification_method NOT IN ('BARCODE', 'SKU_MANUAL', 'SEARCH_MANUAL') THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_IDENTIFICATION_METHOD', DETAIL = pg_catalog.jsonb_build_object('message', 'Método de identificación no soportado.', 'retryable', false)::text;
    END IF;
    v_clean_scanned_code := CASE WHEN p_scanned_code IS NULL THEN NULL ELSE pg_catalog.btrim(p_scanned_code) END;
    IF p_identification_method IN ('BARCODE', 'SKU_MANUAL') AND (v_clean_scanned_code IS NULL OR v_clean_scanned_code = '') THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'El código escaneado es obligatorio para este método.', 'retryable', false)::text;
    END IF;
    v_actor_id := inventarios.require_actor();

    SELECT z.company_id, z.session_id, z.snapshot_id, z.id, t.id, t.validation_cycle, a.id, true
    INTO v_company_id, v_session_id, v_snapshot_id, v_session_zone_id, v_task_id, v_task_cycle, v_assignment_id, v_is_authorized
    FROM inventarios.task_assignments a
    JOIN inventarios.tasks t ON t.id = a.task_id
    JOIN inventarios.session_zones z ON z.id = t.session_zone_id
    JOIN inventarios.sessions s ON s.id = z.session_id
    JOIN inventarios.session_participants p ON p.id = a.session_participant_id
    WHERE z.id = p_zone_id AND a.user_id = v_actor_id AND a.released_at IS NULL
      AND p.user_id = v_actor_id AND p.functional_role = 'COUNTER'
      AND p.active_from <= pg_catalog.now() AND p.revoked_at IS NULL
      AND s.status = 'COUNTING' AND z.is_enabled = true AND t.status = 'IN_PROGRESS'
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL AND t.invalidated_at IS NULL;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED', DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;
    PERFORM inventarios.require_company_access(v_company_id);

    SELECT true, szl.snapshot_location_id INTO v_is_open, v_snapshot_location_id
    FROM inventarios.task_locations tl
    JOIN inventarios.session_zone_locations szl ON szl.id = tl.session_zone_location_id
    WHERE tl.company_id = v_company_id AND tl.task_id = v_task_id AND tl.session_zone_id = p_zone_id
      AND szl.session_zone_id = p_zone_id AND szl.location_id = p_location_id
      AND tl.opened_by = v_actor_id AND tl.status = 'OPEN';
    IF v_is_open IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED', DETAIL = pg_catalog.jsonb_build_object('message', 'La ubicación no está abierta para esta tarea.', 'retryable', false)::text;
    END IF;

    SELECT sp.barcode, sp.sku INTO v_actual_barcode, v_actual_sku
    FROM inventarios.snapshot_products sp
    WHERE sp.company_id = v_company_id AND sp.snapshot_id = v_snapshot_id AND sp.id = p_snapshot_product_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_PRODUCT', DETAIL = pg_catalog.jsonb_build_object('message', 'El producto no pertenece al inventario activo.', 'retryable', false)::text;
    END IF;
    IF p_identification_method = 'BARCODE' AND (v_actual_barcode IS NULL OR v_clean_scanned_code <> v_actual_barcode) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_PRODUCT_IDENTITY_MISMATCH', DETAIL = pg_catalog.jsonb_build_object('message', 'El barcode capturado no corresponde al producto seleccionado.', 'retryable', false)::text;
    END IF;
    IF p_identification_method = 'SKU_MANUAL' AND (v_actual_sku IS NULL OR v_clean_scanned_code <> v_actual_sku) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_PRODUCT_IDENTITY_MISMATCH', DETAIL = pg_catalog.jsonb_build_object('message', 'El SKU ingresado no corresponde al producto seleccionado.', 'retryable', false)::text;
    END IF;

    v_request_payload := pg_catalog.jsonb_build_object('operation', 'inventarios.mobile.count.submit', 'zone_id', p_zone_id, 'location_id', p_location_id, 'snapshot_product_id', p_snapshot_product_id, 'physical_quantity', p_physical_quantity, 'identification_method', p_identification_method, 'scanned_code', v_clean_scanned_code, 'captured_at', p_captured_at, 'device_id', v_clean_device_id);
    v_request_hash := inventarios.compute_request_hash(v_request_payload);
    v_operation := inventarios.begin_idempotent_operation(v_company_id, 'inventarios.mobile.count.submit', p_idempotency_key, v_request_hash);
    v_count_event_key := (pg_catalog.md5(p_idempotency_key::text || ':COUNT_RECORDED'))::uuid;
    IF v_operation ->> 'mode' = 'REPLAY' THEN
        v_replay_payload := v_operation -> 'response_payload';
        v_count_entry_id := (v_replay_payload ->> 'entity_id')::uuid;
        v_count_event_id := (v_replay_payload -> 'data' ->> 'count_event_id')::uuid;
        IF NOT EXISTS (SELECT 1 FROM inventarios.count_entries ce WHERE ce.company_id = v_company_id AND ce.session_id = v_session_id AND ce.task_id = v_task_id AND ce.snapshot_product_id = p_snapshot_product_id AND ce.snapshot_location_id = v_snapshot_location_id AND ce.id = v_count_entry_id AND ce.offline_id = p_idempotency_key) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;
        SELECT te.id, te.technical_metadata INTO v_count_event_id, v_count_event_payload FROM inventarios.task_events te WHERE te.company_id = v_company_id AND te.task_id = v_task_id AND te.idempotency_key = v_count_event_key;
        IF v_count_event_id IS NULL THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM inventarios.task_events te WHERE te.company_id = v_company_id AND te.session_id = v_session_id AND te.session_zone_id = v_session_zone_id AND te.task_id = v_task_id AND te.id = v_count_event_id AND te.event_type = 'COUNT_RECORDED' AND te.idempotency_key = v_count_event_key AND te.technical_metadata ->> 'count_entry_id' = v_count_entry_id::text AND te.technical_metadata ->> 'snapshot_product_id' = p_snapshot_product_id::text) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_IDEMPOTENCY_CONFLICT', DETAIL = pg_catalog.jsonb_build_object('message', 'La clave de idempotencia ya fue usada con una solicitud distinta.', 'retryable', false)::text;
        END IF;
        RETURN v_replay_payload;
    END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    v_quantities_payload := pg_catalog.jsonb_build_object('available_quantity', p_physical_quantity, 'blocked_quantity', 0, 'damaged_quantity', 0, 'expired_quantity', 0, 'other_unavailable_quantity', 0);
    v_count_result := inventarios.record_inventory_count(v_company_id, v_task_id, v_task_cycle, p_snapshot_product_id, v_snapshot_location_id, v_quantities_payload, p_identification_method, v_clean_scanned_code, 'MOBILE', p_idempotency_key, v_clean_device_id, p_captured_at, p_idempotency_key);
    v_count_entry_id := (v_count_result ->> 'entity_id')::uuid;
    v_count_occurred_at := COALESCE((v_count_result ->> 'occurred_at')::timestamptz, pg_catalog.now());
    INSERT INTO inventarios.task_events (company_id, session_id, session_zone_id, task_id, event_type, previous_status, next_status, actor_id, cycle, occurred_at, idempotency_key, source, technical_metadata, created_at, created_by)
    VALUES (v_company_id, v_session_id, v_session_zone_id, v_task_id, 'COUNT_RECORDED', 'IN_PROGRESS', 'IN_PROGRESS', v_actor_id, v_task_cycle, v_count_occurred_at, v_count_event_key, 'ANDROID', pg_catalog.jsonb_build_object('count_entry_id', v_count_entry_id, 'snapshot_product_id', p_snapshot_product_id), v_count_occurred_at, v_actor_id)
    ON CONFLICT (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
    SELECT te.id, te.technical_metadata INTO v_count_event_id, v_count_event_payload FROM inventarios.task_events te WHERE te.company_id = v_company_id AND te.task_id = v_task_id AND te.idempotency_key = v_count_event_key;
    IF v_count_event_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM inventarios.task_events te WHERE te.company_id = v_company_id AND te.session_id = v_session_id AND te.session_zone_id = v_session_zone_id AND te.task_id = v_task_id AND te.id = v_count_event_id AND te.event_type = 'COUNT_RECORDED' AND te.idempotency_key = v_count_event_key AND te.technical_metadata ->> 'count_entry_id' = v_count_entry_id::text AND te.technical_metadata ->> 'snapshot_product_id' = p_snapshot_product_id::text) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_IDEMPOTENCY_CONFLICT', DETAIL = pg_catalog.jsonb_build_object('message', 'La clave de idempotencia ya fue usada con una solicitud distinta.', 'retryable', false)::text;
    END IF;
    v_response := pg_catalog.jsonb_build_object('operation', 'inventarios.mobile.count.submit', 'entity_id', v_count_entry_id, 'state', NULL::text, 'version', NULL::integer, 'cycle_number', v_task_cycle, 'assignment_id', v_assignment_id, 'event_id', v_count_event_id, 'replayed', false, 'occurred_at', v_count_occurred_at, 'data', COALESCE(v_count_result -> 'data', '{}'::jsonb) || pg_catalog.jsonb_build_object('count_event_id', v_count_event_id));
    RETURN inventarios.complete_idempotent_operation(v_company_id, v_operation_id, v_count_entry_id, v_response);
END;
$function$;

ALTER FUNCTION inventarios.submit_my_mobile_count(uuid, uuid, uuid, numeric, text, text, uuid, timestamp with time zone, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.submit_my_mobile_count(uuid, uuid, uuid, numeric, text, text, uuid, timestamp with time zone, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.submit_my_mobile_count(uuid, uuid, uuid, numeric, text, text, uuid, timestamp with time zone, text) TO authenticated;
