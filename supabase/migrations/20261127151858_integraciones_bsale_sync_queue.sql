-- ============================================================================
-- SYNC-02 (Hardened): Cola persistente de sincronizaciones Bsale
--
-- Jerarquía canónica global de bloqueos PostgreSQL (sin inversión de orden):
--   Nivel 1: pg_advisory_xact_lock(hashtextextended('bsale_sync_coord:' || credential_scope, 0))
--   Nivel 2: pg_advisory_xact_lock(hashtextextended('bsale_sync_queue_dedupe:' || dedupe_key, 0))
--   Nivel 3: Filas de integraciones.bsale_sync_locks
--   Nivel 4: Filas de integraciones.bsale_sync_queue / bsale_sync_scope_cooldowns
--
-- Garantías de seguridad y concurrencia:
-- - Respeta íntegramente Retry-After de Bsale sin reducirlo a 300 segundos.
-- - Impide marcar COMPLETED cuando el propietario perdió su lease o expiró.
-- - Valida identidad completa (request_id + company_id + lock_name +
--   credential_scope + owner_token) antes de liberar cualquier bloqueo;
--   elimina toda liberación basada únicamente en owner_token.
-- - Compatible con PostgreSQL 15+. Forward-only.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS integraciones.bsale_sync_scope_cooldowns (
  credential_scope         text PRIMARY KEY,
  blocked_until            timestamptz NOT NULL,
  retry_after_seconds      integer NOT NULL CHECK (retry_after_seconds >= 1),
  last_http_status         integer NOT NULL DEFAULT 429,
  reason                   text,
  updated_at               timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE integraciones.bsale_sync_scope_cooldowns ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS integraciones.bsale_sync_queue (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL REFERENCES core.companies(id),
  credential_scope         text NOT NULL,
  operation_kind           text NOT NULL,
  lock_name                text NOT NULL,
  incompatible_lock_names  text[] NOT NULL DEFAULT ARRAY[]::text[],
  resource_key             text,
  dedupe_key               text NOT NULL,
  status                   text NOT NULL DEFAULT 'PENDING',
  priority                 text NOT NULL DEFAULT 'NORMAL',
  priority_weight          integer NOT NULL DEFAULT 200,
  coalesced_count          integer NOT NULL DEFAULT 1 CHECK (coalesced_count >= 1),
  attempt_count            integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts             integer NOT NULL DEFAULT 3 CHECK (max_attempts >= 1 AND max_attempts <= 10),
  ttl_seconds              integer NOT NULL DEFAULT 600 CHECK (ttl_seconds >= 1),
  trigger_type             text NOT NULL DEFAULT 'MANUAL',
  requested_by             uuid,
  payload                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  owner_token              text,
  worker_id                text,
  sync_run_id              uuid,
  enqueued_at              timestamptz NOT NULL DEFAULT now(),
  available_at             timestamptz NOT NULL DEFAULT now(),
  started_at               timestamptz,
  lease_expires_at         timestamptz,
  completed_at             timestamptz,
  cancelled_at             timestamptz,
  duration_ms              bigint,
  last_http_status         integer,
  retry_after_seconds      integer,
  last_error_code          text,
  last_error_message       text,
  error_history            jsonb NOT NULL DEFAULT '[]'::jsonb,
  result_summary           jsonb,
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_bsale_sync_queue_status
    CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),

  CONSTRAINT chk_bsale_sync_queue_priority
    CHECK (priority IN ('CRITICAL', 'HIGH', 'NORMAL', 'LOW')),

  CONSTRAINT chk_bsale_sync_queue_credential_scope
    CHECK (credential_scope LIKE 'cred:%'),

  -- Prohibición estricta de encolar facturación u otras escrituras tributarias en Bsale.
  CONSTRAINT chk_bsale_sync_queue_operation_kind
    CHECK (operation_kind IN (
      'REPLENISHMENT_SYNC',
      'OPERATIONAL_PREP_SYNC',
      'WAREHOUSE_INCREMENTAL',
      'WAREHOUSE_OPERATIONAL',
      'WAREHOUSE_MANUAL',
      'WAREHOUSE_FULL_REFRESH',
      'CARD_SYNC',
      'INCIDENT_SYNC',
      'AUDIT_SYNC',
      'COBRANZA_SNAPSHOT'
    ))
);

ALTER TABLE integraciones.bsale_sync_queue ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bsale_sync_queue_pending_dedupe
  ON integraciones.bsale_sync_queue (dedupe_key)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_bsale_sync_queue_pending_dispatch
  ON integraciones.bsale_sync_queue (status, available_at, priority_weight DESC, enqueued_at ASC)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_bsale_sync_queue_running_lease
  ON integraciones.bsale_sync_queue (status, lease_expires_at)
  WHERE status = 'RUNNING';

CREATE INDEX IF NOT EXISTS idx_bsale_sync_queue_company_enqueued
  ON integraciones.bsale_sync_queue (company_id, enqueued_at DESC);

-- Renovación unificada respetando estrictamente Nivel 1 -> Nivel 3 -> Nivel 4.
CREATE OR REPLACE FUNCTION integraciones.renew_bsale_sync_lock_v1(
  p_company_id uuid,
  p_lock_name text,
  p_owner_token text,
  p_ttl_seconds integer DEFAULT 600,
  p_credential_scope text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = integraciones, core, public
AS $$
DECLARE
  v_scope text := NULLIF(btrim(p_credential_scope), '');
  v_now timestamptz;
  v_ttl_seconds integer;
  v_expires_at timestamptz;
  v_lease_count integer;
BEGIN
  IF p_company_id IS NULL OR NULLIF(btrim(p_lock_name), '') IS NULL OR NULLIF(btrim(p_owner_token), '') IS NULL THEN
    RETURN jsonb_build_object('renewed', false, 'reason', 'INVALID_PARAMS');
  END IF;

  IF v_scope IS NULL THEN
    SELECT l.credential_scope
      INTO v_scope
      FROM integraciones.bsale_sync_locks l
     WHERE l.company_id = p_company_id
       AND l.lock_name = p_lock_name;
  END IF;

  IF v_scope IS NULL OR v_scope NOT LIKE 'cred:%' THEN
    RETURN jsonb_build_object(
      'renewed', false,
      'reason', 'LOCK_LOST_OR_EXPIRED',
      'server_now', clock_timestamp()
    );
  END IF;

  -- Nivel 1: bloqueo transaccional del alcance de credenciales
  PERFORM pg_advisory_xact_lock(hashtextextended('bsale_sync_coord:' || v_scope, 0));
  PERFORM set_config('integraciones.bsale_sync_coord_bypass', 'on', true);

  v_ttl_seconds := GREATEST(COALESCE(p_ttl_seconds, 600), 1);
  v_now := clock_timestamp();
  v_expires_at := v_now + make_interval(secs => v_ttl_seconds);

  -- Nivel 3: actualizar bsale_sync_locks validando identidad completa y vigencia
  UPDATE integraciones.bsale_sync_locks l
     SET expires_at = v_expires_at,
         renewed_at = v_now,
         lease_count = COALESCE(l.lease_count, 1) + 1
   WHERE l.company_id = p_company_id
     AND l.lock_name = p_lock_name
     AND l.credential_scope = v_scope
     AND l.owner_token = p_owner_token
     AND l.expires_at > v_now
  RETURNING l.lease_count INTO v_lease_count;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'renewed', false,
      'reason', 'LOCK_LOST_OR_EXPIRED',
      'server_now', v_now
    );
  END IF;

  -- Nivel 4: sincronizar lease_expires_at de la solicitud RUNNING correspondiente
  UPDATE integraciones.bsale_sync_queue q
     SET lease_expires_at = v_expires_at,
         updated_at = v_now
   WHERE q.company_id = p_company_id
     AND q.lock_name = p_lock_name
     AND q.credential_scope = v_scope
     AND q.owner_token = p_owner_token
     AND q.status = 'RUNNING'
     AND q.lease_expires_at > v_now;

  RETURN jsonb_build_object(
    'renewed', true,
    'server_now', v_now,
    'expires_at', v_expires_at,
    'lease_count', v_lease_count
  );
