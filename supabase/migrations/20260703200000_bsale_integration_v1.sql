-- ============================================================================
-- Migration: Bsale Integration v1
-- Schema: integraciones (nuevo)
-- Schema: adquisiciones (tablas nuevas)
-- Descripción: Espejo solo lectura de Bsale + tablas de análisis de reposición
--             + mapeo producto-proveedor + generación de OC desde sugerido
-- ============================================================================

-- ============================================================================
-- PARTE 1: SCHEMA integraciones
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS integraciones;

-- ============================================================================
-- 1.1 bsale_sync_runs — control de corridas de sincronización
-- ============================================================================
CREATE TABLE integraciones.bsale_sync_runs (
    id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id          uuid NOT NULL REFERENCES core.companies(id),
    status              varchar(20) DEFAULT 'STARTED' CHECK (status IN ('STARTED','COMPLETED','FAILED')),
    trigger             varchar(20) DEFAULT 'CRON' CHECK (trigger IN ('INITIAL','CRON','NIGHTLY','MANUAL')),
    date_from           date,
    date_to             date,
    started_at          timestamptz DEFAULT now(),
    completed_at        timestamptz,
    error_message       text,
    products_count      int,
    variants_count      int,
    stocks_count        int,
    documents_count     int,
    document_details_count int,
    costs_count         int
);

CREATE INDEX idx_sync_runs_company  ON integraciones.bsale_sync_runs(company_id);
CREATE INDEX idx_sync_runs_status   ON integraciones.bsale_sync_runs(status);
CREATE INDEX idx_sync_runs_started  ON integraciones.bsale_sync_runs(started_at DESC);

-- ============================================================================
-- 1.2 bsale_document_types
-- ============================================================================
CREATE TABLE integraciones.bsale_document_types (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id      uuid NOT NULL REFERENCES core.companies(id),
    bsale_id        int NOT NULL,
    name            text,
    state           int,
    raw_json        jsonb,
    bsale_sync_run_id uuid REFERENCES integraciones.bsale_sync_runs(id),
    synced_at       timestamptz DEFAULT now(),
    created_at      timestamptz DEFAULT now(),
    UNIQUE (company_id, bsale_id)
);

-- ============================================================================
-- 1.3 bsale_payment_types
-- ============================================================================
CREATE TABLE integraciones.bsale_payment_types (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id      uuid NOT NULL REFERENCES core.companies(id),
    bsale_id        int NOT NULL,
    name            text,
    raw_json        jsonb,
    bsale_sync_run_id uuid REFERENCES integraciones.bsale_sync_runs(id),
    synced_at       timestamptz DEFAULT now(),
    created_at      timestamptz DEFAULT now(),
    UNIQUE (company_id, bsale_id)
);

-- ============================================================================
-- 1.4 bsale_offices
-- ============================================================================
CREATE TABLE integraciones.bsale_offices (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id      uuid NOT NULL REFERENCES core.companies(id),
    bsale_id        int NOT NULL,
    name            text,
    city            text,
    municipality    text,
    state           int,
    raw_json        jsonb,
    bsale_sync_run_id uuid REFERENCES integraciones.bsale_sync_runs(id),
    synced_at       timestamptz DEFAULT now(),
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now(),
    UNIQUE (company_id, bsale_id)
);

-- ============================================================================
-- 1.5 bsale_clients
-- ============================================================================
CREATE TABLE integraciones.bsale_clients (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id      uuid NOT NULL REFERENCES core.companies(id),
    bsale_id        int NOT NULL,
    code            text,
    name            text,
    first_name      text,
    last_name       text,
    company         text,
    email           text,
    phone           text,
    city            text,
    municipality    text,
    state           int,
    raw_json        jsonb,
    bsale_sync_run_id uuid REFERENCES integraciones.bsale_sync_runs(id),
    synced_at       timestamptz DEFAULT now(),
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now(),
    UNIQUE (company_id, bsale_id)
);

-- ============================================================================
-- 1.6 bsale_products
-- ============================================================================
CREATE TABLE integraciones.bsale_products (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id      uuid NOT NULL REFERENCES core.companies(id),
    bsale_id        int NOT NULL,
    name            text,
    description     text,
    classification  int,
    stock_control   boolean,
    state           int,
    product_type_id int,
    raw_json        jsonb,
    bsale_sync_run_id uuid REFERENCES integraciones.bsale_sync_runs(id),
    synced_at       timestamptz DEFAULT now(),
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now(),
    UNIQUE (company_id, bsale_id)
);

