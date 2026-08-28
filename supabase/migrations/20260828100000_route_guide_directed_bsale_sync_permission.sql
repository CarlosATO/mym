-- Permission for the server-side, folio-scoped Bsale sync used by route guides.
DO $$
DECLARE
    v_module_id uuid;
    v_role_id uuid;
BEGIN
    SELECT id INTO v_module_id FROM portal.modules WHERE code = 'logistica';

    IF v_module_id IS NOT NULL THEN
        INSERT INTO portal.permissions (code, name, description, module_id)
        VALUES (
            'logistica.route_guides.sync_bsale',
            'Sincronizar facturas Bsale para Guías de Ruta',
            'Puede verificar y sincronizar folios Bsale específicos antes de emitir una guía',
            v_module_id
        )
        ON CONFLICT (code) DO NOTHING;
    END IF;

    FOR v_role_id IN
        SELECT id FROM portal.roles WHERE name IN ('SUPER_USUARIO', 'GERENCIA', 'BODEGA')
    LOOP
        INSERT INTO portal.role_permissions (role_id, permission_id)
        SELECT v_role_id, p.id
        FROM portal.permissions p
        WHERE p.code = 'logistica.route_guides.sync_bsale'
          AND NOT EXISTS (
              SELECT 1 FROM portal.role_permissions rp
              WHERE rp.role_id = v_role_id AND rp.permission_id = p.id
          );
    END LOOP;
END $$;
