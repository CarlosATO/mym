-- Migration: 20260803110200_inventarios_snapshot_stock_cost_result.sql
-- Description: Fase 4I.2C. Stock teorico congelado por alcance (WAREHOUSE/LOCATION),
--              costo unitario congelado por snapshot y resultados oficiales por
--              ubicacion. snapshot_stocks existente se preserva para Bsale.
-- Author: Assistant

-- ============================================================
-- 0. GARANTIZAR UNIQUE(company_id, snapshot_id, id) en snapshot_locations
--    para soportar las FKs compuestas de las tablas nuevas.
-- ============================================================
ALTER TABLE inventarios.snapshot_locations
    ADD CONSTRAINT uq_inventarios_snapshot_locations_company_snapshot_id
    UNIQUE (company_id, snapshot_id, id);

-- ============================================================
-- 1. STOCK TEORICO CONGELADO
-- ============================================================
CREATE TABLE inventarios.snapshot_theoretical_stocks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    snapshot_id uuid NOT NULL,
    snapshot_product_id uuid NOT NULL,
    scope_level text NOT NULL,
    snapshot_location_id uuid,
    theoretical_quantity numeric(14,3) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_theoretical_stocks_company_id UNIQUE (company_id, id),
    CONSTRAINT chk_inventarios_theoretical_stocks_scope
        CHECK (scope_level IN ('WAREHOUSE', 'LOCATION')),
    CONSTRAINT chk_inventarios_theoretical_stocks_scope_location
        CHECK (
            (scope_level = 'WAREHOUSE' AND snapshot_location_id IS NULL)
            OR (scope_level = 'LOCATION' AND snapshot_location_id IS NOT NULL)
        ),
    CONSTRAINT chk_inventarios_theoretical_stocks_quantity
        CHECK (theoretical_quantity >= 0),
    CONSTRAINT fk_inventarios_theoretical_stocks_snapshot
        FOREIGN KEY (company_id, snapshot_id)
        REFERENCES inventarios.operational_snapshots(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_theoretical_stocks_product
        FOREIGN KEY (company_id, snapshot_id, snapshot_product_id)
        REFERENCES inventarios.snapshot_products(company_id, snapshot_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_theoretical_stocks_location
        FOREIGN KEY (company_id, snapshot_id, snapshot_location_id)
        REFERENCES inventarios.snapshot_locations(company_id, snapshot_id, id)
        ON DELETE RESTRICT
);

-- Un solo teorico WAREHOUSE por producto
CREATE UNIQUE INDEX uq_inventarios_theoretical_stocks_warehouse
    ON inventarios.snapshot_theoretical_stocks (company_id, snapshot_id, snapshot_product_id)
    WHERE scope_level = 'WAREHOUSE';

-- Un solo teorico LOCATION por producto y ubicacion
CREATE UNIQUE INDEX uq_inventarios_theoretical_stocks_location
    ON inventarios.snapshot_theoretical_stocks (company_id, snapshot_id, snapshot_product_id, snapshot_location_id)
    WHERE scope_level = 'LOCATION';

-- ============================================================
-- 2. COSTO UNITARIO CONGELADO POR SNAPSHOT
-- ============================================================
CREATE TABLE inventarios.snapshot_unit_costs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    snapshot_id uuid NOT NULL,
    snapshot_product_id uuid NOT NULL,
    unit_cost numeric(14,2),
    currency text NOT NULL DEFAULT 'CLP',
    source text NOT NULL,
    captured_at timestamptz NOT NULL,
    has_cost boolean NOT NULL DEFAULT false,
    valuation_status text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_unit_costs_company_id UNIQUE (company_id, id),
    CONSTRAINT uq_inventarios_unit_costs_snapshot_product UNIQUE (company_id, snapshot_id, snapshot_product_id),
    CONSTRAINT chk_inventarios_unit_costs_currency
        CHECK (currency = 'CLP'),
    CONSTRAINT chk_inventarios_unit_costs_source
        CHECK (source IN ('EXCEL_IMPORT', 'BSALE_SYNC')),
    CONSTRAINT chk_inventarios_unit_costs_valuation
        CHECK (valuation_status IN ('COMPLETE', 'INCOMPLETE_NO_COST')),
    CONSTRAINT chk_inventarios_unit_costs_has_cost
        CHECK (has_cost = (unit_cost IS NOT NULL AND unit_cost > 0)),
    CONSTRAINT chk_inventarios_unit_costs_cost_value
        CHECK (unit_cost IS NULL OR unit_cost >= 0),
    CONSTRAINT fk_inventarios_unit_costs_snapshot
        FOREIGN KEY (company_id, snapshot_id)
        REFERENCES inventarios.operational_snapshots(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_unit_costs_product
        FOREIGN KEY (company_id, snapshot_id, snapshot_product_id)
        REFERENCES inventarios.snapshot_products(company_id, snapshot_id, id)
        ON DELETE RESTRICT
);

-- ============================================================
-- 3. RESULTADO OFICIAL POR UBICACION
-- ============================================================
CREATE TABLE inventarios.official_version_location_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    official_version_id uuid NOT NULL,
    session_id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    snapshot_product_id uuid NOT NULL,
    snapshot_location_id uuid NOT NULL,
    theoretical_quantity numeric(14,3),
    physical_quantity numeric(14,3) NOT NULL,
    difference_quantity numeric(14,3),
    unit_cost numeric(14,2),
    difference_value numeric(14,2),
    currency text NOT NULL DEFAULT 'CLP',
    has_cost boolean NOT NULL DEFAULT false,
    valuation_status text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_ovli_company_id UNIQUE (company_id, id),
    CONSTRAINT uq_inventarios_ovli_version_location UNIQUE (company_id, official_version_id, snapshot_product_id, snapshot_location_id),
    CONSTRAINT chk_inventarios_ovli_currency
        CHECK (currency = 'CLP'),
    CONSTRAINT chk_inventarios_ovli_valuation
        CHECK (valuation_status IN ('COMPLETE', 'INCOMPLETE_NO_COST', 'NOT_APPLICABLE')),
    CONSTRAINT chk_inventarios_ovli_has_cost
        CHECK (has_cost = (unit_cost IS NOT NULL AND unit_cost > 0)),
    CONSTRAINT fk_inventarios_ovli_version
        FOREIGN KEY (company_id, official_version_id)
        REFERENCES inventarios.official_versions(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_ovli_product
        FOREIGN KEY (company_id, snapshot_id, snapshot_product_id)
        REFERENCES inventarios.snapshot_products(company_id, snapshot_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_ovli_location
        FOREIGN KEY (company_id, snapshot_id, snapshot_location_id)
        REFERENCES inventarios.snapshot_locations(company_id, snapshot_id, id)
        ON DELETE RESTRICT
);

CREATE INDEX idx_inventarios_ovli_version
    ON inventarios.official_version_location_items (company_id, official_version_id);
