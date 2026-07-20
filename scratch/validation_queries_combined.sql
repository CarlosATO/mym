SELECT json_build_object(
  'default_cutoff_time_exists', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'logistica' AND table_name = 'dispatch_calendars' AND column_name = 'default_cutoff_time'),
  'original_route_date_exists', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'logistica' AND table_name = 'sales_order_preparation_cards' AND column_name = 'original_route_date'),
  'exceptions_table_exists', EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'logistica' AND table_name = 'sales_order_route_exceptions'),
  'functions_exist', (SELECT count(*) FROM information_schema.routines WHERE routine_schema = 'logistica' AND routine_name IN ('get_next_dispatch_route_context', 'preview_next_route_candidates')),
  'total_cards', (SELECT count(*) FROM logistica.sales_order_preparation_cards),
  'cards_by_status', (SELECT json_object_agg(status, cnt) FROM (SELECT status, count(*) as cnt FROM logistica.sales_order_preparation_cards GROUP BY status) t),
  'total_movements', (SELECT count(*) FROM logistica.sales_order_preparation_movements),
  'total_exceptions', (SELECT count(*) FROM logistica.sales_order_route_exceptions),
  'preview_output', (SELECT logistica.preview_next_route_candidates((SELECT company_id FROM logistica.dispatch_calendars LIMIT 1)))
) as results;
