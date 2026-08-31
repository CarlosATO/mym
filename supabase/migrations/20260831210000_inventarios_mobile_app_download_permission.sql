-- Register the permission required to download the Inventarios mobile app.
INSERT INTO portal.permissions (code, name, description, module_id, is_active)
SELECT
  'inventarios.mobile_app.download',
  'Descargar App de Inventarios',
  'Permite acceder al QR y enlace de descarga de la aplicación móvil de Inventarios.',
  m.id,
  true
FROM portal.modules AS m
WHERE m.code = 'inventarios'
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    module_id = EXCLUDED.module_id,
    is_active = true;
