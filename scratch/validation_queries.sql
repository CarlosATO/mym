SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'logistica'
  AND table_name = 'dispatch_calendars'
  AND column_name = 'default_cutoff_time';

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'logistica'
  AND table_name = 'sales_order_preparation_cards'
  AND column_name = 'original_route_date';

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'logistica'
  AND table_name = 'sales_order_route_exceptions'
ORDER BY ordinal_position;

SELECT routine_name
FROM information_schema.routines
WHERE routine_schema = 'logistica'
  AND routine_name IN (
    'get_next_dispatch_route_context',
    'preview_next_route_candidates'
  );

SELECT *
FROM logistica.get_next_dispatch_route_context(
  (SELECT company_id FROM logistica.dispatch_calendars LIMIT 1)
);

SELECT logistica.preview_next_route_candidates(
  (SELECT company_id FROM logistica.dispatch_calendars LIMIT 1)
);

SELECT count(*) as total_cards
FROM logistica.sales_order_preparation_cards;

SELECT status, count(*) as count_by_status
FROM logistica.sales_order_preparation_cards
GROUP BY status
ORDER BY status;

SELECT count(*) as total_movements
FROM logistica.sales_order_preparation_movements;

SELECT count(*) as total_exceptions
FROM logistica.sales_order_route_exceptions;
