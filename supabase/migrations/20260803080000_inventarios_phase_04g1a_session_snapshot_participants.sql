-- Migration: 20260803080000_inventarios_phase_04g1a_session_snapshot_participants.sql
-- Description: Fase 4G.1a. Permisos de configuracion DRAFT, creacion atomica de
--              jornada DRAFT con operational_snapshot temprano, y gestion de
--              participantes. No implementa DRAFT -> PREPARED.
-- Author: Assistant

-- ============================================================
-- 1. PERMISOS NUEVOS DEL MODULO
-- ============================================================
INSERT INTO portal.permissions (code, name, module_id)
SELECT permission.code, permission.name, module.id
FROM (
    VALUES
        ('inventarios.sessions.create', 'Crear jornadas de inventario'),
        ('inventarios.sessions.configure', 'Configurar jornadas de inventario'),
        ('inventarios.participants.manage', 'Gestionar participantes de jornadas'),
        ('inventarios.sessions.read', 'Leer configuracion de jornadas')
) AS permission(code, name)
CROSS JOIN (SELECT id FROM portal.modules WHERE code = 'inventarios') AS module
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name, module_id = EXCLUDED.module_id;

-- ============================================================
-- 2. MATRIZ DE ROLES (BODEGA y SUPER_USUARIO). GERENCIA conserva
--    unicamente inventarios.sessions.approve.
-- ============================================================
INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
    ('SUPER_USUARIO', 'inventarios.sessions.create'),
    ('SUPER_USUARIO', 'inventarios.sessions.configure'),
    ('SUPER_USUARIO', 'inventarios.participants.manage'),
    ('SUPER_USUARIO', 'inventarios.sessions.read'),
    ('BODEGA', 'inventarios.sessions.create'),
    ('BODEGA', 'inventarios.sessions.configure'),
    ('BODEGA', 'inventarios.participants.manage'),
    ('BODEGA', 'inventarios.sessions.read')
) AS m(role_name, perm_code)
JOIN portal.roles r ON r.name = m.role_name AND r.is_active = true
JOIN portal.permissions p ON p.code = m.perm_code AND p.is_active = true
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ============================================================
-- 3. RPC: create_inventory_session
--    Crea la jornada DRAFT y su unico operational_snapshot en la
--    misma transaccion. Registra al responsable como participante
--    ADMINISTRATOR activo. Genera session_number por empresa.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.create_inventory_session(
    p_company_id uuid, p_name text, p_inventory_type text, p_warehouse_id uuid,
    p_bsale_office_id integer, p_scope_mode text, p_responsible_user_id uuid,
    p_notes text, p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid; v_operation jsonb; v_operation_id uuid;
    v_inventory_type text; v_scope_mode text; v_name text; v_notes text;
    v_session_number integer; v_session_id uuid; v_snapshot_id uuid;
    v_participant_id uuid; v_occurred_at timestamptz;
    v_response jsonb; v_payload jsonb;
BEGIN
    v_inventory_type := pg_catalog.upper(pg_catalog.btrim(p_inventory_type));
    v_scope_mode := pg_catalog.upper(pg_catalog.btrim(p_scope_mode));
    v_name := pg_catalog.btrim(p_name);
    v_notes := pg_catalog.btrim(pg_catalog.coalesce(p_notes, ''));
    IF p_company_id IS NULL OR v_name = '' OR pg_catalog.char_length(v_name) > 200
       OR v_inventory_type NOT IN ('GENERAL','PARTIAL','CYCLIC','CONTROL','RECOUNT')
       OR p_warehouse_id IS NULL OR p_bsale_office_id IS NULL OR p_bsale_office_id < 1
       OR v_scope_mode NOT IN ('GENERAL','PARTIAL')
       OR NOT ((v_inventory_type = 'GENERAL' AND v_scope_mode = 'GENERAL')
               OR (v_inventory_type = 'PARTIAL' AND v_scope_mode = 'PARTIAL')
               OR v_inventory_type IN ('CYCLIC','CONTROL','RECOUNT'))
       OR p_responsible_user_id IS NULL OR pg_catalog.char_length(v_notes) > 2000
       OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.create');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.create_inventory_session'),
        pg_catalog.hashtext(p_company_id::text));
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.create','company_id',p_company_id,'name',v_name,
        'inventory_type',v_inventory_type,'warehouse_id',p_warehouse_id,
        'bsale_office_id',p_bsale_office_id,'scope_mode',v_scope_mode,
        'responsible_user_id',p_responsible_user_id);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.session.create',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    IF NOT EXISTS (SELECT 1 FROM core.companies c WHERE c.id = p_company_id AND c.is_active = true) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_COMPANY_ACCESS_DENIED',
            DETAIL=pg_catalog.jsonb_build_object('message','No tienes acceso a la empresa solicitada.','retryable',false)::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM adquisiciones.warehouses w
                   WHERE w.id = p_warehouse_id AND w.company_id = p_company_id
                     AND w.is_active = true AND w.status = 'ACTIVE') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La bodega solicitada no existe o no esta activa.','retryable',false)::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM integraciones.bsale_offices bo
                   WHERE bo.company_id = p_company_id AND bo.bsale_id = p_bsale_office_id::bigint
                     AND bo.is_active = true) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La oficina Bsale solicitada no existe o no esta activa.','retryable',false)::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM portal.users u
                   JOIN core.user_company_access uca
                     ON uca.user_id = u.id AND uca.company_id = p_company_id AND uca.is_active = true
                   WHERE u.id = p_responsible_user_id AND u.is_active = true AND u.deleted_at IS NULL) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El responsable solicitado no existe o no tiene acceso a la empresa.','retryable',false)::text;
    END IF;
    IF EXISTS (SELECT 1 FROM inventarios.sessions s
               WHERE s.company_id = p_company_id AND s.warehouse_id = p_warehouse_id
                 AND s.inventory_type = v_inventory_type AND s.status IN ('DRAFT','PREPARED')) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_DUPLICATE',
            DETAIL=pg_catalog.jsonb_build_object('message','Ya existe una jornada configurable para la misma bodega y tipo.','retryable',false)::text;
    END IF;
    SELECT pg_catalog.coalesce(pg_catalog.max(s.session_number), 0) + 1
    INTO v_session_number
    FROM inventarios.sessions s WHERE s.company_id = p_company_id;
    v_occurred_at := pg_catalog.now();
    INSERT INTO inventarios.sessions AS s (company_id, session_number, name, inventory_type, status,
        warehouse_id, bsale_office_id, scope_mode, responsible_user_id, notes,
        created_at, created_by, updated_at, updated_by)
    VALUES (p_company_id, v_session_number, v_name, v_inventory_type, 'DRAFT',
        p_warehouse_id, p_bsale_office_id, v_scope_mode, p_responsible_user_id,
        CASE WHEN v_notes = '' THEN NULL ELSE v_notes END,
        v_occurred_at, v_actor_id, v_occurred_at, v_actor_id)
    RETURNING s.id INTO v_session_id;
    INSERT INTO inventarios.operational_snapshots AS os (company_id, session_id, snapshot_version,
        completion_status, captured_at, captured_by, created_at, created_by)
    VALUES (p_company_id, v_session_id, 1, 'PENDING', v_occurred_at, v_actor_id, v_occurred_at, v_actor_id)
    RETURNING os.id INTO v_snapshot_id;
    INSERT INTO inventarios.session_participants AS sp (company_id, session_id, user_id, functional_role,
        active_from, created_at, created_by)
    VALUES (p_company_id, v_session_id, p_responsible_user_id, 'ADMINISTRATOR',
        v_occurred_at, v_occurred_at, v_actor_id)
    RETURNING sp.id INTO v_participant_id;
    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.create','entity_id',v_session_id,'state','DRAFT',
        'version',NULL::integer,'cycle_number',NULL::integer,'assignment_id',NULL::uuid,
        'event_id',NULL::uuid,'replayed',false,'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object('session_number',v_session_number,
            'snapshot_id',v_snapshot_id,'responsible_participant_id',v_participant_id,
            'responsible_user_id',p_responsible_user_id,'completion_status','PENDING'));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, v_session_id, v_response);
