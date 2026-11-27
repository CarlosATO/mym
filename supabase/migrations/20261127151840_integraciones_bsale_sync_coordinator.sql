-- ============================================================================
-- SYNC-01 (Hardened for SYNC-02): Coordinador central de sincronización Bsale
--
-- Jerarquía canónica global de bloqueos PostgreSQL (sin inversión de orden):
--   Nivel 1: pg_advisory_xact_lock(hashtextextended('bsale_sync_coord:' || credential_scope, 0))
--   Nivel 2: pg_advisory_xact_lock(hashtextextended('bsale_sync_queue_dedupe:' || dedupe_key, 0))
--   Nivel 3: Filas de integraciones.bsale_sync_locks
--   Nivel 4: Filas de integraciones.bsale_sync_queue / bsale_sync_scope_cooldowns
--
-- Incluye control compartido de cooldown HTTP 429 (Retry-After íntegro sin tope
-- artificial de 300s) aplicado tanto a adquisición directa como a cola,
-- expiración confirmada (expires_at + server_now) y validación de identidad
-- completa al renovar y liberar.
-- Compatible con PostgreSQL 15+. Forward-only.
-- ============================================================================

BEGIN;

ALTER TABLE integraciones.bsale_sync_locks
  ADD COLUMN IF NOT EXISTS owner_token text,
  ADD COLUMN IF NOT EXISTS operation_kind text,
  ADD COLUMN IF NOT EXISTS credential_scope text,
  ADD COLUMN IF NOT EXISTS resource_key text,
  ADD COLUMN IF NOT EXISTS renewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_count integer NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_bsale_sync_locks_credential_scope_expires
  ON integraciones.bsale_sync_locks (credential_scope, expires_at);

