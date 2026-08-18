-- Read-only manifest for Storage cleanup after the Inventarios DB purge.
-- This file intentionally performs no INSERT/UPDATE/DELETE on storage.objects.

SELECT bucket_id, name, owner_id, created_at
FROM storage.objects
WHERE bucket_id = 'inventario-imports'
  AND name LIKE 'd1000000-0000-0000-0000-000000000001/campaign-stock-imports/%'
  AND split_part(name, '/', 3) IN (
    'ce167065-7f26-4c33-9971-25b83c52cff1','8a509fed-d7b9-4cf3-aeb2-8690e65596a2',
    'b6cfa451-ce9b-4541-9f55-cfffed07fe34','ae850148-1cb7-43fc-87d8-bb2b4fb50469',
    '10737e8c-a3ab-4b42-a3ca-6aec1be72e67','5725f49e-963b-48f7-9eca-f278c6d0463a',
    '2831ae14-22a6-4b95-84d7-09ce09a3fce7','8b0eac49-f670-4ab7-bd7f-394b0f83c7c8',
    'decf970d-821f-4b4d-8bce-a7f57cfc04a5','2a1e8155-5d60-4848-9252-28d59db2b9c6',
    'b7a9d961-882e-4d80-a961-982e57afc650','b1b452d4-9325-4d43-8b21-d9b8e6dfded7',
    'd05733cf-9a8d-4e75-bbf0-191473f9af59','79d43c76-2eb4-4f12-bd19-79866a881141',
    '2349aed2-156c-4e03-9d23-c9551085dd65','d0b21680-3776-44d6-b1ee-b2da958bec4f',
    'c30d055a-6c68-4c2f-97a6-cf7064297517','58064901-000d-4c01-8c12-f1670f834c80',
    '153bf5e6-b63c-4a8a-97d5-abc1ff3e8093','a6b261bb-5c91-41db-9db0-7066b4470c52'
  )
UNION ALL
SELECT bucket_id, name, owner_id, created_at
FROM storage.objects
WHERE bucket_id = 'inventory-evidence'
  AND name LIKE 'd1000000-0000-0000-0000-000000000001/%'
ORDER BY bucket_id, name;
