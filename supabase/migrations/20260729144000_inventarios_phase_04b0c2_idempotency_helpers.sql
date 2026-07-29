CREATE FUNCTION inventarios.compute_request_hash(
    p_payload jsonb
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
PARALLEL UNSAFE
AS $$
BEGIN
    IF p_payload IS NULL OR p_payload = 'null'::jsonb THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'La solicitud no tiene el formato requerido.',
                      'retryable', false
                  )::text;
    END IF;

    RETURN pg_catalog.encode(
        extensions.digest(
            pg_catalog.convert_to(p_payload::text, 'UTF8'),
            'sha256'
        ),
        'hex'
    );
END;
$$;

CREATE FUNCTION inventarios.begin_idempotent_operation(
    p_company_id uuid,
    p_operation_code text,
    p_idempotency_key uuid,
    p_request_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
PARALLEL UNSAFE
AS $$
DECLARE
    v_actor_id uuid;
    v_operation_id uuid;
    v_existing_actor_id uuid;
    v_existing_request_hash text;
    v_existing_status text;
    v_existing_response_payload jsonb;
BEGIN
    v_actor_id := inventarios.require_company_access(p_company_id);

    IF p_operation_code IS NULL
       OR pg_catalog.btrim(p_operation_code) = ''
       OR p_operation_code NOT LIKE 'inventarios.%'
       OR p_idempotency_key IS NULL
       OR p_request_hash IS NULL
       OR p_request_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'La solicitud no tiene el formato requerido.',
                      'retryable', false
                  )::text;
    END IF;

    INSERT INTO inventarios.operation_idempotency AS oi (
        company_id,
        operation_code,
        idempotency_key,
        actor_id,
        request_hash
    )
    VALUES (
        p_company_id,
        p_operation_code,
        p_idempotency_key,
        v_actor_id,
        p_request_hash
    )
    ON CONFLICT (company_id, operation_code, idempotency_key) DO NOTHING
    RETURNING oi.id INTO v_operation_id;

    IF v_operation_id IS NOT NULL THEN
        RETURN pg_catalog.jsonb_build_object(
            'mode', 'NEW',
            'operation_id', v_operation_id,
            'actor_id', v_actor_id,
            'response_payload', NULL::jsonb
        );
    END IF;

    SELECT oi.id,
           oi.actor_id,
           oi.request_hash,
           oi.status,
           oi.response_payload
    INTO v_operation_id,
         v_existing_actor_id,
         v_existing_request_hash,
         v_existing_status,
         v_existing_response_payload
    FROM inventarios.operation_idempotency AS oi
    WHERE oi.company_id = p_company_id
      AND oi.operation_code = p_operation_code
      AND oi.idempotency_key = p_idempotency_key
    FOR UPDATE;

    IF NOT FOUND THEN
        INSERT INTO inventarios.operation_idempotency AS oi (
            company_id,
            operation_code,
            idempotency_key,
            actor_id,
            request_hash
        )
        VALUES (
            p_company_id,
            p_operation_code,
            p_idempotency_key,
            v_actor_id,
            p_request_hash
        )
        ON CONFLICT (company_id, operation_code, idempotency_key) DO NOTHING
        RETURNING oi.id INTO v_operation_id;

        IF v_operation_id IS NOT NULL THEN
            RETURN pg_catalog.jsonb_build_object(
                'mode', 'NEW',
                'operation_id', v_operation_id,
                'actor_id', v_actor_id,
                'response_payload', NULL::jsonb
            );
        END IF;

        SELECT oi.id,
               oi.actor_id,
               oi.request_hash,
               oi.status,
               oi.response_payload
        INTO v_operation_id,
             v_existing_actor_id,
             v_existing_request_hash,
             v_existing_status,
             v_existing_response_payload
        FROM inventarios.operation_idempotency AS oi
        WHERE oi.company_id = p_company_id
          AND oi.operation_code = p_operation_code
          AND oi.idempotency_key = p_idempotency_key
        FOR UPDATE;
    END IF;

    IF NOT FOUND
       OR v_existing_actor_id IS DISTINCT FROM v_actor_id
       OR v_existing_request_hash IS DISTINCT FROM p_request_hash THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_IDEMPOTENCY_CONFLICT',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'La clave de idempotencia ya fue usada con una solicitud distinta.',
                      'retryable', false
                  )::text;
    END IF;

    IF v_existing_status = 'COMPLETED' THEN
        RETURN pg_catalog.jsonb_build_object(
            'mode', 'REPLAY',
            'operation_id', v_operation_id,
            'actor_id', v_actor_id,
            'response_payload', pg_catalog.jsonb_set(
                v_existing_response_payload,
                ARRAY['replayed'],
                'true'::jsonb,
                false
            )
        );
    END IF;

    RAISE EXCEPTION
        USING ERRCODE = 'P0001',
              MESSAGE = 'INV_IDEMPOTENCY_IN_PROGRESS',
              DETAIL = pg_catalog.jsonb_build_object(
                  'message', 'La operación todavía está siendo procesada. Intenta nuevamente.',
                  'retryable', true
              )::text;