CREATE INDEX IF NOT EXISTS idx_bsale_sync_locks_resource_key_expires
  ON integraciones.bsale_sync_locks (credential_scope, resource_key, expires_at)
  WHERE resource_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS integraciones.bsale_sync_scope_cooldowns (
  credential_scope         text PRIMARY KEY,
  blocked_until            timestamptz NOT NULL,
  retry_after_seconds      integer NOT NULL CHECK (retry_after_seconds >= 1),
  last_http_status         integer NOT NULL DEFAULT 429,
  reason                   text,
  updated_at               timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE integraciones.bsale_sync_scope_cooldowns ENABLE ROW LEVEL SECURITY;

-- Registro atómico de cooldown HTTP 429 para ejecuciones directas o encoladas,
-- respetando íntegramente el plazo Retry-After informado por Bsale.
CREATE OR REPLACE FUNCTION integraciones.register_bsale_scope_cooldown_v1(
  p_company_id uuid,
  p_credential_scope text,
  p_retry_after_seconds integer,
  p_http_status integer DEFAULT 429,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = integraciones, core, public
AS $$
DECLARE
  v_scope text := NULLIF(btrim(p_credential_scope), '');
  v_now timestamptz;
  v_retry_secs integer;
  v_blocked_until timestamptz;
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'BSALE_SYNC_COORDINATOR_INVALID_COMPANY';
  END IF;
  IF v_scope IS NULL OR v_scope NOT LIKE 'cred:%' THEN
    RAISE EXCEPTION 'BSALE_SYNC_COORDINATOR_INVALID_CREDENTIAL_SCOPE';
  END IF;

  -- Nivel 1: bloqueo transaccional del alcance de credenciales
  PERFORM pg_advisory_xact_lock(hashtextextended('bsale_sync_coord:' || v_scope, 0));

  v_now := clock_timestamp();
  v_retry_secs := GREATEST(1, COALESCE(p_retry_after_seconds, 30));
  v_blocked_until := v_now + make_interval(secs => v_retry_secs);

  -- Nivel 4: actualización de cooldown del alcance
  INSERT INTO integraciones.bsale_sync_scope_cooldowns (
    credential_scope,
    blocked_until,
    retry_after_seconds,
    last_http_status,
    reason,
    updated_at
  ) VALUES (
    v_scope,
    v_blocked_until,
    v_retry_secs,
    COALESCE(p_http_status, 429),
    LEFT(COALESCE(p_reason, 'Bsale HTTP 429'), 500),
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
        updated_at = v_now
  RETURNING blocked_until, retry_after_seconds INTO v_blocked_until, v_retry_secs;

  RETURN jsonb_build_object(
    'registered', true,
    'credential_scope', v_scope,
    'server_now', v_now,
    'blocked_until', v_blocked_until,
    'retry_after_seconds', v_retry_secs
  );
END;
$$;

CREATE OR REPLACE FUNCTION integraciones.acquire_bsale_sync_lock_v1(
  p_company_id uuid,
  p_lock_name text,
  p_owner_token text,
  p_operation_kind text,
  p_credential_scope text,
  p_resource_key text DEFAULT NULL,
  p_run_id uuid DEFAULT NULL,
  p_ttl_seconds integer DEFAULT 600,
  p_incompatible_lock_names text[] DEFAULT ARRAY[]::text[],
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = integraciones, core, public
AS $$
DECLARE
  v_scope text;
  v_now timestamptz;
  v_ttl_seconds integer;
  v_expires_at timestamptz;
  v_blocking record;
  v_cooldown record;
  v_incompatible text[];
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'BSALE_SYNC_COORDINATOR_INVALID_COMPANY';
  END IF;
  IF NULLIF(btrim(p_lock_name), '') IS NULL THEN
    RAISE EXCEPTION 'BSALE_SYNC_COORDINATOR_INVALID_LOCK_NAME';
  END IF;
  IF NULLIF(btrim(p_owner_token), '') IS NULL THEN
    RAISE EXCEPTION 'BSALE_SYNC_COORDINATOR_INVALID_OWNER_TOKEN';
  END IF;
  v_scope := NULLIF(btrim(p_credential_scope), '');
  IF v_scope IS NULL OR v_scope NOT LIKE 'cred:%' THEN
    RAISE EXCEPTION 'BSALE_SYNC_COORDINATOR_INVALID_CREDENTIAL_SCOPE';
  END IF;

  v_ttl_seconds := GREATEST(COALESCE(p_ttl_seconds, 600), 1);
  v_incompatible := COALESCE(p_incompatible_lock_names, ARRAY[]::text[]);
  IF NOT (p_lock_name = ANY(v_incompatible)) THEN
    v_incompatible := array_append(v_incompatible, p_lock_name);
  END IF;

  -- Nivel 1: serialización atómica por credencial Bsale.
  PERFORM pg_advisory_xact_lock(hashtextextended('bsale_sync_coord:' || v_scope, 0));
  PERFORM set_config('integraciones.bsale_sync_coord_bypass', 'on', true);

  v_now := clock_timestamp();
  v_expires_at := v_now + make_interval(secs => v_ttl_seconds);

  -- Nivel 3: limpiar bloqueos expirados del mismo alcance o llave física.
  DELETE FROM integraciones.bsale_sync_locks l
   WHERE l.expires_at <= v_now
     AND (
       (l.company_id = p_company_id AND l.lock_name = p_lock_name)
       OR l.credential_scope = v_scope
     );

  -- Nivel 3: verificar incompatibilidad contra bloqueos activos (incluidos legacy en transición).
  SELECT
    l.company_id,
    l.lock_name,
    l.operation_kind,
    l.run_id,
    l.owner_token,
    l.resource_key,
    l.expires_at
  INTO v_blocking
  FROM integraciones.bsale_sync_locks l
  WHERE l.expires_at > v_now
    AND (l.credential_scope = v_scope OR l.company_id = p_company_id)
    AND COALESCE(l.owner_token, '') IS DISTINCT FROM p_owner_token
    AND (
      l.lock_name = ANY(v_incompatible)
      OR (p_resource_key IS NOT NULL AND l.resource_key = p_resource_key)
    )
  ORDER BY l.acquired_at ASC
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'acquired', false,
      'status', 'LOCK_BUSY',
      'reason', 'LOCK_INCOMPATIBLE_ACTIVE',
      'credential_scope', v_scope,
      'server_now', v_now,
      'blocking_company_id', v_blocking.company_id,
      'blocking_lock_name', v_blocking.lock_name,
      'blocking_operation_kind', v_blocking.operation_kind,
      'blocking_run_id', v_blocking.run_id,
      'blocking_resource_key', v_blocking.resource_key,
      'blocking_expires_at', v_blocking.expires_at
    );
  END IF;

  -- Nivel 4: verificar y depurar cooldown HTTP 429 por credenciales en adquisición directa.
  DELETE FROM integraciones.bsale_sync_scope_cooldowns c
   WHERE c.credential_scope = v_scope
     AND c.blocked_until <= v_now;

  SELECT c.blocked_until, c.retry_after_seconds, c.reason
    INTO v_cooldown
    FROM integraciones.bsale_sync_scope_cooldowns c
   WHERE c.credential_scope = v_scope
     AND c.blocked_until > v_now;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'acquired', false,
      'status', 'LOCK_BUSY',
      'reason', 'COOLDOWN_ACTIVE',
      'credential_scope', v_scope,
      'server_now', v_now,
      'cooldown_until', v_cooldown.blocked_until,
      'retry_after_seconds', v_cooldown.retry_after_seconds,
      'blocking_company_id', p_company_id,
      'blocking_lock_name', 'bsale_rate_limit_cooldown',
      'blocking_operation_kind', 'HTTP_429_COOLDOWN',
      'blocking_run_id', NULL,
      'blocking_resource_key', NULL,
      'blocking_expires_at', v_cooldown.blocked_until
    );
  END IF;

  -- Nivel 3: insertar/actualizar lease activo.
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
    p_company_id,
    p_lock_name,
    p_run_id,
    v_now,
    v_expires_at,
    COALESCE(p_metadata, '{}'::jsonb),
    p_owner_token,
    p_operation_kind,
    v_scope,
    NULLIF(btrim(p_resource_key), ''),
    v_now,
    1
  )
  ON CONFLICT (company_id, lock_name) DO UPDATE
    SET run_id = EXCLUDED.run_id,
        acquired_at = CASE
          WHEN bsale_sync_locks.owner_token = EXCLUDED.owner_token THEN bsale_sync_locks.acquired_at
          ELSE v_now
        END,
        expires_at = EXCLUDED.expires_at,
        metadata = EXCLUDED.metadata,
        owner_token = EXCLUDED.owner_token,
        operation_kind = EXCLUDED.operation_kind,
        credential_scope = EXCLUDED.credential_scope,
        resource_key = EXCLUDED.resource_key,
        renewed_at = v_now,
        lease_count = CASE
          WHEN bsale_sync_locks.owner_token = EXCLUDED.owner_token THEN bsale_sync_locks.lease_count + 1
          ELSE 1
        END
  WHERE bsale_sync_locks.expires_at <= v_now
     OR bsale_sync_locks.owner_token = EXCLUDED.owner_token;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'acquired', false,
      'status', 'LOCK_BUSY',
      'reason', 'LOCK_CONFLICT',
      'credential_scope', v_scope,
      'server_now', v_now,
      'blocking_lock_name', p_lock_name
    );
  END IF;

  RETURN jsonb_build_object(
    'acquired', true,
    'status', 'ACQUIRED',
    'lock_name', p_lock_name,
    'owner_token', p_owner_token,
    'credential_scope', v_scope,
    'server_now', v_now,
    'expires_at', v_expires_at
  );
