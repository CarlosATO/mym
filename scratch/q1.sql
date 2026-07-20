-- 2. Confirmar tabla route_events
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'logistica'
  AND table_name = 'sales_order_preparation_route_events'
ORDER BY ordinal_position;
