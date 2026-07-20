SELECT
  (SELECT count(*) FROM logistica.sales_order_preparation_cards WHERE company_id = 'd1000000-0000-0000-0000-000000000001') AS total_cards,
  (SELECT count(*) FROM logistica.sales_order_preparation_movements WHERE company_id = 'd1000000-0000-0000-0000-000000000001') AS movements,
  (SELECT count(*) FROM logistica.sales_order_route_exceptions WHERE company_id = 'd1000000-0000-0000-0000-000000000001') AS exceptions,
  (SELECT count(*) FROM logistica.sales_order_preparation_route_events WHERE company_id = 'd1000000-0000-0000-0000-000000000001') AS route_events;
