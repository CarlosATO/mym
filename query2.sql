SELECT 
  nv.nv_folio,
  nv.nv_bsale_id,
  nv.client_id AS client_bsale_id,
  nv.client_name,
  nv.city_raw AS nv_city_raw,
  nv.municipality_raw AS nv_municipality_raw,
  c.city AS client_city,
  c.commune AS client_municipality,
  c.address
FROM integraciones.vw_bsale_sales_orders_for_preparation nv
LEFT JOIN integraciones.bsale_clients c 
  ON c.bsale_client_id = nv.client_id 
  AND c.company_id = nv.company_id
ORDER BY nv.nv_emission_date DESC
LIMIT 10;
