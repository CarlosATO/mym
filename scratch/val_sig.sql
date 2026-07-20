SELECT
  p.proname,
  pg_catalog.oidvectortypes(p.proargtypes) AS args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'logistica'
  AND p.proname = 'sync_next_route_preparation_cards';
