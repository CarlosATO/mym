-- supabase/migrations/20260717000009_client_commercial_model_phase_3a.sql
-- ============================================================================
-- Fase 3A — Modelo Comercial PetGrup: tablas, vistas, función refresh
-- Reglas certificadas MYM:
--   type_id 5 = Factura Electrónica = venta oficial
--   type_id 23 = Nota Venta = pedido operativo
--   type_id 2 = Nota Crédito = reversa/corrección
--   type_id 7 = Guía Despacho = logística
--   type_id 1 = Boleta Electrónica T = anomalía
-- ============================================================================

-- ============================================================================
-- 1. SCHEMA
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS comercial;

GRANT USAGE ON SCHEMA comercial TO authenticated;
GRANT USAGE ON SCHEMA comercial TO service_role;
GRANT USAGE ON SCHEMA comercial TO anon;

-- ============================================================================
-- 2. TABLAS
-- ============================================================================

-- 2A. client_metrics_snapshot: cache de métricas calculadas por cliente
CREATE TABLE IF NOT EXISTS comercial.client_metrics_snapshot (
    company_id              uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    bsale_client_id         bigint NOT NULL,

    status                  text NOT NULL,
    quality_score           integer NOT NULL DEFAULT 0,

    first_invoice_date      date,
    last_invoice_date       date,
    days_since_last_invoice integer,

    official_sales_30d      numeric(14,2) NOT NULL DEFAULT 0,
    official_sales_60d      numeric(14,2) NOT NULL DEFAULT 0,
    official_sales_90d      numeric(14,2) NOT NULL DEFAULT 0,
    official_sales_180d     numeric(14,2) NOT NULL DEFAULT 0,
    official_sales_365d     numeric(14,2) NOT NULL DEFAULT 0,
    official_sales_total    numeric(14,2) NOT NULL DEFAULT 0,
    official_invoice_docs_30d   integer NOT NULL DEFAULT 0,
    official_invoice_docs_90d   integer NOT NULL DEFAULT 0,
    official_invoice_docs_total integer NOT NULL DEFAULT 0,

    credit_note_amount_90d  numeric(14,2) NOT NULL DEFAULT 0,
    credit_note_amount_total numeric(14,2) NOT NULL DEFAULT 0,
    credit_note_count_90d   integer NOT NULL DEFAULT 0,
    credit_note_count_total integer NOT NULL DEFAULT 0,

    sales_order_amount_30d  numeric(14,2) NOT NULL DEFAULT 0,
    sales_order_amount_90d  numeric(14,2) NOT NULL DEFAULT 0,
    sales_order_count_30d   integer NOT NULL DEFAULT 0,
    sales_order_count_90d   integer NOT NULL DEFAULT 0,
    last_sales_order_date   date,

    avg_ticket_gross_90d    numeric(14,2),
    avg_ticket_gross_total  numeric(14,2),

    last_seller_id          bigint,
    last_seller_name        text,
    main_seller_id          bigint,
    main_seller_name        text,

    commune                 text,
    city                    text,
    has_email               boolean NOT NULL DEFAULT false,
    has_phone               boolean NOT NULL DEFAULT false,
    has_address             boolean NOT NULL DEFAULT false,
    has_possible_sibling    boolean NOT NULL DEFAULT false,
    has_anomalous_receipt   boolean NOT NULL DEFAULT false,

    calculated_at           timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (company_id, bsale_client_id)
);

-- 2B. commercial_groups: agrupación de cuentas hermanas
CREATE TABLE IF NOT EXISTS comercial.commercial_groups (
    id                      uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id              uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    group_name              text NOT NULL,
    group_code              text,
    status                  text NOT NULL DEFAULT 'ACTIVE',
    primary_bsale_client_id bigint,
    notes                   text,
    created_by              uuid REFERENCES portal.users(id),
    updated_by              uuid REFERENCES portal.users(id),
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_commercial_groups_name UNIQUE (company_id, group_name),
    CONSTRAINT uq_commercial_groups_company_id UNIQUE (company_id, id),
    CONSTRAINT chk_group_status CHECK (status IN ('ACTIVE', 'INACTIVE', 'MERGED'))
);

