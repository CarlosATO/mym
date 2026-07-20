SELECT 
  nv_folio,
  client_name,
  city_raw,
  municipality_raw,
  client_city_raw,
  client_municipality_raw,
  route_location_raw,
  route_location_source
FROM integraciones.vw_bsale_sales_orders_for_preparation
ORDER BY nv_emission_date DESC
LIMIT 5;
