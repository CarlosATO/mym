-- Migration: 20260803110100_inventarios_stock_import_tables.sql
-- Description: Fase 4I.2C. Tablas de importacion de stock/costo por Excel.
--              stock_imports (cabecera), stock_import_rows (filas) y
--              stock_import_row_issues (multiples errores/advertencias por fila).
-- Author: Assistant

-- ============================================================
-- 1. CABECERA DE IMPORTACION
-- ============================================================
CREATE TABLE inventarios.stock_imports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    warehouse_id uuid NOT NULL REFERENCES adquisiciones.warehouses(id) ON DELETE RESTRICT,
    modality text NOT NULL,
    cutoff_at timestamptz NOT NULL,
    original_filename text NOT NULL,
    mime_type text,
    file_size bigint,
    file_sha256 char(64),
    template_version text,
    storage_path text,
    currency text NOT NULL DEFAULT 'CLP',
    status text NOT NULL DEFAULT 'DRAFT',
    consumed_session_id uuid,
    row_count integer NOT NULL DEFAULT 0,
    error_count integer NOT NULL DEFAULT 0,
    warning_count integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    validated_at timestamptz,
    validated_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_stock_imports_company_id UNIQUE (company_id, id),
    CONSTRAINT uq_inventarios_stock_imports_company_hash UNIQUE (company_id, file_sha256),
    CONSTRAINT chk_inventarios_stock_imports_modality
        CHECK (modality IN ('GENERAL', 'POR_UBICACION')),
    CONSTRAINT chk_inventarios_stock_imports_status
        CHECK (status IN ('DRAFT', 'VALIDATED', 'REJECTED', 'CONSUMED')),
    CONSTRAINT chk_inventarios_stock_imports_currency
        CHECK (currency = 'CLP'),
    CONSTRAINT chk_inventarios_stock_imports_consumed
        CHECK (consumed_session_id IS NULL OR status = 'CONSUMED'),
    CONSTRAINT fk_inventarios_stock_imports_session
        FOREIGN KEY (company_id, consumed_session_id)
        REFERENCES inventarios.sessions(company_id, id)
        ON DELETE RESTRICT
);

CREATE INDEX idx_inventarios_stock_imports_company_status
    ON inventarios.stock_imports (company_id, status);

-- ============================================================
-- 2. FILAS DE IMPORTACION
-- ============================================================
CREATE TABLE inventarios.stock_import_rows (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    import_id uuid NOT NULL,
    row_index integer NOT NULL,
    sku text NOT NULL,
    barcode text,
    product_id uuid REFERENCES adquisiciones.products(id) ON DELETE RESTRICT,
    bsale_variant_id integer,
    location_id uuid REFERENCES logistica.locations(id) ON DELETE RESTRICT,
    theoretical_quantity numeric(14,3) NOT NULL,
    unit_cost numeric(14,2),
    currency text NOT NULL DEFAULT 'CLP',
    row_status text NOT NULL DEFAULT 'PENDING',
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_stock_import_rows_company_id UNIQUE (company_id, id),
    CONSTRAINT uq_inventarios_stock_import_rows_import_index UNIQUE (company_id, import_id, row_index),
    CONSTRAINT uq_inventarios_stock_import_rows_import_id UNIQUE (company_id, import_id, id),
    CONSTRAINT chk_inventarios_stock_import_rows_currency
        CHECK (currency = 'CLP'),
    CONSTRAINT chk_inventarios_stock_import_rows_status
        CHECK (row_status IN ('PENDING', 'VALID', 'ERROR', 'WARNING')),
    CONSTRAINT chk_inventarios_stock_import_rows_quantity
        CHECK (theoretical_quantity >= 0),
    CONSTRAINT chk_inventarios_stock_import_rows_cost
        CHECK (unit_cost IS NULL OR unit_cost >= 0),
    CONSTRAINT fk_inventarios_stock_import_rows_import_company
        FOREIGN KEY (company_id, import_id)
        REFERENCES inventarios.stock_imports(company_id, id)
        ON DELETE CASCADE
);

CREATE INDEX idx_inventarios_stock_import_rows_import
    ON inventarios.stock_import_rows (company_id, import_id);
CREATE INDEX idx_inventarios_stock_import_rows_sku
    ON inventarios.stock_import_rows (company_id, sku);

-- ============================================================
-- 3. ISSUES POR FILA (varios por fila)
-- ============================================================
CREATE TABLE inventarios.stock_import_row_issues (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    import_id uuid NOT NULL,
    row_id uuid NOT NULL,
    row_index integer NOT NULL,
    issue_level text NOT NULL,
    issue_code text NOT NULL,
    safe_message text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_inventarios_stock_import_issues_company_id UNIQUE (company_id, id),
    CONSTRAINT chk_inventarios_stock_import_issues_level
        CHECK (issue_level IN ('ERROR', 'WARNING')),
    CONSTRAINT fk_inventarios_stock_import_issues_import_company
        FOREIGN KEY (company_id, import_id)
        REFERENCES inventarios.stock_imports(company_id, id)
        ON DELETE CASCADE,
    CONSTRAINT fk_inventarios_stock_import_issues_row_company
        FOREIGN KEY (company_id, import_id, row_id)
        REFERENCES inventarios.stock_import_rows(company_id, import_id, id)
        ON DELETE CASCADE
);

CREATE INDEX idx_inventarios_stock_import_issues_import
    ON inventarios.stock_import_row_issues (company_id, import_id);
CREATE INDEX idx_inventarios_stock_import_issues_row
    ON inventarios.stock_import_row_issues (company_id, import_id, row_id);

-- Permisos de acceso a tablas (solo via RPC; sin acceso directo en cliente)
GRANT SELECT, INSERT, UPDATE ON TABLE inventarios.stock_imports TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE inventarios.stock_import_rows TO authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE inventarios.stock_import_row_issues TO authenticated;
