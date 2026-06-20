CREATE TABLE portal.role_permissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    role_id uuid NOT NULL REFERENCES portal.roles(id) ON DELETE CASCADE,
    permission_id uuid NOT NULL REFERENCES portal.permissions(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES portal.users(id)
);

CREATE UNIQUE INDEX idx_role_permissions_unique ON portal.role_permissions (role_id, permission_id);
CREATE INDEX idx_role_permissions_role_id ON portal.role_permissions (role_id);
CREATE INDEX idx_role_permissions_permission_id ON portal.role_permissions (permission_id);

CREATE TABLE portal.user_permissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES portal.users(id) ON DELETE CASCADE,
    permission_id uuid NOT NULL REFERENCES portal.permissions(id) ON DELETE CASCADE,
    granted boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES portal.users(id)
);

CREATE UNIQUE INDEX idx_user_permissions_unique ON portal.user_permissions (user_id, permission_id);
CREATE INDEX idx_user_permissions_user_id ON portal.user_permissions (user_id);

CREATE TABLE portal.user_modules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES portal.users(id) ON DELETE CASCADE,
    module_id uuid NOT NULL REFERENCES portal.modules(id) ON DELETE CASCADE,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES portal.users(id)
);

CREATE UNIQUE INDEX idx_user_modules_unique ON portal.user_modules (user_id, module_id);
CREATE INDEX idx_user_modules_user_id ON portal.user_modules (user_id);
CREATE INDEX idx_user_modules_module_id ON portal.user_modules (module_id);
