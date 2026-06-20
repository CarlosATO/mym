INSERT INTO portal.permissions (code, name, description, module_id)
SELECT 'module.adquisiciones.view', 'Ver Adquisiciones', 'Acceso al módulo de Adquisiciones', id
FROM portal.modules WHERE code = 'adquisiciones'
AND NOT EXISTS (SELECT 1 FROM portal.permissions WHERE code = 'module.adquisiciones.view');

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM portal.roles r, portal.permissions p
WHERE r.name = 'SUPER_USUARIO' AND p.code = 'module.adquisiciones.view'
AND NOT EXISTS (
    SELECT 1 FROM portal.role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
);

DROP FUNCTION IF EXISTS portal.get_visible_modules;

CREATE OR REPLACE FUNCTION portal.get_visible_modules(p_user_id uuid DEFAULT auth.uid())
RETURNS TABLE (
    id uuid,
    code varchar,
    name varchar,
    description text,
    icon varchar,
    route varchar,
    sort_order integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
DECLARE
    v_caller_id uuid;
    v_perm_code varchar;
BEGIN
    v_caller_id := auth.uid();

    RETURN QUERY
    SELECT m.id, m.code, m.name, m.description, m.icon, m.route, m.sort_order
    FROM portal.modules m
    WHERE m.is_active = true
    AND (
        CASE
            WHEN v_caller_id IS NOT NULL THEN portal.has_permission('system.admin')
            ELSE portal.user_has_permission(p_user_id, 'system.admin')
        END
        OR (
            (
                NOT EXISTS (
                    SELECT 1 FROM portal.user_modules um
                    WHERE um.user_id = p_user_id AND um.module_id = m.id AND um.is_active = false
                )
            )
            AND (
                CASE
                    WHEN m.code = 'dashboard' THEN
                        CASE
                            WHEN v_caller_id IS NOT NULL THEN portal.has_permission('dashboard.view')
                            ELSE portal.user_has_permission(p_user_id, 'dashboard.view')
                        END
                    ELSE
                        CASE
                            WHEN v_caller_id IS NOT NULL THEN portal.has_permission('module.' || m.code || '.view')
                            ELSE portal.user_has_permission(p_user_id, 'module.' || m.code || '.view')
                        END
                END
            )
        )
    )
    ORDER BY m.sort_order ASC;
END;
$$;