END;
$$;

-- ============================================================
-- 4. RPC: add_inventory_session_participant
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.add_inventory_session_participant(
    p_company_id uuid, p_session_id uuid, p_user_id uuid,
    p_functional_role text, p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid; v_operation jsonb; v_operation_id uuid;
    v_functional_role text; v_session_status text; v_participant_id uuid;
    v_occurred_at timestamptz; v_response jsonb; v_payload jsonb;
BEGIN
    v_functional_role := pg_catalog.upper(pg_catalog.btrim(p_functional_role));
    IF p_company_id IS NULL OR p_session_id IS NULL OR p_user_id IS NULL
       OR v_functional_role NOT IN ('COUNTER','SUPERVISOR','ADMINISTRATOR','MANAGER')
       OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.participants.manage');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.add_inventory_session_participant'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_session_id::text));
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.participant.add','company_id',p_company_id,
        'session_id',p_session_id,'user_id',p_user_id,'functional_role',v_functional_role);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.session.participant.add',p_idempotency_key,
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
    IF NOT EXISTS (SELECT 1 FROM portal.users u
                   JOIN core.user_company_access uca
                     ON uca.user_id = u.id AND uca.company_id = p_company_id AND uca.is_active = true
                   WHERE u.id = p_user_id AND u.is_active = true AND u.deleted_at IS NULL) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PARTICIPANT_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El usuario no existe o no tiene acceso activo a la empresa.','retryable',false)::text;
    END IF;
    IF EXISTS (SELECT 1 FROM inventarios.session_participants sp
               WHERE sp.company_id = p_company_id AND sp.session_id = p_session_id
                 AND sp.user_id = p_user_id AND sp.functional_role = v_functional_role
                 AND sp.revoked_at IS NULL) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PARTICIPANT_DUPLICATE',
            DETAIL=pg_catalog.jsonb_build_object('message','El usuario ya tiene una participacion activa con ese rol.','retryable',false)::text;
    END IF;
    v_occurred_at := pg_catalog.now();
    INSERT INTO inventarios.session_participants AS sp (company_id, session_id, user_id, functional_role,
        active_from, created_at, created_by)
    VALUES (p_company_id, p_session_id, p_user_id, v_functional_role,
        v_occurred_at, v_occurred_at, v_actor_id)
    RETURNING sp.id INTO v_participant_id;
    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.participant.add','entity_id',v_participant_id,
        'state','ACTIVE','version',NULL::integer,'cycle_number',NULL::integer,
        'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object('session_id',p_session_id,'user_id',p_user_id,
            'functional_role',v_functional_role,'active_from',v_occurred_at));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, v_participant_id, v_response);