-- ============================================================================
-- 1.7 bsale_variants (contiene SKU)
-- ============================================================================
CREATE TABLE integraciones.bsale_variants (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id      uuid NOT NULL REFERENCES core.companies(id),
    bsale_id        int NOT NULL,
    bsale_product_id int NOT NULL,
    code            text,                       -- SKU
    description     text,
    bar_code        text,
    state           int,
    unlimited_stock boolean,
    allow_negative_stock boolean,
    raw_json        jsonb,
    bsale_sync_run_id uuid REFERENCES integraciones.bsale_sync_runs(id),
    synced_at       timestamptz DEFAULT now(),
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now(),
    UNIQUE (company_id, bsale_id)
);

CREATE INDEX idx_bsale_var_code ON integraciones.bsale_variants(company_id, code);
CREATE INDEX idx_bsale_var_product ON integraciones.bsale_variants(bsale_product_id);

-- ============================================================================
-- 1.8 bsale_stock_current
-- ============================================================================
CREATE TABLE integraciones.bsale_stock_current (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id      uuid NOT NULL REFERENCES core.companies(id),
    bsale_id        int NOT NULL,
    variant_id      int NOT NULL,
    variant_code    text,
    quantity        numeric(14,3),
    quantity_reserved numeric(14,3),
    quantity_available numeric(14,3),
    office_id       int,
    raw_json        jsonb,
    bsale_sync_run_id uuid REFERENCES integraciones.bsale_sync_runs(id),
    synced_at       timestamptz DEFAULT now(),
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now(),
    UNIQUE (company_id, bsale_id)
);

CREATE INDEX idx_bsale_stock_var ON integraciones.bsale_stock_current(company_id, variant_code);

-- ============================================================================
-- 1.9 bsale_variant_costs
-- ============================================================================
CREATE TABLE integraciones.bsale_variant_costs (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id      uuid NOT NULL REFERENCES core.companies(id),
    variant_id      int NOT NULL,
    variant_code    text,
    average_cost    numeric(14,2),
    total_cost      numeric(14,2),
    cost_history    jsonb,
    raw_json        jsonb,
    bsale_sync_run_id uuid REFERENCES integraciones.bsale_sync_runs(id),
    synced_at       timestamptz DEFAULT now(),
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now(),
    UNIQUE (company_id, variant_id)
);

-- ============================================================================
-- 1.10 bsale_documents
-- ============================================================================
CREATE TABLE integraciones.bsale_documents (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id      uuid NOT NULL REFERENCES core.companies(id),
    bsale_id        int NOT NULL,
    number          int,
    emission_date   date,                           -- fecha comercial/tributaria
    generation_date timestamptz,                    -- timestamp real
    total_amount    numeric(14,2),
    net_amount      numeric(14,2),
    tax_amount      numeric(14,2),
    exempt_amount   numeric(14,2),
    document_type_id int,
    client_id       int,
    office_id       int,
    state           int,
    tracking_number text,
    url_pdf         text,
    raw_json        jsonb,
    bsale_sync_run_id uuid REFERENCES integraciones.bsale_sync_runs(id),
    synced_at       timestamptz DEFAULT now(),
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now(),
    UNIQUE (company_id, bsale_id)
);

CREATE INDEX idx_bsale_docs_emission ON integraciones.bsale_documents(company_id, emission_date);
CREATE INDEX idx_bsale_docs_type     ON integraciones.bsale_documents(document_type_id);

-- ============================================================================
-- 1.11 bsale_document_details
-- ============================================================================
CREATE TABLE integraciones.bsale_document_details (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id      uuid NOT NULL REFERENCES core.companies(id),
    bsale_id        int NOT NULL,
    bsale_document_id int NOT NULL,
    line_number     int,
    quantity        numeric(14,3),
    net_unit_value  numeric(14,2),
    total_unit_value numeric(14,2),
    net_amount      numeric(14,2),
    tax_amount      numeric(14,2),
    total_amount    numeric(14,2),
    net_discount    numeric(14,2),
    variant_id      int,
    variant_code    text,
    variant_description text,
    raw_json        jsonb,
    bsale_sync_run_id uuid REFERENCES integraciones.bsale_sync_runs(id),
    synced_at       timestamptz DEFAULT now(),
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now(),
    UNIQUE (company_id, bsale_id)
);

