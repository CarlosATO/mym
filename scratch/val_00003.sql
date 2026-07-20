-- Validación 2: firma activa
SELECT
  p.proname,
  pg_catalog.oidvectortypes(p.proargtypes) AS args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'logistica'
  AND p.proname = 'sync_next_route_preparation_cards';

-- Validación 3: dry-run true
SELECT logistica.sync_next_route_preparation_cards(
  'd1000000-0000-0000-0000-000000000001'::uuid,
  '11111111-1111-1111-1111-111111111111'::uuid,
  true,
  NULL
);

-- Validación 5: conteos
SELECT
  (SELECT count(*) FROM logistica.sales_order_preparation_cards WHERE company_id = 'd1000000-0000-0000-0000-000000000001') AS cards_count,
  (SELECT count(*) FROM logistica.sales_order_preparation_cards WHERE company_id = 'd1000000-0000-0000-0000-000000000001' AND status = 'PENDING_ROUTE_PREP') AS pending_count,
  (SELECT count(*) FROM logistica.sales_order_preparation_movements WHERE company_id = 'd1000000-0000-0000-0000-000000000001') AS movements_count,
  (SELECT count(*) FROM logistica.sales_order_route_exceptions WHERE company_id = 'd1000000-0000-0000-0000-000000000001') AS exceptions_count,
  (SELECT count(*) FROM logistica.sales_order_preparation_route_events WHERE company_id = 'd1000000-0000-0000-0000-000000000001') AS events_count;
