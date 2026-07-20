SELECT routine_schema, routine_name
FROM information_schema.routines
WHERE routine_name LIKE '%preview_next%';
