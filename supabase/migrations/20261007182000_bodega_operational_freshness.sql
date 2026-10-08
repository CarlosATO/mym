-- Bodega V2: persist operational freshness metrics and keep unresolved Bsale
-- states visible until their semantics are explicitly confirmed.

ALTER TABLE integraciones.bsale_sync_runs
  ADD COLUMN IF NOT EXISTS metrics jsonb;

ALTER TABLE integraciones.bsale_sync_runs
  DROP CONSTRAINT IF EXISTS bsale_sync_runs_trigger_check;

ALTER TABLE integraciones.bsale_sync_runs
  ADD CONSTRAINT bsale_sync_runs_trigger_check
  CHECK (trigger IN (
    'INITIAL', 'CRON', 'NIGHTLY', 'MANUAL', 'SCHEDULED',
    'ROUTE_GUIDE_DIRECTED', 'WAREHOUSE_PREP',
    'WAREHOUSE_OPERATIONAL', 'WAREHOUSE_FULL'
  ));

CREATE OR REPLACE VIEW integraciones.vw_bsale_sales_orders_for_preparation AS
SELECT
    nv.company_id,
    nv.bsale_id AS nv_bsale_id,
    nv.number AS nv_folio,
    nv.emission_date AS nv_emission_date,
    nv.generation_date AS nv_generation_date,
    nv.client_id,
    c.company AS client_name,
    c.code AS client_rut,
    nv.raw_json->>'city' AS city_raw,
    nv.raw_json->>'municipality' AS municipality_raw,
    nv.raw_json->>'address' AS address_raw,
    CAST(nv.raw_json->'user'->>'id' AS int) AS seller_bsale_id,
    s.name AS seller_name,
    nv.total_amount,
    (SELECT COUNT(d.id) FROM integraciones.bsale_document_details d WHERE d.company_id = nv.company_id AND d.bsale_document_id = nv.bsale_id) AS products_count,
    (SELECT SUM(d.quantity) FROM integraciones.bsale_document_details d WHERE d.company_id = nv.company_id AND d.bsale_document_id = nv.bsale_id) AS total_quantity,
    invoice_link.invoice_bsale_id,
    invoice.number::text AS invoice_folio,
    invoice.emission_date AS invoice_emission_date,
    (invoice_link.invoice_bsale_id IS NOT NULL) AS is_invoiced,
    nv.client_id AS client_bsale_id,
    nv.raw_json->>'city' AS nv_city_raw,
    nv.raw_json->>'municipality' AS nv_municipality_raw,
    c.city AS client_city_raw,
    c.commune AS client_municipality_raw,
    CASE
      WHEN c.commune IS NOT NULL AND trim(c.commune) <> '' THEN trim(c.commune)
      WHEN nv.raw_json->>'municipality' IS NOT NULL AND trim(nv.raw_json->>'municipality') <> '' THEN trim(nv.raw_json->>'municipality')
      WHEN c.city IS NOT NULL AND trim(c.city) <> '' THEN trim(c.city)
      WHEN nv.raw_json->>'city' IS NOT NULL AND trim(nv.raw_json->>'city') <> '' THEN trim(nv.raw_json->>'city')
      ELSE 'SIN COMUNA'
    END AS route_location_raw,
    CASE
      WHEN c.commune IS NOT NULL AND trim(c.commune) <> '' THEN 'CLIENT_MUNICIPALITY'
      WHEN nv.raw_json->>'municipality' IS NOT NULL AND trim(nv.raw_json->>'municipality') <> '' THEN 'NV_MUNICIPALITY'
      WHEN c.city IS NOT NULL AND trim(c.city) <> '' THEN 'CLIENT_CITY'
      WHEN nv.raw_json->>'city' IS NOT NULL AND trim(nv.raw_json->>'city') <> '' THEN 'NV_CITY'
      ELSE 'UNKNOWN'
    END AS route_location_source,
    nv.net_amount,
    nv.tax_amount,
    nv.total_amount AS gross_amount
FROM integraciones.bsale_documents nv
LEFT JOIN integraciones.bsale_clients c
  ON nv.company_id = c.company_id AND nv.client_id = c.bsale_client_id
LEFT JOIN integraciones.bsale_sellers s
  ON nv.company_id = s.company_id
 AND CAST(nv.raw_json->'user'->>'id' AS int) = s.bsale_id
LEFT JOIN LATERAL (
  SELECT link.invoice_bsale_id
  FROM integraciones.bsale_invoice_sales_order_links link
  JOIN integraciones.bsale_documents historical_invoice
    ON historical_invoice.company_id = link.company_id
   AND historical_invoice.bsale_id = link.invoice_bsale_id
   AND historical_invoice.document_type_id = 5
  WHERE link.company_id = nv.company_id
    AND link.sales_order_bsale_id = nv.bsale_id
  ORDER BY historical_invoice.generation_date DESC NULLS LAST, link.invoice_bsale_id DESC
  LIMIT 1
) invoice_link ON true
LEFT JOIN integraciones.bsale_documents invoice
  ON invoice.company_id = nv.company_id
 AND invoice.bsale_id = invoice_link.invoice_bsale_id
WHERE nv.document_type_id = 23
  AND nv.state IN (0, 8888);

ALTER VIEW integraciones.vw_bsale_sales_orders_for_preparation SET (security_invoker = true);
