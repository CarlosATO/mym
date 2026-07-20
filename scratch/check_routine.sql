SELECT routine_schema, routine_name
FROM information_schema.routines
WHERE routine_schema = 'logistica'
  AND routine_name = 'preview_next_route_candidates';
