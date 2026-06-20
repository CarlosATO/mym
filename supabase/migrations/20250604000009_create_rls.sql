ALTER TABLE portal.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal.modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal.permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal.user_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal.user_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal.security_logs ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA portal TO authenticated, anon;
GRANT ALL ON ALL TABLES IN SCHEMA portal TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA portal TO authenticated;

CREATE POLICY rls_roles_select ON portal.roles
    FOR SELECT TO authenticated
    USING (portal.has_permission('roles.view') OR portal.has_permission('system.admin'));

CREATE POLICY rls_roles_insert ON portal.roles
    FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin'));

CREATE POLICY rls_roles_update ON portal.roles
    FOR UPDATE TO authenticated
    USING (portal.has_permission('system.admin'))
    WITH CHECK (portal.has_permission('system.admin'));

CREATE POLICY rls_roles_delete ON portal.roles
    FOR DELETE TO authenticated
    USING (portal.has_permission('system.admin'));

CREATE POLICY rls_modules_select ON portal.modules
    FOR SELECT TO authenticated
    USING (portal.has_permission('modules.view') OR portal.has_permission('system.admin'));

CREATE POLICY rls_modules_insert ON portal.modules
    FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('modules.manage') OR portal.has_permission('system.admin'));

CREATE POLICY rls_modules_update ON portal.modules
    FOR UPDATE TO authenticated
    USING (portal.has_permission('modules.manage') OR portal.has_permission('system.admin'))
    WITH CHECK (portal.has_permission('modules.manage') OR portal.has_permission('system.admin'));

CREATE POLICY rls_permissions_select ON portal.permissions
    FOR SELECT TO authenticated
    USING (portal.has_permission('roles.view') OR portal.has_permission('system.admin'));

CREATE POLICY rls_permissions_insert ON portal.permissions
    FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin'));

CREATE POLICY rls_permissions_update ON portal.permissions
    FOR UPDATE TO authenticated
    USING (portal.has_permission('system.admin'))
    WITH CHECK (portal.has_permission('system.admin'));

CREATE POLICY rls_users_select ON portal.users
    FOR SELECT TO authenticated
    USING (
        id = auth.uid()
        OR portal.has_permission('usuarios.view')
        OR portal.has_permission('system.admin')
    );

CREATE POLICY rls_users_insert ON portal.users
    FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('usuarios.create') OR portal.has_permission('system.admin'));

CREATE POLICY rls_users_update ON portal.users
    FOR UPDATE TO authenticated
    USING (
        id = auth.uid()
        OR portal.has_permission('usuarios.update')
        OR portal.has_permission('usuarios.deactivate')
        OR portal.has_permission('system.admin')
    )
    WITH CHECK (
        id = auth.uid()
        OR portal.has_permission('usuarios.update')
        OR portal.has_permission('system.admin')
    );

CREATE POLICY rls_role_permissions_select ON portal.role_permissions
    FOR SELECT TO authenticated
    USING (portal.has_permission('roles.view') OR portal.has_permission('system.admin'));

CREATE POLICY rls_role_permissions_insert ON portal.role_permissions
    FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('roles.assign') OR portal.has_permission('system.admin'));

CREATE POLICY rls_role_permissions_delete ON portal.role_permissions
    FOR DELETE TO authenticated
    USING (portal.has_permission('roles.assign') OR portal.has_permission('system.admin'));

CREATE POLICY rls_user_permissions_select ON portal.user_permissions
    FOR SELECT TO authenticated
    USING (portal.has_permission('roles.view') OR portal.has_permission('system.admin'));

CREATE POLICY rls_user_permissions_insert ON portal.user_permissions
    FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('roles.assign') OR portal.has_permission('system.admin'));

CREATE POLICY rls_user_permissions_update ON portal.user_permissions
    FOR UPDATE TO authenticated
    USING (portal.has_permission('roles.assign') OR portal.has_permission('system.admin'))
    WITH CHECK (portal.has_permission('roles.assign') OR portal.has_permission('system.admin'));

CREATE POLICY rls_user_permissions_delete ON portal.user_permissions
    FOR DELETE TO authenticated
    USING (portal.has_permission('roles.assign') OR portal.has_permission('system.admin'));

CREATE POLICY rls_user_modules_select ON portal.user_modules
    FOR SELECT TO authenticated
    USING (portal.has_permission('modules.view') OR portal.has_permission('system.admin'));

CREATE POLICY rls_user_modules_insert ON portal.user_modules
    FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('modules.manage') OR portal.has_permission('system.admin'));

CREATE POLICY rls_user_modules_update ON portal.user_modules
    FOR UPDATE TO authenticated
    USING (portal.has_permission('modules.manage') OR portal.has_permission('system.admin'))
    WITH CHECK (portal.has_permission('modules.manage') OR portal.has_permission('system.admin'));

CREATE POLICY rls_user_modules_delete ON portal.user_modules
    FOR DELETE TO authenticated
    USING (portal.has_permission('modules.manage') OR portal.has_permission('system.admin'));

CREATE POLICY rls_audit_logs_select ON portal.audit_logs
    FOR SELECT TO authenticated
    USING (portal.has_permission('audit.view') OR portal.has_permission('system.admin'));

CREATE POLICY rls_audit_logs_insert ON portal.audit_logs
    FOR INSERT TO authenticated
    WITH CHECK (true);

CREATE POLICY rls_security_logs_select ON portal.security_logs
    FOR SELECT TO authenticated
    USING (portal.has_permission('security.view') OR portal.has_permission('system.admin'));

CREATE POLICY rls_security_logs_insert ON portal.security_logs
    FOR INSERT TO authenticated
    WITH CHECK (true);
