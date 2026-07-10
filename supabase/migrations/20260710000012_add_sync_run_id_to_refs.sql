-- ============================================================================
-- 1. Añadir bsale_sync_run_id a bsale_document_references
-- ============================================================================

ALTER TABLE integraciones.bsale_document_references 
ADD COLUMN IF NOT EXISTS bsale_sync_run_id uuid REFERENCES integraciones.bsale_sync_runs(id);

-- Para evitar que el schema cache moleste en migraciones futuras
NOTIFY pgrst, 'reload schema';
