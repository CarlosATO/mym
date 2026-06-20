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
            EXISTS (
                SELECT 1 FROM portal.user_modules um
                WHERE um.user_id = p_user_id AND um.module_id = m.id AND um.is_active = true
            )
            AND CASE
                WHEN v_caller_id IS NOT NULL THEN portal.has_permission(m.code || '.view')
                ELSE portal.user_has_permission(p_user_id, m.code || '.view')
            END
        )
    )
    ORDER BY m.sort_order ASC;
END;
$$;

CREATE OR REPLACE FUNCTION portal.user_has_permission(
    p_user_id uuid,
    p_permission_code varchar
)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
DECLARE
    v_role_id uuid;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN false;
    END IF;

    IF p_permission_code != 'system.admin' THEN
        IF portal.user_has_permission(p_user_id, 'system.admin') THEN
            RETURN true;
        END IF;
    END IF;

    SELECT role_id INTO v_role_id
    FROM portal.users
    WHERE id = p_user_id AND is_active = true AND deleted_at IS NULL;

    IF v_role_id IS NULL THEN
        RETURN false;
    END IF;

    IF EXISTS (
        SELECT 1 FROM portal.user_permissions up
        JOIN portal.permissions p ON p.id = up.permission_id
        WHERE up.user_id = p_user_id AND p.code = p_permission_code AND up.granted = false
    ) THEN
        RETURN false;
    END IF;

    IF EXISTS (
        SELECT 1 FROM portal.user_permissions up
        JOIN portal.permissions p ON p.id = up.permission_id
        WHERE up.user_id = p_user_id AND p.code = p_permission_code AND up.granted = true
    ) THEN
        RETURN true;
    END IF;

    RETURN EXISTS (
        SELECT 1 FROM portal.role_permissions rp
        JOIN portal.permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = v_role_id AND p.code = p_permission_code
    );
END;
$$;