-- 2C. commercial_group_members: relación grupo ↔ cliente
CREATE TABLE IF NOT EXISTS comercial.commercial_group_members (
    id                      uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id              uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    group_id                uuid NOT NULL,
    bsale_client_id         bigint NOT NULL,
    relationship_type       text NOT NULL,
    confidence_level        text NOT NULL DEFAULT 'MANUAL',
    source                  text NOT NULL DEFAULT 'MANUAL',
    is_primary              boolean NOT NULL DEFAULT false,
    valid_from              date NOT NULL DEFAULT current_date,
    valid_to                date,
    approved_by             uuid REFERENCES portal.users(id),
    approved_at             timestamptz,
    notes                   text,
    created_at              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_group_member UNIQUE (company_id, group_id, bsale_client_id),
    CONSTRAINT fk_group_member_company_group FOREIGN KEY (company_id, group_id)
        REFERENCES comercial.commercial_groups(company_id, id) ON DELETE CASCADE,
    CONSTRAINT chk_relationship_type CHECK (relationship_type IN (
        'MISMO_RUT', 'MISMO_TELEFONO', 'MISMO_EMAIL', 'MISMA_DIRECCION',
        'MISMO_DUENO', 'MISMA_CADENA', 'MISMA_ADMINISTRACION',
        'RELACION_MANUAL', 'OTRO'
    )),
    CONSTRAINT chk_confidence_level CHECK (confidence_level IN (
        'ALTA', 'MEDIA', 'BAJA', 'REQUIERE_REVISION', 'MANUAL'
    )),
    CONSTRAINT chk_source CHECK (source IN (
        'AUTOMATIC', 'MANUAL', 'SUGGESTION', 'BSALE'
    ))
);

-- 2D. client_relationship_suggestions: sugerencias no aprobadas
CREATE TABLE IF NOT EXISTS comercial.client_relationship_suggestions (
    id                      uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id              uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    client_a_id             bigint NOT NULL,
    client_b_id             bigint NOT NULL,
    suggestion_type         text NOT NULL,
    confidence_score        numeric(5,2) NOT NULL DEFAULT 0,
    evidence_json           jsonb NOT NULL DEFAULT '{}'::jsonb,
    status                  text NOT NULL DEFAULT 'PENDING',
    reviewed_by             uuid REFERENCES portal.users(id),
    reviewed_at             timestamptz,
    review_notes            text,
    created_at              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_suggestion UNIQUE (company_id, client_a_id, client_b_id, suggestion_type),
    CONSTRAINT chk_suggestion_type CHECK (suggestion_type IN (
        'MISMO_RUT', 'MISMO_TELEFONO', 'MISMO_EMAIL', 'MISMA_DIRECCION',
        'MISMO_DUENO', 'MISMA_CADENA', 'MISMA_ADMINISTRACION', 'OTRO'
    )),
    CONSTRAINT chk_suggestion_status CHECK (status IN (
        'PENDING', 'APPROVED', 'REJECTED', 'DISMISSED'
    )),
    CONSTRAINT chk_client_order CHECK (client_a_id < client_b_id)
);

-- ============================================================================
-- 3. ÍNDICES
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_cms_company_status  ON comercial.client_metrics_snapshot (company_id, status);
CREATE INDEX IF NOT EXISTS idx_cms_company_last_inv ON comercial.client_metrics_snapshot (company_id, last_invoice_date);
CREATE INDEX IF NOT EXISTS idx_cms_company_seller   ON comercial.client_metrics_snapshot (company_id, main_seller_id);

CREATE INDEX IF NOT EXISTS idx_cgm_company_client    ON comercial.commercial_group_members (company_id, bsale_client_id);
CREATE INDEX IF NOT EXISTS idx_cgm_group_id          ON comercial.commercial_group_members (group_id);

CREATE INDEX IF NOT EXISTS idx_crs_company_status    ON comercial.client_relationship_suggestions (company_id, status);
CREATE INDEX IF NOT EXISTS idx_crs_company_type      ON comercial.client_relationship_suggestions (company_id, suggestion_type);

-- ============================================================================
-- 4. RLS
-- ============================================================================
ALTER TABLE comercial.client_metrics_snapshot       ENABLE ROW LEVEL SECURITY;
ALTER TABLE comercial.commercial_groups             ENABLE ROW LEVEL SECURITY;
ALTER TABLE comercial.commercial_group_members      ENABLE ROW LEVEL SECURITY;
ALTER TABLE comercial.client_relationship_suggestions ENABLE ROW LEVEL SECURITY;

