-- Conteos generales
SELECT
  (SELECT count(*) FROM logistica.sales_order_preparation_cards WHERE company_id = 'd1000000-0000-0000-0000-000000000001') AS total_cards,
  (SELECT count(*) FROM logistica.sales_order_preparation_movements WHERE company_id = 'd1000000-0000-0000-0000-000000000001') AS movements,
  (SELECT count(*) FROM logistica.sales_order_route_exceptions WHERE company_id = 'd1000000-0000-0000-0000-000000000001') AS exceptions,
  (SELECT count(*) FROM logistica.sales_order_preparation_route_events WHERE company_id = 'd1000000-0000-0000-0000-000000000001') AS route_events;

-- Por route_date y status
SELECT route_date, status, count(*)
FROM logistica.sales_order_preparation_cards
WHERE company_id = 'd1000000-0000-0000-0000-000000000001'
GROUP BY route_date, status
ORDER BY route_date, status;

-- Eventos por tipo
SELECT event_type, count(*)
FROM logistica.sales_order_preparation_route_events
WHERE company_id = 'd1000000-0000-0000-0000-000000000001'
GROUP BY event_type
ORDER BY event_type;

-- Tarjetas reprogramadas (original_route_date NOT NULL)
SELECT
  bsale_nv_folio,
  bsale_nv_id,
  route_date,
  original_route_date,
  status
FROM logistica.sales_order_preparation_cards
WHERE company_id = 'd1000000-0000-0000-0000-000000000001'
  AND original_route_date IS NOT NULL
ORDER BY bsale_nv_folio;
