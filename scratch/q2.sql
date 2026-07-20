-- 3. Confirmar función
SELECT routine_name
FROM information_schema.routines
WHERE routine_schema = 'logistica'
  AND routine_name = 'sync_next_route_preparation_cards';