END;
$$;

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

  -- Nivel 1: adquirir primero el bloqueo del alcance de credenciales.
  PERFORM pg_advisory_xact_lock(hashtextextended('bsale_sync_coord:' || v_scope, 0));
  PERFORM set_config('integraciones.bsale_sync_coord_bypass', 'on', true);

  v_ttl_seconds := GREATEST(COALESCE(p_ttl_seconds, 600), 1);
  v_now := clock_timestamp();
  v_expires_at := v_now + make_interval(secs => v_ttl_seconds);

  -- Nivel 3: actualizar fila de bloqueo validando identidad completa y vigencia.
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

  RETURN jsonb_build_object(
    'renewed', true,
    'server_now', v_now,
    'expires_at', v_expires_at,
    'lease_count', v_lease_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION integraciones.release_bsale_sync_lock_v1(
  p_company_id uuid,
  p_lock_name text,
  p_owner_token text,
  p_credential_scope text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = integraciones, core, public
AS $$
DECLARE
  v_scope text := NULLIF(btrim(p_credential_scope), '');
  v_deleted_run_id uuid;
BEGIN
  IF p_company_id IS NULL OR NULLIF(btrim(p_lock_name), '') IS NULL OR NULLIF(btrim(p_owner_token), '') IS NULL THEN
    RETURN jsonb_build_object('released', false, 'reason', 'INVALID_PARAMS');
  END IF;

  IF v_scope IS NULL THEN
    SELECT l.credential_scope
      INTO v_scope
      FROM integraciones.bsale_sync_locks l
     WHERE l.company_id = p_company_id
       AND l.lock_name = p_lock_name;
  END IF;

  IF v_scope IS NULL OR v_scope NOT LIKE 'cred:%' THEN
    RETURN jsonb_build_object('released', false, 'reason', 'NOT_OWNER_OR_ALREADY_RELEASED');
  END IF;

  -- Nivel 1: adquirir primero el bloqueo del alcance de credenciales.
  PERFORM pg_advisory_xact_lock(hashtextextended('bsale_sync_coord:' || v_scope, 0));
  PERFORM set_config('integraciones.bsale_sync_coord_bypass', 'on', true);

  -- Nivel 3: validar identidad completa (company_id + lock_name + credential_scope + owner_token).
  DELETE FROM integraciones.bsale_sync_locks l
   WHERE l.company_id = p_company_id
     AND l.lock_name = p_lock_name
     AND l.credential_scope = v_scope
     AND l.owner_token = p_owner_token
  RETURNING l.run_id INTO v_deleted_run_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('released', false, 'reason', 'NOT_OWNER_OR_ALREADY_RELEASED');
  END IF;

  RETURN jsonb_build_object(
    'released', true,
    'run_id', v_deleted_run_id
  );
END;
$$;

REVOKE ALL ON FUNCTION integraciones.register_bsale_scope_cooldown_v1(uuid, text, integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION integraciones.register_bsale_scope_cooldown_v1(uuid, text, integer, integer, text) TO service_role;

REVOKE ALL ON FUNCTION integraciones.acquire_bsale_sync_lock_v1(uuid, text, text, text, text, text, uuid, integer, text[], jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION integraciones.acquire_bsale_sync_lock_v1(uuid, text, text, text, text, text, uuid, integer, text[], jsonb) TO service_role;

REVOKE ALL ON FUNCTION integraciones.renew_bsale_sync_lock_v1(uuid, text, text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION integraciones.renew_bsale_sync_lock_v1(uuid, text, text, integer, text) TO service_role;

REVOKE ALL ON FUNCTION integraciones.release_bsale_sync_lock_v1(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION integraciones.release_bsale_sync_lock_v1(uuid, text, text, text) TO service_role;

-- Protección contra mecanismos legacy que intenten eliminar, sobrescribir o
-- ignorar bloqueos activos del coordinador durante la transición de versiones.
CREATE OR REPLACE FUNCTION integraciones.guard_bsale_sync_locks_owner_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = integraciones, core, public
AS $$
DECLARE
  v_bypass text := current_setting('integraciones.bsale_sync_coord_bypass', true);
BEGIN
  IF v_bypass = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF OLD.owner_token IS NOT NULL AND OLD.expires_at > clock_timestamp() THEN
      RAISE EXCEPTION 'BSALE_SYNC_LOCK_PROTECTED_BY_COORDINATOR' USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  -- TG_OP = 'INSERT' desde código legacy sin coordinador:
  -- rechazar si existe cualquier bloqueo activo del coordinador en la misma empresa.
  IF EXISTS (
    SELECT 1
      FROM integraciones.bsale_sync_locks l
     WHERE l.company_id = NEW.company_id
       AND l.owner_token IS NOT NULL
       AND l.expires_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'BSALE_SYNC_LOCK_PROTECTED_BY_COORDINATOR' USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_bsale_sync_locks_owner_v1 ON integraciones.bsale_sync_locks;
CREATE TRIGGER trg_guard_bsale_sync_locks_owner_v1
  BEFORE INSERT OR UPDATE OR DELETE ON integraciones.bsale_sync_locks
  FOR EACH ROW
  EXECUTE FUNCTION integraciones.guard_bsale_sync_locks_owner_v1();

GRANT SELECT ON integraciones.bsale_sync_scope_cooldowns TO service_role;

COMMIT;
