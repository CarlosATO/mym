-- Migración: Sincronización y verificación atómica de clientes Bsale
-- Objetivo: Garantizar escrituras atómicas (sin TOCTOU ni Read-Modify-Write), monotonicidad estricta,
--           validación rigurosa de corridas y resolución temporal comparable mediante PostgreSQL.

BEGIN;

-- 1. Modificar columna last_sync_at para permitir NULL en clientes creados exclusivamente por verificación puntual
ALTER TABLE integraciones.bsale_clients ALTER COLUMN last_sync_at DROP NOT NULL;

-- 2. Función auxiliar para obtener timestamp comparable de PostgreSQL antes de consultar Bsale
--    Volatilidad VOLATILE estricta (clock_timestamp cambia en cada llamada) y SECURITY INVOKER estándar
CREATE OR REPLACE FUNCTION integraciones.get_server_timestamp()
RETURNS timestamptz
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog, integraciones, public
AS $$
  SELECT clock_timestamp();
$$;

REVOKE ALL ON FUNCTION integraciones.get_server_timestamp() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION integraciones.get_server_timestamp() TO authenticated, service_role;

-- 3. Función RPC para upsert por lotes de la sincronización completa (cron)
CREATE OR REPLACE FUNCTION integraciones.upsert_bsale_clients_sync(
  p_company_id uuid,
  p_clients jsonb,
  p_sync_run_id uuid,
  p_snapshot_started_at timestamptz DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, integraciones, public
AS $$
DECLARE
  v_snapshot_started_at timestamptz;
  v_count integer;
BEGIN
  -- Validaciones obligatorias de parámetros
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'p_company_id cannot be null' USING ERRCODE = '23502';
  END IF;

  IF p_clients IS NULL THEN
    RAISE EXCEPTION 'p_clients cannot be null' USING ERRCODE = '23502';
  END IF;

  IF jsonb_typeof(p_clients) <> 'array' THEN
    RAISE EXCEPTION 'p_clients must be a jsonb array of client records' USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_clients) = 0 THEN
    RETURN 0;
  END IF;

  -- Validación estricta: ningún elemento del arreglo puede carecer de bsale_client_id
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_clients) AS r
    WHERE NULLIF(r->>'bsale_client_id', '') IS NULL
  ) THEN
    RAISE EXCEPTION 'Invalid record in p_clients: bsale_client_id is required for every client'
      USING ERRCODE = '23502';
  END IF;

  -- Validación estricta de la corrida de sincronización (sin sustitutos silenciosos)
  IF p_sync_run_id IS NOT NULL THEN
    SELECT started_at INTO v_snapshot_started_at
    FROM integraciones.sync_runs
    WHERE id = p_sync_run_id
      AND company_id = p_company_id
      AND upper(provider) = 'BSALE'
      AND upper(entity) = 'CLIENTS';

    IF v_snapshot_started_at IS NULL THEN
      RAISE EXCEPTION 'p_sync_run_id % not found or does not match company_id, provider BSALE and entity CLIENTS in integraciones.sync_runs', p_sync_run_id
        USING ERRCODE = '23503';
    END IF;
  ELSE
    -- Solo si p_sync_run_id es NULL (ej. ejecución explícita controlada o pruebas), se exige p_snapshot_started_at explícito
    IF p_snapshot_started_at IS NULL THEN
      RAISE EXCEPTION 'p_sync_run_id or explicit p_snapshot_started_at is required' USING ERRCODE = '23502';
    END IF;
    v_snapshot_started_at := p_snapshot_started_at;
  END IF;

  -- Inserción / Actualización por lotes atómica
  WITH input_rows AS (
    SELECT
      p_company_id AS company_id,
      (r->>'bsale_client_id')::bigint AS bsale_client_id,
      r->>'code' AS code,
      r->>'code_clean' AS code_clean,
      r->>'business_name' AS business_name,
      r->>'first_name' AS first_name,
      r->>'last_name' AS last_name,
      r->>'email' AS email,
      r->>'phone' AS phone,
      r->>'mobile' AS mobile,
      r->>'address' AS address,
      r->>'city' AS city,
      r->>'commune' AS commune,
      r->>'region' AS region,
      r->>'district' AS district,
      r->>'activity' AS activity,
      r->>'company' AS company,
      r->>'client_type' AS client_type,
      NULLIF(r->>'price_list_id', '')::bigint AS price_list_id,
      r->>'price_list_name' AS price_list_name,
      NULLIF(r->>'payment_type_id', '')::bigint AS payment_type_id,
      r->>'payment_type_name' AS payment_type_name,
      NULLIF(r->>'sale_condition_id', '')::bigint AS sale_condition_id,
      r->>'sale_condition_name' AS sale_condition_name,
      NULLIF(r->>'has_credit', '')::boolean AS has_credit,
      NULLIF(r->>'credit_limit', '')::numeric AS credit_limit,
      NULLIF(r->>'credit_days', '')::integer AS credit_days,
      NULLIF(r->>'is_active_bsale', '')::boolean AS is_active_bsale,
      COALESCE((r->'raw_payload')::jsonb, '{}'::jsonb) AS raw_payload,
      r->>'payload_hash' AS payload_hash
    FROM jsonb_array_elements(p_clients) AS r
  ),
  upserted AS (
    INSERT INTO integraciones.bsale_clients AS target (
      company_id, bsale_client_id, code, code_clean, business_name, first_name, last_name,
      email, phone, mobile, address, city, commune, region, district, activity, company, client_type,
      price_list_id, price_list_name, payment_type_id, payment_type_name,
      sale_condition_id, sale_condition_name, has_credit, credit_limit, credit_days,
      is_active_bsale, raw_payload, payload_hash, last_seen_at, last_sync_at, updated_at
    )
    SELECT
      company_id, bsale_client_id, code, code_clean, business_name, first_name, last_name,
      email, phone, mobile, address, city, commune, region, district, activity, company, client_type,
      price_list_id, price_list_name, payment_type_id, payment_type_name,
      sale_condition_id, sale_condition_name, has_credit, credit_limit, credit_days,
      is_active_bsale,
      -- En inserción nueva, estampamos commercial_observed_at con la marca de inicio del snapshot del cron
      raw_payload || jsonb_build_object('commercial_observed_at', v_snapshot_started_at),
      payload_hash,
      clock_timestamp(),
      clock_timestamp(),
      clock_timestamp()
    FROM input_rows
    ON CONFLICT (company_id, bsale_client_id)
    DO UPDATE SET
      code = EXCLUDED.code,
      code_clean = EXCLUDED.code_clean,
      business_name = EXCLUDED.business_name,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      email = EXCLUDED.email,
      phone = EXCLUDED.phone,
      mobile = EXCLUDED.mobile,
      address = EXCLUDED.address,
      city = EXCLUDED.city,
      commune = EXCLUDED.commune,
      region = EXCLUDED.region,
      district = EXCLUDED.district,
      activity = EXCLUDED.activity,
      company = EXCLUDED.company,
      client_type = EXCLUDED.client_type,
      price_list_id = EXCLUDED.price_list_id,
      price_list_name = EXCLUDED.price_list_name,
      payment_type_id = EXCLUDED.payment_type_id,
      payment_type_name = EXCLUDED.payment_type_name,
      sale_condition_id = EXCLUDED.sale_condition_id,
      sale_condition_name = EXCLUDED.sale_condition_name,
      has_credit = EXCLUDED.has_credit,
      credit_limit = EXCLUDED.credit_limit,
      credit_days = EXCLUDED.credit_days,
      is_active_bsale = EXCLUDED.is_active_bsale,
      payload_hash = EXCLUDED.payload_hash, -- Conserva el hash exacto provisto por el runtime Node (computeHash)
      last_sync_at = clock_timestamp(),     -- Sincronización masiva de catálogo completada
      last_seen_at = clock_timestamp(),
      updated_at = clock_timestamp(),
      raw_payload = CASE
        -- Preservación atómica: si la fila existente fue observada con posterioridad al inicio del snapshot del cron,
        -- se conserva el estado de bloqueo verificado y su marca temporal de observación:
        WHEN (COALESCE(target.raw_payload->>'commercial_observed_at', target.raw_payload->>'commercial_verified_at'))::timestamptz > v_snapshot_started_at
        THEN (EXCLUDED.raw_payload || jsonb_build_object(
               'commerciallyBlocked', target.raw_payload->'commerciallyBlocked',
               'commercial_observed_at', COALESCE(target.raw_payload->>'commercial_observed_at', target.raw_payload->>'commercial_verified_at'),
               'commercial_verified_at', target.raw_payload->'commercial_verified_at'
             ))
        ELSE (EXCLUDED.raw_payload || jsonb_build_object(
               'commercial_observed_at', v_snapshot_started_at
             ))
      END
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM upserted;
  RETURN v_count;
END;
$$;

-- 4. Función RPC para verificación comercial individual puntual
CREATE OR REPLACE FUNCTION integraciones.update_bsale_client_commercial_status(
  p_company_id uuid,
  p_bsale_client_id bigint,
  p_commercially_blocked boolean,
  p_observed_at timestamptz,
  p_raw_client jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, integraciones, public
AS $$
DECLARE
  v_code text;
  v_code_clean text;
  v_first_name text;
  v_last_name text;
  v_business_name text;
  v_initial_payload jsonb;
  v_result jsonb;
BEGIN
  -- Validaciones obligatorias: p_observed_at debe ser capturado en PostgreSQL antes de consultar Bsale
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'p_company_id cannot be null' USING ERRCODE = '23502';
  END IF;

  IF p_bsale_client_id IS NULL THEN
    RAISE EXCEPTION 'p_bsale_client_id cannot be null' USING ERRCODE = '23502';
  END IF;

  IF p_observed_at IS NULL THEN
    RAISE EXCEPTION 'p_observed_at cannot be null: must be captured prior to querying Bsale' USING ERRCODE = '23502';
  END IF;

  IF p_commercially_blocked IS NULL THEN
    RAISE EXCEPTION 'p_commercially_blocked cannot be null: commercial status must be explicitly boolean (true or false)'
      USING ERRCODE = '23502';
  END IF;

  v_code := p_raw_client->>'code';
  v_code_clean := regexp_replace(upper(COALESCE(v_code, '')), '[^0-9K]', '', 'g');
  IF v_code_clean = '' THEN v_code_clean := NULL; END IF;

  v_first_name := p_raw_client->>'firstName';
  v_last_name := p_raw_client->>'lastName';
  v_business_name := COALESCE(
    NULLIF(trim(p_raw_client->>'company'), ''),
    NULLIF(trim(concat_ws(' ', v_first_name, v_last_name)), '')
  );

  v_initial_payload := COALESCE(p_raw_client, '{}'::jsonb) || jsonb_build_object(
    'commerciallyBlocked', p_commercially_blocked,
    'commercial_observed_at', p_observed_at,
    'commercial_verified_at', p_observed_at
  );

  INSERT INTO integraciones.bsale_clients AS target (
    company_id,
    bsale_client_id,
    code,
    code_clean,
    business_name,
    first_name,
    last_name,
    raw_payload,
    payload_hash,
    last_seen_at,
    last_sync_at, -- NULL explícito: no ha sido sincronizado por un cron masivo
    updated_at
  )
  VALUES (
    p_company_id,
    p_bsale_client_id,
    v_code,
    v_code_clean,
    v_business_name,
    v_first_name,
    v_last_name,
    v_initial_payload,
    NULL,
    p_observed_at,
    NULL,
    clock_timestamp()
  )
  ON CONFLICT (company_id, bsale_client_id)
  DO UPDATE SET
    -- Actualización atómica con monotonicidad estricta bidireccional:
    -- Si la fila existente tiene una observación posterior a p_observed_at, se ignora la respuesta tardía
    raw_payload = CASE
      WHEN (COALESCE(target.raw_payload->>'commercial_observed_at', target.raw_payload->>'commercial_verified_at'))::timestamptz > p_observed_at
      THEN target.raw_payload
      ELSE target.raw_payload || jsonb_build_object(
        'commerciallyBlocked', p_commercially_blocked,
        'commercial_observed_at', p_observed_at,
        'commercial_verified_at', p_observed_at
      )
    END,
    last_seen_at = GREATEST(target.last_seen_at, p_observed_at),
    updated_at = clock_timestamp()
    -- last_sync_at NO se toca: conserva su valor previo o NULL
  RETURNING jsonb_build_object(
    'id', target.id,
    'company_id', target.company_id,
    'bsale_client_id', target.bsale_client_id,
    'commercially_blocked', (target.raw_payload->>'commerciallyBlocked')::boolean,
    'commercial_observed_at', target.raw_payload->>'commercial_observed_at',
    'last_seen_at', target.last_seen_at,
    'last_sync_at', target.last_sync_at,
    'applied', (COALESCE(target.raw_payload->>'commercial_observed_at', target.raw_payload->>'commercial_verified_at'))::timestamptz = p_observed_at
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- 5. Revocar permisos públicos y conceder exclusivamente a service_role
REVOKE ALL ON FUNCTION integraciones.upsert_bsale_clients_sync(uuid, jsonb, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION integraciones.upsert_bsale_clients_sync(uuid, jsonb, uuid, timestamptz) TO service_role;

REVOKE ALL ON FUNCTION integraciones.update_bsale_client_commercial_status(uuid, bigint, boolean, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION integraciones.update_bsale_client_commercial_status(uuid, bigint, boolean, timestamptz, jsonb) TO service_role;

COMMIT;
