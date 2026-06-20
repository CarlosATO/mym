CREATE OR REPLACE FUNCTION portal.has_permission(p_permission_code varchar)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
DECLARE
    v_user_id uuid;
    v_role_id uuid;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN false;
    END IF;

    IF p_permission_code != 'system.admin' THEN
        IF portal.has_permission('system.admin') THEN
            RETURN true;
        END IF;
    END IF;

    SELECT role_id INTO v_role_id
    FROM portal.users
    WHERE id = v_user_id AND is_active = true AND deleted_at IS NULL;

    IF v_role_id IS NULL THEN
        RETURN false;
    END IF;

    IF EXISTS (
        SELECT 1 FROM portal.user_permissions up
        JOIN portal.permissions p ON p.id = up.permission_id
        WHERE up.user_id = v_user_id AND p.code = p_permission_code AND up.granted = false
    ) THEN
        RETURN false;
    END IF;

    IF EXISTS (
        SELECT 1 FROM portal.user_permissions up
        JOIN portal.permissions p ON p.id = up.permission_id
        WHERE up.user_id = v_user_id AND p.code = p_permission_code AND up.granted = true
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

CREATE OR REPLACE FUNCTION portal.get_user_permissions(p_user_id uuid DEFAULT auth.uid())
RETURNS TABLE (permission_code varchar)
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT DISTINCT p.code
    FROM portal.permissions p
    WHERE p.is_active = true
    AND (
        EXISTS (
            SELECT 1 FROM portal.role_permissions rp
            JOIN portal.roles r ON r.id = rp.role_id
            JOIN portal.users u ON u.role_id = r.id
            WHERE u.id = p_user_id AND rp.permission_id = p.id
        )
        OR EXISTS (
            SELECT 1 FROM portal.user_permissions up
            WHERE up.user_id = p_user_id AND up.permission_id = p.id AND up.granted = true
        )
    )
    AND NOT EXISTS (
        SELECT 1 FROM portal.user_permissions up
        WHERE up.user_id = p_user_id AND up.permission_id = p.id AND up.granted = false
    );
END;
$$;

CREATE OR REPLACE FUNCTION portal.create_user_profile(
    p_user_id uuid,
    p_email varchar,
    p_nombre varchar,
    p_apellido varchar,
    p_role_id uuid,
    p_created_by uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
    INSERT INTO portal.users (id, email, nombre, apellido, role_id, created_by)
    VALUES (p_user_id, p_email, p_nombre, p_apellido, p_role_id, p_created_by);
END;
$$;

CREATE OR REPLACE FUNCTION portal.log_security_event(
    p_event_type varchar,
    p_success boolean,
    p_user_id uuid DEFAULT NULL,
    p_email varchar DEFAULT NULL,
    p_ip_address varchar DEFAULT NULL,
    p_user_agent text DEFAULT NULL,
    p_metadata jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
    INSERT INTO portal.security_logs (event_type, success, user_id, email, ip_address, user_agent, metadata)
    VALUES (p_event_type, p_success, p_user_id, p_email, p_ip_address, p_user_agent, p_metadata);
END;
$$;

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
