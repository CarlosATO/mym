-- Migration: 20260804110010_inventarios_campaign_snapshot_tables.sql
-- Description: Fase 4I.3C.1. Tablas base del snapshot maestro por campana:
--              inventory_campaign_snapshots, inventory_campaign_snapshot_products,
--              inventory_campaign_theoretical_stocks y
--              inventory_campaign_snapshot_unit_costs. Solo modelo fisico;
--              la poblacion llega en 4I.3C.5.
-- Author: Assistant

-- ============================================================
-- 1. SNAPSHOT MAESTRO POR CAMPANA (a lo sumo uno por campana)
-- ============================================================
CREATE TABLE inventarios.inventory_campaign_snapshots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    campaign_id uuid NOT NULL,
    stock_import_id uuid,
    theoretical_scope text NOT NULL,
    completion_status text NOT NULL DEFAULT 'PENDING',
    content_hash char(64),
    captured_at timestamptz,
    captured_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_campaign_snapshots_company_id UNIQUE (company_id, id),
    CONSTRAINT uq_inventarios_campaign_snapshots_campaign UNIQUE (company_id, campaign_id),
    CONSTRAINT chk_inventarios_campaign_snapshots_scope
        CHECK (theoretical_scope IN ('TOTAL_CAMPAIGN', 'BY_SITE', 'BY_LOCATION')),
    CONSTRAINT chk_inventarios_campaign_snapshots_status
        CHECK (completion_status IN ('PENDING', 'COMPLETED')),
    CONSTRAINT fk_inventarios_campaign_snapshots_campaign
        FOREIGN KEY (company_id, campaign_id)
        REFERENCES inventarios.inventory_campaigns(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_campaign_snapshots_import
        FOREIGN KEY (company_id, stock_import_id)
        REFERENCES inventarios.stock_imports(company_id, id)
        ON DELETE RESTRICT
);

-- ============================================================
-- 2. PRODUCTOS CONGELADOS DEL MAESTRO
-- ============================================================
CREATE TABLE inventarios.inventory_campaign_snapshot_products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    campaign_snapshot_id uuid NOT NULL,
    product_id uuid REFERENCES adquisiciones.products(id) ON DELETE RESTRICT,
    bsale_variant_id integer,
    sku text NOT NULL,
    barcode text,
    name text NOT NULL,
    product_metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_campaign_snapshot_products_company_id UNIQUE (company_id, id),
    CONSTRAINT uq_inventarios_campaign_snapshot_products_company_snapshot_id UNIQUE (company_id, campaign_snapshot_id, id),
    CONSTRAINT uq_inventarios_campaign_snapshot_products_product UNIQUE (company_id, campaign_snapshot_id, product_id),
    CONSTRAINT fk_inventarios_campaign_snapshot_products_snapshot
        FOREIGN KEY (company_id, campaign_snapshot_id)
        REFERENCES inventarios.inventory_campaign_snapshots(company_id, id)
        ON DELETE RESTRICT
);