END;
$$;

CREATE FUNCTION inventarios.complete_idempotent_operation(
    p_company_id uuid,
    p_operation_id uuid,
    p_entity_id uuid,
    p_response_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
PARALLEL UNSAFE
AS $$
DECLARE
    v_actor_id uuid;
    v_operation_code text;
    v_existing_actor_id uuid;
    v_status text;
    v_uuid uuid;
    v_numeric numeric;
BEGIN
    v_actor_id := inventarios.require_company_access(p_company_id);

    SELECT oi.operation_code,
           oi.actor_id,
           oi.status
    INTO v_operation_code,
         v_existing_actor_id,
         v_status
    FROM inventarios.operation_idempotency AS oi
    WHERE oi.company_id = p_company_id
      AND oi.id = p_operation_id
    FOR UPDATE;

    IF NOT FOUND THEN
        IF EXISTS (
            SELECT 1
            FROM inventarios.operation_idempotency AS oi
            WHERE oi.id = p_operation_id
        ) THEN
            RAISE EXCEPTION
                USING ERRCODE = 'P0001',
                      MESSAGE = 'INV_COMPANY_ACCESS_DENIED',
                      DETAIL = pg_catalog.jsonb_build_object(
                          'message', 'No tienes acceso a la empresa solicitada.',
                          'retryable', false
                      )::text;
        END IF;

        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_NOT_FOUND',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'El recurso solicitado no existe.',
                      'retryable', false
                  )::text;
    END IF;

    IF v_existing_actor_id IS DISTINCT FROM v_actor_id THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_COMPANY_ACCESS_DENIED',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'No tienes acceso a la empresa solicitada.',
                      'retryable', false
                  )::text;
    END IF;

    IF v_status = 'COMPLETED' THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_OPERATION_ALREADY_APPLIED',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'La operacion ya fue finalizada.',
                      'retryable', false
                  )::text;
    END IF;

    IF p_response_payload IS NULL
       OR pg_catalog.jsonb_typeof(p_response_payload) <> 'object'
       OR NOT (p_response_payload ?& ARRAY[
           'operation', 'entity_id', 'state', 'version', 'cycle_number',
           'assignment_id', 'event_id', 'replayed', 'occurred_at', 'data'
       ]) THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_INVALID_RESPONSE_ENVELOPE',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'La respuesta de la operacion no tiene el formato requerido.',
                      'retryable', false
                  )::text;
    END IF;

    IF pg_catalog.jsonb_typeof(p_response_payload -> 'operation') <> 'string'
       OR pg_catalog.btrim(p_response_payload ->> 'operation') = ''
       OR p_response_payload ->> 'operation' <> v_operation_code
       OR pg_catalog.jsonb_typeof(p_response_payload -> 'state') NOT IN ('null', 'string')
       OR (pg_catalog.jsonb_typeof(p_response_payload -> 'state') = 'string'
           AND pg_catalog.btrim(p_response_payload ->> 'state') = '')
       OR pg_catalog.jsonb_typeof(p_response_payload -> 'replayed') <> 'boolean'
       OR p_response_payload -> 'replayed' <> 'false'::jsonb
       OR pg_catalog.jsonb_typeof(p_response_payload -> 'occurred_at') <> 'string'
       OR pg_catalog.btrim(p_response_payload ->> 'occurred_at') = ''
       OR pg_catalog.jsonb_typeof(p_response_payload -> 'data') <> 'object' THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_INVALID_RESPONSE_ENVELOPE',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'La respuesta de la operacion no tiene el formato requerido.',
                      'retryable', false
                  )::text;
    END IF;

    BEGIN
        IF pg_catalog.jsonb_typeof(p_response_payload -> 'version') <> 'null' THEN
            IF pg_catalog.jsonb_typeof(p_response_payload -> 'version') <> 'number' THEN
                RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_RESPONSE_ENVELOPE';
            END IF;
            v_numeric := (p_response_payload ->> 'version')::numeric;
            IF v_numeric <= 0 OR v_numeric <> pg_catalog.trunc(v_numeric) OR v_numeric > 2147483647 THEN
                RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_RESPONSE_ENVELOPE';
            END IF;
        END IF;

        IF pg_catalog.jsonb_typeof(p_response_payload -> 'cycle_number') <> 'null' THEN
            IF pg_catalog.jsonb_typeof(p_response_payload -> 'cycle_number') <> 'number' THEN
                RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_RESPONSE_ENVELOPE';
            END IF;
            v_numeric := (p_response_payload ->> 'cycle_number')::numeric;
            IF v_numeric <= 0 OR v_numeric <> pg_catalog.trunc(v_numeric) OR v_numeric > 2147483647 THEN
                RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_RESPONSE_ENVELOPE';
            END IF;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_INVALID_RESPONSE_ENVELOPE',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'La respuesta de la operacion no tiene el formato requerido.',
                      'retryable', false
                  )::text;
    END;

    BEGIN
        IF pg_catalog.jsonb_typeof(p_response_payload -> 'entity_id') = 'null' THEN
            IF p_entity_id IS NOT NULL THEN
                RAISE EXCEPTION
                    USING ERRCODE = 'P0001',
                          MESSAGE = 'INV_INVALID_RESPONSE_ENVELOPE',
                          DETAIL = pg_catalog.jsonb_build_object(
                              'message', 'La respuesta de la operacion no tiene el formato requerido.',
                              'retryable', false
                          )::text;
            END IF;
        ELSIF pg_catalog.jsonb_typeof(p_response_payload -> 'entity_id') = 'string' THEN
            v_uuid := (p_response_payload ->> 'entity_id')::uuid;
            IF p_entity_id IS NULL OR v_uuid <> p_entity_id THEN
                RAISE EXCEPTION
                    USING ERRCODE = 'P0001',
                          MESSAGE = 'INV_INVALID_RESPONSE_ENVELOPE',
                          DETAIL = pg_catalog.jsonb_build_object(
                              'message', 'La respuesta de la operacion no tiene el formato requerido.',
                              'retryable', false
                          )::text;
            END IF;
        ELSE
            RAISE EXCEPTION
                USING ERRCODE = 'P0001',
                      MESSAGE = 'INV_INVALID_RESPONSE_ENVELOPE',
                      DETAIL = pg_catalog.jsonb_build_object(
                          'message', 'La respuesta de la operacion no tiene el formato requerido.',
                          'retryable', false
                      )::text;
        END IF;

        IF pg_catalog.jsonb_typeof(p_response_payload -> 'assignment_id') <> 'null' THEN
            IF pg_catalog.jsonb_typeof(p_response_payload -> 'assignment_id') <> 'string' THEN
                RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_RESPONSE_ENVELOPE';
            END IF;
            v_uuid := (p_response_payload ->> 'assignment_id')::uuid;
        END IF;

        IF pg_catalog.jsonb_typeof(p_response_payload -> 'event_id') <> 'null' THEN
            IF pg_catalog.jsonb_typeof(p_response_payload -> 'event_id') <> 'string' THEN
                RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_RESPONSE_ENVELOPE';
            END IF;
            v_uuid := (p_response_payload ->> 'event_id')::uuid;
        END IF;

        PERFORM (p_response_payload ->> 'occurred_at')::timestamptz;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_INVALID_RESPONSE_ENVELOPE',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'La respuesta de la operacion no tiene el formato requerido.',
                      'retryable', false
                  )::text;
    END;

    UPDATE inventarios.operation_idempotency AS oi
    SET entity_id = p_entity_id,
        response_payload = p_response_payload,
        status = 'COMPLETED',
        completed_at = pg_catalog.now()
    WHERE oi.company_id = p_company_id
      AND oi.id = p_operation_id;

    RETURN p_response_payload;
END;
$$;

ALTER FUNCTION inventarios.compute_request_hash(jsonb) OWNER TO postgres;
ALTER FUNCTION inventarios.begin_idempotent_operation(uuid, text, uuid, text) OWNER TO postgres;
ALTER FUNCTION inventarios.complete_idempotent_operation(uuid, uuid, uuid, jsonb) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.compute_request_hash(jsonb)
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.begin_idempotent_operation(uuid, text, uuid, text)
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.complete_idempotent_operation(uuid, uuid, uuid, jsonb)
FROM PUBLIC, anon, authenticated, service_role;
