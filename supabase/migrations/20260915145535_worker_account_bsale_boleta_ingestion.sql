-- Worker account: reconcile active Bsale electronic bills from the local mirror.

CREATE OR REPLACE FUNCTION mermas.reconcile_worker_bsale_boletas(
  p_company_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, rrhh, integraciones, mermas
AS $$
DECLARE
  v_activation_date constant date := DATE '2026-09-01';
  v_document record;
  v_employee_id uuid;
  v_match_count integer;
  v_source_id text;
  v_scanned integer := 0;
  v_created integer := 0;
  v_already_exists integer := 0;
  v_unmatched integer := 0;
  v_ambiguous integer := 0;
  v_invalid integer := 0;
BEGIN
  IF p_company_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM core.companies c WHERE c.id = p_company_id AND c.is_active
  ) THEN
    RAISE EXCEPTION 'Empresa inválida para reconciliar Boletas Bsale';
  END IF;

  FOR v_document IN
    SELECT d.company_id, d.bsale_id, d.number, d.emission_date, d.total_amount,
      d.document_type_id, d.client_id, d.state,
      d.raw_json->>'cancellationDate' AS cancellation_date,
      d.raw_json->>'cancellationStatus' AS cancellation_status,
      c.bsale_client_id,
      regexp_replace(upper(btrim(coalesce(nullif(c.code_clean, ''), c.code))), '[^0-9K]', '', 'g') AS client_rut
    FROM integraciones.bsale_documents d
    LEFT JOIN integraciones.bsale_clients c
      ON c.company_id = d.company_id AND c.bsale_client_id = d.client_id
    WHERE d.company_id = p_company_id
      AND d.document_type_id = 1
      AND d.emission_date >= v_activation_date
    ORDER BY d.emission_date, d.number, d.bsale_id
  LOOP
    v_scanned := v_scanned + 1;
    v_source_id := v_document.bsale_id::text;

    -- The mirror's established active-document convention is state = 0.
    -- Missing fiscal identity or a non-integer/non-positive CLP total is invalid.
    IF v_document.state IS DISTINCT FROM 0
       OR nullif(btrim(coalesce(v_document.cancellation_date, '')), '') IS NOT NULL
       OR coalesce(nullif(btrim(v_document.cancellation_status), ''), '0') <> '0'
       OR v_document.client_id IS NULL
       OR v_document.bsale_client_id IS NULL
       OR v_document.client_rut IS NULL
       OR v_document.client_rut = ''
       OR v_document.number IS NULL
       OR v_document.emission_date IS NULL
       OR v_document.total_amount IS NULL
       OR v_document.total_amount <= 0
       OR v_document.total_amount <> trunc(v_document.total_amount) THEN
      v_invalid := v_invalid + 1;
      CONTINUE;
    END IF;

    SELECT count(*)::integer, (array_agg(e.id ORDER BY e.id))[1]
    INTO v_match_count, v_employee_id
    FROM rrhh.employees e
    WHERE e.estado = 'ACTIVO'
      AND v_document.emission_date >= coalesce(e.fecha_ingreso, v_activation_date)
      AND regexp_replace(upper(btrim(e.rut)), '[^0-9K]', '', 'g') = v_document.client_rut;

    IF v_match_count = 0 THEN
      v_unmatched := v_unmatched + 1;
      CONTINUE;
    END IF;
    IF v_match_count > 1 THEN
      v_ambiguous := v_ambiguous + 1;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM rrhh.worker_account_charges charge
      WHERE charge.company_id = p_company_id
        AND charge.source_type = 'BSALE_BOLETA'
        AND charge.source_id = v_source_id
    ) THEN
      v_already_exists := v_already_exists + 1;
      CONTINUE;
    END IF;

    INSERT INTO rrhh.worker_account_charges (
      company_id, employee_id, source_type, source_id, document_type,
      document_number, document_date, amount, status, metadata, created_by
    ) VALUES (
      p_company_id, v_employee_id, 'BSALE_BOLETA', v_source_id, 'BOLETA',
      v_document.number::text,
      v_document.emission_date::timestamp AT TIME ZONE 'America/Santiago',
      v_document.total_amount, 'ACTIVE',
      jsonb_build_object(
        'bsale_document_id', v_document.bsale_id,
        'bsale_client_id', v_document.bsale_client_id,
        'rut_normalized', v_document.client_rut,
        'document_number', v_document.number,
        'origin', 'BSALE'
      ), NULL
    )
    ON CONFLICT (company_id, source_type, source_id) DO NOTHING;

    IF FOUND THEN
      v_created := v_created + 1;
    ELSE
      v_already_exists := v_already_exists + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'scanned', v_scanned,
    'created', v_created,
    'already_exists', v_already_exists,
    'unmatched', v_unmatched,
    'ambiguous', v_ambiguous,
    'invalid', v_invalid
  );
END;
$$;

REVOKE ALL ON FUNCTION mermas.reconcile_worker_bsale_boletas(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mermas.reconcile_worker_bsale_boletas(uuid)
  TO service_role;
