-- PRECHECK: dry-run confirmación de números
SELECT logistica.sync_next_route_preparation_cards(
  'd1000000-0000-0000-0000-000000000001'::uuid,
  '11111111-1111-1111-1111-111111111111'::uuid,
  true,
  NULL
);

-- PRECHECK: conteos operativos
SELECT
  (SELECT count(*) FROM logistica.sales_order_preparation_cards WHERE company_id = 'd1000000-0000-0000-0000-000000000001') AS cards,
  (SELECT count(*) FROM logistica.sales_order_preparation_route_events WHERE company_id = 'd1000000-0000-0000-0000-000000000001') AS route_events,
  (SELECT count(*) FROM logistica.sales_order_preparation_movements WHERE company_id = 'd1000000-0000-0000-0000-000000000001') AS movements,
  (SELECT count(*) FROM logistica.sales_order_route_exceptions WHERE company_id = 'd1000000-0000-0000-0000-000000000001') AS exceptions;
