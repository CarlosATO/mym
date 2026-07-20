-- 4. Ejecutar dry-run real
SELECT logistica.sync_next_route_preparation_cards(
  'd1000000-0000-0000-0000-000000000001'::uuid,
  '11111111-1111-1111-1111-111111111111'::uuid,
  true
);
