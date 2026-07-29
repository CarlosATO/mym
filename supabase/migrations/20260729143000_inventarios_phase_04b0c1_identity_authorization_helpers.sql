CREATE FUNCTION inventarios.require_actor()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
PARALLEL UNSAFE
AS $$
DECLARE
    v_auth_user_id uuid;
    v_actor_id uuid;
    v_is_active boolean;
    v_deleted_at timestamptz;
BEGIN
    v_auth_user_id := auth.uid();

    IF v_auth_user_id IS NULL THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_UNAUTHENTICATED',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'Debes iniciar sesion para realizar esta operacion.',
                      'retryable', false
                  )::text;
    END IF;

    SELECT u.id, u.is_active, u.deleted_at
    INTO v_actor_id, v_is_active, v_deleted_at
    FROM portal.users AS u
    WHERE u.id = v_auth_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_ACTOR_NOT_REGISTERED',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'Tu usuario no esta registrado para operar inventarios.',
                      'retryable', false
                  )::text;
    END IF;

    IF v_is_active IS NOT TRUE OR v_deleted_at IS NOT NULL THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_ACTOR_INACTIVE',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'Tu usuario no esta activo para operar inventarios.',
                      'retryable', false
                  )::text;
    END IF;

    RETURN v_actor_id;
END;
$$;

CREATE FUNCTION inventarios.require_company_access(
    p_company_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
PARALLEL UNSAFE
AS $$
DECLARE
    v_actor_id uuid;
BEGIN
    IF p_company_id IS NULL THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_COMPANY_ACCESS_DENIED',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'No tienes acceso a la empresa solicitada.',
                      'retryable', false
                  )::text;
    END IF;

    v_actor_id := inventarios.require_actor();

    IF NOT core.has_company_access(v_actor_id, p_company_id) THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_COMPANY_ACCESS_DENIED',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'No tienes acceso a la empresa solicitada.',
                      'retryable', false
                  )::text;
    END IF;

    RETURN v_actor_id;
END;
$$;

CREATE FUNCTION inventarios.require_permission(
    p_company_id uuid,
    p_permission_code text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
PARALLEL UNSAFE
AS $$
DECLARE
    v_actor_id uuid;
    v_permission_code text;
BEGIN
    IF p_permission_code IS NULL THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'El permiso solicitado no es valido para esta operacion.',
                      'retryable', false
                  )::text;
    END IF;

    v_permission_code := pg_catalog.btrim(p_permission_code);

    IF v_permission_code = '' OR v_permission_code NOT LIKE 'inventarios.%' THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'El permiso solicitado no es valido para esta operacion.',
                      'retryable', false
                  )::text;
    END IF;

    v_actor_id := inventarios.require_company_access(p_company_id);

    IF NOT EXISTS (
        SELECT 1
        FROM portal.permissions AS p
        JOIN portal.modules AS m ON m.id = p.module_id
        WHERE p.code = v_permission_code
          AND p.is_active = true
          AND m.code = 'inventarios'
    ) THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'El permiso solicitado no es valido para esta operacion.',
                      'retryable', false
                  )::text;
    END IF;

    IF NOT portal.has_permission(v_permission_code::pg_catalog.varchar) THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_PERMISSION_REQUIRED',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'No tienes el permiso requerido para esta operacion.',
                      'retryable', false
                  )::text;
    END IF;

    RETURN v_actor_id;
END;
$$;

CREATE FUNCTION inventarios.require_session_participant(
    p_company_id uuid,
    p_session_id uuid,
    p_functional_role text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
PARALLEL UNSAFE
AS $$
DECLARE
    v_actor_id uuid;
    v_functional_role text;
    v_session_status text;
    v_historical_count bigint;
    v_active_count bigint;
    v_participant_id uuid;
BEGIN
    v_actor_id := inventarios.require_company_access(p_company_id);

    IF p_session_id IS NULL THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'La solicitud no tiene el formato requerido.',
                      'retryable', false
                  )::text;
    END IF;

    IF p_functional_role IS NULL THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'La solicitud no tiene el formato requerido.',
                      'retryable', false
                  )::text;
    END IF;

    v_functional_role := pg_catalog.upper(pg_catalog.btrim(p_functional_role));

    IF v_functional_role = ''
       OR v_functional_role NOT IN ('COUNTER', 'SUPERVISOR', 'ADMINISTRATOR', 'MANAGER') THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'La solicitud no tiene el formato requerido.',
                      'retryable', false
                  )::text;
    END IF;

    SELECT s.status
    INTO v_session_status
    FROM inventarios.sessions AS s
    WHERE s.company_id = p_company_id
      AND s.id = p_session_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_NOT_FOUND',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'El recurso solicitado no existe.',
                      'retryable', false
                  )::text;
    END IF;

    IF v_session_status = 'CANCELLED' THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_SESSION_INVALID_STATE',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'La jornada no permite operaciones de participantes.',
                      'retryable', false
                  )::text;
    END IF;

    SELECT pg_catalog.count(*),
           pg_catalog.count(*) FILTER (
               WHERE sp.active_from <= pg_catalog.now()
                 AND sp.revoked_at IS NULL
           ),
           (pg_catalog.array_agg(sp.id ORDER BY sp.id) FILTER (
               WHERE sp.active_from <= pg_catalog.now()
                 AND sp.revoked_at IS NULL
           ))[1]
    INTO v_historical_count, v_active_count, v_participant_id
    FROM inventarios.session_participants AS sp
    WHERE sp.company_id = p_company_id
      AND sp.session_id = p_session_id
      AND sp.user_id = v_actor_id
      AND sp.functional_role = v_functional_role;

    IF v_historical_count = 0 THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_NOT_FOUND',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'El recurso solicitado no existe.',
                      'retryable', false
                  )::text;
    END IF;

    IF v_active_count = 0 THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_PARTICIPANT_INACTIVE',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'No tienes una participacion activa en la jornada.',
                      'retryable', false
                  )::text;
    END IF;

    IF v_active_count > 1 THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_CONCURRENT_MODIFICATION',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'Se detecto un conflicto en la asignacion del participante.',
                      'retryable', true
                  )::text;
    END IF;

    RETURN v_participant_id;
END;
$$;

ALTER FUNCTION inventarios.require_actor() OWNER TO postgres;
ALTER FUNCTION inventarios.require_company_access(uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.require_permission(uuid, text) OWNER TO postgres;
ALTER FUNCTION inventarios.require_session_participant(uuid, uuid, text) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.require_actor()
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.require_company_access(uuid)
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.require_permission(uuid, text)
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.require_session_participant(uuid, uuid, text)
FROM PUBLIC, anon, authenticated, service_role;