END;
$$;

-- 1. Encolado con deduplicación atómica (Orden Nivel 1 -> Nivel 2 -> Nivel 4).
CREATE OR REPLACE FUNCTION integraciones.enqueue_bsale_sync_request_v1(
  p_company_id uuid,
  p_credential_scope text,
  p_operation_kind text,
  p_lock_name text,
  p_incompatible_lock_names text[] DEFAULT ARRAY[]::text[],
  p_resource_key text DEFAULT NULL,
  p_priority text DEFAULT 'NORMAL',
  p_priority_weight integer DEFAULT 200,
  p_ttl_seconds integer DEFAULT 600,
  p_max_attempts integer DEFAULT 3,
  p_trigger_type text DEFAULT 'MANUAL',
  p_requested_by uuid DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_delay_seconds integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = integraciones, core, public
AS $$
DECLARE
  v_now timestamptz;
  v_scope text := NULLIF(btrim(p_credential_scope), '');
  v_op text := NULLIF(btrim(p_operation_kind), '');
  v_lock text := NULLIF(btrim(p_lock_name), '');
  v_resource text := NULLIF(btrim(p_resource_key), '');
  v_dedupe_key text;
  v_incompatible text[];
  v_available_at timestamptz;
  v_existing integraciones.bsale_sync_queue%ROWTYPE;
  v_running integraciones.bsale_sync_queue%ROWTYPE;
  v_active_lock integraciones.bsale_sync_locks%ROWTYPE;
  v_inserted integraciones.bsale_sync_queue%ROWTYPE;
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'BSALE_QUEUE_INVALID_COMPANY';
  END IF;
  IF v_scope IS NULL OR v_scope NOT LIKE 'cred:%' THEN
    RAISE EXCEPTION 'BSALE_QUEUE_INVALID_CREDENTIAL_SCOPE';
  END IF;
  IF v_lock IS NULL THEN
    RAISE EXCEPTION 'BSALE_QUEUE_INVALID_LOCK_NAME';
  END IF;
  IF v_op IS NULL OR v_op NOT IN (
    'REPLENISHMENT_SYNC',
    'OPERATIONAL_PREP_SYNC',
    'WAREHOUSE_INCREMENTAL',
    'WAREHOUSE_OPERATIONAL',
    'WAREHOUSE_MANUAL',
    'WAREHOUSE_FULL_REFRESH',
    'CARD_SYNC',
    'INCIDENT_SYNC',
    'AUDIT_SYNC',
    'COBRANZA_SNAPSHOT'
  ) THEN
    RAISE EXCEPTION 'BSALE_QUEUE_FORBIDDEN_OPERATION: %', COALESCE(v_op, 'NULL');
  END IF;

  v_dedupe_key := p_company_id::text || ':' || v_op || ':' || COALESCE(v_resource, 'ALL');
  v_incompatible := COALESCE(p_incompatible_lock_names, ARRAY[]::text[]);
  IF NOT (v_lock = ANY(v_incompatible)) THEN
    v_incompatible := array_append(v_incompatible, v_lock);
  END IF;

  -- Nivel 1 -> Nivel 2: orden canónico estricto antes de tocar filas
  PERFORM pg_advisory_xact_lock(hashtextextended('bsale_sync_coord:' || v_scope, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('bsale_sync_queue_dedupe:' || v_dedupe_key, 0));

  v_now := clock_timestamp();
  v_available_at := v_now + make_interval(secs => GREATEST(COALESCE(p_delay_seconds, 0), 0));

  -- Nivel 3: verificar si la misma operación ya está ejecutándose con lease vigente en bsale_sync_locks
  SELECT l.*
    INTO v_active_lock
    FROM integraciones.bsale_sync_locks l
   WHERE l.company_id = p_company_id
     AND l.expires_at > v_now
     AND (
       (l.operation_kind = v_op AND COALESCE(l.resource_key, '') = COALESCE(v_resource, ''))
       OR (
         v_resource IS NOT NULL
         AND v_resource LIKE 'card:%'
         AND l.resource_key = v_resource
         AND v_op IN ('CARD_SYNC', 'AUDIT_SYNC', 'INCIDENT_SYNC')
         AND l.operation_kind IN ('CARD_SYNC', 'AUDIT_SYNC', 'INCIDENT_SYNC')
       )
     )
   LIMIT 1;

  -- Nivel 4: fila RUNNING con lease vigente en bsale_sync_queue (deduplicación ante carreras simultáneas en ejecución)
  SELECT *
    INTO v_running
    FROM integraciones.bsale_sync_queue q
   WHERE q.dedupe_key = v_dedupe_key
     AND q.status = 'RUNNING'
     AND q.lease_expires_at > v_now
   FOR UPDATE;

  IF FOUND THEN
    UPDATE integraciones.bsale_sync_queue q
       SET coalesced_count = q.coalesced_count + 1,
           updated_at = v_now
     WHERE q.id = v_running.id
    RETURNING * INTO v_inserted;

    RETURN jsonb_build_object(
      'enqueued', false,
      'already_running', true,
      'deduplicated', true,
      'request_id', v_inserted.id,
      'status', 'RUNNING',
      'dedupe_key', v_inserted.dedupe_key,
      'credential_scope', v_inserted.credential_scope,
      'coalesced_count', v_inserted.coalesced_count,
      'available_at', v_inserted.available_at
    );
  END IF;

  -- Si existe ejecución directa activa equivalente en bsale_sync_locks (p. ej. múltiples pestañas simultáneas desde reposo),
  -- deduplicar atómicamente sin insertar una segunda ejecución redundante en cola.
  IF v_active_lock.company_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'enqueued', false,
      'already_running', true,
      'deduplicated', true,
      'request_id', NULLIF(v_active_lock.metadata->>'queue_request_id', ''),
      'status', 'RUNNING',
      'dedupe_key', v_dedupe_key,
      'credential_scope', v_scope,
      'coalesced_count', 2,
      'available_at', v_now
    );
  END IF;

  -- Nivel 4: fila PENDING en bsale_sync_queue
  SELECT *
    INTO v_existing
    FROM integraciones.bsale_sync_queue q
   WHERE q.dedupe_key = v_dedupe_key
     AND q.status = 'PENDING'
   FOR UPDATE;

  IF FOUND THEN
    UPDATE integraciones.bsale_sync_queue q
       SET coalesced_count = q.coalesced_count + 1,
           priority_weight = GREATEST(q.priority_weight, COALESCE(p_priority_weight, 200)),
           priority = CASE
             WHEN COALESCE(p_priority_weight, 200) > q.priority_weight THEN COALESCE(p_priority, q.priority)
             ELSE q.priority
           END,
           available_at = LEAST(q.available_at, v_available_at),
           updated_at = v_now
     WHERE q.id = v_existing.id
    RETURNING * INTO v_inserted;

    RETURN jsonb_build_object(
      'enqueued', true,
      'deduplicated', true,
      'request_id', v_inserted.id,
      'status', v_inserted.status,
      'dedupe_key', v_inserted.dedupe_key,
      'credential_scope', v_inserted.credential_scope,
      'coalesced_count', v_inserted.coalesced_count,
      'available_at', v_inserted.available_at
    );
  END IF;

  INSERT INTO integraciones.bsale_sync_queue (
    company_id,
    credential_scope,
    operation_kind,
    lock_name,
    incompatible_lock_names,
    resource_key,
    dedupe_key,
    status,
    priority,
    priority_weight,
    coalesced_count,
    attempt_count,
    max_attempts,
    ttl_seconds,
    trigger_type,
    requested_by,
    payload,
    enqueued_at,
    available_at,
    updated_at
  ) VALUES (
    p_company_id,
    v_scope,
    v_op,
    v_lock,
    v_incompatible,
    v_resource,
    v_dedupe_key,
    'PENDING',
    COALESCE(p_priority, 'NORMAL'),
    COALESCE(p_priority_weight, 200),
    1,
    0,
    LEAST(10, GREATEST(1, COALESCE(p_max_attempts, 3))),
    GREATEST(1, COALESCE(p_ttl_seconds, 600)),
    COALESCE(NULLIF(btrim(p_trigger_type), ''), 'MANUAL'),
    p_requested_by,
    COALESCE(p_payload, '{}'::jsonb),
    v_now,
    v_available_at,
    v_now
  )
  RETURNING * INTO v_inserted;

  RETURN jsonb_build_object(
    'enqueued', true,
    'deduplicated', false,
    'request_id', v_inserted.id,
    'status', v_inserted.status,
    'dedupe_key', v_inserted.dedupe_key,
    'credential_scope', v_inserted.credential_scope,
    'coalesced_count', v_inserted.coalesced_count,
    'available_at', v_inserted.available_at
  );
END;
$$;

-- 2. Recuperación ante interrupciones/reinicios (Orden Nivel 1 -> Nivel 2 -> Nivel 3 -> Nivel 4).
CREATE OR REPLACE FUNCTION integraciones.recover_bsale_sync_queue_v1()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = integraciones, core, public
AS $$
DECLARE
  v_now timestamptz;
  v_cand record;
  v_row integraciones.bsale_sync_queue%ROWTYPE;
  v_active_lock_exists boolean;
  v_recovered integer := 0;
  v_failed integer := 0;
  v_cancelled integer := 0;
  v_has_pending boolean;
  v_history_entry jsonb;
  v_skipped_contended integer := 0;
BEGIN
  PERFORM set_config('integraciones.bsale_sync_coord_bypass', 'on', true);

  -- Lectura inicial SIN bloqueo de fila (FOR UPDATE) para respetar Nivel 1 -> Nivel 2 primero,
  -- ordenada determinísticamente por credential_scope y dedupe_key.
  FOR v_cand IN
    SELECT q.id, q.company_id, q.lock_name, q.credential_scope, q.dedupe_key, q.owner_token
      FROM integraciones.bsale_sync_queue q
     WHERE q.status = 'RUNNING'
     ORDER BY q.credential_scope ASC, q.dedupe_key ASC, q.id ASC
  LOOP
    -- Nivel 1 -> Nivel 2 NO bloqueantes: esta función recorre varios credential_scope en una
    -- misma transacción y los advisory locks transaccionales se retienen hasta el commit.
    -- Para impedir deadlocks entre alcances, nunca espera un advisory lock: si el alcance o
    -- la deduplicación están ocupados, omite el candidato (se reintenta en el siguiente barrido)
    -- y revalida el estado real tras obtenerlos.
    IF NOT pg_try_advisory_xact_lock(hashtextextended('bsale_sync_coord:' || v_cand.credential_scope, 0)) THEN
      v_skipped_contended := v_skipped_contended + 1;
      CONTINUE;
    END IF;
    IF NOT pg_try_advisory_xact_lock(hashtextextended('bsale_sync_queue_dedupe:' || v_cand.dedupe_key, 0)) THEN
      v_skipped_contended := v_skipped_contended + 1;
      CONTINUE;
    END IF;
    v_now := clock_timestamp();

    -- Nivel 3: verificar en bsale_sync_locks si el propietario aún conserva lease activo
    SELECT EXISTS (
      SELECT 1
        FROM integraciones.bsale_sync_locks l
       WHERE l.company_id = v_cand.company_id
         AND l.lock_name = v_cand.lock_name
         AND l.credential_scope = v_cand.credential_scope
         AND v_cand.owner_token IS NOT NULL
         AND l.owner_token = v_cand.owner_token
         AND l.expires_at > v_now
    ) INTO v_active_lock_exists;

    -- Nivel 4: bloquear la fila RUNNING y revalidar expiración real tras serializar con renew
    SELECT *
      INTO v_row
      FROM integraciones.bsale_sync_queue q
     WHERE q.id = v_cand.id
       AND q.status = 'RUNNING'
     FOR UPDATE;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    -- Revalidar por si renew cambió owner_token o extendió lease justo antes de entrar a Nivel 1
    IF v_row.owner_token IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1
          FROM integraciones.bsale_sync_locks l
         WHERE l.company_id = v_row.company_id
           AND l.lock_name = v_row.lock_name
           AND l.credential_scope = v_row.credential_scope
           AND l.owner_token = v_row.owner_token
           AND l.expires_at > v_now
      ) INTO v_active_lock_exists;
    ELSE
      v_active_lock_exists := false;
    END IF;

    IF v_active_lock_exists AND v_row.lease_expires_at IS NOT NULL AND v_row.lease_expires_at > v_now THEN
      CONTINUE;
    END IF;

    -- Limpiar lock vencido validando identidad completa (company_id + lock_name + credential_scope + owner_token)
    IF v_row.owner_token IS NOT NULL THEN
      DELETE FROM integraciones.bsale_sync_locks l
       WHERE l.company_id = v_row.company_id
         AND l.lock_name = v_row.lock_name
         AND l.credential_scope = v_row.credential_scope
         AND l.owner_token = v_row.owner_token
         AND l.expires_at <= v_now;
    END IF;

    v_history_entry := jsonb_build_object(
      'attempt', v_row.attempt_count,
      'at', v_now,
      'error_code', 'INTERRUPTED_OR_LEASE_EXPIRED',
      'error_message', 'Solicitud RUNNING sin lease vigente (reinicio o interrupción del servidor).'
    );

    SELECT EXISTS (
      SELECT 1
        FROM integraciones.bsale_sync_queue p
       WHERE p.dedupe_key = v_row.dedupe_key
         AND p.status = 'PENDING'
    ) INTO v_has_pending;

    IF v_has_pending THEN
      UPDATE integraciones.bsale_sync_queue
         SET status = 'CANCELLED',
             cancelled_at = v_now,
             owner_token = NULL,
             worker_id = NULL,
             lease_expires_at = NULL,
             last_error_code = 'SUPERSEDED_AFTER_INTERRUPTION',
             last_error_message = 'Ejecución interrumpida reemplazada por una solicitud PENDING más reciente.',
             error_history = COALESCE(error_history, '[]'::jsonb) || jsonb_build_array(v_history_entry),
             updated_at = v_now
       WHERE id = v_row.id;
      v_cancelled := v_cancelled + 1;
    ELSIF v_row.attempt_count < v_row.max_attempts THEN
      UPDATE integraciones.bsale_sync_queue
         SET status = 'PENDING',
             available_at = v_now,
             owner_token = NULL,
             worker_id = NULL,
             lease_expires_at = NULL,
             last_error_code = 'INTERRUPTED_OR_LEASE_EXPIRED',
             last_error_message = 'Ejecución interrumpida; reencolada automáticamente para recuperación.',
             error_history = COALESCE(error_history, '[]'::jsonb) || jsonb_build_array(v_history_entry),
             updated_at = v_now
       WHERE id = v_row.id;
      v_recovered := v_recovered + 1;
    ELSE
      UPDATE integraciones.bsale_sync_queue
         SET status = 'FAILED',
             completed_at = v_now,
             owner_token = NULL,
             worker_id = NULL,
             lease_expires_at = NULL,
             last_error_code = 'MAX_ATTEMPTS_EXCEEDED_AFTER_INTERRUPTION',
             last_error_message = 'Se agotaron los reintentos tras interrupción o expiración del lease.',
             error_history = COALESCE(error_history, '[]'::jsonb) || jsonb_build_array(v_history_entry),
             updated_at = v_now
       WHERE id = v_row.id;
      v_failed := v_failed + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'server_now', clock_timestamp(),
    'recovered_to_pending', v_recovered,
    'failed_exhausted', v_failed,
    'cancelled_superseded', v_cancelled,
    'skipped_contended', v_skipped_contended
  );