CREATE INDEX idx_bsale_detail_doc ON integraciones.bsale_document_details(company_id, bsale_document_id);
CREATE INDEX idx_bsale_detail_var ON integraciones.bsale_document_details(company_id, variant_code);

-- ============================================================================
-- 1.12 bsale_payments
-- ============================================================================
CREATE TABLE integraciones.bsale_payments (
    id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id          uuid NOT NULL REFERENCES core.companies(id),
    bsale_id            int NOT NULL,
    bsale_document_id   int,                       -- nullable (algunos pagos no tienen documento directo)
    amount              numeric(14,2),
    payment_date        timestamptz,
    record_date         date,
    payment_type_id     int,
    payment_type_name   text,
    is_credit_payment   boolean DEFAULT false,
    raw_json            jsonb,
    bsale_sync_run_id   uuid REFERENCES integraciones.bsale_sync_runs(id),
    synced_at           timestamptz DEFAULT now(),
    created_at          timestamptz DEFAULT now(),
    updated_at          timestamptz DEFAULT now(),
    UNIQUE (company_id, bsale_id)
);

CREATE INDEX idx_bsale_payments_doc ON integraciones.bsale_payments(company_id, bsale_document_id);

-- ============================================================================
-- 1.13 bsale_document_references
-- ============================================================================
CREATE TABLE integraciones.bsale_document_references (
    id                      uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id              uuid NOT NULL REFERENCES core.companies(id),
    bsale_id                int NOT NULL,
    bsale_document_id       int NOT NULL,
    reference_document_id   int,
    reference_document_number text,
    reference_date          date,
    reference_document_type_id int,
    dte_code                text,
    reason                  text,
    raw_json                jsonb,
    bsale_sync_run_id       uuid REFERENCES integraciones.bsale_sync_runs(id),
    synced_at               timestamptz DEFAULT now(),
    created_at              timestamptz DEFAULT now(),
    updated_at              timestamptz DEFAULT now(),
    UNIQUE (company_id, bsale_id)
);

CREATE INDEX idx_bsale_refs_doc ON integraciones.bsale_document_references(company_id, bsale_document_id);

-- ============================================================================
-- 1.14 bsale_receptions
-- ============================================================================
CREATE TABLE integraciones.bsale_receptions (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id      uuid NOT NULL REFERENCES core.companies(id),
    bsale_id        int NOT NULL,
    admission_date  timestamptz,
    raw_admission_date text,
    document        text,
    document_number text,
    note            text,
    office_id       int,
    raw_json        jsonb,
    bsale_sync_run_id uuid REFERENCES integraciones.bsale_sync_runs(id),
    synced_at       timestamptz DEFAULT now(),
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now(),
    UNIQUE (company_id, bsale_id)
);

-- ============================================================================
-- 1.15 bsale_reception_details
-- ============================================================================
CREATE TABLE integraciones.bsale_reception_details (
    id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id          uuid NOT NULL REFERENCES core.companies(id),
    bsale_id            int NOT NULL,
    bsale_reception_id  int NOT NULL,
    quantity            numeric(14,3),
    cost                numeric(14,2),
    variant_stock       numeric(14,3),
    variant_id          int,
    variant_code        text,
    raw_json            jsonb,
    bsale_sync_run_id   uuid REFERENCES integraciones.bsale_sync_runs(id),
    synced_at           timestamptz DEFAULT now(),
    created_at          timestamptz DEFAULT now(),
    updated_at          timestamptz DEFAULT now(),
    UNIQUE (company_id, bsale_id)
);

-- ============================================================================
-- PARTE 2: TABLAS NUEVAS EN adquisiciones
-- ============================================================================

-- ============================================================================
-- 2.1 product_supplier_mappings
-- ============================================================================
CREATE TABLE adquisiciones.product_supplier_mappings (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id      uuid NOT NULL REFERENCES core.companies(id),
    product_id      uuid REFERENCES adquisiciones.products(id) ON DELETE SET NULL,
    supplier_id     uuid NOT NULL REFERENCES adquisiciones.suppliers(id),
    bsale_variant_id int,
    sku             text NOT NULL,
    product_name    text,
    unit_cost       numeric(14,2),
    is_preferred    boolean DEFAULT false,
    is_active       boolean DEFAULT true,
    synced_at       timestamptz,
    created_by      uuid,
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now(),
    updated_by      uuid,

    UNIQUE (company_id, supplier_id, sku)
);

