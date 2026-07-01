-- MIGRATION: 20260630000000_route_settlement_attachments.sql
-- Tabla de comprobantes por ítem de rendición de ruta
-- Patrón igual que recepciones (bucket privado + RLS por company_id en el path)

-- 1. Tabla de adjuntos
CREATE TABLE IF NOT EXISTS adquisiciones.route_settlement_item_attachments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    settlement_id uuid NOT NULL REFERENCES adquisiciones.route_settlements(id) ON DELETE CASCADE,
    settlement_item_id uuid NOT NULL REFERENCES adquisiciones.route_settlement_items(id) ON DELETE CASCADE,
    file_name text NOT NULL,
    storage_bucket varchar(100) NOT NULL DEFAULT 'rendicion-rutas',
    storage_path text NOT NULL,
    file_mime_type text,
    file_size bigint,
    notes text,
    uploaded_by uuid NOT NULL REFERENCES portal.users(id),
    uploaded_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_rsi_attachments_item ON adquisiciones.route_settlement_item_attachments (company_id, settlement_item_id);
CREATE INDEX idx_rsi_attachments_settlement ON adquisiciones.route_settlement_item_attachments (company_id, settlement_id);

-- Trigger updated_at no necesario (immutable tras upload)

-- 2. RLS
ALTER TABLE adquisiciones.route_settlement_item_attachments ENABLE ROW LEVEL SECURITY;
GRANT ALL ON adquisiciones.route_settlement_item_attachments TO authenticated, service_role;

CREATE POLICY "Users can view rsi_attachments if company access"
ON adquisiciones.route_settlement_item_attachments FOR SELECT
USING (core.has_company_access(auth.uid(), company_id));

-- Insert/Delete solo vía Server Actions (no direct client mutation)

-- 3. Storage bucket privado para rendición de rutas
-- Igual al patrón de 'recepciones': privado, 10MB, PDF/imagen
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'rendicion-rutas',
  'rendicion-rutas',
  false,
  10485760, -- 10MB
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- 4. RLS en storage.objects para bucket rendicion-rutas
-- Path esperado: {company_id}/rendicion-rutas/{settlement_id}/{timestamp}-{filename}
DROP POLICY IF EXISTS "Permitir SELECT en rendicion-rutas para usuarios con acceso a la empresa" ON storage.objects;
CREATE POLICY "Permitir SELECT en rendicion-rutas para usuarios con acceso a la empresa"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'rendicion-rutas' AND
  name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/' AND
  (SELECT EXISTS (
    SELECT 1 FROM core.user_company_access uca
    WHERE uca.user_id = auth.uid()
      AND uca.company_id = split_part(name, '/', 1)::uuid
      AND uca.is_active = true
  ))
);

DROP POLICY IF EXISTS "Permitir INSERT en rendicion-rutas para usuarios con acceso a la empresa" ON storage.objects;
CREATE POLICY "Permitir INSERT en rendicion-rutas para usuarios con acceso a la empresa"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'rendicion-rutas' AND
  name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/' AND
  (SELECT EXISTS (
    SELECT 1 FROM core.user_company_access uca
    WHERE uca.user_id = auth.uid()
      AND uca.company_id = split_part(name, '/', 1)::uuid
      AND uca.is_active = true
  ))
);

DROP POLICY IF EXISTS "Permitir DELETE en rendicion-rutas para usuarios con acceso a la empresa" ON storage.objects;
CREATE POLICY "Permitir DELETE en rendicion-rutas para usuarios con acceso a la empresa"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'rendicion-rutas' AND
  name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/' AND
  (SELECT EXISTS (
    SELECT 1 FROM core.user_company_access uca
    WHERE uca.user_id = auth.uid()
      AND uca.company_id = split_part(name, '/', 1)::uuid
      AND uca.is_active = true
  ))
);
