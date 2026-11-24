-- Cuentas por Pagar | Evidencia histórica de facturas pendientes importadas desde Excel (solo referencia).
-- NO valida facturas automáticamente, NO habilita pagos ante bloqueos documentales/recepción
-- y NO modifica los 1.589 registros históricos pagados ni el espejo Bsale.

CREATE TABLE cuentas_por_pagar.historical_pending_excel_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL CHECK (company_id = 'd1000000-0000-0000-0000-000000000001'::uuid),
  source_filename text NOT NULL,
  source_sheet text NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  expected_pending_count integer NOT NULL CHECK (expected_pending_count > 0),
  expected_original_total_clp numeric(18,2) NOT NULL CHECK (expected_original_total_clp > 0),
  expected_credit_note_total_clp numeric(18,2) NOT NULL CHECK (expected_credit_note_total_clp >= 0),
  expected_pending_total_clp numeric(18,2) NOT NULL CHECK (expected_pending_total_clp > 0),
  declared_authorization text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, source_sha256)
);

CREATE TABLE cuentas_por_pagar.historical_pending_excel_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL CHECK (company_id = 'd1000000-0000-0000-0000-000000000001'::uuid),
  batch_id uuid NOT NULL REFERENCES cuentas_por_pagar.historical_pending_excel_batches(id) ON DELETE RESTRICT,
  source_row integer NOT NULL CHECK (source_row >= 2),
  issuer_rut_normalized text NOT NULL CHECK (issuer_rut_normalized ~ '^[0-9]{7,8}[0-9K]$'),
  supplier_name text,
  document_folio text NOT NULL CHECK (document_folio ~ '^[0-9]+$'),
  document_issue_date date NOT NULL,
  excel_due_date date,
  original_amount_clp numeric(18,2) NOT NULL CHECK (original_amount_clp > 0),
  credit_note_amount_clp numeric(18,2) NOT NULL DEFAULT 0 CHECK (credit_note_amount_clp >= 0),
  pending_balance_clp numeric(18,2) NOT NULL CHECK (
    pending_balance_clp > 0
    AND round(original_amount_clp - credit_note_amount_clp, 2) = round(pending_balance_clp, 2)
  ),
  excel_observation text,
  declared_payment_status text NOT NULL DEFAULT 'HISTORICAL_PENDING_EXCEL'
    CHECK (declared_payment_status = 'HISTORICAL_PENDING_EXCEL'),
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, source_row),
  UNIQUE (company_id, issuer_rut_normalized, document_folio)
);

CREATE INDEX historical_pending_excel_records_sii_idx
  ON cuentas_por_pagar.historical_pending_excel_records (company_id, issuer_rut_normalized, document_folio);

ALTER TABLE cuentas_por_pagar.historical_pending_excel_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuentas_por_pagar.historical_pending_excel_records ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON cuentas_por_pagar.historical_pending_excel_batches FROM PUBLIC, anon, authenticated;
REVOKE ALL ON cuentas_por_pagar.historical_pending_excel_records FROM PUBLIC, anon, authenticated;
GRANT SELECT ON cuentas_por_pagar.historical_pending_excel_batches TO service_role;
GRANT SELECT ON cuentas_por_pagar.historical_pending_excel_records TO service_role;

CREATE TRIGGER prevent_historical_pending_batch_mutation
  BEFORE UPDATE OR DELETE ON cuentas_por_pagar.historical_pending_excel_batches
  FOR EACH ROW EXECUTE FUNCTION cuentas_por_pagar.prevent_payment_mutation();

CREATE TRIGGER prevent_historical_pending_record_mutation
  BEFORE UPDATE OR DELETE ON cuentas_por_pagar.historical_pending_excel_records
  FOR EACH ROW EXECUTE FUNCTION cuentas_por_pagar.prevent_payment_mutation();

