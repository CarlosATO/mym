-- Make module visibility depend only on effective permissions.
-- dashboard.view remains the root permission for the dashboard module.
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
BEGIN
    RETURN QUERY
    SELECT m.id, m.code, m.name, m.description, m.icon, m.route, m.sort_order
    FROM portal.modules m
    WHERE m.is_active = true
      AND portal.user_has_permission(
          p_user_id,
          CASE
              WHEN m.code = 'dashboard' THEN 'dashboard.view'
              ELSE 'module.' || m.code || '.view'
          END
      )
    ORDER BY m.sort_order ASC;
END;
$$;
