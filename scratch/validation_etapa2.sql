-- 2. Confirmar tabla route_events
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'logistica'
  AND table_name = 'sales_order_preparation_route_events'
ORDER BY ordinal_position;

-- 3. Confirmar función
SELECT routine_name
FROM information_schema.routines
WHERE routine_schema = 'logistica'
  AND routine_name = 'sync_next_route_preparation_cards';

-- 4. Ejecutar dry-run real
SELECT logistica.sync_next_route_preparation_cards(
  'd1000000-0000-0000-0000-000000000001'::uuid,
  '11111111-1111-1111-1111-111111111111'::uuid,
  true
);

-- 5. Validar counts
SELECT count(*) AS total_cards
FROM logistica.sales_order_preparation_cards;

SELECT status, count(*)
FROM logistica.sales_order_preparation_cards
GROUP BY status
ORDER BY status;

SELECT count(*) AS total_movements
FROM logistica.sales_order_preparation_movements;

SELECT count(*) AS total_exceptions
FROM logistica.sales_order_route_exceptions;

SELECT count(*) AS total_route_events
FROM logistica.sales_order_preparation_route_events;
