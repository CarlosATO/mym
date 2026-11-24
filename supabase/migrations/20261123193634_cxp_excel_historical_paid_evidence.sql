-- Cuentas por Pagar | Evidencia histórica de facturas pagadas importadas desde Excel (solo lectura).
-- Migración ya aplicada en producción bajo versión 20261123193634_cxp_excel_historical_paid_evidence.

CREATE TABLE cuentas_por_pagar.historical_paid_excel_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL CHECK (company_id='d1000000-0000-0000-0000-000000000001'::uuid),
  source_filename text NOT NULL,
  source_sheet text NOT NULL,
  source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
  expected_paid_count integer NOT NULL CHECK(expected_paid_count > 0),
  expected_total_clp numeric(18,2) NOT NULL CHECK(expected_total_clp > 0),
  declared_authorization text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id,source_sha256)
);
CREATE TABLE cuentas_por_pagar.historical_paid_excel_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL CHECK (company_id='d1000000-0000-0000-0000-000000000001'::uuid),
  batch_id uuid NOT NULL REFERENCES cuentas_por_pagar.historical_paid_excel_batches(id) ON DELETE RESTRICT,
  source_row integer NOT NULL CHECK(source_row>=2),
  issuer_rut_normalized text NOT NULL CHECK(issuer_rut_normalized~'^[0-9]{7,8}[0-9K]$'),
  document_folio text NOT NULL CHECK(document_folio~'^[0-9]+$'),
  document_issue_date date NOT NULL,
  reference_payment_date date NOT NULL,
  payment_date_basis text NOT NULL CHECK(payment_date_basis IN ('EXCEL_COLUMN_H','ASSUMED_DOCUMENT_DATE')),
  document_total_clp numeric(18,2) NOT NULL CHECK(document_total_clp>0),
  credit_note_amount_clp numeric(18,2) CHECK(credit_note_amount_clp>=0),
  has_excel_observation boolean NOT NULL DEFAULT false,
  declared_payment_status text NOT NULL DEFAULT 'FULLY_PAID_PRIOR' CHECK(declared_payment_status='FULLY_PAID_PRIOR'),
  declared_pending_balance_clp numeric(18,2) NOT NULL DEFAULT 0 CHECK(declared_pending_balance_clp=0),
  source_status text NOT NULL DEFAULT 'PAGADO' CHECK(source_status='PAGADO'),
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id,source_row),
  UNIQUE (company_id,issuer_rut_normalized,document_folio)
);
CREATE INDEX historical_paid_excel_records_sii_idx ON cuentas_por_pagar.historical_paid_excel_records
  (company_id,issuer_rut_normalized,document_folio);
ALTER TABLE cuentas_por_pagar.historical_paid_excel_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuentas_por_pagar.historical_paid_excel_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON cuentas_por_pagar.historical_paid_excel_batches FROM PUBLIC,anon,authenticated;
REVOKE ALL ON cuentas_por_pagar.historical_paid_excel_records FROM PUBLIC,anon,authenticated;
GRANT SELECT ON cuentas_por_pagar.historical_paid_excel_batches TO service_role;
GRANT SELECT ON cuentas_por_pagar.historical_paid_excel_records TO service_role;
CREATE TRIGGER prevent_historical_paid_batch_mutation BEFORE UPDATE OR DELETE
  ON cuentas_por_pagar.historical_paid_excel_batches FOR EACH ROW
  EXECUTE FUNCTION cuentas_por_pagar.prevent_payment_mutation();
CREATE TRIGGER prevent_historical_paid_record_mutation BEFORE UPDATE OR DELETE
  ON cuentas_por_pagar.historical_paid_excel_records FOR EACH ROW
  EXECUTE FUNCTION cuentas_por_pagar.prevent_payment_mutation();
CREATE VIEW cuentas_por_pagar.vw_historical_paid_excel_sii_match WITH (security_invoker=true) AS
SELECT h.company_id,h.batch_id,h.source_row,h.issuer_rut_normalized,h.document_folio,
  h.document_issue_date,h.reference_payment_date,h.payment_date_basis,h.document_total_clp,
  h.credit_note_amount_clp,h.has_excel_observation,h.declared_payment_status,
  h.declared_pending_balance_clp,
  coalesce(s.matches,0) AS sii_matches,
  s.sii_document_id,s.sii_emission_date,s.sii_total_clp,s.sii_code,
  CASE
    WHEN coalesce(s.matches,0)=0 THEN 'NO_SII_IN_MIRROR'
    WHEN s.matches>1 THEN 'AMBIGUOUS_SII_IDENTITY'
    WHEN s.sii_total_clp=h.document_total_clp AND s.sii_emission_date=h.document_issue_date THEN 'EXACT'
    WHEN s.sii_total_clp=h.document_total_clp THEN 'AMOUNT_MATCH_DATE_DIFF'
    ELSE 'AMOUNT_MISMATCH'
  END AS sii_match_status
FROM cuentas_por_pagar.historical_paid_excel_records h
LEFT JOIN LATERAL (
 SELECT count(*)::integer matches,
        max(d.bsale_document_id) sii_document_id,
        max(d.emission_date) sii_emission_date,
        max(d.total_amount) sii_total_clp,
        max(d.code_sii) sii_code
 FROM integraciones.bsale_third_party_documents d
 WHERE d.company_id=h.company_id
   AND d.issuer_rut_normalized=h.issuer_rut_normalized
   AND d.document_number::text=h.document_folio
   AND d.code_sii IN ('33','34')
) s ON true;
REVOKE ALL ON cuentas_por_pagar.vw_historical_paid_excel_sii_match FROM PUBLIC,anon,authenticated;
GRANT SELECT ON cuentas_por_pagar.vw_historical_paid_excel_sii_match TO service_role;
