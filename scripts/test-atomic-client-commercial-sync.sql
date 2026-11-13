-- ==============================================================================
-- PETGROUP — Suite SQL de Pruebas de Atomicidad e Integridad de Clientes Bsale
-- Compatible con psql y Supabase SQL Editor.
--
-- NOTA IMPORTANTE DE AISLAMIENTO:
-- Este script asume que la migración previa fue instalada en la base de datos de prueba
-- (o corre en un entorno desechable).
-- Todo el bloque de fixtures y pruebas corre dentro de una transacción que finaliza
-- con ROLLBACK estricto, garantizando que NINGÚN dato de prueba persista.
-- ==============================================================================

BEGIN;

DO $$
DECLARE
  v_company_id uuid := gen_random_uuid();
  v_client_id bigint := 9999901;
  v_sync_run_1 uuid := gen_random_uuid();
  v_sync_run_2 uuid := gen_random_uuid();
  v_sync_run_wrong_entity uuid := gen_random_uuid();
  v_sync_run_wrong_provider uuid := gen_random_uuid();
  v_t0 timestamptz := '2026-11-13 12:00:00+00';
  v_t1 timestamptz := '2026-11-13 12:00:20+00';
  v_t2 timestamptz := '2026-11-13 12:00:40+00';
  v_t3 timestamptz := '2026-11-13 12:01:00+00';
  v_t4 timestamptz := '2026-11-13 12:01:20+00';
  v_res_json jsonb;
  v_row record;
  v_cnt integer;
  v_error_caught boolean;
