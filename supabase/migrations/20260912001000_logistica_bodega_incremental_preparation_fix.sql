-- Corrige las referencias de columna de la materialización sin ruta.
CREATE OR REPLACE FUNCTION logistica.materialize_bodega_preparation_cards(
  p_company_id uuid
)
RETURNS jsonb AS $$
DECLARE
  v_discovered integer := 0;
  v_skipped_invoiced integer := 0;
  v_created integer := 0;
BEGIN
  SELECT count(*) INTO v_discovered
  FROM integraciones.bsale_documents nv
  WHERE nv.company_id = p_company_id
    AND nv.document_type_id = 23
    AND nv.state = 0
    AND NOT EXISTS (
      SELECT 1 FROM logistica.sales_order_preparation_cards c
      WHERE c.company_id = p_company_id AND c.bsale_nv_id = nv.bsale_id
    );

  SELECT count(*) INTO v_skipped_invoiced
  FROM integraciones.bsale_documents nv
  WHERE nv.company_id = p_company_id
    AND nv.document_type_id = 23
    AND nv.state = 0
    AND EXISTS (
      SELECT 1 FROM integraciones.bsale_document_references invoice_ref
      WHERE invoice_ref.company_id = p_company_id
        AND invoice_ref.referenced_document_id = nv.bsale_id
        AND invoice_ref.source_document_type_id = 5
    )
    AND NOT EXISTS (
      SELECT 1 FROM logistica.sales_order_preparation_cards c
      WHERE c.company_id = p_company_id AND c.bsale_nv_id = nv.bsale_id
    );

  WITH inserted AS (
    INSERT INTO logistica.sales_order_preparation_cards (
      company_id, bsale_nv_id, bsale_nv_folio, raw_city,
      raw_municipality, normalized_city, status
    )
    SELECT
      nv.company_id, nv.bsale_id, nv.number::text,
      nv.raw_json->>'city', nv.raw_json->>'municipality',
      logistica.normalize_city(nv.company_id, nv.raw_json->>'city'),
      'PENDING_ROUTE_PREP'
    FROM integraciones.bsale_documents nv
    WHERE nv.company_id = p_company_id
      AND nv.document_type_id = 23
      AND nv.state = 0
      AND NOT EXISTS (
        SELECT 1 FROM integraciones.bsale_document_references invoice_ref
        WHERE invoice_ref.company_id = p_company_id
          AND invoice_ref.referenced_document_id = nv.bsale_id
          AND invoice_ref.source_document_type_id = 5
      )
      AND NOT EXISTS (
        SELECT 1 FROM logistica.sales_order_preparation_cards c
        WHERE c.company_id = p_company_id AND c.bsale_nv_id = nv.bsale_id
      )
    ON CONFLICT DO NOTHING
    RETURNING id
  )
  SELECT count(*) INTO v_created FROM inserted;

  RETURN jsonb_build_object(
    'discovered', v_discovered,
    'skipped_invoiced', v_skipped_invoiced,
    'created', v_created
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION logistica.materialize_bodega_preparation_cards(uuid)
  TO service_role;