CREATE INDEX idx_psm_company_sku   ON adquisiciones.product_supplier_mappings(company_id, sku);
CREATE INDEX idx_psm_supplier      ON adquisiciones.product_supplier_mappings(supplier_id);
CREATE INDEX idx_psm_product       ON adquisiciones.product_supplier_mappings(product_id);
CREATE INDEX idx_psm_active        ON adquisiciones.product_supplier_mappings(company_id, is_active);

-- Un solo proveedor preferido activo por company_id + sku
CREATE UNIQUE INDEX uq_psm_preferred_sku
    ON adquisiciones.product_supplier_mappings(company_id, sku)
    WHERE is_preferred = true AND is_active = true;

-- ============================================================================
-- 2.2 purchase_replenishment_analyses
-- ============================================================================
CREATE TABLE adquisiciones.purchase_replenishment_analyses (
    id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id        uuid NOT NULL REFERENCES core.companies(id),
    name              text,
    status            varchar(30) DEFAULT 'BORRADOR'
        CHECK (status IN ('BORRADOR','PARCIALMENTE_ORDENADO','ORDENADO','DESCARTADO')),

    period_days       int NOT NULL DEFAULT 180,
    coverage_weeks    int NOT NULL DEFAULT 4,
    min_sales_filter  numeric(12,0) DEFAULT 50000,

    total_skus        int DEFAULT 0,
    total_with_supplier int DEFAULT 0,
    total_without_supplier int DEFAULT 0,
    total_without_product  int DEFAULT 0,
    total_to_order    int DEFAULT 0,
    total_units       numeric(14,3) DEFAULT 0,
    total_cost        numeric(14,2) DEFAULT 0,

    bsale_sync_run_id uuid REFERENCES integraciones.bsale_sync_runs(id),
    bsale_synced_at   timestamptz,
    sales_date_from   date,
    sales_date_to     date,
    sales_docs_count  int,
    stock_snapshotted_at timestamptz,

    created_by        uuid NOT NULL,
    created_at        timestamptz DEFAULT now(),
    updated_at        timestamptz DEFAULT now(),

    UNIQUE (id, company_id)
);

CREATE INDEX idx_analysis_company  ON adquisiciones.purchase_replenishment_analyses(company_id);
CREATE INDEX idx_analysis_status   ON adquisiciones.purchase_replenishment_analyses(status);
CREATE INDEX idx_analysis_created  ON adquisiciones.purchase_replenishment_analyses(created_at DESC);
CREATE INDEX idx_analysis_bsale_run ON adquisiciones.purchase_replenishment_analyses(bsale_sync_run_id);

-- ============================================================================
-- 2.3 purchase_replenishment_analysis_items
-- ============================================================================
CREATE TABLE adquisiciones.purchase_replenishment_analysis_items (
    analysis_id         uuid NOT NULL,
    id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id          uuid NOT NULL REFERENCES core.companies(id),

    product_supplier_mapping_id uuid REFERENCES adquisiciones.product_supplier_mappings(id),
    product_id          uuid REFERENCES adquisiciones.products(id),
    supplier_id         uuid REFERENCES adquisiciones.suppliers(id),
    sku                 text NOT NULL,
    product_name        text NOT NULL,
    variant_desc        text,

    FOREIGN KEY (analysis_id, company_id)
        REFERENCES adquisiciones.purchase_replenishment_analyses(id, company_id)
        ON DELETE CASCADE,

    current_stock       numeric(14,3) DEFAULT 0,
    weekly_avg_sales    numeric(14,3) DEFAULT 0,
    days_coverage       numeric(8,1),
    sales_last_period   numeric(14,2) DEFAULT 0,
    alert_type          varchar(40),
    priority            varchar(20),

    suggested_quantity  numeric(14,3) DEFAULT 0,
    unit_cost           numeric(14,2) DEFAULT 0,
    total_cost          numeric(14,2) DEFAULT 0,

    selected            boolean DEFAULT true,
    ordered_quantity    numeric(14,3) DEFAULT 0,
    purchase_order_id   uuid REFERENCES adquisiciones.purchase_orders(id),
    ordered_at          timestamptz,

    pending_receipt_qty numeric(14,3) DEFAULT 0,

    notes               text,

    UNIQUE (analysis_id, sku)
);