END;
$$;

-- ============================================================
-- 5. RPC: revoke_inventory_session_participant
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.revoke_inventory_session_participant(
    p_company_id uuid, p_session_id uuid, p_user_id uuid,
    p_reason text, p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid; v_operation jsonb; v_operation_id uuid;
    v_reason text; v_session_status text; v_participant_id uuid;
    v_active_task_count bigint; v_occurred_at timestamptz;
    v_response jsonb; v_payload jsonb;
BEGIN
    v_reason := pg_catalog.btrim(p_reason);
    IF p_company_id IS NULL OR p_session_id IS NULL OR p_user_id IS NULL
       OR v_reason = '' OR pg_catalog.char_length(v_reason) < 5 OR pg_catalog.char_length(v_reason) > 500
       OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.participants.manage');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.revoke_inventory_session_participant'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_session_id::text));
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.participant.revoke','company_id',p_company_id,
        'session_id',p_session_id,'user_id',p_user_id,'reason',v_reason);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.session.participant.revoke',p_idempotency_key,
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
    SELECT sp.id INTO v_participant_id
    FROM inventarios.session_participants sp
    WHERE sp.company_id = p_company_id AND sp.session_id = p_session_id
      AND sp.user_id = p_user_id AND sp.revoked_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El participante solicitado no existe o ya esta revocado.','retryable',false)::text;
    END IF;
    SELECT pg_catalog.count(*) INTO v_active_task_count
    FROM inventarios.task_assignments ta
    JOIN inventarios.tasks t
      ON t.company_id = ta.company_id AND t.session_id = ta.session_id AND t.id = ta.task_id
    WHERE ta.company_id = p_company_id AND ta.session_id = p_session_id
      AND ta.session_participant_id = v_participant_id AND ta.released_at IS NULL
      AND t.status IN ('ASSIGNED','IN_PROGRESS','PAUSED')
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL;
    IF v_active_task_count > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PARTICIPANT_HAS_ACTIVE_TASKS',
            DETAIL=pg_catalog.jsonb_build_object('message','No se puede revocar el participante porque tiene tareas activas asignadas.','retryable',false,'active_task_count',v_active_task_count)::text;
    END IF;
    v_occurred_at := pg_catalog.now();
    UPDATE inventarios.session_participants AS sp
    SET revoked_at = v_occurred_at, revoked_by = v_actor_id, revocation_reason = v_reason
    WHERE sp.id = v_participant_id;
    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.participant.revoke','entity_id',v_participant_id,
        'state','REVOKED','version',NULL::integer,'cycle_number',NULL::integer,
        'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object('session_id',p_session_id,'user_id',p_user_id,
            'revoked_at',v_occurred_at,'reason',v_reason));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, v_participant_id, v_response);
END;
$$;

-- ============================================================
-- 6. OWNER Y REVOKES
-- ============================================================
ALTER FUNCTION inventarios.create_inventory_session(uuid, text, text, uuid, integer, text, uuid, text, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.add_inventory_session_participant(uuid, uuid, uuid, text, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.revoke_inventory_session_participant(uuid, uuid, uuid, text, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.create_inventory_session(uuid, text, text, uuid, integer, text, uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.add_inventory_session_participant(uuid, uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.revoke_inventory_session_participant(uuid, uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
