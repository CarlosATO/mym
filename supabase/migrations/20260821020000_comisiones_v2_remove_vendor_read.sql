-- COMV2-03B.1: sellers cannot inspect V2 until seller-level resolution exists.
-- Keep the commercial module access and every other VENDEDOR permission intact.

DELETE FROM portal.role_permissions rp
USING portal.roles r, portal.permissions p
WHERE rp.role_id = r.id
  AND rp.permission_id = p.id
  AND r.name = 'VENDEDOR'
  AND p.code = 'comisiones.v2.read';