CREATE INDEX idx_replenishment_items_company          ON adquisiciones.purchase_replenishment_analysis_items(company_id);
CREATE INDEX idx_replenishment_items_analysis_company ON adquisiciones.purchase_replenishment_analysis_items(analysis_id, company_id);
CREATE INDEX idx_items_analysis                       ON adquisiciones.purchase_replenishment_analysis_items(analysis_id);
CREATE INDEX idx_items_selected                       ON adquisiciones.purchase_replenishment_analysis_items(analysis_id, selected);
CREATE INDEX idx_items_supplier                       ON adquisiciones.purchase_replenishment_analysis_items(analysis_id, supplier_id);
CREATE INDEX idx_items_ordered                        ON adquisiciones.purchase_replenishment_analysis_items(purchase_order_id);
CREATE INDEX idx_items_sku                            ON adquisiciones.purchase_replenishment_analysis_items(sku);

-- ============================================================================
-- 2.4 purchase_replenishment_analysis_orders
-- ============================================================================
CREATE TABLE adquisiciones.purchase_replenishment_analysis_orders (
    id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    analysis_id       uuid NOT NULL,
    company_id        uuid NOT NULL REFERENCES core.companies(id),
    supplier_id       uuid NOT NULL REFERENCES adquisiciones.suppliers(id),
    purchase_order_id uuid NOT NULL REFERENCES adquisiciones.purchase_orders(id),

    FOREIGN KEY (analysis_id, company_id)
        REFERENCES adquisiciones.purchase_replenishment_analyses(id, company_id)
        ON DELETE CASCADE,

    item_count        int DEFAULT 0,
    total_units       numeric(14,3) DEFAULT 0,
    total_cost        numeric(14,2) DEFAULT 0,

    created_by        uuid NOT NULL,
    created_at        timestamptz DEFAULT now(),

    UNIQUE (purchase_order_id),
    UNIQUE (analysis_id, supplier_id)
);

CREATE INDEX idx_replenishment_orders_company          ON adquisiciones.purchase_replenishment_analysis_orders(company_id);
CREATE INDEX idx_replenishment_orders_analysis_company ON adquisiciones.purchase_replenishment_analysis_orders(analysis_id, company_id);
CREATE INDEX idx_orders_analysis                       ON adquisiciones.purchase_replenishment_analysis_orders(analysis_id);
CREATE INDEX idx_orders_supplier                       ON adquisiciones.purchase_replenishment_analysis_orders(analysis_id, supplier_id);

-- ============================================================================
-- PARTE 3: RLS — SCHEMA integraciones (solo lectura)
-- ============================================================================

ALTER TABLE integraciones.bsale_sync_runs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_document_types      ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_payment_types       ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_offices             ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_clients             ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_products            ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_variants            ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_stock_current       ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_variant_costs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_documents           ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_document_details    ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_payments            ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_document_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_receptions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_reception_details   ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    tbl text;
BEGIN
    FOR tbl IN
        SELECT unnest(ARRAY[
            'bsale_sync_runs', 'bsale_document_types', 'bsale_payment_types',
            'bsale_offices', 'bsale_clients', 'bsale_products', 'bsale_variants',
            'bsale_stock_current', 'bsale_variant_costs', 'bsale_documents',
            'bsale_document_details', 'bsale_payments', 'bsale_document_references',
            'bsale_receptions', 'bsale_reception_details'
        ])
    LOOP
        EXECUTE format(
            'CREATE POLICY rls_%s_select ON integraciones.%I FOR SELECT TO authenticated
             USING (core.has_company_access(auth.uid(), company_id))',
            tbl, tbl
        );
    END LOOP;
END $$;

-- ============================================================================
-- PARTE 4: RLS — adquisiciones (tablas nuevas)
-- ============================================================================

ALTER TABLE adquisiciones.product_supplier_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_psm_select ON adquisiciones.product_supplier_mappings
    FOR SELECT TO authenticated
    USING (portal.has_permission('system.admin') OR (
        portal.has_permission('module.adquisiciones.view')
        AND core.has_company_access(auth.uid(), company_id)
    ));

CREATE POLICY rls_psm_insert ON adquisiciones.product_supplier_mappings
    FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin') OR (
        portal.has_permission('adquisiciones.po.create')
        AND core.has_company_access(auth.uid(), company_id)
    ));

