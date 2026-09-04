-- Migration: 20260903240000_inventarios_mobile_recount_without_company_id.sql
-- Description: Los dos RPC nuevos de reconteo Mobile dejan de depender de
--              p_company_id. El backend resuelve la empresa de forma segura
--              usando el usuario autenticado y/o el recount_request_id.
--
--  1. list_my_pending_recount_tasks()
--       - sin argumentos; usa auth.uid() (require_actor) para devolver
--         unicamente los reconteos pendientes (ASSIGNED/IN_PROGRESS) asignados
--         al usuario autenticado, en cualquier empresa. Se agrega company_id a
--         cada fila del payload util.
--
--  2. submit_my_recount_task(p_recount_request_id, ...)
--       - sin p_company_id; deriva company_id desde el propio recount_request
--         por su id (PK global) y valida acceso de empresa + asignacion del
--         usuario autenticado. Conserva intactas las guardas de campana
--         terminal, idempotencia y reconteo sin foto.
--
-- No modifica login, list_my_inventories, inventoryZones, conteo normal,
-- auditorias, aliases/barcodes, cierre de zona, snapshots, tablas existentes
-- ni Mobile/UI. No desplegar en este paso (QA con ROLLBACK).

-- ============================================================
-- 0. RETIRAR las firmas antiguas que recibian p_company_id
--    (CREATE OR REPLACE no elige por firma distinta: sin este DROP,
--    las firmas antiguas quedarian expuestas junto a las nuevas).
-- ============================================================
DROP FUNCTION IF EXISTS inventarios.list_my_pending_recount_tasks(uuid);
DROP FUNCTION IF EXISTS inventarios.submit_my_recount_task(uuid, uuid, jsonb, text, text, uuid, timestamptz, text);

-- ============================================================
-- 1. LISTA: reconteos pendientes asignados al usuario autenticado
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.list_my_pending_recount_tasks()
RETURNS jsonb
LANGUAGE plpgsql
STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_rows jsonb;
BEGIN
    v_actor_id := inventarios.require_actor();

    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            row_data
            ORDER BY row_data ->> 'created_at' DESC
        ),
        '[]'::jsonb
    )
    INTO v_rows
    FROM (
        SELECT pg_catalog.jsonb_build_object(
            'id', rr.id,
            'recount_request_id', rr.id,
            'company_id', rr.company_id,
            'status', rr.status,
            'ordinal', rr.ordinal,
            'cycle_number', rr.cycle_number,
            'reason', rr.reason,
            'assigned_at', rr.assigned_at,
            'assigned_user_id', rr.assigned_user_id,
            'started_at', rr.started_at,
            'completed_at', rr.completed_at,
            'requested_at', rr.requested_at,
            'created_at', rr.created_at,
            'session_id', rr.session_id,
            'session_name', s.name,
            'session_status', s.status,
            'session_number', s.session_number,
            'campaign_id', s.campaign_id,
            'campaign_name', c.name,
            'campaign_status', c.status,
            'session_zone_id', rr.session_zone_id,
            'zone_code', z.zone_code,
            'zone_name', z.display_name,
            'snapshot_product_id', rr.snapshot_product_id,
            'product_id', sp.product_id,
            'sku', sp.sku,
            'product_name', sp.name,
            'snapshot_location_id', rr.snapshot_location_id,
            'location_code', sl.code,
            'location_name', sl.name,
            'source_task_id', rr.source_task_id,
            'source_count_entry_id', rr.source_count_entry_id,
            'reference_quantity', src_ce.physical_quantity
        ) AS row_data
        FROM inventarios.recount_requests rr
        JOIN inventarios.sessions s
          ON s.company_id = rr.company_id AND s.id = rr.session_id
        LEFT JOIN inventarios.inventory_campaigns c
          ON c.company_id = s.company_id AND c.id = s.campaign_id
        JOIN inventarios.session_zones z
          ON z.company_id = rr.company_id AND z.session_id = rr.session_id
         AND z.id = rr.session_zone_id
        JOIN inventarios.snapshot_products sp
          ON sp.company_id = rr.company_id AND sp.snapshot_id = rr.snapshot_id
         AND sp.id = rr.snapshot_product_id
        LEFT JOIN inventarios.snapshot_locations sl
          ON sl.company_id = rr.company_id AND sl.snapshot_id = rr.snapshot_id
         AND sl.id = rr.snapshot_location_id
        LEFT JOIN inventarios.count_entries src_ce
          ON src_ce.company_id = rr.company_id AND src_ce.id = rr.source_count_entry_id
        WHERE rr.assigned_user_id = v_actor_id
          AND rr.status IN ('ASSIGNED','IN_PROGRESS')
    ) AS r;

    RETURN pg_catalog.jsonb_build_object(
        'actor_id', v_actor_id,
        'task_count', pg_catalog.jsonb_array_length(v_rows),
        'tasks', v_rows
    );