-- ============================================================
-- 3. TEORICO CONGELADO POR ALCANCE
-- ============================================================
CREATE TABLE inventarios.inventory_campaign_theoretical_stocks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    campaign_snapshot_id uuid NOT NULL,
    snapshot_product_id uuid NOT NULL,
    scope_level text NOT NULL,
    inventory_site_id uuid,
    inventory_site_location_id uuid,
    theoretical_quantity numeric(14,3) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_campaign_theoretical_stocks_company_id UNIQUE (company_id, id),
    CONSTRAINT chk_inventarios_campaign_theoretical_scope
        CHECK (scope_level IN ('TOTAL_CAMPAIGN', 'BY_SITE', 'BY_LOCATION')),
    CONSTRAINT chk_inventarios_campaign_theoretical_target
        CHECK (
            (scope_level = 'TOTAL_CAMPAIGN' AND inventory_site_id IS NULL AND inventory_site_location_id IS NULL)
            OR (scope_level = 'BY_SITE' AND inventory_site_id IS NOT NULL AND inventory_site_location_id IS NULL)
            OR (scope_level = 'BY_LOCATION' AND inventory_site_id IS NOT NULL AND inventory_site_location_id IS NOT NULL)
        ),
    CONSTRAINT chk_inventarios_campaign_theoretical_quantity
        CHECK (theoretical_quantity >= 0),
    CONSTRAINT fk_inventarios_campaign_theoretical_snapshot
        FOREIGN KEY (company_id, campaign_snapshot_id)
        REFERENCES inventarios.inventory_campaign_snapshots(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_campaign_theoretical_product
        FOREIGN KEY (company_id, campaign_snapshot_id, snapshot_product_id)
        REFERENCES inventarios.inventory_campaign_snapshot_products(company_id, campaign_snapshot_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_campaign_theoretical_site
        FOREIGN KEY (company_id, inventory_site_id)
        REFERENCES inventarios.inventory_sites(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_campaign_theoretical_location
        FOREIGN KEY (company_id, inventory_site_id, inventory_site_location_id)
        REFERENCES inventarios.inventory_site_locations(company_id, inventory_site_id, id)
        ON DELETE RESTRICT
);

-- Un solo teorico TOTAL_CAMPAIGN por producto
CREATE UNIQUE INDEX uq_inventarios_campaign_theoretical_total
    ON inventarios.inventory_campaign_theoretical_stocks (company_id, campaign_snapshot_id, snapshot_product_id)
    WHERE scope_level = 'TOTAL_CAMPAIGN';

-- Un solo teorico BY_SITE por producto y unidad
CREATE UNIQUE INDEX uq_inventarios_campaign_theoretical_site
    ON inventarios.inventory_campaign_theoretical_stocks (company_id, campaign_snapshot_id, snapshot_product_id, inventory_site_id)
    WHERE scope_level = 'BY_SITE';

-- Un solo teorico BY_LOCATION por producto y ubicacion
CREATE UNIQUE INDEX uq_inventarios_campaign_theoretical_location
    ON inventarios.inventory_campaign_theoretical_stocks (company_id, campaign_snapshot_id, snapshot_product_id, inventory_site_location_id)
    WHERE scope_level = 'BY_LOCATION';

-- ============================================================
-- 4. COSTO UNITARIO CONGELADO DEL MAESTRO
-- ============================================================
CREATE TABLE inventarios.inventory_campaign_snapshot_unit_costs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    campaign_snapshot_id uuid NOT NULL,
    snapshot_product_id uuid NOT NULL,
    unit_cost numeric(14,2),
    currency text NOT NULL DEFAULT 'CLP',
    source text NOT NULL,
    captured_at timestamptz NOT NULL,
    has_cost boolean NOT NULL DEFAULT false,
    valuation_status text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_campaign_unit_costs_company_id UNIQUE (company_id, id),
    CONSTRAINT uq_inventarios_campaign_unit_costs_snapshot_product UNIQUE (company_id, campaign_snapshot_id, snapshot_product_id),
    CONSTRAINT chk_inventarios_campaign_unit_costs_currency
        CHECK (currency = 'CLP'),
    CONSTRAINT chk_inventarios_campaign_unit_costs_source
        CHECK (source IN ('EXCEL_IMPORT', 'BSALE_SYNC')),
    CONSTRAINT chk_inventarios_campaign_unit_costs_valuation
        CHECK (valuation_status IN ('COMPLETE', 'INCOMPLETE_NO_COST')),
    CONSTRAINT chk_inventarios_campaign_unit_costs_has_cost
        CHECK (has_cost = (unit_cost IS NOT NULL AND unit_cost > 0)),
    CONSTRAINT chk_inventarios_campaign_unit_costs_cost_value
        CHECK (unit_cost IS NULL OR unit_cost >= 0),
    CONSTRAINT fk_inventarios_campaign_unit_costs_snapshot
        FOREIGN KEY (company_id, campaign_snapshot_id)
        REFERENCES inventarios.inventory_campaign_snapshots(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_campaign_unit_costs_product
        FOREIGN KEY (company_id, campaign_snapshot_id, snapshot_product_id)
        REFERENCES inventarios.inventory_campaign_snapshot_products(company_id, campaign_snapshot_id, id)
        ON DELETE RESTRICT
);

-- ============================================================
-- 5. SEGURIDAD: patron de Inventarios. RLS habilitado sin politicas
--    (acceso directo bloqueado para clientes; acceso solo via RPC
--    SECURITY DEFINER) y service_role con acceso de backend.
-- ============================================================
ALTER TABLE inventarios.inventory_campaign_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventarios.inventory_campaign_snapshot_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventarios.inventory_campaign_theoretical_stocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventarios.inventory_campaign_snapshot_unit_costs ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE inventarios.inventory_campaign_snapshots TO service_role;
GRANT ALL ON TABLE inventarios.inventory_campaign_snapshot_products TO service_role;
GRANT ALL ON TABLE inventarios.inventory_campaign_theoretical_stocks TO service_role;
GRANT ALL ON TABLE inventarios.inventory_campaign_snapshot_unit_costs TO service_role;
