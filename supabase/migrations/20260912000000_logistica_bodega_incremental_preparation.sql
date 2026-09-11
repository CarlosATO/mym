-- Materialización incremental de Bodega, independiente de rutas y calendarios.
CREATE OR REPLACE VIEW logistica.vw_sales_order_preparation_board AS
SELECT
  c.id AS card_id, c.company_id, c.status, c.priority, c.assigned_user_id,
  c.route_date, c.normalized_city,
  nv.bsale_id AS nv_bsale_id, nv.number AS nv_folio,
  nv.emission_date AS nv_emission_date, nv.generation_date AS nv_generation_date,
  client.company AS client_name,
  nv.raw_json->>'city' AS city_raw,
  nv.raw_json->>'municipality' AS municipality_raw,
  nv.raw_json->>'address' AS address_raw,
  (nv.raw_json->'user'->>'id')::integer AS seller_bsale_id,
  seller.name AS seller_name,
  (SELECT sum(d.quantity) FROM integraciones.bsale_document_details d
   WHERE d.company_id = c.company_id AND d.bsale_document_id = nv.bsale_id) AS total_quantity,
  nv.total_amount,
  invoice_ref.source_document_number AS invoice_folio,
  (invoice_ref.bsale_document_id IS NOT NULL) AS is_invoiced,
  c.created_at, c.updated_at,
  nv.net_amount, nv.tax_amount, nv.total_amount AS gross_amount
FROM logistica.sales_order_preparation_cards c
JOIN integraciones.bsale_documents nv
  ON c.company_id = nv.company_id AND c.bsale_nv_id = nv.bsale_id
LEFT JOIN integraciones.bsale_clients client
  ON nv.company_id = client.company_id AND nv.client_id = client.bsale_client_id
LEFT JOIN integraciones.bsale_sellers seller
  ON nv.company_id = seller.company_id
 AND (nv.raw_json->'user'->>'id')::integer = seller.bsale_id
LEFT JOIN integraciones.bsale_document_references invoice_ref
  ON invoice_ref.company_id = nv.company_id
 AND invoice_ref.referenced_document_id = nv.bsale_id
 AND invoice_ref.source_document_type_id = 5;

CREATE OR REPLACE FUNCTION logistica.materialize_bodega_preparation_cards(
  p_company_id uuid
)
RETURNS jsonb AS $$
DECLARE
  v_discovered integer := 0;
  v_skipped_invoiced integer := 0;
  v_created integer := 0;
BEGIN
  SELECT count(*)
    INTO v_discovered
  FROM integraciones.bsale_documents nv
  WHERE nv.company_id = p_company_id
    AND nv.document_type_id = 23
    AND nv.state = 0
    AND NOT EXISTS (
      SELECT 1
      FROM logistica.sales_order_preparation_cards c
      WHERE c.company_id = p_company_id
        AND c.bsale_nv_id = nv.bsale_id
    );

  SELECT count(*)
    INTO v_skipped_invoiced
  FROM integraciones.bsale_documents nv
  WHERE nv.company_id = p_company_id
    AND nv.document_type_id = 23
    AND nv.state = 0
    AND EXISTS (
      SELECT 1
      FROM integraciones.bsale_document_references invoice_ref
      WHERE invoice_ref.company_id = p_company_id
        AND invoice_ref.referenced_document_id = nv.bsale_id
        AND invoice_ref.source_document_type_id = 5
    )
    AND NOT EXISTS (
      SELECT 1
      FROM logistica.sales_order_preparation_cards c
      WHERE c.company_id = p_company_id
        AND c.bsale_nv_id = nv.bsale_id
    );

  WITH inserted AS (
    INSERT INTO logistica.sales_order_preparation_cards (
      company_id,
      bsale_nv_id,
      bsale_nv_folio,
      raw_city,
      raw_municipality,
      normalized_city,
      status
    )
    SELECT
      nv.company_id,
       nv.bsale_id,
       nv.number::text,
       nv.raw_json->>'city',
       nv.raw_json->>'municipality',
       logistica.normalize_city(nv.company_id, nv.raw_json->>'city'),
      'PENDING_ROUTE_PREP'
    FROM integraciones.bsale_documents nv
    WHERE nv.company_id = p_company_id
      AND nv.document_type_id = 23
      AND nv.state = 0
      AND NOT EXISTS (
        SELECT 1
        FROM integraciones.bsale_document_references invoice_ref
        WHERE invoice_ref.company_id = p_company_id
          AND invoice_ref.referenced_document_id = nv.bsale_id
          AND invoice_ref.source_document_type_id = 5
      )
      AND NOT EXISTS (
        SELECT 1
        FROM logistica.sales_order_preparation_cards c
        WHERE c.company_id = p_company_id
          AND c.bsale_nv_id = nv.bsale_id
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