CREATE VIEW cuentas_por_pagar.vw_historical_pending_excel_sii_match WITH (security_invoker = true) AS
SELECT
  h.company_id,
  h.batch_id,
  h.source_row,
  h.issuer_rut_normalized,
  h.supplier_name,
  h.document_folio,
  h.document_issue_date,
  h.excel_due_date,
  h.original_amount_clp,
  h.credit_note_amount_clp,
  h.pending_balance_clp,
  h.excel_observation,
  h.declared_payment_status,
  coalesce(s.matches, 0) AS sii_matches,
  s.sii_document_id,
  s.sii_emission_date,
  s.sii_total_clp,
  s.sii_code,
  CASE
    WHEN coalesce(s.matches, 0) = 0 THEN 'NO_SII_IN_MIRROR'
    WHEN s.matches > 1 THEN 'AMBIGUOUS_SII_IDENTITY'
    WHEN s.sii_total_clp = h.original_amount_clp AND s.sii_emission_date = h.document_issue_date THEN 'EXACT'
    WHEN s.sii_total_clp = h.original_amount_clp THEN 'AMOUNT_MATCH_DATE_DIFF'
    ELSE 'AMOUNT_MISMATCH'
  END AS sii_match_status
FROM cuentas_por_pagar.historical_pending_excel_records h
LEFT JOIN LATERAL (
  SELECT
    count(*)::integer AS matches,
    max(d.bsale_document_id) AS sii_document_id,
    max(d.emission_date) AS sii_emission_date,
    max(d.total_amount) AS sii_total_clp,
    max(d.code_sii) AS sii_code
  FROM integraciones.bsale_third_party_documents d
  WHERE d.company_id = h.company_id
    AND d.issuer_rut_normalized = h.issuer_rut_normalized
    AND d.document_number::text = h.document_folio
    AND d.code_sii IN ('33', '34')
) s ON true;

REVOKE ALL ON cuentas_por_pagar.vw_historical_pending_excel_sii_match FROM PUBLIC, anon, authenticated;
GRANT SELECT ON cuentas_por_pagar.vw_historical_pending_excel_sii_match TO service_role;

CREATE OR REPLACE FUNCTION public.cxp_historical_pending_excel_sii_matches()
RETURNS TABLE (
  batch_id uuid,
  source_row integer,
  issuer_rut_normalized text,
  supplier_name text,
  document_folio text,
  document_issue_date date,
  excel_due_date date,
  original_amount_clp numeric,
  credit_note_amount_clp numeric,
  pending_balance_clp numeric,
  excel_observation text,
  declared_payment_status text,
  sii_matches integer,
  sii_document_id bigint,
  sii_emission_date date,
  sii_total_clp numeric,
  sii_code text,
  sii_match_status text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_company_id constant uuid := 'd1000000-0000-0000-0000-000000000001'::uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(cuentas_por_pagar.can_access(v_company_id), false) THEN
    RAISE EXCEPTION 'Acceso a Cuentas por Pagar denegado' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    v.batch_id,
    v.source_row,
    v.issuer_rut_normalized::text,
    v.supplier_name::text,
    v.document_folio::text,
    v.document_issue_date,
    v.excel_due_date,
    v.original_amount_clp,
    v.credit_note_amount_clp,
    v.pending_balance_clp,
    v.excel_observation::text,
    v.declared_payment_status::text,
    v.sii_matches,
    v.sii_document_id,
    v.sii_emission_date,
    v.sii_total_clp,
    v.sii_code::text,
    v.sii_match_status::text
  FROM cuentas_por_pagar.vw_historical_pending_excel_sii_match v
  WHERE v.company_id = v_company_id
    AND v.sii_match_status = 'EXACT'
    AND v.sii_matches = 1
    AND v.sii_document_id IS NOT NULL
  ORDER BY v.source_row ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.cxp_historical_pending_excel_sii_matches() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cxp_historical_pending_excel_sii_matches() TO authenticated;

NOTIFY pgrst, 'reload schema';
