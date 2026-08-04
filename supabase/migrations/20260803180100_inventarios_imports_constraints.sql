-- Migration: 20260803180100_inventarios_imports_constraints.sql
-- Description: Fase 4I.3A. Ajustes de esquema para idempotencia y trazabilidad
--              de archivos de importacion de stock/costo.
--              1) Se corrige la restriccion UNIQUE(company_id, file_sha256):
--                 permite el mismo archivo en otro sitio u otro corte.
--              2) theoretical_quantity pasa a ser nullable para filas con
--                 cantidad invalida (no se convierte silenciosamente a cero).
--              3) Columnas de trazabilidad de reemplazo y issues de archivo.
-- Author: Assistant

-- ============================================================
-- 1. IDEMPOTENCIA
--    La identidad idempotente es:
--      company_id + inventory_site_id + modality + cutoff_at + file_sha256
--    Solo para imports no CONSUMED. El mismo archivo puede usarse en otro
--    sitio u otro corte (site/cutoff distintos no chocan).
-- ============================================================
ALTER TABLE inventarios.stock_imports
    DROP CONSTRAINT IF EXISTS uq_inventarios_stock_imports_company_hash;

CREATE UNIQUE INDEX uq_inventarios_stock_imports_idempotency
    ON inventarios.stock_imports (company_id, inventory_site_id, modality, cutoff_at, file_sha256)
    WHERE file_sha256 IS NOT NULL AND status <> 'CONSUMED';

-- ============================================================
-- 2. FILAS CON CANTIDAD INVALIDA
--    Una fila puede persistirse con theoretical_quantity NULL cuando la
--    cantidad no cumple la validacion (MISSING/INVALID/NEGATIVE/SCALE).
--    Nunca se reemplaza un valor invalido por 0 de forma silenciosa.
-- ============================================================
ALTER TABLE inventarios.stock_import_rows
    ALTER COLUMN theoretical_quantity DROP NOT NULL;

-- Nombre del producto ingresado en el archivo (solo referencia, no canónico).
ALTER TABLE inventarios.stock_import_rows
    ADD COLUMN IF NOT EXISTS entered_name text;

-- ============================================================
-- 3. TRAZABILIDAD DE REEMPLAZO Y ISSUES DE ARCHIVO
--    previous_* conserva el archivo reemplazado para auditoria.
--    file_issues almacena advertencias/errores a nivel de archivo
--    (columnas desconocidas, hoja Datos ausente, etc.).
--    source identifica la fuente de la importacion (futuro BSALE_SYNC).
-- ============================================================
ALTER TABLE inventarios.stock_imports
    ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'EXCEL_IMPORT';

ALTER TABLE inventarios.stock_imports
    ADD COLUMN IF NOT EXISTS previous_storage_path text;

ALTER TABLE inventarios.stock_imports
    ADD COLUMN IF NOT EXISTS previous_file_sha256 char(64);

ALTER TABLE inventarios.stock_imports
    ADD COLUMN IF NOT EXISTS file_issues jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE inventarios.stock_imports
    DROP CONSTRAINT IF EXISTS chk_inventarios_stock_imports_source;

ALTER TABLE inventarios.stock_imports
    ADD CONSTRAINT chk_inventarios_stock_imports_source
    CHECK (source IN ('EXCEL_IMPORT', 'BSALE_SYNC'));