-- Políticas: todos los usuarios autenticados pueden ver datos de su empresa
CREATE POLICY rls_cms_select ON comercial.client_metrics_snapshot
    FOR SELECT TO authenticated
    USING (core.has_company_access(auth.uid(), company_id));

CREATE POLICY rls_cms_insert ON comercial.client_metrics_snapshot
    FOR INSERT TO authenticated
    WITH CHECK (core.has_company_access(auth.uid(), company_id));

CREATE POLICY rls_cms_update ON comercial.client_metrics_snapshot
    FOR UPDATE TO authenticated
    USING (core.has_company_access(auth.uid(), company_id))
    WITH CHECK (core.has_company_access(auth.uid(), company_id));

CREATE POLICY rls_cg_select ON comercial.commercial_groups
    FOR SELECT TO authenticated
    USING (core.has_company_access(auth.uid(), company_id));

CREATE POLICY rls_cg_insert ON comercial.commercial_groups
    FOR INSERT TO authenticated
    WITH CHECK (core.has_company_access(auth.uid(), company_id));

CREATE POLICY rls_cg_update ON comercial.commercial_groups
    FOR UPDATE TO authenticated
    USING (core.has_company_access(auth.uid(), company_id))
    WITH CHECK (core.has_company_access(auth.uid(), company_id));

CREATE POLICY rls_cgm_select ON comercial.commercial_group_members
    FOR SELECT TO authenticated
    USING (core.has_company_access(auth.uid(), company_id));

CREATE POLICY rls_cgm_insert ON comercial.commercial_group_members
    FOR INSERT TO authenticated
    WITH CHECK (core.has_company_access(auth.uid(), company_id));

CREATE POLICY rls_cgm_update ON comercial.commercial_group_members
    FOR UPDATE TO authenticated
    USING (core.has_company_access(auth.uid(), company_id))
    WITH CHECK (core.has_company_access(auth.uid(), company_id));

CREATE POLICY rls_crs_select ON comercial.client_relationship_suggestions
    FOR SELECT TO authenticated
    USING (core.has_company_access(auth.uid(), company_id));

CREATE POLICY rls_crs_insert ON comercial.client_relationship_suggestions
    FOR INSERT TO authenticated
    WITH CHECK (core.has_company_access(auth.uid(), company_id));

CREATE POLICY rls_crs_update ON comercial.client_relationship_suggestions
    FOR UPDATE TO authenticated
    USING (core.has_company_access(auth.uid(), company_id))
    WITH CHECK (core.has_company_access(auth.uid(), company_id));

-- Grants
GRANT SELECT, INSERT, UPDATE ON comercial.client_metrics_snapshot TO authenticated;
GRANT ALL ON comercial.client_metrics_snapshot TO service_role;
GRANT SELECT, INSERT, UPDATE ON comercial.commercial_groups TO authenticated;
GRANT ALL ON comercial.commercial_groups TO service_role;
GRANT SELECT, INSERT, UPDATE ON comercial.commercial_group_members TO authenticated;
GRANT ALL ON comercial.commercial_group_members TO service_role;
GRANT SELECT, INSERT, UPDATE ON comercial.client_relationship_suggestions TO authenticated;
GRANT ALL ON comercial.client_relationship_suggestions TO service_role;

-- ============================================================================
-- 5. TRIGGER updated_at para commercial_groups
-- ============================================================================
DROP TRIGGER IF EXISTS set_commercial_groups_updated_at ON comercial.commercial_groups;
CREATE TRIGGER set_commercial_groups_updated_at
    BEFORE UPDATE ON comercial.commercial_groups
    FOR EACH ROW EXECUTE PROCEDURE portal.set_updated_at();

-- ============================================================================
-- 6. VISTAS
-- ============================================================================

