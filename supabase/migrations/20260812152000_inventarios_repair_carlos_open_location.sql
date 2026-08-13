-- M2: Reparar la task_location OPEN que quedo huerfana al cancelar la jornada
-- historica de Carlos (sesion b98b5a11...). La cancelacion de una jornada
-- ocurrio antes de que cancel_inventory_session terminalizara las task_locations
-- OPEN (bloque incorporado en 20260812151000). Esta migracion cierra la location
-- residual y registra su evento LOCATION_CLOSED con actor administrativo.
--
-- Precondiciones defensivas (si algo no coincide, la migracion aborta sin tocar
-- datos):
--   1. La sesion existe, pertenece a la empresa d1000000..., y esta CANCELLED.
--   2. La tarea existe, pertenece a esa sesion, y esta cancelada.
--   3. La task_location existe, pertenece a esa tarea, esta OPEN, y fue abierta
--      por el usuario historico dc9be3b3... (Carlos).
-- Idempotencia: si la location ya esta CLOSED, la migracion no hace nada.

DO $$
DECLARE
    v_company_id uuid := 'd1000000-0000-0000-0000-000000000001';
    v_session_id uuid := 'b98b5a11-3bba-46ef-b607-17345aa796d0';
    v_task_id uuid := 'baee9465-af0b-4595-a2ae-43cecd7166e7';
    v_task_location_id uuid := 'e42466a4-ab6a-4301-ad15-e0bb9b72dd85';
    v_historical_user_id uuid := 'dc9be3b3-bf39-47b2-8ea3-fdd6aa9a4aaa';

    v_session_status text;
    v_session_cancelled_at timestamptz;
    v_session_cancelled_by uuid;
    v_session_zone_id uuid;
    v_task_cancelled_at timestamptz;
    v_task_cycle integer;
    v_tl_status text;
    v_tl_opened_by uuid;
    v_actor_id uuid;
    v_occurred_at timestamptz;
    v_event_idempotency_key uuid;
    v_event_id uuid;
BEGIN
    -- Precondicion 1: la sesion existe, es de la empresa, y esta CANCELLED.
    SELECT s.status, s.cancelled_at, s.cancelled_by
    INTO v_session_status, v_session_cancelled_at, v_session_cancelled_by
    FROM inventarios.sessions s
    WHERE s.company_id = v_company_id AND s.id = v_session_id;
    IF v_session_status IS NULL THEN
        RAISE EXCEPTION 'Precondition failed: session % not found', v_session_id;
    END IF;
    IF v_session_status <> 'CANCELLED' THEN
        RAISE EXCEPTION 'Precondition failed: session % status is %, expected CANCELLED',
            v_session_id, v_session_status;
    END IF;

    -- Precondicion 2: la tarea existe, es de la sesion, y esta cancelada.
    SELECT t.cancelled_at, t.validation_cycle
    INTO v_task_cancelled_at, v_task_cycle
    FROM inventarios.tasks t
    WHERE t.company_id = v_company_id AND t.session_id = v_session_id AND t.id = v_task_id;
    IF v_task_cancelled_at IS NULL THEN
        RAISE EXCEPTION 'Precondition failed: task % is not cancelled', v_task_id;
    END IF;

    -- Precondicion 3: la task_location existe, pertenece a la tarea, esta OPEN,
    -- y fue abierta por el usuario historico esperado.
    SELECT tl.status, tl.opened_by, tl.session_zone_id
    INTO v_tl_status, v_tl_opened_by, v_session_zone_id
    FROM inventarios.task_locations tl
    WHERE tl.company_id = v_company_id AND tl.session_id = v_session_id
      AND tl.task_id = v_task_id AND tl.id = v_task_location_id;
    IF v_tl_status IS NULL THEN
        RAISE EXCEPTION 'Precondition failed: task_location % not found', v_task_location_id;
    END IF;
    IF v_tl_status = 'CLOSED' THEN
        RAISE NOTICE 'task_location % already CLOSED; nothing to repair', v_task_location_id;
        RETURN;
    END IF;
    IF v_tl_status <> 'OPEN' THEN
        RAISE EXCEPTION 'Precondition failed: task_location % status is %, expected OPEN',
            v_task_location_id, v_tl_status;
    END IF;
    IF v_tl_opened_by <> v_historical_user_id THEN
        RAISE EXCEPTION 'Precondition failed: task_location % opened_by % differs from expected %',
            v_task_location_id, v_tl_opened_by, v_historical_user_id;
    END IF;

    -- Actor administrativo: el mismo usuario que cancelo la jornada (Carlos, unico
    -- participante administrador de esta sesion), de forma coherente con la
    -- cancelacion historica y con la reparacion 20260812145500.
    IF v_session_cancelled_by IS NULL THEN
        v_actor_id := v_historical_user_id;
    ELSE
        v_actor_id := v_session_cancelled_by;
    END IF;

    -- Momento coherente con la cancelacion historica de la jornada.
    v_occurred_at := v_session_cancelled_at;
    IF v_occurred_at IS NULL THEN
        v_occurred_at := pg_catalog.now();
    END IF;

    -- Cierre de la location.
    UPDATE inventarios.task_locations tl
    SET status = 'CLOSED',
        closed_at = v_occurred_at,
        closed_by = v_actor_id
    WHERE tl.company_id = v_company_id AND tl.session_id = v_session_id
      AND tl.task_id = v_task_id AND tl.id = v_task_location_id
      AND tl.status = 'OPEN';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Precondition failed: task_location % not OPEN at update time', v_task_location_id;
    END IF;

    -- Evento LOCATION_CLOSED idempotente.
    v_event_idempotency_key := (pg_catalog.md5(
        'M2_REPAIR:' || v_task_location_id::text || ':LOCATION_CLOSED'
    ))::uuid;
    INSERT INTO inventarios.task_events (
        company_id, session_id, session_zone_id, task_id, event_type, actor_id,
        cycle, occurred_at, reason, idempotency_key, source, technical_metadata,
        created_by
    ) VALUES (
        v_company_id, v_session_id, v_session_zone_id, v_task_id,
        'LOCATION_CLOSED', v_actor_id, v_task_cycle, v_occurred_at,
        'Administrative cleanup of open location left by cancelled session',
        v_event_idempotency_key, 'WEB',
        pg_catalog.jsonb_build_object(
            'task_location_id', v_task_location_id,
            'repair','M2',
            'session_status','CANCELLED',
            'terminal_status','CLOSED'
        ),
        v_actor_id
    )
    ON CONFLICT (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL
    DO NOTHING
    RETURNING id INTO v_event_id;

    RAISE NOTICE 'task_location % repaired: status CLOSED, event %',
        v_task_location_id, v_event_id;
END;
$$;