BEGIN
  RAISE NOTICE '=== INICIO SUITE SQL DE PRUEBAS DE ATOMICIDAD BSALE CLIENTS ===';

  -- 1. Fixture de Empresa: esquema real core.companies (business_name, rut)
  INSERT INTO core.companies (id, business_name, rut)
  VALUES (v_company_id, 'Empresa Test Concurrencia', '76999999-1')
  ON CONFLICT (id) DO NOTHING;

  -- 2. Fixtures de Corridas: esquema real integraciones.sync_runs (trigger_type = 'SCHEDULED')
  -- Corrida 1 válida: BSALE / clients / SCHEDULED / RUNNING iniciada en v_t0
  INSERT INTO integraciones.sync_runs (id, company_id, provider, entity, trigger_type, status, started_at)
  VALUES (v_sync_run_1, v_company_id, 'BSALE', 'clients', 'SCHEDULED', 'RUNNING', v_t0);

  -- Corrida con entidad no correspondiente ('documents')
  INSERT INTO integraciones.sync_runs (id, company_id, provider, entity, trigger_type, status, started_at)
  VALUES (v_sync_run_wrong_entity, v_company_id, 'BSALE', 'documents', 'SCHEDULED', 'RUNNING', v_t0);

  -- Corrida con proveedor no correspondiente ('MERCADOLIBRE')
  INSERT INTO integraciones.sync_runs (id, company_id, provider, entity, trigger_type, status, started_at)
  VALUES (v_sync_run_wrong_provider, v_company_id, 'MERCADOLIBRE', 'clients', 'SCHEDULED', 'RUNNING', v_t0);

  -- --------------------------------------------------------------------------
  -- VALIDACIÓN 1: Validación estricta de p_sync_run_id (sin sustitutos silenciosos)
  -- --------------------------------------------------------------------------
  RAISE NOTICE 'Prueba 1: Rechazo de p_sync_run_id con entidad o proveedor incorrecto...';
  
  -- Entidad incorrecta
  v_error_caught := false;
  BEGIN
    PERFORM integraciones.upsert_bsale_clients_sync(
      v_company_id,
      jsonb_build_array(jsonb_build_object('bsale_client_id', v_client_id)),
      v_sync_run_wrong_entity
    );
  EXCEPTION WHEN OTHERS THEN
    v_error_caught := true;
  END;
  ASSERT v_error_caught, 'FALLO 1A: Debió rechazar corrida con entity <> clients';

  -- Proveedor incorrecto
  v_error_caught := false;
  BEGIN
    PERFORM integraciones.upsert_bsale_clients_sync(
      v_company_id,
      jsonb_build_array(jsonb_build_object('bsale_client_id', v_client_id)),
      v_sync_run_wrong_provider
    );
  EXCEPTION WHEN OTHERS THEN
    v_error_caught := true;
  END;
  ASSERT v_error_caught, 'FALLO 1B: Debió rechazar corrida con provider <> BSALE';

  -- --------------------------------------------------------------------------
  -- VALIDACIÓN 2: Rechazo de p_clients con estructura inválida (no-array)
  -- --------------------------------------------------------------------------
  RAISE NOTICE 'Prueba 2: Rechazo de p_clients con estructura no-array...';
  v_error_caught := false;
  BEGIN
    PERFORM integraciones.upsert_bsale_clients_sync(
      v_company_id,
      '{"invalid": "object"}'::jsonb,
      v_sync_run_1
    );
  EXCEPTION WHEN OTHERS THEN
    v_error_caught := true;
  END;
  ASSERT v_error_caught, 'FALLO 2: Debió rechazar p_clients que no sea un jsonb array';

  -- --------------------------------------------------------------------------
  -- VALIDACIÓN 3: Rechazo de registros sin bsale_client_id (no ignorar silenciosamente)
  -- --------------------------------------------------------------------------
  RAISE NOTICE 'Prueba 3: Rechazo de cliente sin bsale_client_id en el lote...';
  v_error_caught := false;
  BEGIN
    PERFORM integraciones.upsert_bsale_clients_sync(
      v_company_id,
      jsonb_build_array(
        jsonb_build_object('business_name', 'Cliente Sin ID', 'code', '11111111-1')
      ),
      v_sync_run_1
    );
  EXCEPTION WHEN OTHERS THEN
    v_error_caught := true;
  END;
  ASSERT v_error_caught, 'FALLO 3: Debió lanzar excepción si un registro del array carece de bsale_client_id';

  -- --------------------------------------------------------------------------
  -- VALIDACIÓN 4: p_observed_at es obligatorio en verificación puntual
  -- --------------------------------------------------------------------------
  RAISE NOTICE 'Prueba 4: p_observed_at obligatorio (sin sustituto silencioso)...';
  v_error_caught := false;
  BEGIN
    PERFORM integraciones.update_bsale_client_commercial_status(
      v_company_id,
      v_client_id,
      false,
      NULL, -- p_observed_at es NULL
      '{"id": 9999901}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    v_error_caught := true;
  END;
  ASSERT v_error_caught, 'FALLO 4: Debió exigir p_observed_at obligatorio';

  -- --------------------------------------------------------------------------
  -- CASO 1: ORDEN 1 - Cron snapshot t0 (bloqueado) -> Verificación puntual en t1 (desbloquea) -> Cron escribe en t2
  -- --------------------------------------------------------------------------
  RAISE NOTICE 'Prueba 5: Caso 1 (Cron t0 -> Verificación t1 -> Cron escribe t2)...';

  -- Estado previo del cliente en BD
  INSERT INTO integraciones.bsale_clients (
    company_id, bsale_client_id, code, business_name, address, phone,
    raw_payload, payload_hash, last_seen_at, last_sync_at, updated_at
  )
  VALUES (
    v_company_id, v_client_id, '76111222-3', 'Cliente Test 999', 'Calle Vieja 123', '+56911111111',
    '{"id": 9999901, "commerciallyBlocked": 1}'::jsonb,
    'hash_original_node',
    v_t0 - interval '1 hour', v_t0 - interval '1 hour', v_t0 - interval '1 hour'
  );

  -- En t1: Verificación puntual en Bsale -> DESBLOQUEADO (false) con observación t1
  v_res_json := integraciones.update_bsale_client_commercial_status(
    v_company_id,
    v_client_id,
    false, -- UNBLOCKED
    v_t1,  -- p_observed_at = t1
    '{"id": 9999901, "code": "76111222-3", "company": "Cliente Test 999", "commerciallyBlocked": false}'::jsonb
  );
  ASSERT (v_res_json->>'applied')::boolean = true, 'FALLO 5A: Verificación puntual debió ser aplicada';

  -- En t2: Cron termina descarga y escribe snapshot tomado en t0 (commerciallyBlocked = 1, nueva dirección y teléfono)
  v_cnt := integraciones.upsert_bsale_clients_sync(
    v_company_id,
    jsonb_build_array(
      jsonb_build_object(
        'bsale_client_id', v_client_id,
        'code', '76111222-3',
        'business_name', 'Cliente Test 999',
        'address', 'Avenida Nueva 456',
        'phone', '+56922222222',
        'raw_payload', '{"id": 9999901, "commerciallyBlocked": 1, "address": "Avenida Nueva 456"}'::jsonb,
        'payload_hash', 'hash_calculado_en_node_123'
      )
    ),
    v_sync_run_1
  );

  SELECT (raw_payload->>'commerciallyBlocked')::boolean AS is_blocked,
         (raw_payload->>'commercial_observed_at')::timestamptz AS observed_at,
         address, phone, payload_hash
  INTO v_row
  FROM integraciones.bsale_clients
  WHERE company_id = v_company_id AND bsale_client_id = v_client_id;

  ASSERT v_row.is_blocked = false,
    format('FALLO 5B: El cron sobrescribió el desbloqueo verificado. is_blocked=%s', v_row.is_blocked);

  -- Comparación estricta de timestamptz, no de texto
  ASSERT v_row.observed_at = v_t1,
    format('FALLO 5C: Timestamp de observación incorrecto. observed_at=%s vs esperado=%s', v_row.observed_at, v_t1);

  ASSERT v_row.address = 'Avenida Nueva 456',
    format('FALLO 5D: El cron no actualizó la dirección nueva. address=%s', v_row.address);

  ASSERT v_row.phone = '+56922222222',
    format('FALLO 5E: El cron no actualizó el teléfono nuevo. phone=%s', v_row.phone);

  ASSERT v_row.payload_hash = 'hash_calculado_en_node_123',
    format('FALLO 5F: payload_hash debió conservar el hash provisto por Node. hash=%s', v_row.payload_hash);

  RAISE NOTICE 'PASÓ Prueba 5: Desbloqueo preservado, datos de contacto actualizados y hash de Node intacto.';

  -- --------------------------------------------------------------------------
  -- CASO 2: ORDEN 2 - Verificación puntual en t1 -> Nueva corrida Cron en t3 (> t1)
  -- --------------------------------------------------------------------------
  RAISE NOTICE 'Prueba 6: Caso 2 (Cron t3 posterior a verificación t1 actualiza estado)...';

  INSERT INTO integraciones.sync_runs (id, company_id, provider, entity, trigger_type, status, started_at)
  VALUES (v_sync_run_2, v_company_id, 'BSALE', 'clients', 'SCHEDULED', 'RUNNING', v_t3);

  -- En t4: Cron escribe datos de corrida t3 donde Bsale reporta cliente bloqueado
  PERFORM integraciones.upsert_bsale_clients_sync(
    v_company_id,
    jsonb_build_array(
      jsonb_build_object(
        'bsale_client_id', v_client_id,
        'code', '76111222-3',
        'raw_payload', '{"id": 9999901, "commerciallyBlocked": 1}'::jsonb,
        'payload_hash', 'hash_cron_run_2'
      )
    ),
    v_sync_run_2
  );

  SELECT (raw_payload->>'commerciallyBlocked')::boolean AS is_blocked,
         (raw_payload->>'commercial_observed_at')::timestamptz AS observed_at
  INTO v_row
  FROM integraciones.bsale_clients
  WHERE company_id = v_company_id AND bsale_client_id = v_client_id;

  ASSERT v_row.is_blocked = true, 'FALLO 6A: Corrida posterior del cron debió actualizar a bloqueado';
  ASSERT v_row.observed_at = v_t3, 'FALLO 6B: Marca de observación debió actualizarse a la fecha de la corrida 2';

  RAISE NOTICE 'PASÓ Prueba 6: Cron posterior actualizó legítimamente el estado.';

  -- --------------------------------------------------------------------------
  -- CASO 3: Respuesta individual tardía rezagada no degrada cron más reciente
  -- --------------------------------------------------------------------------
  RAISE NOTICE 'Prueba 7: Respuesta individual rezagada (observada en t2 < t3) vs cron en t3...';

  -- En t3 el cron estableció que el cliente está bloqueado.
  -- Llega una respuesta individual atrasada cuya observación en Bsale fue en t2 (< t3)
  -- intentando indicar que estaba desbloqueado:
  v_res_json := integraciones.update_bsale_client_commercial_status(
    v_company_id,
    v_client_id,
    false, -- intenta decir que estaba desbloqueado
    v_t2,  -- observado en t2 (< t3)
    '{"id": 9999901}'::jsonb
  );

  ASSERT (v_res_json->>'applied')::boolean = false,
    'FALLO 7A: Verificación rezagada debió ser descartada (applied=false)';

  SELECT (raw_payload->>'commerciallyBlocked')::boolean AS is_blocked
  INTO v_row
  FROM integraciones.bsale_clients
  WHERE company_id = v_company_id AND bsale_client_id = v_client_id;

  ASSERT v_row.is_blocked = true,
    'FALLO 7B: El estado más reciente del cron debió prevalecer sobre la respuesta tardía';

  RAISE NOTICE 'PASÓ Prueba 7: Respuesta individual rezagada descartada correctamente.';

  -- --------------------------------------------------------------------------
  -- CASO 4: Inserción de cliente nuevo por verificación puntual (last_sync_at = NULL)
  -- --------------------------------------------------------------------------
  RAISE NOTICE 'Prueba 8: Inserción de cliente nuevo y semántica de last_sync_at...';

  v_res_json := integraciones.update_bsale_client_commercial_status(
    v_company_id,
    9999902,
    false,
    v_t1,
    '{"id": 9999902, "code": "76333444-5", "company": "Nuevo Cliente SPA"}'::jsonb
  );

  SELECT bsale_client_id, last_sync_at, last_seen_at
  INTO v_row
  FROM integraciones.bsale_clients
  WHERE company_id = v_company_id AND bsale_client_id = 9999902;

  ASSERT v_row.bsale_client_id = 9999902, 'FALLO 8A: Cliente nuevo no fue insertado';
  ASSERT v_row.last_sync_at IS NULL,
    'FALLO 8B: last_sync_at debe ser NULL para clientes creados exclusivamente por verificación puntual';
  ASSERT v_row.last_seen_at = v_t1,
    'FALLO 8C: last_seen_at debe corresponder a la fecha de observación';

  RAISE NOTICE 'PASÓ Prueba 8: last_sync_at es NULL para clientes no sincronizados masivamente.';

  -- --------------------------------------------------------------------------
  -- CASO 5: Rechazo estricto de p_commercially_blocked = NULL
  -- --------------------------------------------------------------------------
  RAISE NOTICE 'Prueba 9: Rechazo estricto de p_commercially_blocked = NULL...';

  -- 9A. Intento de actualizar un cliente previamente bloqueado (v_client_id) con NULL: debe lanzar excepción
  v_error_caught := false;
  BEGIN
    PERFORM integraciones.update_bsale_client_commercial_status(
      v_company_id,
      v_client_id,
      NULL, -- p_commercially_blocked = NULL
      v_t4,
      '{"id": 9999901}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    v_error_caught := true;
  END;
  ASSERT v_error_caught, 'FALLO 9A: update_bsale_client_commercial_status debió rechazar p_commercially_blocked = NULL';

  -- 9B. Verificar que el cliente previamente bloqueado (v_client_id) permanezca intacto
  SELECT (raw_payload->>'commerciallyBlocked')::boolean AS is_blocked,
         (raw_payload->>'commercial_observed_at')::timestamptz AS observed_at
  INTO v_row
  FROM integraciones.bsale_clients
  WHERE company_id = v_company_id AND bsale_client_id = v_client_id;

  ASSERT v_row.is_blocked = true,
    'FALLO 9B: El cliente previamente bloqueado no debió alterar su estado ante parámetro NULL inválido';
  ASSERT v_row.observed_at = v_t3,
    'FALLO 9B: Las marcas temporales del cliente no debieron modificarse';

  -- 9C. Intento de insertar un cliente nuevo con NULL: debe lanzar excepción y NO insertarse
  v_error_caught := false;
  BEGIN
    PERFORM integraciones.update_bsale_client_commercial_status(
      v_company_id,
      9999904, -- cliente inexistente
      NULL,    -- p_commercially_blocked = NULL
      v_t4,
      '{"id": 9999904}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    v_error_caught := true;
  END;
  ASSERT v_error_caught, 'FALLO 9C: Inserción con p_commercially_blocked = NULL debió ser rechazada';

  -- Verificar que el cliente nuevo 9999904 NO exista en la base de datos
  ASSERT NOT EXISTS (
    SELECT 1 FROM integraciones.bsale_clients
    WHERE company_id = v_company_id AND bsale_client_id = 9999904
  ), 'FALLO 9D: Cliente nuevo con estado NULL no debió ser insertado';

  RAISE NOTICE 'PASÓ Prueba 9: NULL rechazado, cliente bloqueado intacto y cliente nuevo no insertado.';

  RAISE NOTICE '=== TODAS LAS PRUEBAS DE LA SUITE SQL PASARON EXITOSAMENTE ===';
END;
$$;

-- Deshacer absolutamente todas las inserciones y mutaciones de prueba
ROLLBACK;