-- 6A. vw_clients_base: clientes con datos normalizados + calidad
CREATE OR REPLACE VIEW comercial.vw_clients_base
WITH (security_invoker = true)
AS
WITH ranked_customers AS (
    SELECT
        c.*,
        ROW_NUMBER() OVER (
            PARTITION BY c.company_id, c.bsale_client_id
            ORDER BY
                c.is_active DESC NULLS LAST,
                c.last_bsale_sync_at DESC NULLS LAST,
                c.updated_at DESC NULLS LAST,
                c.created_at DESC NULLS LAST,
                c.id DESC
        ) AS rn
    FROM comercial.customers c
    WHERE c.source = 'BSALE'
      AND c.bsale_client_id IS NOT NULL
)
SELECT
    c.company_id,
    c.bsale_client_id,
    c.rut,
    c.rut_clean,
    c.business_name,
    c.fantasy_name,
    c.business_activity,
    c.email,
    c.phone,
    c.mobile,
    c.address,
    c.city,
    c.commune,
    c.region,
    c.is_active,
    c.last_sale_at,
    c.last_bsale_sync_at,
    c.source,
    c.seller_name AS seller_name_actual,
    c.route_name AS route_name_actual,

    -- Indicadores de calidad
    (COALESCE(c.rut_clean, '') <> '')::int * 25
    + (COALESCE(c.business_name, '') <> '')::int * 15
    + (CASE WHEN COALESCE(c.phone, c.mobile, '') <> '' THEN 15 ELSE 0 END)
    + (COALESCE(c.email, '') <> '')::int * 10
    + (COALESCE(c.address, '') <> '')::int * 10
    + (COALESCE(c.commune, '') <> '')::int * 10
    + (c.is_active = true)::int * 5
    + (c.last_sale_at IS NOT NULL)::int * 5
    + (COALESCE(c.seller_name, '') <> '')::int * 5
    AS data_quality_base_score,

    COALESCE(c.email, '') <> '' AS has_email,
    COALESCE(c.phone, c.mobile, '') <> '' AS has_phone,
    COALESCE(c.address, '') <> '' AS has_address

FROM ranked_customers c
WHERE c.rn = 1;

-- 6B. vw_client_sales_metrics: solo facturas oficiales type_id=5
CREATE OR REPLACE VIEW comercial.vw_client_sales_metrics
WITH (security_invoker = true)
AS
SELECT
    d.company_id,
    d.client_id AS bsale_client_id,
    MIN(d.emission_date::date) AS first_invoice_date,
    MAX(d.emission_date::date) AS last_invoice_date,
    COUNT(*) AS invoice_docs_total,
    SUM(d.total_amount) AS official_sales_total,

    SUM(d.total_amount) FILTER (WHERE d.emission_date >= current_date - interval '30 days') AS official_sales_30d,
    SUM(d.total_amount) FILTER (WHERE d.emission_date >= current_date - interval '60 days') AS official_sales_60d,
    SUM(d.total_amount) FILTER (WHERE d.emission_date >= current_date - interval '90 days') AS official_sales_90d,
    SUM(d.total_amount) FILTER (WHERE d.emission_date >= current_date - interval '180 days') AS official_sales_180d,
    SUM(d.total_amount) FILTER (WHERE d.emission_date >= current_date - interval '365 days') AS official_sales_365d,

    COUNT(*) FILTER (WHERE d.emission_date >= current_date - interval '30 days') AS official_invoice_docs_30d,
    COUNT(*) FILTER (WHERE d.emission_date >= current_date - interval '90 days') AS official_invoice_docs_90d,

    CASE WHEN COUNT(*) > 0 THEN SUM(d.total_amount) / COUNT(*) END AS avg_ticket_gross_total,
    CASE WHEN COUNT(*) FILTER (WHERE d.emission_date >= current_date - interval '90 days') > 0
         THEN SUM(d.total_amount) FILTER (WHERE d.emission_date >= current_date - interval '90 days')
              / COUNT(*) FILTER (WHERE d.emission_date >= current_date - interval '90 days')
    END AS avg_ticket_gross_90d

FROM integraciones.bsale_documents d
WHERE d.document_type_id = 5
  AND d.client_id IS NOT NULL
GROUP BY d.company_id, d.client_id;

-- 6C. vw_client_credit_note_metrics: NC type_id=2 separadas
CREATE OR REPLACE VIEW comercial.vw_client_credit_note_metrics
WITH (security_invoker = true)
AS
SELECT
    d.company_id,
    d.client_id AS bsale_client_id,
    COUNT(*) AS credit_note_count_total,
    SUM(d.total_amount) AS credit_note_amount_total,
    COUNT(*) FILTER (WHERE d.emission_date >= current_date - interval '90 days') AS credit_note_count_90d,
    SUM(d.total_amount) FILTER (WHERE d.emission_date >= current_date - interval '90 days') AS credit_note_amount_90d,
    MAX(d.emission_date::date) AS last_credit_note_date

