CREATE TABLE portal.users (
    id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email varchar(255) NOT NULL,
    nombre varchar(100) NOT NULL,
    apellido varchar(100) NOT NULL,
    telefono varchar(20),
    avatar_url text,
    role_id uuid NOT NULL REFERENCES portal.roles(id),
    is_active boolean NOT NULL DEFAULT true,
    must_change_password boolean NOT NULL DEFAULT true,
    last_login_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES portal.users(id),
    updated_by uuid REFERENCES portal.users(id),
    deleted_at timestamptz
);

CREATE UNIQUE INDEX idx_users_email ON portal.users (email);
CREATE INDEX idx_users_role_id ON portal.users (role_id);
CREATE INDEX idx_users_deleted_at ON portal.users (deleted_at);