END;
$function$;

-- ============================================================
-- 2. SUBMIT: registrar un NUEVO count_entry valido y resolver
--    exactamente la tarea de reconteo, SIN foto/evidencia.
--    company_id se deriva del recount_request por su id.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.submit_my_recount_task(
    p_recount_request_id uuid,
    p_quantities jsonb,
    p_identification_method text,
    p_scanned_code text,
    p_idempotency_key uuid,
    p_captured_at timestamptz,
    p_device_id text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_company_id uuid;
    v_operation jsonb;
    v_operation_id uuid;
    v_payload jsonb;
    v_resp jsonb;
    v_session_id uuid;
    v_snapshot_id uuid;
    v_zone_id uuid;
    v_prod_id uuid;
    v_task_id uuid;
    v_cycle integer;
    v_app_id uuid;
    v_auser_id uuid;
    v_aat timestamptz;
    v_req_by uuid;
    v_rr_status text;
    v_snap_loc_id uuid;
    v_source_ce_id uuid;
    v_started_at timestamptz;
    v_reason text;
    v_loc_id uuid;
    v_variant_id integer;
    v_campaign_id uuid;
    v_campaign_status text;
    v_phys numeric(14,3);
    v_avail numeric(14,3); v_dam numeric(14,3); v_exp numeric(14,3);
    v_blk numeric(14,3); v_oth numeric(14,3);
    v_ident text; v_scanned text; v_devid text;
    v_cap timestamptz; v_serv timestamptz; v_completed_at timestamptz;
    v_entry_id uuid;
    v_offline_id uuid;
    v_keys text[];
    v_key_count integer;
    v_keys_sorted text[];
    v_qk text[] := ARRAY['available_quantity','blocked_quantity','damaged_quantity','expired_quantity','other_unavailable_quantity'];
    v_k text; v_val numeric;
BEGIN
    -- 1. Formato basico de la solicitud.
    IF p_recount_request_id IS NULL OR p_quantities IS NULL
       OR p_identification_method IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_ident := pg_catalog.btrim(p_identification_method);
    IF v_ident = '' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    IF p_scanned_code IS NOT NULL THEN
        v_scanned := pg_catalog.btrim(p_scanned_code);
        IF v_scanned = '' THEN v_scanned := NULL; END IF;
    END IF;
    v_devid := pg_catalog.btrim(coalesce(p_device_id, ''));
    IF v_devid = '' THEN v_devid := 'MOBILE_RECONTO'; END IF;

    IF pg_catalog.jsonb_typeof(p_quantities) <> 'object' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_keys := ARRAY(SELECT pg_catalog.jsonb_object_keys(p_quantities) ORDER BY 1);
    v_keys_sorted := ARRAY(SELECT k FROM unnest(v_qk) AS k ORDER BY 1);
    v_key_count := pg_catalog.array_length(v_keys, 1);
    IF v_key_count IS DISTINCT FROM 5 OR v_keys <> v_keys_sorted THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    FOREACH v_k IN ARRAY v_qk LOOP
        IF pg_catalog.jsonb_typeof(p_quantities -> v_k) <> 'number' THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
                DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
        END IF;
        v_val := (p_quantities ->> v_k)::numeric;
        IF v_val < 0 OR v_val > 99999999999.999 THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
                DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
        END IF;
        CASE v_k
            WHEN 'available_quantity' THEN v_avail := v_val;
            WHEN 'damaged_quantity' THEN v_dam := v_val;
            WHEN 'expired_quantity' THEN v_exp := v_val;
            WHEN 'blocked_quantity' THEN v_blk := v_val;
            WHEN 'other_unavailable_quantity' THEN v_oth := v_val;
        END CASE;
    END LOOP;
    v_phys := v_avail + v_dam + v_exp + v_blk + v_oth;

    -- 2. Actor autenticado + empresa resuelta desde el recount_request (PK global).
    v_actor_id := inventarios.require_actor();
    SELECT rr.company_id INTO v_company_id
    FROM inventarios.recount_requests rr
    WHERE rr.id = p_recount_request_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;
    -- Valida acceso del usuario autenticado a la empresa derivada.
    PERFORM inventarios.require_company_access(v_company_id);
    v_offline_id := p_idempotency_key;

    -- 3. Idempotencia (reintento del mismo payload no duplica conteos).
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.recount.mobile_submit','company_id',v_company_id,
        'recount_request_id',p_recount_request_id,'quantities',p_quantities,
        'identification_method',v_ident,'scanned_code',v_scanned,'offline_id',v_offline_id,
        'device_id',v_devid,'captured_at',p_captured_at
    );
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.submit_my_recount_task.idempotency'),
        pg_catalog.hashtext(v_company_id::text || ':' || p_idempotency_key::text)
    );
    v_operation := inventarios.begin_idempotent_operation(
        v_company_id, 'inventarios.recount.mobile_submit', p_idempotency_key,
        inventarios.compute_request_hash(v_payload)
    );
    IF v_operation ->> 'mode' = 'REPLAY' THEN
        RETURN v_operation -> 'response_payload';
    END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.submit_my_recount_task'),
        pg_catalog.hashtext(v_company_id::text || ':' || p_recount_request_id::text)
    );

    -- 4. Reconteo existente.
    SELECT rr.session_id, rr.snapshot_id, rr.session_zone_id, rr.snapshot_product_id,
           rr.source_task_id, rr.cycle_number, rr.assigned_participant_id, rr.assigned_user_id,
           rr.assigned_at, rr.requested_by, rr.status, rr.snapshot_location_id, rr.source_count_entry_id,
           rr.started_at, rr.reason
    INTO v_session_id, v_snapshot_id, v_zone_id, v_prod_id, v_task_id, v_cycle,
         v_app_id, v_auser_id, v_aat, v_req_by, v_rr_status, v_snap_loc_id, v_source_ce_id,
         v_started_at, v_reason
    FROM inventarios.recount_requests rr
    WHERE rr.company_id = v_company_id AND rr.id = p_recount_request_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;
    IF v_session_id IS NULL OR v_snapshot_id IS NULL OR v_zone_id IS NULL OR v_prod_id IS NULL
       OR v_task_id IS NULL OR v_cycle IS NULL OR v_cycle < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
            DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;
    IF v_rr_status = 'COMPLETED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_RECOUNT_ALREADY_COMPLETED',
            DETAIL=pg_catalog.jsonb_build_object('message','La tarea de reconteo ya fue completada.','retryable',false)::text;
    END IF;
    IF v_rr_status = 'CANCELLED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_RECOUNT_CANCELLED',
            DETAIL=pg_catalog.jsonb_build_object('message','La tarea de reconteo esta cancelada.','retryable',false)::text;
    END IF;
    IF v_rr_status NOT IN ('ASSIGNED','IN_PROGRESS') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_RECOUNT_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La tarea de reconteo no permite esta operacion.','retryable',false,'status',v_rr_status)::text;
    END IF;

    -- 5. Validar usuario/asignacion.
    IF v_auser_id IS NULL OR v_app_id IS NULL OR v_aat IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
            DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;
    IF v_auser_id IS DISTINCT FROM v_actor_id THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_RECOUNT_ACTOR_MISMATCH',
            DETAIL=pg_catalog.jsonb_build_object('message','No tienes una asignacion vigente para esta operacion.','retryable',false)::text;
    END IF;
    PERFORM 1 FROM inventarios.session_participants sp
    WHERE sp.id = v_app_id AND sp.company_id = v_company_id AND sp.session_id = v_session_id
      AND sp.user_id = v_actor_id AND sp.functional_role = 'COUNTER'
      AND sp.active_from <= pg_catalog.now() AND sp.revoked_at IS NULL
    FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;

    -- 6. La campana debe seguir operativa. Zona/seccion cerrada no bloquea.
    SELECT s.campaign_id INTO v_campaign_id
    FROM inventarios.sessions s
    WHERE s.company_id = v_company_id AND s.id = v_session_id;
    IF v_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_NOT_OPERATIONAL',
            DETAIL=pg_catalog.jsonb_build_object('message','El Inventario no esta operativo para completar reconteos.','retryable',false)::text;
    END IF;
    SELECT c.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns c
    WHERE c.company_id = v_company_id AND c.id = v_campaign_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;
    IF v_campaign_status = 'APPROVED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_ALREADY_APPROVED',
            DETAIL=pg_catalog.jsonb_build_object('message','El Inventario ya fue cerrado y no admite reconteos.','retryable',false,'status',v_campaign_status)::text;
    END IF;
    IF v_campaign_status = 'CANCELLED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_CANCELLED',
            DETAIL=pg_catalog.jsonb_build_object('message','El Inventario esta cancelado y no admite reconteos.','retryable',false,'status',v_campaign_status)::text;
    END IF;
    IF v_campaign_status NOT IN ('IN_PROGRESS','UNDER_REVIEW') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_NOT_OPERATIONAL',
            DETAIL=pg_catalog.jsonb_build_object('message','El Inventario no esta en una etapa operativa para completar reconteos.','retryable',false,'status',v_campaign_status)::text;
    END IF;

    -- 7. Variante BSale del producto snapshot.
    SELECT sp.bsale_variant_id INTO v_variant_id
    FROM inventarios.snapshot_products sp
    WHERE sp.company_id = v_company_id AND sp.snapshot_id = v_snapshot_id AND sp.id = v_prod_id;
    IF v_variant_id IS NULL AND v_source_ce_id IS NOT NULL THEN
        SELECT ce.bsale_variant_id INTO v_variant_id
        FROM inventarios.count_entries ce
        WHERE ce.company_id = v_company_id AND ce.id = v_source_ce_id;
    END IF;
    IF v_variant_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;

    -- 8. Ubicacion del snapshot dentro de la zona.
    IF v_snap_loc_id IS NOT NULL THEN
        PERFORM 1 FROM inventarios.session_zone_locations szl
        WHERE szl.company_id = v_company_id AND szl.session_id = v_session_id
          AND szl.snapshot_id = v_snapshot_id AND szl.session_zone_id = v_zone_id
          AND szl.snapshot_location_id = v_snap_loc_id;
        IF FOUND THEN
            v_loc_id := v_snap_loc_id;
        END IF;
    END IF;
    IF v_loc_id IS NULL THEN
        SELECT szl.snapshot_location_id INTO v_loc_id
        FROM inventarios.session_zone_locations szl
        WHERE szl.company_id = v_company_id AND szl.session_id = v_session_id
          AND szl.snapshot_id = v_snapshot_id AND szl.session_zone_id = v_zone_id
        ORDER BY szl.snapshot_location_id
        LIMIT 1;
    END IF;
    IF v_loc_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;

    -- 9. Guarda anti-duplicados: un reconteo ya resuelto no debe sumar un segundo conteo.
    IF EXISTS (
        SELECT 1 FROM inventarios.count_entries ce
        WHERE ce.company_id = v_company_id AND ce.recount_request_id = p_recount_request_id
          AND ce.invalidated_at IS NULL AND ce.invalidated_by IS NULL AND ce.invalidation_reason IS NULL
    ) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_RECOUNT_ALREADY_COMPLETED',
            DETAIL=pg_catalog.jsonb_build_object('message','La tarea de reconteo ya fue completada.','retryable',false)::text;
    END IF;

    -- 10. Marcar inicio si la tarea estaba asignada y no iniciada.
    --     El inicio toma el menor instante entre la captura del dispositivo y el
    --     servidor para evitar errores por desfase de reloj.
    v_serv := pg_catalog.now();
    v_cap := coalesce(p_captured_at, v_serv);
    v_cap := least(v_cap, v_serv);
    IF v_started_at IS NULL THEN
        v_started_at := v_cap;
    END IF;
    IF v_cap < v_started_at THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    IF v_rr_status = 'ASSIGNED' THEN
        UPDATE inventarios.recount_requests
        SET status = 'IN_PROGRESS', started_at = v_started_at,
            updated_at = v_serv, updated_by = v_actor_id
        WHERE company_id = v_company_id AND id = p_recount_request_id
          AND status = 'ASSIGNED'
          AND assigned_participant_id = v_app_id AND assigned_user_id = v_actor_id
          AND assigned_at = v_aat
          AND started_at IS NULL AND completed_at IS NULL
          AND cancelled_at IS NULL AND cancelled_by IS NULL AND cancellation_reason IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
                DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
        END IF;
    END IF;

    -- 11. Registrar el NUEVO count_entry (el rechazado permanece historico).
    INSERT INTO inventarios.count_entries (
        company_id, session_id, snapshot_id, session_zone_id, task_id, task_cycle,
        session_participant_id, counted_by, snapshot_product_id, snapshot_location_id,
        bsale_variant_id, identification_method, scanned_code, capture_source, offline_id,
        device_id, captured_at, server_received_at, synced_at, synced_by,
        physical_quantity, available_quantity, damaged_quantity, expired_quantity,
        blocked_quantity, other_unavailable_quantity, recount_request_id, created_by
    ) VALUES (
        v_company_id, v_session_id, v_snapshot_id, v_zone_id, v_task_id, v_cycle,
        v_app_id, v_actor_id, v_prod_id, v_loc_id, v_variant_id, v_ident, v_scanned,
        'MOBILE', v_offline_id, v_devid, v_cap, v_serv, v_serv, v_actor_id,
        v_phys, v_avail, v_dam, v_exp, v_blk, v_oth, p_recount_request_id, v_actor_id
    )
    RETURNING id INTO v_entry_id;

    -- 12. Resolver exactamente la tarea de reconteo.
    v_completed_at := greatest(pg_catalog.now(), v_started_at);
    UPDATE inventarios.recount_requests
    SET status = 'COMPLETED', completed_at = v_completed_at,
        updated_at = v_completed_at, updated_by = v_actor_id
    WHERE company_id = v_company_id AND id = p_recount_request_id
      AND status IN ('ASSIGNED','IN_PROGRESS')
      AND assigned_participant_id = v_app_id AND assigned_user_id = v_actor_id
      AND assigned_at IS NOT NULL
      AND completed_at IS NULL
      AND cancelled_at IS NULL AND cancelled_by IS NULL AND cancellation_reason IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
            DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;

    -- 13. Envoltorio de respuesta.
    v_resp := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.recount.mobile_submit',
        'entity_id', p_recount_request_id,
        'state', 'COMPLETED',
        'version', NULL::integer,
        'cycle_number', v_cycle,
        'assignment_id', NULL::uuid,
        'event_id', NULL::uuid,
        'replayed', false,
        'occurred_at', v_completed_at,
        'data', pg_catalog.jsonb_build_object(
            'recount_request_id', p_recount_request_id,
            'company_id', v_company_id,
            'count_entry_id', v_entry_id,
            'session_id', v_session_id,
            'session_zone_id', v_zone_id,
            'snapshot_product_id', v_prod_id,
            'snapshot_location_id', v_loc_id,
            'source_task_id', v_task_id,
            'assigned_participant_id', v_app_id,
            'assigned_user_id', v_auser_id,
            'offline_id', v_offline_id,
            'device_id', v_devid,
            'captured_at', v_cap,
            'server_received_at', v_serv,
            'available_quantity', v_avail,
            'damaged_quantity', v_dam,
            'expired_quantity', v_exp,
            'blocked_quantity', v_blk,
            'other_unavailable_quantity', v_oth,
            'physical_quantity', v_phys
        )
    );
    RETURN inventarios.complete_idempotent_operation(
        v_company_id, v_operation_id, p_recount_request_id, v_resp
    );
END;
$function$;

-- ============================================================
-- 3. OWNER, REVOKES Y GRANT (mismo patron que los contratos Mobile).
-- ============================================================
ALTER FUNCTION inventarios.list_my_pending_recount_tasks() OWNER TO postgres;
ALTER FUNCTION inventarios.submit_my_recount_task(uuid, jsonb, text, text, uuid, timestamptz, text) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.list_my_pending_recount_tasks() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.submit_my_recount_task(uuid, jsonb, text, text, uuid, timestamptz, text) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.list_my_pending_recount_tasks() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.submit_my_recount_task(uuid, jsonb, text, text, uuid, timestamptz, text) TO authenticated, service_role;
