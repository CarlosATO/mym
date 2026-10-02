CREATE OR REPLACE FUNCTION integraciones.find_missing_bsale_document_variant_ids(p_company_id uuid)
RETURNS TABLE(variant_id int)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = integraciones, pg_temp
AS $$
  SELECT DISTINCT d.variant_id
  FROM integraciones.bsale_document_details AS d
  LEFT JOIN integraciones.bsale_variants AS v
    ON v.company_id = d.company_id
   AND v.bsale_id = d.variant_id
  WHERE d.company_id = p_company_id
    AND d.variant_id IS NOT NULL
    AND v.bsale_id IS NULL
  ORDER BY d.variant_id;
$$;

REVOKE ALL ON FUNCTION integraciones.find_missing_bsale_document_variant_ids(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION integraciones.find_missing_bsale_document_variant_ids(uuid) TO service_role;