CREATE POLICY rls_psm_update ON adquisiciones.product_supplier_mappings
    FOR UPDATE TO authenticated
    USING (portal.has_permission('system.admin') OR (
        portal.has_permission('adquisiciones.po.create')
        AND core.has_company_access(auth.uid(), company_id)
    ))
    WITH CHECK (portal.has_permission('system.admin') OR (
        portal.has_permission('adquisiciones.po.create')
        AND core.has_company_access(auth.uid(), company_id)
    ));

-- Analyses
ALTER TABLE adquisiciones.purchase_replenishment_analyses ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_analysis_select ON adquisiciones.purchase_replenishment_analyses
    FOR SELECT TO authenticated
    USING (portal.has_permission('system.admin') OR (
        portal.has_permission('module.adquisiciones.view')
        AND core.has_company_access(auth.uid(), company_id)
    ));

CREATE POLICY rls_analysis_insert ON adquisiciones.purchase_replenishment_analyses
    FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin') OR (
        portal.has_permission('adquisiciones.po.create')
        AND core.has_company_access(auth.uid(), company_id)
    ));

CREATE POLICY rls_analysis_update ON adquisiciones.purchase_replenishment_analyses
    FOR UPDATE TO authenticated
    USING (portal.has_permission('system.admin') OR (
        created_by = auth.uid()
        AND portal.has_permission('adquisiciones.po.create')
        AND core.has_company_access(auth.uid(), company_id)
    ))
    WITH CHECK (portal.has_permission('system.admin') OR (
        created_by = auth.uid()
        AND portal.has_permission('adquisiciones.po.create')
        AND core.has_company_access(auth.uid(), company_id)
    ));

-- Analysis items
ALTER TABLE adquisiciones.purchase_replenishment_analysis_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_items_select ON adquisiciones.purchase_replenishment_analysis_items
    FOR SELECT TO authenticated
    USING (portal.has_permission('system.admin') OR (
        portal.has_permission('module.adquisiciones.view')
        AND core.has_company_access(auth.uid(), company_id)
    ));

CREATE POLICY rls_items_insert ON adquisiciones.purchase_replenishment_analysis_items
    FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin') OR (
        portal.has_permission('adquisiciones.po.create')
        AND core.has_company_access(auth.uid(), company_id)
    ));

CREATE POLICY rls_items_update ON adquisiciones.purchase_replenishment_analysis_items
    FOR UPDATE TO authenticated
    USING (portal.has_permission('system.admin') OR (
        portal.has_permission('adquisiciones.po.create')
        AND core.has_company_access(auth.uid(), company_id)
    ))
    WITH CHECK (portal.has_permission('system.admin') OR (
        portal.has_permission('adquisiciones.po.create')
        AND core.has_company_access(auth.uid(), company_id)
    ));

-- Analysis orders
ALTER TABLE adquisiciones.purchase_replenishment_analysis_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_orders_select ON adquisiciones.purchase_replenishment_analysis_orders
    FOR SELECT TO authenticated
    USING (portal.has_permission('system.admin') OR (
        portal.has_permission('module.adquisiciones.view')
        AND core.has_company_access(auth.uid(), company_id)
    ));

CREATE POLICY rls_orders_insert ON adquisiciones.purchase_replenishment_analysis_orders
    FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin') OR (
        portal.has_permission('adquisiciones.po.create')
        AND core.has_company_access(auth.uid(), company_id)
    ));

-- ============================================================================
-- PARTE 5: GRANTS
-- ============================================================================

GRANT USAGE ON SCHEMA integraciones TO authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA integraciones TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA integraciones TO authenticated;

GRANT ALL ON adquisiciones.product_supplier_mappings TO service_role;
GRANT SELECT, INSERT, UPDATE ON adquisiciones.product_supplier_mappings TO authenticated;

GRANT ALL ON adquisiciones.purchase_replenishment_analyses TO service_role;
GRANT SELECT, INSERT, UPDATE ON adquisiciones.purchase_replenishment_analyses TO authenticated;

GRANT ALL ON adquisiciones.purchase_replenishment_analysis_items TO service_role;
GRANT SELECT, INSERT, UPDATE ON adquisiciones.purchase_replenishment_analysis_items TO authenticated;

GRANT ALL ON adquisiciones.purchase_replenishment_analysis_orders TO service_role;
GRANT SELECT, INSERT ON adquisiciones.purchase_replenishment_analysis_orders TO authenticated;