FROM integraciones.bsale_documents d
WHERE d.document_type_id = 2
  AND d.client_id IS NOT NULL
GROUP BY d.company_id, d.client_id;

-- 6D. vw_client_sales_order_metrics: NV type_id=23 como pedido operativo
CREATE OR REPLACE VIEW comercial.vw_client_sales_order_metrics
WITH (security_invoker = true)
AS
SELECT
    d.company_id,
    d.client_id AS bsale_client_id,
    COUNT(*) AS sales_order_count_total,
    SUM(d.total_amount) AS sales_order_amount_total,
    COUNT(*) FILTER (WHERE d.emission_date >= current_date - interval '30 days') AS sales_order_count_30d,
    SUM(d.total_amount) FILTER (WHERE d.emission_date >= current_date - interval '30 days') AS sales_order_amount_30d,
    COUNT(*) FILTER (WHERE d.emission_date >= current_date - interval '90 days') AS sales_order_count_90d,
    SUM(d.total_amount) FILTER (WHERE d.emission_date >= current_date - interval '90 days') AS sales_order_amount_90d,
    MAX(d.emission_date::date) AS last_sales_order_date

FROM integraciones.bsale_documents d
WHERE d.document_type_id = 23
  AND d.client_id IS NOT NULL
GROUP BY d.company_id, d.client_id;

-- 6E. vw_client_seller_metrics: vendedor desde raw_json en facturas
CREATE OR REPLACE VIEW comercial.vw_client_seller_metrics
WITH (security_invoker = true)
AS
WITH invoice_sellers AS (
    SELECT
        d.company_id,
        d.client_id AS bsale_client_id,
        d.bsale_id,
        d.emission_date,
        d.total_amount,
        (d.raw_json -> 'user' ->> 'id')::bigint AS seller_id,
        COALESCE(
            s.name,
            NULLIF(TRIM(CONCAT(
                d.raw_json -> 'user' ->> 'firstName',
                ' ',
                d.raw_json -> 'user' ->> 'lastName'
            )), '')
        ) AS seller_name
    FROM integraciones.bsale_documents d
    LEFT JOIN integraciones.bsale_sellers s
        ON s.company_id = d.company_id
        AND s.bsale_id = (d.raw_json -> 'user' ->> 'id')::int
    WHERE d.document_type_id = 5
      AND d.client_id IS NOT NULL
      AND d.raw_json -> 'user' ->> 'id' IS NOT NULL
),
last_seller AS (
    SELECT ranked.company_id, ranked.bsale_client_id, ranked.seller_id, ranked.seller_name
    FROM (
        SELECT
            inv.company_id,
            inv.bsale_client_id,
            inv.seller_id,
            inv.seller_name,
            ROW_NUMBER() OVER (
                PARTITION BY inv.company_id, inv.bsale_client_id
                ORDER BY inv.emission_date DESC, inv.bsale_id DESC
            ) AS rn
        FROM invoice_sellers inv
    ) ranked
    WHERE ranked.rn = 1
),
seller_sales_180d AS (
    SELECT
        inv.company_id,
        inv.bsale_client_id,
        inv.seller_id,
        inv.seller_name,
        SUM(inv.total_amount) AS seller_sales_180d,
        COUNT(*) AS seller_invoice_count_180d
    FROM invoice_sellers inv
    WHERE inv.emission_date >= current_date - interval '180 days'
    GROUP BY inv.company_id, inv.bsale_client_id, inv.seller_id, inv.seller_name
),
main_seller AS (
    SELECT ranked.company_id, ranked.bsale_client_id, ranked.seller_id, ranked.seller_name, ranked.seller_sales_180d
    FROM (
        SELECT
            ss.company_id,
            ss.bsale_client_id,
            ss.seller_id,
            ss.seller_name,
            ss.seller_sales_180d,
            ROW_NUMBER() OVER (
                PARTITION BY ss.company_id, ss.bsale_client_id
                ORDER BY ss.seller_sales_180d DESC, ss.seller_invoice_count_180d DESC, ss.seller_id
            ) AS rn
        FROM seller_sales_180d ss
    ) ranked
    WHERE ranked.rn = 1
)
SELECT
    COALESCE(ls.company_id, ms.company_id) AS company_id,
    COALESCE(ls.bsale_client_id, ms.bsale_client_id) AS bsale_client_id,
    ls.seller_id AS last_seller_id,
    ls.seller_name AS last_seller_name,
    ms.seller_id AS main_seller_id,
    ms.seller_name AS main_seller_name,
    ms.main_seller_sales_180d
