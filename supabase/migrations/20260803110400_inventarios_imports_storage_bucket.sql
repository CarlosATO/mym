-- Migration: 20260803110400_inventarios_imports_storage_bucket.sql
-- Description: Fase 4I.2C. Bucket privado inventario-imports para archivos de
--              importacion de stock/costo. Maximo 20MB, XLSX/XLS/CSV.
--              El parseo del archivo se implementa en una fase posterior.
-- Author: Assistant

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'inventario-imports',
  'inventario-imports',
  false,
  20971520, -- 20MB
  ARRAY[
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/csv',
    'application/csv'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Path esperado: {company_id}/stock-imports/{import_id}/{timestamp}-{filename}
DROP POLICY IF EXISTS "Permitir SELECT en inventario-imports con acceso a la empresa" ON storage.objects;
CREATE POLICY "Permitir SELECT en inventario-imports con acceso a la empresa"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'inventario-imports' AND
  name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/' AND
  core.has_company_access(
    auth.uid(),
    (string_to_array(name, '/'))[1]::uuid
  )
);

DROP POLICY IF EXISTS "Permitir INSERT en inventario-imports con acceso a la empresa" ON storage.objects;
CREATE POLICY "Permitir INSERT en inventario-imports con acceso a la empresa"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'inventario-imports' AND
  name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/' AND
  core.has_company_access(
    auth.uid(),
    (string_to_array(name, '/'))[1]::uuid
  )
);
