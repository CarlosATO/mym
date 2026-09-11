-- RRHH V1: foundation for MYM personnel and private employee documents.

CREATE SCHEMA IF NOT EXISTS rrhh;

CREATE TABLE rrhh.employees (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    rut text NOT NULL CHECK (btrim(rut) <> ''),
    rut_normalized text GENERATED ALWAYS AS (
        regexp_replace(upper(btrim(rut)), '[^0-9K]', '', 'g')
    ) STORED,
    nombres text NOT NULL,
    apellido_paterno text NOT NULL,
    apellido_materno text,
    fecha_nacimiento date,
    telefono text,
    email_personal text,
    email_corporativo text,
    direccion text,
    comuna text,
    ciudad text,
    cargo text,
    area_departamento text,
    fecha_ingreso date,
    tipo_contrato text,
    estado text NOT NULL DEFAULT 'ACTIVO' CHECK (estado IN ('ACTIVO', 'INACTIVO')),
    observaciones text,
    portal_user_id uuid REFERENCES portal.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES portal.users(id) ON DELETE SET NULL,
    updated_by uuid REFERENCES portal.users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX employees_rut_normalized_uidx ON rrhh.employees (rut_normalized);
CREATE INDEX employees_estado_idx ON rrhh.employees (estado);
CREATE INDEX employees_portal_user_id_idx ON rrhh.employees (portal_user_id)
    WHERE portal_user_id IS NOT NULL;

CREATE TABLE rrhh.employee_documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id uuid NOT NULL REFERENCES rrhh.employees(id) ON DELETE RESTRICT,
    document_type text NOT NULL CHECK (document_type IN (
        'CONTRATO', 'ANEXO', 'CURSO_CERTIFICADO', 'DOCUMENTO_PERSONAL', 'OTRO'
    )),
    title text NOT NULL,
    document_date date,
    expiration_date date,
    notes text,
    storage_path text NOT NULL,
    original_filename text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL CHECK (size_bytes > 0),
    uploaded_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    uploaded_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT employee_documents_storage_path_format CHECK (
        storage_path ~ '^[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}/[^/]+$'
    )
);

CREATE INDEX employee_documents_employee_idx ON rrhh.employee_documents (employee_id, uploaded_at DESC);
CREATE INDEX employee_documents_expiration_idx ON rrhh.employee_documents (expiration_date)
    WHERE expiration_date IS NOT NULL;

CREATE TRIGGER trg_rrhh_employees_set_updated_at
    BEFORE UPDATE ON rrhh.employees
    FOR EACH ROW EXECUTE FUNCTION portal.set_updated_at();

ALTER TABLE rrhh.employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE rrhh.employee_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY rrhh_employees_select ON rrhh.employees FOR SELECT TO authenticated
    USING (portal.has_permission('system.admin') OR portal.has_permission('rrhh.personal.view'));
CREATE POLICY rrhh_employees_insert ON rrhh.employees FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin') OR portal.has_permission('rrhh.personal.manage'));
CREATE POLICY rrhh_employees_update ON rrhh.employees FOR UPDATE TO authenticated
    USING (portal.has_permission('system.admin') OR portal.has_permission('rrhh.personal.manage'))
    WITH CHECK (portal.has_permission('system.admin') OR portal.has_permission('rrhh.personal.manage'));

CREATE POLICY rrhh_employee_documents_select ON rrhh.employee_documents FOR SELECT TO authenticated
    USING (portal.has_permission('system.admin') OR portal.has_permission('rrhh.documents.manage'));
CREATE POLICY rrhh_employee_documents_insert ON rrhh.employee_documents FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin') OR portal.has_permission('rrhh.documents.manage'));
CREATE POLICY rrhh_employee_documents_update ON rrhh.employee_documents FOR UPDATE TO authenticated
    USING (portal.has_permission('system.admin') OR portal.has_permission('rrhh.documents.manage'))
    WITH CHECK (portal.has_permission('system.admin') OR portal.has_permission('rrhh.documents.manage'));
