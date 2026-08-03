-- Migration: 20260803099000_inventarios_zone_location_ops.sql
-- Description: Fase 4H.2F3. Operaciones para quitar una ubicacion de una zona y
--              deshabilitar una zona vacia, solo en jornadas DRAFT. No elimina
--              evidencia historica; la deshabilitacion es logica (is_enabled).
-- Author: Assistant

-- ============================================================
-- 1. RPC: remove_inventory_zone_location
--    Quita la membresia session_zone_locations. La ubicacion queda
--    disponible para asignarse nuevamente. Solo DRAFT.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.remove_inventory_zone_location(
    p_company_id uuid,
    p_session_id uuid,
    p_session_zone_id uuid,
    p_location_id uuid,
    p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid; v_operation jsonb; v_operation_id uuid;
    v_session_status text;
    v_occurred_at timestamptz; v_response jsonb; v_payload jsonb;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL OR p_session_zone_id IS NULL
       OR p_location_id IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.zones.manage');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.remove_inventory_zone_location'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_session_id::text));
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.zone.location.remove','company_id',p_company_id,
        'session_id',p_session_id,'session_zone_id',p_session_zone_id,
        'location_id',p_location_id);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.session.zone.location.remove',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT s.status INTO v_session_status
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.id = p_session_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;
    IF v_session_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no permite esta operacion en su estado actual.','retryable',false)::text;
    END IF;
    PERFORM inventarios.require_session_participant(p_company_id, p_session_id, 'ADMINISTRATOR');

    IF NOT EXISTS (SELECT 1 FROM inventarios.session_zones sz
                   WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id
                     AND sz.id = p_session_zone_id) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La zona solicitada no existe en la jornada.','retryable',false)::text;
    END IF;

    DELETE FROM inventarios.session_zone_locations szl
    WHERE szl.company_id = p_company_id
      AND szl.session_id = p_session_id
      AND szl.session_zone_id = p_session_zone_id
      AND szl.location_id = p_location_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La ubicacion no pertenece a la zona.','retryable',false)::text;
    END IF;

    v_occurred_at := pg_catalog.now();
    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.zone.location.remove','entity_id',p_session_zone_id,
        'state','DRAFT','version',NULL::integer,'cycle_number',NULL::integer,
        'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object('session_id',p_session_id,
            'session_zone_id',p_session_zone_id,'location_id',p_location_id,
            'available_again',true));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_session_zone_id, v_response);
END;
$$;

-- ============================================================
-- 2. RPC: delete_inventory_session_zone
--    Deshabilita logicamente una zona vacia (is_enabled=false) en DRAFT.
--    Exige zona sin ubicaciones y sin tareas. No elimina filas.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.delete_inventory_session_zone(
    p_company_id uuid,
    p_session_id uuid,
    p_session_zone_id uuid,
    p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid; v_operation jsonb; v_operation_id uuid;
    v_session_status text;
    v_location_count bigint; v_task_count bigint;
    v_occurred_at timestamptz; v_response jsonb; v_payload jsonb;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL OR p_session_zone_id IS NULL
       OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.zones.manage');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.delete_inventory_session_zone'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_session_id::text));
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.zone.delete','company_id',p_company_id,
        'session_id',p_session_id,'session_zone_id',p_session_zone_id);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.session.zone.delete',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT s.status INTO v_session_status
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.id = p_session_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;
    IF v_session_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no permite esta operacion en su estado actual.','retryable',false)::text;
    END IF;
    PERFORM inventarios.require_session_participant(p_company_id, p_session_id, 'ADMINISTRATOR');

    IF NOT EXISTS (SELECT 1 FROM inventarios.session_zones sz
                   WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id
                     AND sz.id = p_session_zone_id) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La zona solicitada no existe en la jornada.','retryable',false)::text;
    END IF;

    SELECT pg_catalog.count(*) INTO v_location_count
    FROM inventarios.session_zone_locations szl
    WHERE szl.company_id = p_company_id AND szl.session_id = p_session_id
      AND szl.session_zone_id = p_session_zone_id;
    IF v_location_count > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_ZONE_HAS_LOCATIONS',
            DETAIL=pg_catalog.jsonb_build_object('message','Debes retirar las ubicaciones de la zona antes de eliminarla.','retryable',false,'location_count',v_location_count)::text;
    END IF;

    SELECT pg_catalog.count(*) INTO v_task_count
    FROM inventarios.tasks t
    WHERE t.company_id = p_company_id AND t.session_id = p_session_id
      AND t.session_zone_id = p_session_zone_id
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL;
    IF v_task_count > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_ZONE_HAS_TASKS',
            DETAIL=pg_catalog.jsonb_build_object('message','Una zona con tareas no puede eliminarse.','retryable',false,'task_count',v_task_count)::text;
    END IF;

    v_occurred_at := pg_catalog.now();

    UPDATE inventarios.session_zones sz
    SET is_enabled = false,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id
      AND sz.id = p_session_zone_id;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.zone.delete','entity_id',p_session_zone_id,
        'state','DRAFT','version',NULL::integer,'cycle_number',NULL::integer,
        'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object('session_id',p_session_id,
            'session_zone_id',p_session_zone_id,'is_enabled',false,
            'deleted_logically',true));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_session_zone_id, v_response);
END;
$$;

-- ============================================================
-- 3. OWNER, REVOKES Y GRANTS
-- ============================================================
ALTER FUNCTION inventarios.remove_inventory_zone_location(uuid, uuid, uuid, uuid, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.delete_inventory_session_zone(uuid, uuid, uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.remove_inventory_zone_location(uuid, uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.delete_inventory_session_zone(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.remove_inventory_zone_location(uuid, uuid, uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.delete_inventory_session_zone(uuid, uuid, uuid, uuid) TO authenticated;
