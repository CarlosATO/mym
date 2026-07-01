-- MIGRATION: 20260630070000_sales_analysis_reports.sql
-- Creación de tablas para reportes de Análisis de Ventas y Sugerencias de Compras

CREATE TABLE IF NOT EXISTS adquisiciones.sales_analysis_reports (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL REFERENCES auth.users(id),
    date_from date,
    date_to date,
    total_sales numeric(15,2) DEFAULT 0,
    total_stock_value numeric(15,2) DEFAULT 0,
    target_coverage_weeks integer DEFAULT 4
);

CREATE TABLE IF NOT EXISTS adquisiciones.sales_analysis_items (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    report_id uuid NOT NULL REFERENCES adquisiciones.sales_analysis_reports(id) ON DELETE CASCADE,
    sku text NOT NULL,
    product_name text,
    variant text,
    supplier text,
    category text,
    brand text,
    current_stock integer DEFAULT 0,
    unit_cost numeric(15,2) DEFAULT 0,
    total_units_sold integer DEFAULT 0,
    weekly_average_sales numeric(15,2) DEFAULT 0,
    suggested_quantity integer DEFAULT 0,
    status text DEFAULT 'PENDING' -- PENDING, APPROVED, EXCLUDED
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_sales_analysis_reports_company_id ON adquisiciones.sales_analysis_reports(company_id);
CREATE INDEX IF NOT EXISTS idx_sales_analysis_items_report_id ON adquisiciones.sales_analysis_items(report_id);

-- RLS
ALTER TABLE adquisiciones.sales_analysis_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE adquisiciones.sales_analysis_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view sales reports in their companies"
    ON adquisiciones.sales_analysis_reports
    FOR SELECT
    USING (core.has_company_access(auth.uid(), company_id));

CREATE POLICY "Users can create sales reports in their companies"
    ON adquisiciones.sales_analysis_reports
    FOR INSERT
    WITH CHECK (core.has_company_access(auth.uid(), company_id));

CREATE POLICY "Users can view sales report items in their companies"
    ON adquisiciones.sales_analysis_items
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM adquisiciones.sales_analysis_reports r
            WHERE r.id = report_id AND core.has_company_access(auth.uid(), r.company_id)
        )
    );

CREATE POLICY "Users can insert sales report items in their companies"
    ON adquisiciones.sales_analysis_items
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM adquisiciones.sales_analysis_reports r
            WHERE r.id = report_id AND core.has_company_access(auth.uid(), r.company_id)
        )
    );

CREATE POLICY "Users can update sales report items in their companies"
    ON adquisiciones.sales_analysis_items
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM adquisiciones.sales_analysis_reports r
            WHERE r.id = report_id AND core.has_company_access(auth.uid(), r.company_id)
        )
    );
