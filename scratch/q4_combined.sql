SELECT 
  (SELECT count(*) FROM logistica.sales_order_preparation_cards) AS cards_count,
  (SELECT count(*) FROM logistica.sales_order_preparation_cards WHERE status = 'PENDING_ROUTE_PREP') AS pending_cards_count,
  (SELECT count(*) FROM logistica.sales_order_preparation_movements) AS movements_count,
  (SELECT count(*) FROM logistica.sales_order_route_exceptions) AS exceptions_count,
  (SELECT count(*) FROM logistica.sales_order_preparation_route_events) AS events_count;
