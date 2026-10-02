CREATE INDEX IF NOT EXISTS idx_bsale_receptions_company_admission
  ON integraciones.bsale_receptions (company_id, admission_date DESC, bsale_id DESC);

CREATE INDEX IF NOT EXISTS idx_bsale_reception_details_company_variant
  ON integraciones.bsale_reception_details (company_id, variant_id);