END;
$$;

-- 3. Adquisición atómica de la siguiente solicitud pendiente ejecutable
--    (Orden Nivel 1 -> Nivel 2 -> Nivel 3 -> Nivel 4).
CREATE OR REPLACE FUNCTION integraciones.claim_next_bsale_sync_request_v1(
  p_worker_id text,
  p_credential_scope text DEFAULT NULL,
  p_max_starvation_seconds integer DEFAULT 900,
  p_aging_step_seconds integer DEFAULT 180
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = integraciones, core, public
AS $$
DECLARE
  v_now timestamptz;
  v_starvation_secs integer := GREATEST(1, COALESCE(p_max_starvation_seconds, 900));
  v_aging_secs integer := GREATEST(1, COALESCE(p_aging_step_seconds, 180));
  v_candidate record;
  v_claimed integraciones.bsale_sync_queue%ROWTYPE;
  v_cooldown_until timestamptz;
  v_owner_token text;
  v_expires_at timestamptz;
  v_blocking_exists boolean;
  v_still_pending boolean;
  v_next_wakeup timestamptz := NULL;
  v_contended_wakeup timestamptz;
BEGIN
  IF NULLIF(btrim(p_worker_id), '') IS NULL THEN
    RAISE EXCEPTION 'BSALE_QUEUE_INVALID_WORKER_ID';
  END IF;

  PERFORM integraciones.recover_bsale_sync_queue_v1();
  PERFORM set_config('integraciones.bsale_sync_coord_bypass', 'on', true);
  v_now := clock_timestamp();

  FOR v_candidate IN
    SELECT
      q.id,
      q.company_id,
      q.credential_scope,
      q.dedupe_key,
      q.operation_kind,
      q.lock_name,
      q.incompatible_lock_names,
      q.resource_key,
      q.priority,
      q.trigger_type,
      q.sync_run_id,
      q.ttl_seconds
    FROM integraciones.bsale_sync_queue q
    WHERE q.status = 'PENDING'
      AND q.available_at <= v_now
      AND (p_credential_scope IS NULL OR q.credential_scope = p_credential_scope)
    ORDER BY
      CASE
        WHEN EXTRACT(EPOCH FROM (v_now - q.enqueued_at)) >= v_starvation_secs THEN 1
        ELSE 0
      END DESC,
      (q.priority_weight + (FLOOR(GREATEST(0, EXTRACT(EPOCH FROM (v_now - q.enqueued_at))) / v_aging_secs)::integer * 50)) DESC,
      q.enqueued_at ASC,
      q.id ASC
  LOOP
    -- Nivel 1 -> Nivel 2 NO bloqueantes: claim_next evalúa candidatos de varios credential_scope
    -- en una sola transacción y los advisory locks se retienen hasta el commit. Nunca espera:
    -- si el alcance o la deduplicación están ocupados por otra transacción, omite el candidato,
    -- programa un reintento breve y revalida el estado real tras obtener los bloqueos.
    IF NOT pg_try_advisory_xact_lock(hashtextextended('bsale_sync_coord:' || v_candidate.credential_scope, 0)) THEN
      v_contended_wakeup := clock_timestamp() + interval '1 second';
      IF v_next_wakeup IS NULL OR v_contended_wakeup < v_next_wakeup THEN
        v_next_wakeup := v_contended_wakeup;
      END IF;
      CONTINUE;
    END IF;
    IF NOT pg_try_advisory_xact_lock(hashtextextended('bsale_sync_queue_dedupe:' || v_candidate.dedupe_key, 0)) THEN
      v_contended_wakeup := clock_timestamp() + interval '1 second';
      IF v_next_wakeup IS NULL OR v_contended_wakeup < v_next_wakeup THEN
        v_next_wakeup := v_contended_wakeup;
      END IF;
      CONTINUE;
    END IF;
    v_now := clock_timestamp();

    SELECT EXISTS (
      SELECT 1
        FROM integraciones.bsale_sync_queue q
       WHERE q.id = v_candidate.id
         AND q.status = 'PENDING'
         AND q.available_at <= v_now
    ) INTO v_still_pending;

    IF NOT v_still_pending THEN
      CONTINUE;
    END IF;

    -- Nivel 3: limpiar bloqueos vencidos y comprobar incompatibilidades en bsale_sync_locks
    DELETE FROM integraciones.bsale_sync_locks l
     WHERE l.expires_at <= v_now
       AND (
         l.credential_scope = v_candidate.credential_scope
         OR (l.company_id = v_candidate.company_id AND l.lock_name = v_candidate.lock_name)
       );

    SELECT EXISTS (
      SELECT 1
        FROM integraciones.bsale_sync_locks l
       WHERE l.expires_at > v_now
         AND (l.credential_scope = v_candidate.credential_scope OR l.company_id = v_candidate.company_id)
         AND (
           l.lock_name = ANY(v_candidate.incompatible_lock_names)
           OR l.lock_name = v_candidate.lock_name
           OR (v_candidate.resource_key IS NOT NULL AND l.resource_key = v_candidate.resource_key)
         )
    ) INTO v_blocking_exists;

    IF v_blocking_exists THEN
      CONTINUE;
    END IF;

    -- Nivel 4: comprobar y depurar cooldown HTTP 429 del alcance
    DELETE FROM integraciones.bsale_sync_scope_cooldowns c
     WHERE c.credential_scope = v_candidate.credential_scope
       AND c.blocked_until <= v_now;

    SELECT c.blocked_until
      INTO v_cooldown_until
      FROM integraciones.bsale_sync_scope_cooldowns c
     WHERE c.credential_scope = v_candidate.credential_scope
       AND c.blocked_until > v_now;

    IF FOUND THEN
      IF v_next_wakeup IS NULL OR v_cooldown_until < v_next_wakeup THEN
        v_next_wakeup := v_cooldown_until;
      END IF;
      CONTINUE;
    END IF;

    v_owner_token := gen_random_uuid()::text;
    v_expires_at := v_now + make_interval(secs => v_candidate.ttl_seconds);

    -- Nivel 3: adquirir lease en bsale_sync_locks
    INSERT INTO integraciones.bsale_sync_locks (
      company_id,
      lock_name,
      run_id,
      acquired_at,
      expires_at,
      metadata,
      owner_token,
      operation_kind,
      credential_scope,
      resource_key,
      renewed_at,
      lease_count
    ) VALUES (
      v_candidate.company_id,
      v_candidate.lock_name,
      v_candidate.sync_run_id,
      v_now,
      v_expires_at,
      jsonb_build_object(
        'queue_request_id', v_candidate.id,
        'priority', v_candidate.priority,
        'dedupeKey', v_candidate.dedupe_key,
        'triggerType', v_candidate.trigger_type
      ),
      v_owner_token,
      v_candidate.operation_kind,
      v_candidate.credential_scope,
      v_candidate.resource_key,
      v_now,
      1
    )
    ON CONFLICT (company_id, lock_name) DO UPDATE
      SET run_id = EXCLUDED.run_id,
          acquired_at = v_now,
          expires_at = EXCLUDED.expires_at,
          metadata = EXCLUDED.metadata,
          owner_token = EXCLUDED.owner_token,
          operation_kind = EXCLUDED.operation_kind,
          credential_scope = EXCLUDED.credential_scope,
          resource_key = EXCLUDED.resource_key,
          renewed_at = v_now,
          lease_count = 1
    WHERE bsale_sync_locks.expires_at <= v_now;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    -- Nivel 4: reclamar solicitud en bsale_sync_queue
    UPDATE integraciones.bsale_sync_queue q
       SET status = 'RUNNING',
           owner_token = v_owner_token,
           worker_id = p_worker_id,
           attempt_count = q.attempt_count + 1,
           started_at = v_now,
           lease_expires_at = v_expires_at,
           updated_at = v_now
     WHERE q.id = v_candidate.id
       AND q.status = 'PENDING'
       AND q.available_at <= v_now
    RETURNING * INTO v_claimed;

    IF NOT FOUND THEN
      DELETE FROM integraciones.bsale_sync_locks l
       WHERE l.company_id = v_candidate.company_id
         AND l.lock_name = v_candidate.lock_name
         AND l.credential_scope = v_candidate.credential_scope
         AND l.owner_token = v_owner_token;
      CONTINUE;
    END IF;

    RETURN jsonb_build_object(
      'claimed', true,
      'server_now', v_now,
      'lease', jsonb_build_object(
        'owner_token', v_owner_token,
        'lock_name', v_claimed.lock_name,
        'expires_at', v_expires_at,
        'server_now', v_now
      ),
      'request', jsonb_build_object(
        'id', v_claimed.id,
        'company_id', v_claimed.company_id,
        'credential_scope', v_claimed.credential_scope,
        'operation_kind', v_claimed.operation_kind,
        'lock_name', v_claimed.lock_name,
        'resource_key', v_claimed.resource_key,
        'dedupe_key', v_claimed.dedupe_key,
        'status', v_claimed.status,
        'priority', v_claimed.priority,
        'priority_weight', v_claimed.priority_weight,
        'coalesced_count', v_claimed.coalesced_count,
        'attempt_count', v_claimed.attempt_count,
        'max_attempts', v_claimed.max_attempts,
        'ttl_seconds', v_claimed.ttl_seconds,
        'trigger_type', v_claimed.trigger_type,
        'requested_by', v_claimed.requested_by,
        'payload', v_claimed.payload,
        'enqueued_at', v_claimed.enqueued_at,
        'started_at', v_claimed.started_at
      )
    );
  END LOOP;

  SELECT MIN(q.available_at)
    INTO v_cooldown_until
    FROM integraciones.bsale_sync_queue q
   WHERE q.status = 'PENDING'
     AND q.available_at > v_now
     AND (p_credential_scope IS NULL OR q.credential_scope = p_credential_scope);

  IF v_cooldown_until IS NOT NULL AND (v_next_wakeup IS NULL OR v_cooldown_until < v_next_wakeup) THEN
    v_next_wakeup := v_cooldown_until;
  END IF;

  SELECT MIN(c.blocked_until)
    INTO v_cooldown_until
    FROM integraciones.bsale_sync_scope_cooldowns c
   WHERE c.blocked_until > v_now
     AND (p_credential_scope IS NULL OR c.credential_scope = p_credential_scope)
     AND EXISTS (
       SELECT 1
         FROM integraciones.bsale_sync_queue q
        WHERE q.status = 'PENDING'
          AND q.credential_scope = c.credential_scope
     );

  IF v_cooldown_until IS NOT NULL AND (v_next_wakeup IS NULL OR v_cooldown_until < v_next_wakeup) THEN
    v_next_wakeup := v_cooldown_until;
  END IF;

  RETURN jsonb_build_object(
    'claimed', false,
    'server_now', v_now,
    'next_available_at', v_next_wakeup
  );
END;
$$;

-- 4. Cierre exitoso exigiendo identidad completa y lease vigente (no expirado ni perdido).
--    Orden Nivel 1 -> Nivel 2 -> Nivel 3 -> Nivel 4.
CREATE OR REPLACE FUNCTION integraciones.complete_bsale_sync_request_v1(
  p_request_id uuid,
  p_company_id uuid,
  p_lock_name text,
  p_credential_scope text,
  p_owner_token text,
  p_duration_ms bigint DEFAULT 0,
  p_sync_run_id uuid DEFAULT NULL,
  p_result_summary jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = integraciones, core, public
AS $$
DECLARE
  v_scope text := NULLIF(btrim(p_credential_scope), '');
  v_lock text := NULLIF(btrim(p_lock_name), '');
  v_owner text := NULLIF(btrim(p_owner_token), '');
  v_dedupe_key text;
  v_now timestamptz;
  v_row integraciones.bsale_sync_queue%ROWTYPE;
  v_active_lock_released boolean := false;
  v_lease_associated boolean := false;
  v_lock_expires_at timestamptz;
  v_has_newer_pending boolean := false;
  v_history_entry jsonb;
  v_fallback_status text;
BEGIN
  IF p_request_id IS NULL OR p_company_id IS NULL OR v_lock IS NULL OR v_scope IS NULL OR v_scope NOT LIKE 'cred:%' OR v_owner IS NULL THEN
    RETURN jsonb_build_object('completed', false, 'reason', 'INVALID_PARAMS');
  END IF;

  -- Validar existencia e identidad completa antes de adquirir bloqueos o modificar estado
  SELECT q.dedupe_key
    INTO v_dedupe_key
    FROM integraciones.bsale_sync_queue q
   WHERE q.id = p_request_id
     AND q.company_id = p_company_id
     AND q.lock_name = v_lock
     AND q.credential_scope = v_scope;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('completed', false, 'reason', 'UNAUTHORIZED_OR_NOT_FOUND');
  END IF;

  -- Nivel 1 -> Nivel 2
  PERFORM pg_advisory_xact_lock(hashtextextended('bsale_sync_coord:' || v_scope, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('bsale_sync_queue_dedupe:' || v_dedupe_key, 0));
  PERFORM set_config('integraciones.bsale_sync_coord_bypass', 'on', true);

  v_now := clock_timestamp();

  -- Validación previa obligatoria: identidad completa + owner_token + estado RUNNING.
  -- Se ejecuta ANTES de tocar cualquier bloqueo. Las mutaciones de esta solicitud y de
  -- su lease están serializadas por el Nivel 1 ya adquirido, por lo que la lectura es estable.
  -- Una solicitud inválida retorna aquí sin modificar ningún bloqueo existente.
  PERFORM 1
    FROM integraciones.bsale_sync_queue q
   WHERE q.id = p_request_id
     AND q.company_id = p_company_id
     AND q.lock_name = v_lock
     AND q.credential_scope = v_scope
     AND q.owner_token = v_owner
     AND q.status = 'RUNNING';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('completed', false, 'reason', 'NOT_OWNER_OR_NOT_RUNNING');
  END IF;

  -- Nivel 3: verificar que el lease pertenezca exactamente a esta solicitud (asociación request_id).
  SELECT l.expires_at
    INTO v_lock_expires_at
    FROM integraciones.bsale_sync_locks l
   WHERE l.company_id = p_company_id
     AND l.lock_name = v_lock
     AND l.credential_scope = v_scope
     AND l.owner_token = v_owner
     AND l.metadata ->> 'queue_request_id' = p_request_id::text
   FOR UPDATE;

  v_lease_associated := FOUND;

  -- Nivel 3: liberar ÚNICAMENTE el lease vigente asociado a esta solicitud.
  IF v_lease_associated AND v_lock_expires_at > v_now THEN
    DELETE FROM integraciones.bsale_sync_locks l
     WHERE l.company_id = p_company_id
       AND l.lock_name = v_lock
       AND l.credential_scope = v_scope
       AND l.owner_token = v_owner
       AND l.metadata ->> 'queue_request_id' = p_request_id::text
       AND l.expires_at > v_now
    RETURNING true INTO v_active_lock_released;
  END IF;

  -- Nivel 4: bloquear la solicitud y verificar propiedad + vigencia de lease_expires_at
  SELECT *
    INTO v_row
    FROM integraciones.bsale_sync_queue q
   WHERE q.id = p_request_id
     AND q.company_id = p_company_id
     AND q.lock_name = v_lock
     AND q.credential_scope = v_scope
     AND q.owner_token = v_owner
     AND q.status = 'RUNNING'
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('completed', false, 'reason', 'NOT_OWNER_OR_NOT_RUNNING');
  END IF;

  -- Impedir estrictamente marcar COMPLETED si el lease había expirado, se perdió o no está asociado a esta solicitud
  IF NOT COALESCE(v_active_lock_released, false) OR v_row.lease_expires_at IS NULL OR v_row.lease_expires_at <= v_now THEN
    -- Limpiar únicamente un lease vencido asociado exactamente a esta solicitud
    IF v_lease_associated THEN
      DELETE FROM integraciones.bsale_sync_locks l
       WHERE l.company_id = p_company_id
         AND l.lock_name = v_lock
         AND l.credential_scope = v_scope
         AND l.owner_token = v_owner
         AND l.metadata ->> 'queue_request_id' = p_request_id::text
         AND l.expires_at <= v_now;
    END IF;

    v_history_entry := jsonb_build_object(
      'attempt', v_row.attempt_count,
      'at', v_now,
      'error_code', 'LEASE_EXPIRED_BEFORE_COMPLETE',
      'error_message', 'Se rechazó COMPLETED porque el lease expiró o perdió propiedad antes del cierre.'
    );

    SELECT EXISTS (
      SELECT 1
        FROM integraciones.bsale_sync_queue p
       WHERE p.dedupe_key = v_row.dedupe_key
         AND p.status = 'PENDING'
    ) INTO v_has_newer_pending;

    IF v_has_newer_pending THEN
      v_fallback_status := 'CANCELLED';
      UPDATE integraciones.bsale_sync_queue q
         SET status = 'CANCELLED',
             cancelled_at = v_now,
             duration_ms = COALESCE(q.duration_ms, 0) + GREATEST(0, COALESCE(p_duration_ms, 0)),
             last_error_code = 'LEASE_EXPIRED_BEFORE_COMPLETE',
             last_error_message = 'Ejecución finalizó tras perder vigencia del lease; reemplazada por solicitud PENDING.',
             error_history = COALESCE(q.error_history, '[]'::jsonb) || jsonb_build_array(v_history_entry),
             owner_token = NULL,
             worker_id = NULL,
             lease_expires_at = NULL,
             updated_at = v_now
       WHERE q.id = p_request_id;
    ELSIF v_row.attempt_count < v_row.max_attempts THEN
      v_fallback_status := 'PENDING';
      UPDATE integraciones.bsale_sync_queue q
         SET status = 'PENDING',
             available_at = v_now,
             duration_ms = COALESCE(q.duration_ms, 0) + GREATEST(0, COALESCE(p_duration_ms, 0)),
             last_error_code = 'LEASE_EXPIRED_BEFORE_COMPLETE',
             last_error_message = 'Ejecución rechazó cierre COMPLETED por lease vencido; reencolada para revalidación limpia.',
             error_history = COALESCE(q.error_history, '[]'::jsonb) || jsonb_build_array(v_history_entry),
             owner_token = NULL,
             worker_id = NULL,
             lease_expires_at = NULL,
             updated_at = v_now
       WHERE q.id = p_request_id;
    ELSE
      v_fallback_status := 'FAILED';
      UPDATE integraciones.bsale_sync_queue q
         SET status = 'FAILED',
             completed_at = v_now,
             duration_ms = COALESCE(q.duration_ms, 0) + GREATEST(0, COALESCE(p_duration_ms, 0)),
             last_error_code = 'LEASE_EXPIRED_BEFORE_COMPLETE',
             last_error_message = 'Ejecución rechazó cierre COMPLETED por lease vencido tras agotar intentos.',
             error_history = COALESCE(q.error_history, '[]'::jsonb) || jsonb_build_array(v_history_entry),
             owner_token = NULL,
             worker_id = NULL,
             lease_expires_at = NULL,
             updated_at = v_now
       WHERE q.id = p_request_id;
    END IF;

    RETURN jsonb_build_object(
      'completed', false,
      'reason', 'LEASE_EXPIRED_OR_LOST',
      'lease_associated', v_lease_associated,
      'status', v_fallback_status,
      'server_now', v_now
    );
  END IF;

  UPDATE integraciones.bsale_sync_queue q
     SET status = 'COMPLETED',
         completed_at = v_now,
         duration_ms = COALESCE(q.duration_ms, 0) + GREATEST(0, COALESCE(p_duration_ms, 0)),
         sync_run_id = COALESCE(p_sync_run_id, q.sync_run_id),
         result_summary = COALESCE(p_result_summary, '{}'::jsonb),
         owner_token = NULL,
         worker_id = NULL,
         lease_expires_at = NULL,
         updated_at = v_now
   WHERE q.id = p_request_id;

  RETURN jsonb_build_object(
    'completed', true,
    'request_id', p_request_id,
    'credential_scope', v_row.credential_scope,
    'completed_at', v_now
  );
END;
$$;

-- 5. Registro de error, manejo íntegro de HTTP 429 (Retry-After sin tope 300s)
--    y validación estricta de identidad completa (sin borrado ciego por owner_token).
--    Orden Nivel 1 -> Nivel 2 -> Nivel 3 -> Nivel 4.
CREATE OR REPLACE FUNCTION integraciones.fail_or_retry_bsale_sync_request_v1(
  p_request_id uuid,
  p_company_id uuid,
  p_lock_name text,
  p_credential_scope text,
  p_owner_token text,
  p_error_code text,
  p_error_message text,
  p_retryable boolean DEFAULT false,
  p_http_status integer DEFAULT NULL,
  p_retry_after_seconds integer DEFAULT NULL,
  p_duration_ms bigint DEFAULT 0,
  p_sync_run_id uuid DEFAULT NULL,
  p_result_summary jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = integraciones, core, public
AS $$
DECLARE
  v_scope text := NULLIF(btrim(p_credential_scope), '');
  v_lock text := NULLIF(btrim(p_lock_name), '');
  v_owner text := NULLIF(btrim(p_owner_token), '');
  v_dedupe_key text;
  v_is_authorized_running boolean := false;
  v_now timestamptz;
  v_row integraciones.bsale_sync_queue%ROWTYPE;
  v_backoff_secs integer;
  v_next_available timestamptz;
  v_has_newer_pending boolean;
  v_history_entry jsonb;
BEGIN
  IF p_request_id IS NULL OR p_company_id IS NULL OR v_lock IS NULL OR v_scope IS NULL OR v_scope NOT LIKE 'cred:%' OR v_owner IS NULL THEN
    RETURN jsonb_build_object('updated', false, 'reason', 'INVALID_PARAMS');
  END IF;

  -- Validar que la solicitud existe con la identidad completa indicada
  SELECT q.dedupe_key
    INTO v_dedupe_key
    FROM integraciones.bsale_sync_queue q
   WHERE q.id = p_request_id
     AND q.company_id = p_company_id
     AND q.lock_name = v_lock
     AND q.credential_scope = v_scope;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('updated', false, 'reason', 'UNAUTHORIZED_OR_NOT_FOUND');
  END IF;

  -- Nivel 1 -> Nivel 2
  PERFORM pg_advisory_xact_lock(hashtextextended('bsale_sync_coord:' || v_scope, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('bsale_sync_queue_dedupe:' || v_dedupe_key, 0));
  PERFORM set_config('integraciones.bsale_sync_coord_bypass', 'on', true);

  v_now := clock_timestamp();

  -- Confirmar propiedad activa de la solicitud ANTES de liberar cualquier bloqueo en Nivel 3
  SELECT EXISTS (
    SELECT 1
      FROM integraciones.bsale_sync_queue q
     WHERE q.id = p_request_id
       AND q.company_id = p_company_id
       AND q.lock_name = v_lock
       AND q.credential_scope = v_scope
       AND q.owner_token = v_owner
       AND q.status = 'RUNNING'
  ) INTO v_is_authorized_running;

  IF NOT v_is_authorized_running THEN
    RETURN jsonb_build_object('updated', false, 'reason', 'NOT_OWNER_OR_ALREADY_RECOVERED');
  END IF;

  -- Nivel 3: liberar el bloqueo validando identidad completa
  DELETE FROM integraciones.bsale_sync_locks l
   WHERE l.company_id = p_company_id
     AND l.lock_name = v_lock
     AND l.credential_scope = v_scope
     AND l.owner_token = v_owner;

  -- Nivel 4: bloquear y actualizar solicitud + cooldown del alcance
  SELECT *
    INTO v_row
    FROM integraciones.bsale_sync_queue q
   WHERE q.id = p_request_id
     AND q.company_id = p_company_id
     AND q.lock_name = v_lock
     AND q.credential_scope = v_scope
     AND q.owner_token = v_owner
     AND q.status = 'RUNNING'
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('updated', false, 'reason', 'NOT_OWNER_OR_ALREADY_RECOVERED');
  END IF;

  IF p_http_status = 429 OR (p_retry_after_seconds IS NOT NULL AND p_retry_after_seconds > 0) THEN
    -- Respetar íntegramente el plazo Retry-After válido indicado por Bsale (sin tope artificial de 300s).
    v_backoff_secs := GREATEST(1, COALESCE(p_retry_after_seconds, 30));
    v_next_available := v_now + make_interval(secs => v_backoff_secs);

    INSERT INTO integraciones.bsale_sync_scope_cooldowns (
      credential_scope,
      blocked_until,
      retry_after_seconds,
      last_http_status,
      reason,
      updated_at
    ) VALUES (
      v_scope,
      v_next_available,
      v_backoff_secs,
      COALESCE(p_http_status, 429),
      LEFT(COALESCE(p_error_message, 'Bsale HTTP 429'), 500),
      v_now
    )
    ON CONFLICT (credential_scope) DO UPDATE
      SET blocked_until = GREATEST(bsale_sync_scope_cooldowns.blocked_until, EXCLUDED.blocked_until),
          retry_after_seconds = CASE
            WHEN EXCLUDED.blocked_until >= bsale_sync_scope_cooldowns.blocked_until THEN EXCLUDED.retry_after_seconds
            ELSE bsale_sync_scope_cooldowns.retry_after_seconds
          END,
          last_http_status = EXCLUDED.last_http_status,
          reason = EXCLUDED.reason,
          updated_at = v_now;
  ELSE
    v_backoff_secs := LEAST(120, GREATEST(2, (2 ^ LEAST(v_row.attempt_count, 5))::integer));
    v_next_available := v_now + make_interval(secs => v_backoff_secs);
  END IF;

  v_history_entry := jsonb_build_object(
    'attempt', v_row.attempt_count,
    'at', v_now,
    'error_code', COALESCE(p_error_code, 'EXECUTION_ERROR'),
    'error_message', LEFT(COALESCE(p_error_message, 'Error desconocido'), 1000),
    'http_status', p_http_status,
    'retry_after_seconds', CASE WHEN p_http_status = 429 OR p_retry_after_seconds IS NOT NULL THEN v_backoff_secs ELSE NULL END,
    'duration_ms', GREATEST(0, COALESCE(p_duration_ms, 0))
  );

  IF COALESCE(p_retryable, false) AND v_row.attempt_count < v_row.max_attempts THEN
    SELECT EXISTS (
      SELECT 1
        FROM integraciones.bsale_sync_queue p
       WHERE p.dedupe_key = v_row.dedupe_key
         AND p.status = 'PENDING'
    ) INTO v_has_newer_pending;

    IF v_has_newer_pending THEN
      UPDATE integraciones.bsale_sync_queue p
         SET available_at = GREATEST(p.available_at, v_next_available),
             updated_at = v_now
       WHERE p.dedupe_key = v_row.dedupe_key
         AND p.status = 'PENDING';

      UPDATE integraciones.bsale_sync_queue q
         SET status = 'CANCELLED',
             cancelled_at = v_now,
             duration_ms = COALESCE(q.duration_ms, 0) + GREATEST(0, COALESCE(p_duration_ms, 0)),
             sync_run_id = COALESCE(p_sync_run_id, q.sync_run_id),
             last_http_status = p_http_status,
             retry_after_seconds = v_backoff_secs,
             last_error_code = 'SUPERSEDED_ON_RETRY',
             last_error_message = LEFT(COALESCE(p_error_message, ''), 1000),
             error_history = COALESCE(q.error_history, '[]'::jsonb) || jsonb_build_array(v_history_entry),
             owner_token = NULL,
             worker_id = NULL,
             lease_expires_at = NULL,
             updated_at = v_now
       WHERE q.id = p_request_id;

      RETURN jsonb_build_object(
        'updated', true,
        'status', 'CANCELLED',
        'credential_scope', v_row.credential_scope,
        'next_available_at', v_next_available,
        'backoff_seconds', v_backoff_secs
      );
    END IF;

    UPDATE integraciones.bsale_sync_queue q
       SET status = 'PENDING',
           available_at = v_next_available,
           duration_ms = COALESCE(q.duration_ms, 0) + GREATEST(0, COALESCE(p_duration_ms, 0)),
           sync_run_id = COALESCE(p_sync_run_id, q.sync_run_id),
           last_http_status = p_http_status,
           retry_after_seconds = v_backoff_secs,
           last_error_code = COALESCE(p_error_code, 'RETRY_SCHEDULED'),
           last_error_message = LEFT(COALESCE(p_error_message, ''), 1000),
           error_history = COALESCE(q.error_history, '[]'::jsonb) || jsonb_build_array(v_history_entry),
           owner_token = NULL,
           worker_id = NULL,
           lease_expires_at = NULL,
           updated_at = v_now
     WHERE q.id = p_request_id;

    RETURN jsonb_build_object(
      'updated', true,
      'status', 'PENDING',
      'credential_scope', v_row.credential_scope,
      'attempt_count', v_row.attempt_count,
      'max_attempts', v_row.max_attempts,
      'next_available_at', v_next_available,
      'backoff_seconds', v_backoff_secs
    );
  END IF;

  UPDATE integraciones.bsale_sync_queue q
     SET status = 'FAILED',
         completed_at = v_now,
         duration_ms = COALESCE(q.duration_ms, 0) + GREATEST(0, COALESCE(p_duration_ms, 0)),
         sync_run_id = COALESCE(p_sync_run_id, q.sync_run_id),
         last_http_status = p_http_status,
         retry_after_seconds = CASE WHEN p_http_status = 429 OR p_retry_after_seconds IS NOT NULL THEN v_backoff_secs ELSE NULL END,
         last_error_code = COALESCE(p_error_code, 'EXECUTION_FAILED'),
         last_error_message = LEFT(COALESCE(p_error_message, 'Error en sincronización Bsale'), 1000),
         error_history = COALESCE(q.error_history, '[]'::jsonb) || jsonb_build_array(v_history_entry),
         result_summary = COALESCE(p_result_summary, q.result_summary),
         owner_token = NULL,
         worker_id = NULL,
         lease_expires_at = NULL,
         updated_at = v_now
   WHERE q.id = p_request_id;

  RETURN jsonb_build_object(
    'updated', true,
    'status', 'FAILED',
    'credential_scope', v_row.credential_scope,
    'attempt_count', v_row.attempt_count,
    'max_attempts', v_row.max_attempts,
    'next_available_at', CASE WHEN p_http_status = 429 THEN v_next_available ELSE NULL END
  );
END;
$$;

-- 6. Cancelación explícita de solicitudes pendientes (Orden Nivel 1 -> Nivel 2 -> Nivel 4).
CREATE OR REPLACE FUNCTION integraciones.cancel_bsale_sync_request_v1(
  p_request_id uuid,
  p_company_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = integraciones, core, public
AS $$
DECLARE
  v_scope text;
  v_dedupe_key text;
  v_now timestamptz;
BEGIN
  IF p_request_id IS NULL OR p_company_id IS NULL THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'INVALID_PARAMS');
  END IF;

  SELECT q.credential_scope, q.dedupe_key
    INTO v_scope, v_dedupe_key
    FROM integraciones.bsale_sync_queue q
   WHERE q.id = p_request_id
     AND q.company_id = p_company_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'NOT_PENDING_OR_NOT_FOUND');
  END IF;

  -- Nivel 1 -> Nivel 2
  PERFORM pg_advisory_xact_lock(hashtextextended('bsale_sync_coord:' || v_scope, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('bsale_sync_queue_dedupe:' || v_dedupe_key, 0));

  v_now := clock_timestamp();

  -- Nivel 4
  UPDATE integraciones.bsale_sync_queue q
     SET status = 'CANCELLED',
         cancelled_at = v_now,
         last_error_code = 'CANCELLED',
         last_error_message = LEFT(COALESCE(NULLIF(btrim(p_reason), ''), 'Solicitud cancelada.'), 500),
         updated_at = v_now
   WHERE q.id = p_request_id
     AND q.company_id = p_company_id
     AND q.status = 'PENDING';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'NOT_PENDING_OR_NOT_FOUND');
  END IF;

  RETURN jsonb_build_object(
    'cancelled', true,
    'request_id', p_request_id,
    'cancelled_at', v_now
  );
END;
$$;

REVOKE ALL ON FUNCTION integraciones.renew_bsale_sync_lock_v1(uuid, text, text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION integraciones.renew_bsale_sync_lock_v1(uuid, text, text, integer, text) TO service_role;

REVOKE ALL ON FUNCTION integraciones.enqueue_bsale_sync_request_v1(uuid, text, text, text, text[], text, text, integer, integer, integer, text, uuid, jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION integraciones.enqueue_bsale_sync_request_v1(uuid, text, text, text, text[], text, text, integer, integer, integer, text, uuid, jsonb, integer) TO service_role;

REVOKE ALL ON FUNCTION integraciones.recover_bsale_sync_queue_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION integraciones.recover_bsale_sync_queue_v1() TO service_role;

REVOKE ALL ON FUNCTION integraciones.claim_next_bsale_sync_request_v1(text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION integraciones.claim_next_bsale_sync_request_v1(text, text, integer, integer) TO service_role;

REVOKE ALL ON FUNCTION integraciones.complete_bsale_sync_request_v1(uuid, uuid, text, text, text, bigint, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION integraciones.complete_bsale_sync_request_v1(uuid, uuid, text, text, text, bigint, uuid, jsonb) TO service_role;

REVOKE ALL ON FUNCTION integraciones.fail_or_retry_bsale_sync_request_v1(uuid, uuid, text, text, text, text, text, boolean, integer, integer, bigint, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION integraciones.fail_or_retry_bsale_sync_request_v1(uuid, uuid, text, text, text, text, text, boolean, integer, integer, bigint, uuid, jsonb) TO service_role;

REVOKE ALL ON FUNCTION integraciones.cancel_bsale_sync_request_v1(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION integraciones.cancel_bsale_sync_request_v1(uuid, uuid, text) TO service_role;

GRANT SELECT ON integraciones.bsale_sync_queue TO service_role;

COMMIT;