FROM last_seller ls
FULL JOIN main_seller ms ON ms.company_id = ls.company_id AND ms.bsale_client_id = ls.bsale_client_id;

-- 6F. vw_client_360: consolidado
CREATE OR REPLACE VIEW comercial.vw_client_360
WITH (security_invoker = true)
AS
SELECT
    b.company_id,
    b.bsale_client_id,
    b.rut,
    b.rut_clean,
    b.business_name,
    b.fantasy_name,
    b.business_activity,
    b.email,
    b.phone,
    b.mobile,
    b.address,
    b.city,
    b.commune,
    b.region,
    b.is_active,
    b.data_quality_base_score,
    b.has_email,
    b.has_phone,
    b.has_address,

    sm.first_invoice_date,
    sm.last_invoice_date,
    sm.invoice_docs_total,
    sm.official_sales_total,
    sm.official_sales_30d,
    sm.official_sales_60d,
    sm.official_sales_90d,
    sm.official_sales_180d,
    sm.official_sales_365d,
    sm.official_invoice_docs_30d,
    sm.official_invoice_docs_90d,
    sm.avg_ticket_gross_total,
    sm.avg_ticket_gross_90d,

    nc.credit_note_count_total,
    nc.credit_note_amount_total,
    nc.credit_note_count_90d,
    nc.credit_note_amount_90d,
    nc.last_credit_note_date,

    so.sales_order_count_total,
    so.sales_order_amount_total,
    so.sales_order_count_30d,
    so.sales_order_count_90d,
    so.sales_order_amount_30d,
    so.sales_order_amount_90d,
    so.last_sales_order_date,

    sel.last_seller_id,
    sel.last_seller_name,
    sel.main_seller_id,
    sel.main_seller_name,
    sel.main_seller_sales_180d,

    cms.status,
    cms.quality_score AS snapshot_quality_score,
    cms.days_since_last_invoice,
    cms.has_possible_sibling,
    cms.has_anomalous_receipt,
    cms.calculated_at AS snapshot_calculated_at

FROM comercial.vw_clients_base b
LEFT JOIN comercial.vw_client_sales_metrics sm
    ON sm.company_id = b.company_id AND sm.bsale_client_id = b.bsale_client_id
LEFT JOIN comercial.vw_client_credit_note_metrics nc
    ON nc.company_id = b.company_id AND nc.bsale_client_id = b.bsale_client_id
LEFT JOIN comercial.vw_client_sales_order_metrics so
    ON so.company_id = b.company_id AND so.bsale_client_id = b.bsale_client_id
LEFT JOIN comercial.vw_client_seller_metrics sel
    ON sel.company_id = b.company_id AND sel.bsale_client_id = b.bsale_client_id
LEFT JOIN comercial.client_metrics_snapshot cms
    ON cms.company_id = b.company_id AND cms.bsale_client_id = b.bsale_client_id;

-- Grants para vistas (solo SELECT)
GRANT SELECT ON comercial.vw_clients_base TO authenticated;
GRANT SELECT ON comercial.vw_clients_base TO service_role;
GRANT SELECT ON comercial.vw_client_sales_metrics TO authenticated;
GRANT SELECT ON comercial.vw_client_sales_metrics TO service_role;
GRANT SELECT ON comercial.vw_client_credit_note_metrics TO authenticated;
GRANT SELECT ON comercial.vw_client_credit_note_metrics TO service_role;
GRANT SELECT ON comercial.vw_client_sales_order_metrics TO authenticated;
GRANT SELECT ON comercial.vw_client_sales_order_metrics TO service_role;
GRANT SELECT ON comercial.vw_client_seller_metrics TO authenticated;
GRANT SELECT ON comercial.vw_client_seller_metrics TO service_role;
GRANT SELECT ON comercial.vw_client_360 TO authenticated;
GRANT SELECT ON comercial.vw_client_360 TO service_role;

