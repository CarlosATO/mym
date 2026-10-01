-- Align local confirmed-outbound application with Merma creation's Casa Matriz resolution.
-- This migration performs no Bsale calls and does not write stock.

DO $migration$
DECLARE
  v_definition text;
  v_old text := $old$
  SELECT count(*)::integer, min(bo.bsale_id)::integer INTO v_office_count, v_expected_office
  FROM integraciones.bsale_offices bo
  WHERE bo.company_id = p_company_id
    AND (upper(btrim(coalesce(bo.name, ''))) LIKE '%CASA MATRIZ%'
      OR upper(btrim(coalesce(bo.name, ''))) LIKE '%MATRIZ%');
  IF v_office_count <> 1 OR v_office_id IS DISTINCT FROM v_expected_office THEN
    RAISE EXCEPTION 'La oficina Bsale no corresponde a CASA MATRIZ';
  END IF;
$old$;
  v_new text := $new$
  SELECT count(DISTINCT bo.bsale_id)::integer, min(bo.bsale_id)::integer
  INTO v_office_count, v_expected_office
  FROM integraciones.bsale_offices bo
  WHERE bo.company_id = p_company_id
    AND (upper(btrim(coalesce(bo.name, ''))) LIKE '%CASA MATRIZ%'
      OR upper(btrim(coalesce(bo.name, ''))) LIKE '%MATRIZ%');
  IF v_office_count <> 1 THEN
    SELECT count(DISTINCT s.office_id)::integer, min(s.office_id)::integer
    INTO v_office_count, v_expected_office
    FROM integraciones.bsale_stock_current s
    WHERE s.company_id = p_company_id
      AND s.office_id IS NOT NULL
      AND (upper(btrim(coalesce(s.raw_json->'office'->>'name', ''))) LIKE '%CASA MATRIZ%'
        OR upper(btrim(coalesce(s.raw_json->'office'->>'name', ''))) LIKE '%MATRIZ%');
  END IF;
  IF v_office_count <> 1 THEN
    SELECT count(DISTINCT s.office_id)::integer, min(s.office_id)::integer
    INTO v_office_count, v_expected_office
    FROM integraciones.bsale_stock_current s
    WHERE s.company_id = p_company_id AND s.office_id IS NOT NULL;
  END IF;
  IF v_office_count <> 1 OR v_office_id IS DISTINCT FROM v_expected_office THEN
    RAISE EXCEPTION 'La oficina Bsale no corresponde a CASA MATRIZ';
  END IF;
$new$;
BEGIN
  SELECT pg_get_functiondef(
    'mermas.apply_confirmed_bsale_merma_outbound(uuid, uuid, uuid, jsonb, jsonb)'::regprocedure
  ) INTO v_definition;
  IF position(v_old IN v_definition) = 0 THEN
    RAISE EXCEPTION 'No se encontró el bloque esperado de resolución CASA MATRIZ en la RPC';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END;
$migration$;
