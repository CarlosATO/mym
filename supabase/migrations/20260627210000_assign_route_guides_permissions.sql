-- MIGRATION: 20260627210000_assign_route_guides_permissions.sql

DO $$
DECLARE
    v_super_role_id uuid;
    v_gerencia_role_id uuid;
    v_bodega_role_id uuid;
    v_finanzas_role_id uuid;
BEGIN
    SELECT id INTO v_super_role_id FROM portal.roles WHERE name = 'SUPER_USUARIO';
    SELECT id INTO v_gerencia_role_id FROM portal.roles WHERE name = 'GERENCIA';
    SELECT id INTO v_bodega_role_id FROM portal.roles WHERE name = 'BODEGA';
    SELECT id INTO v_finanzas_role_id FROM portal.roles WHERE name = 'FINANZAS';

    -- SUPER_USUARIO
    IF v_super_role_id IS NOT NULL THEN
        INSERT INTO portal.role_permissions (role_id, permission_id)
        SELECT v_super_role_id, p.id FROM portal.permissions p
        WHERE p.code IN (
            'logistica.route_guides.view',
            'logistica.route_guides.create',
            'logistica.route_guides.update_draft',
            'logistica.route_guides.dispatch',
            'logistica.route_guides.print',
            'logistica.route_guides.cancel',
            'logistica.route_catalogs.manage'
        )
        AND NOT EXISTS (
            SELECT 1 FROM portal.role_permissions rp 
            WHERE rp.role_id = v_super_role_id AND rp.permission_id = p.id
        );
    END IF;

    -- GERENCIA
    IF v_gerencia_role_id IS NOT NULL THEN
        INSERT INTO portal.role_permissions (role_id, permission_id)
        SELECT v_gerencia_role_id, p.id FROM portal.permissions p
        WHERE p.code IN (
            'logistica.route_guides.view',
            'logistica.route_guides.create',
            'logistica.route_guides.update_draft',
            'logistica.route_guides.dispatch',
            'logistica.route_guides.print',
            'logistica.route_guides.cancel',
            'logistica.route_catalogs.manage'
        )
        AND NOT EXISTS (
            SELECT 1 FROM portal.role_permissions rp 
            WHERE rp.role_id = v_gerencia_role_id AND rp.permission_id = p.id
        );
    END IF;

    -- BODEGA
    IF v_bodega_role_id IS NOT NULL THEN
        INSERT INTO portal.role_permissions (role_id, permission_id)
        SELECT v_bodega_role_id, p.id FROM portal.permissions p
        WHERE p.code IN (
            'logistica.route_guides.view',
            'logistica.route_guides.create',
            'logistica.route_guides.update_draft',
            'logistica.route_guides.dispatch',
            'logistica.route_guides.print',
            'logistica.route_catalogs.manage'
        )
        AND NOT EXISTS (
            SELECT 1 FROM portal.role_permissions rp 
            WHERE rp.role_id = v_bodega_role_id AND rp.permission_id = p.id
        );
    END IF;

    -- FINANZAS
    IF v_finanzas_role_id IS NOT NULL THEN
        INSERT INTO portal.role_permissions (role_id, permission_id)
        SELECT v_finanzas_role_id, p.id FROM portal.permissions p
        WHERE p.code IN (
            'logistica.route_guides.view',
            'logistica.route_guides.print'
        )
        AND NOT EXISTS (
            SELECT 1 FROM portal.role_permissions rp 
            WHERE rp.role_id = v_finanzas_role_id AND rp.permission_id = p.id
        );
    END IF;

END $$;