-- ============================================================================
-- 7. FUNCIÓN refresh_client_metrics_snapshot
-- ============================================================================
CREATE OR REPLACE FUNCTION comercial.refresh_client_metrics_snapshot(
    p_company_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = comercial, integraciones, core, public
AS $$
DECLARE
    v_processed int := 0;
BEGIN
    INSERT INTO comercial.client_metrics_snapshot (
        company_id, bsale_client_id,
        status, quality_score,
        first_invoice_date, last_invoice_date, days_since_last_invoice,
        official_sales_30d, official_sales_60d, official_sales_90d,
        official_sales_180d, official_sales_365d, official_sales_total,
        official_invoice_docs_30d, official_invoice_docs_90d, official_invoice_docs_total,
        credit_note_amount_90d, credit_note_amount_total,
        credit_note_count_90d, credit_note_count_total,
        sales_order_amount_30d, sales_order_amount_90d,
        sales_order_count_30d, sales_order_count_90d, last_sales_order_date,
        avg_ticket_gross_90d, avg_ticket_gross_total,
        last_seller_id, last_seller_name, main_seller_id, main_seller_name,
        commune, city, has_email, has_phone, has_address,
        has_possible_sibling, has_anomalous_receipt,
        calculated_at
    )
    SELECT
        b.company_id,
        b.bsale_client_id,
        -- Estados v1: OBSERVACION usa umbral fijo 61-90 dias.
        -- RECUPERADO requiere detectar brecha real >120 dias entre facturas antes de la ultima factura.
        CASE
            WHEN sm.last_invoice_date IS NULL THEN 'SIN_VENTA_HISTORICA'
            WHEN sm.first_invoice_date >= current_date - interval '30 days' THEN 'NUEVO'
            WHEN current_date - sm.last_invoice_date <= 60 THEN 'ACTIVO'
            WHEN current_date - sm.last_invoice_date <= 90 THEN 'OBSERVACION'
            WHEN current_date - sm.last_invoice_date <= 120 THEN 'RIESGO'
            WHEN current_date - sm.last_invoice_date <= 180 THEN 'INACTIVO'
            ELSE 'PERDIDO'
        END AS status,
        b.data_quality_base_score + CASE WHEN sel.last_seller_id IS NOT NULL THEN 5 ELSE 0 END AS quality_score,
        sm.first_invoice_date,
        sm.last_invoice_date,
        CASE WHEN sm.last_invoice_date IS NULL THEN NULL ELSE current_date - sm.last_invoice_date END AS days_since_last_invoice,
        COALESCE(sm.official_sales_30d, 0),
        COALESCE(sm.official_sales_60d, 0),
        COALESCE(sm.official_sales_90d, 0),
        COALESCE(sm.official_sales_180d, 0),
        COALESCE(sm.official_sales_365d, 0),
        COALESCE(sm.official_sales_total, 0),
        COALESCE(sm.official_invoice_docs_30d, 0),
        COALESCE(sm.official_invoice_docs_90d, 0),
        COALESCE(sm.invoice_docs_total, 0),
        COALESCE(nc.credit_note_amount_90d, 0),
        COALESCE(nc.credit_note_amount_total, 0),
        COALESCE(nc.credit_note_count_90d, 0),
        COALESCE(nc.credit_note_count_total, 0),
        COALESCE(so.sales_order_amount_30d, 0),
        COALESCE(so.sales_order_amount_90d, 0),
        COALESCE(so.sales_order_count_30d, 0),
        COALESCE(so.sales_order_count_90d, 0),
        so.last_sales_order_date,
        sm.avg_ticket_gross_90d,
        sm.avg_ticket_gross_total,
        sel.last_seller_id,
        sel.last_seller_name,
        sel.main_seller_id,
        sel.main_seller_name,
        b.commune,
        b.city,
        b.has_email,
        b.has_phone,
        b.has_address,
        EXISTS (
            SELECT 1
            FROM comercial.vw_clients_base sibling
            WHERE sibling.company_id = b.company_id
              AND sibling.rut_clean = b.rut_clean
              AND sibling.bsale_client_id <> b.bsale_client_id
              AND COALESCE(sibling.rut_clean, '') <> ''
            LIMIT 1
        ) AS has_possible_sibling,
        EXISTS (
            SELECT 1
            FROM integraciones.bsale_documents anomaly
            WHERE anomaly.company_id = b.company_id
              AND anomaly.client_id = b.bsale_client_id
              AND anomaly.document_type_id = 1
            LIMIT 1
        ) AS has_anomalous_receipt,
        now()
    FROM comercial.vw_clients_base b
    LEFT JOIN comercial.vw_client_sales_metrics sm
        ON sm.company_id = b.company_id AND sm.bsale_client_id = b.bsale_client_id
    LEFT JOIN comercial.vw_client_credit_note_metrics nc
        ON nc.company_id = b.company_id AND nc.bsale_client_id = b.bsale_client_id
    LEFT JOIN comercial.vw_client_sales_order_metrics so
        ON so.company_id = b.company_id AND so.bsale_client_id = b.bsale_client_id
    LEFT JOIN comercial.vw_client_seller_metrics sel
        ON sel.company_id = b.company_id AND sel.bsale_client_id = b.bsale_client_id
    WHERE b.company_id = p_company_id
    ON CONFLICT (company_id, bsale_client_id) DO UPDATE SET
        status = EXCLUDED.status,
        quality_score = EXCLUDED.quality_score,
        first_invoice_date = EXCLUDED.first_invoice_date,
        last_invoice_date = EXCLUDED.last_invoice_date,
        days_since_last_invoice = EXCLUDED.days_since_last_invoice,
        official_sales_30d = EXCLUDED.official_sales_30d,
        official_sales_60d = EXCLUDED.official_sales_60d,
        official_sales_90d = EXCLUDED.official_sales_90d,
        official_sales_180d = EXCLUDED.official_sales_180d,
        official_sales_365d = EXCLUDED.official_sales_365d,
        official_sales_total = EXCLUDED.official_sales_total,
        official_invoice_docs_30d = EXCLUDED.official_invoice_docs_30d,
        official_invoice_docs_90d = EXCLUDED.official_invoice_docs_90d,
        official_invoice_docs_total = EXCLUDED.official_invoice_docs_total,
        credit_note_amount_90d = EXCLUDED.credit_note_amount_90d,
        credit_note_amount_total = EXCLUDED.credit_note_amount_total,
        credit_note_count_90d = EXCLUDED.credit_note_count_90d,
        credit_note_count_total = EXCLUDED.credit_note_count_total,
        sales_order_amount_30d = EXCLUDED.sales_order_amount_30d,
        sales_order_amount_90d = EXCLUDED.sales_order_amount_90d,
        sales_order_count_30d = EXCLUDED.sales_order_count_30d,
        sales_order_count_90d = EXCLUDED.sales_order_count_90d,
        last_sales_order_date = EXCLUDED.last_sales_order_date,
        avg_ticket_gross_90d = EXCLUDED.avg_ticket_gross_90d,
        avg_ticket_gross_total = EXCLUDED.avg_ticket_gross_total,
        last_seller_id = EXCLUDED.last_seller_id,
        last_seller_name = EXCLUDED.last_seller_name,
        main_seller_id = EXCLUDED.main_seller_id,
        main_seller_name = EXCLUDED.main_seller_name,
        commune = EXCLUDED.commune,
        city = EXCLUDED.city,
        has_email = EXCLUDED.has_email,
        has_phone = EXCLUDED.has_phone,
        has_address = EXCLUDED.has_address,
        has_possible_sibling = EXCLUDED.has_possible_sibling,
        has_anomalous_receipt = EXCLUDED.has_anomalous_receipt,
        calculated_at = now();

    GET DIAGNOSTICS v_processed = ROW_COUNT;

    RETURN jsonb_build_object(
        'company_id', p_company_id,
        'processed_clients', v_processed,
        'calculated_at', now()
    );
END;
$$;

REVOKE ALL ON FUNCTION comercial.refresh_client_metrics_snapshot(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION comercial.refresh_client_metrics_snapshot(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION comercial.refresh_client_metrics_snapshot(uuid) TO service_role;

-- ============================================================================
-- 8. NOTAS FINALES
-- ============================================================================
-- TODO: revisar políticas RLS — se usó core.has_company_access que es el
-- patrón estándar del proyecto. Si se requieren permisos más específicos
-- (portal.has_permission), agregar en Fase 3C cuando se definan roles
-- comerciales.
--
-- TODO: vw_client_seller_metrics extrae vendedor desde raw_json directamente.
-- Si el volumen de datos crece, considerar extraer seller_id como columna
-- en el sync de documentos (bsale-sync.ts).
-- ============================================================================