CREATE POLICY rrhh_employee_documents_delete ON rrhh.employee_documents FOR DELETE TO authenticated
    USING (portal.has_permission('system.admin') OR portal.has_permission('rrhh.documents.manage'));

GRANT USAGE ON SCHEMA rrhh TO authenticated;
GRANT SELECT, INSERT, UPDATE ON rrhh.employees TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON rrhh.employee_documents TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA rrhh TO service_role;

INSERT INTO portal.modules (code, name, description, icon, route, sort_order)
VALUES ('rrhh', 'RRHH', 'Gestión de personal y documentación laboral', 'UsersRound', '/dashboard/rrhh', 9)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    icon = EXCLUDED.icon,
    route = EXCLUDED.route;

INSERT INTO portal.permissions (code, name, description, module_id)
SELECT permission_rows.code, permission_rows.name, permission_rows.description, modules.id
FROM (VALUES
    ('rrhh.personal.view', 'Ver Personal', 'Consultar el maestro de trabajadores'),
    ('rrhh.personal.manage', 'Gestionar Personal', 'Crear y actualizar trabajadores'),
    ('rrhh.documents.manage', 'Gestionar Documentos RRHH', 'Consultar y gestionar documentos laborales')
) AS permission_rows(code, name, description)
JOIN portal.modules modules ON modules.code = 'rrhh'
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    module_id = EXCLUDED.module_id;

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT roles.id, permissions.id
FROM portal.roles roles
JOIN portal.permissions permissions ON permissions.code IN (
    'rrhh.personal.view', 'rrhh.personal.manage', 'rrhh.documents.manage'
)
WHERE roles.name = 'SUPER_USUARIO'
ON CONFLICT DO NOTHING;

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('rrhh-documents', 'rrhh-documents', false, 52428800)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit;

DROP POLICY IF EXISTS rrhh_documents_storage_select ON storage.objects;
CREATE POLICY rrhh_documents_storage_select ON storage.objects FOR SELECT TO authenticated
    USING (
        bucket_id = 'rrhh-documents'
        AND (portal.has_permission('system.admin') OR portal.has_permission('rrhh.documents.manage'))
        AND EXISTS (
            SELECT 1 FROM rrhh.employee_documents documents
            WHERE documents.storage_path = name
        )
    );

DROP POLICY IF EXISTS rrhh_documents_storage_insert ON storage.objects;
CREATE POLICY rrhh_documents_storage_insert ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'rrhh-documents'
        AND (portal.has_permission('system.admin') OR portal.has_permission('rrhh.documents.manage'))
        AND split_part(name, '/', 1) ~ '^[0-9a-fA-F-]{36}$'
        AND split_part(name, '/', 2) ~ '^[0-9a-fA-F-]{36}$'
        AND EXISTS (
            SELECT 1 FROM rrhh.employees employees
            WHERE employees.id::text = split_part(name, '/', 1)
        )
    );

DROP POLICY IF EXISTS rrhh_documents_storage_update ON storage.objects;
CREATE POLICY rrhh_documents_storage_update ON storage.objects FOR UPDATE TO authenticated
    USING (bucket_id = 'rrhh-documents' AND (portal.has_permission('system.admin') OR portal.has_permission('rrhh.documents.manage')))
    WITH CHECK (bucket_id = 'rrhh-documents' AND (portal.has_permission('system.admin') OR portal.has_permission('rrhh.documents.manage')));

DROP POLICY IF EXISTS rrhh_documents_storage_delete ON storage.objects;
CREATE POLICY rrhh_documents_storage_delete ON storage.objects FOR DELETE TO authenticated
    USING (bucket_id = 'rrhh-documents' AND (portal.has_permission('system.admin') OR portal.has_permission('rrhh.documents.manage')));
