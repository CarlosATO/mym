-- COMV2-07: V2 initial cutover and Chile civil payment calendar.
-- The V2 settings model stores the first eligible date; the historical
-- cutoff is deterministically first_eligible_full_payment_date - 1 day.

INSERT INTO comisiones.settings (
    company_id, currency_code, base_amount_type, requires_full_payment,
    first_eligible_full_payment_date, active
)
SELECT c.id, 'CLP', 'NET', true, DATE '2026-07-26', true
FROM core.companies c
WHERE c.id = 'd1000000-0000-0000-0000-000000000001'
ON CONFLICT (company_id) DO UPDATE
SET currency_code = 'CLP',
    base_amount_type = 'NET',
    requires_full_payment = true,
    first_eligible_full_payment_date = DATE '2026-07-26',
    active = true,
    updated_at = now();

COMMENT ON COLUMN comisiones.settings.first_eligible_full_payment_date IS
    'V2 first eligible Chile civil payment date. Historical cutoff is this date minus one day.';

CREATE OR REPLACE FUNCTION comisiones.get_sales_line_payment_eligibility(
    p_company_id uuid,
    p_seller_bsale_id bigint,
    p_from date,
    p_to date
)
RETURNS TABLE (
    company_id uuid, document_id uuid, document_bsale_id bigint, document_number bigint,
    document_type_id integer, emission_date date, customer_bsale_id bigint, customer_name text,
    detail_id uuid, detail_bsale_id bigint, line_number integer, quantity numeric, net_amount numeric,
    variant_id integer, variant_code_snapshot text, variant_description_snapshot text,
    product_id uuid, current_sku text, current_product_description text, product_is_active boolean,
    bsale_brand_id integer, real_supplier_id uuid, real_supplier_business_name text,
    family_bsale_product_type_id integer, family_name text, resolution_status text,
    resolution_code text, resolution_message text, seller_bsale_id bigint, seller_name text,
    seller_primary_count bigint, seller_primary_ids bigint[], seller_is_commissionable boolean,
    seller_is_active boolean, receivable_status text, total_amount numeric, paid_amount numeric,
    pending_amount numeric, full_payment_date timestamptz
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public, auth, core, portal, comisiones, comercial, integraciones
AS $$
WITH primary_sellers AS MATERIALIZED (
    SELECT company_id, bsale_document_id,
           count(*) FILTER (WHERE is_primary) AS seller_primary_count,
           array_agg(seller_bsale_id ORDER BY seller_bsale_id) FILTER (WHERE is_primary) AS seller_primary_ids
    FROM integraciones.bsale_document_sellers
    WHERE company_id = p_company_id
    GROUP BY company_id, bsale_document_id
), eligible_invoices AS MATERIALIZED (
    SELECT r.*, ds.seller_bsale_id, ds.seller_name,
           sp.is_commissionable AS seller_is_commissionable, sp.active AS seller_is_active,
           ps.seller_primary_count, ps.seller_primary_ids
    FROM comercial.vw_customer_invoice_receivables r
    CROSS JOIN comisiones.settings v2_settings
    JOIN integraciones.bsale_document_sellers ds
      ON ds.company_id = r.company_id AND ds.bsale_document_id = r.bsale_document_id
     AND ds.is_primary AND ds.seller_bsale_id = p_seller_bsale_id
    JOIN comisiones.seller_profiles sp
      ON sp.company_id = ds.company_id AND sp.seller_bsale_id = ds.seller_bsale_id
     AND sp.active AND sp.is_commissionable
    LEFT JOIN primary_sellers ps
      ON ps.company_id = r.company_id AND ps.bsale_document_id = r.bsale_document_id
    WHERE v2_settings.company_id = p_company_id
      AND v2_settings.active
      AND r.company_id = p_company_id AND r.document_type_id = 5
      AND r.receivable_status = 'PAGADA' AND r.pending_amount = 0
      AND (r.last_payment_date AT TIME ZONE 'America/Santiago')::date BETWEEN p_from AND p_to
      AND (r.last_payment_date AT TIME ZONE 'America/Santiago')::date >= v2_settings.first_eligible_full_payment_date
      AND r.is_internal_account = false AND r.is_commissionable = true
), eligible_lines AS MATERIALIZED (
    SELECT i.*, d.id AS detail_id, d.bsale_id AS detail_bsale_id, d.line_number,
           d.quantity, d.net_amount, d.variant_id
    FROM eligible_invoices i
    JOIN integraciones.bsale_document_details d
      ON d.company_id = i.company_id AND d.bsale_document_id = i.bsale_document_id
    WHERE NOT EXISTS (
        SELECT 1 FROM comisiones.line_locks lock
        WHERE lock.company_id = d.company_id AND lock.source_document_line_id = d.id
          AND lock.status = 'ACTIVE'
    )
)
SELECT r.company_id, r.document_id, r.document_bsale_id::bigint, r.document_number::bigint,
       r.document_type_id, r.emission_date, e.bsale_client_id::bigint, e.client_name,
       e.detail_id, e.detail_bsale_id::bigint, e.line_number, e.quantity, e.net_amount, e.variant_id,
       r.variant_code_snapshot::text, r.variant_description_snapshot::text, r.product_id,
       r.current_sku::text, r.current_product_description::text, r.product_is_active, r.bsale_brand_id,
       r.real_supplier_id, r.real_supplier_business_name, r.family_bsale_product_type_id,
       r.family_name::text, r.resolution_status::text, r.resolution_code::text, r.resolution_message,
       e.seller_bsale_id, e.seller_name, e.seller_primary_count, e.seller_primary_ids,
       e.seller_is_commissionable, e.seller_is_active, e.receivable_status, e.total_amount,
       e.paid_amount, e.pending_amount, e.last_payment_date
FROM eligible_lines e
JOIN comisiones.vw_sales_line_resolution r
  ON r.company_id = e.company_id AND r.detail_id = e.detail_id
ORDER BY e.last_payment_date DESC, e.document_number DESC, e.line_number;
$$;

CREATE OR REPLACE FUNCTION comisiones.get_sales_line_simulation(
    p_company_id uuid, p_seller_bsale_id bigint, p_from date, p_to date
)
RETURNS TABLE (
    company_id uuid, document_id uuid, document_bsale_id bigint, document_number bigint,
    document_type_id integer, emission_date date, customer_bsale_id bigint, customer_name text,
    detail_id uuid, detail_bsale_id bigint, line_number integer, quantity numeric, net_amount numeric,
    variant_id integer, variant_code_snapshot text, variant_description_snapshot text,
    product_id uuid, current_sku text, current_product_description text, product_is_active boolean,
    bsale_brand_id integer, real_supplier_id uuid, real_supplier_business_name text,
    family_bsale_product_type_id integer, family_name text, resolution_status text,
    resolution_code text, resolution_message text, seller_bsale_id bigint, seller_name text,
    seller_primary_count bigint, seller_primary_ids bigint[], seller_is_commissionable boolean,
    seller_is_active boolean, receivable_status text, total_amount numeric, paid_amount numeric,
    pending_amount numeric, full_payment_date timestamptz, plan_id uuid, plan_code text,
    family_percentage numeric, commission_amount numeric, simulation_status text, simulation_message text
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public, auth, core, portal, comisiones, comercial, integraciones, adquisiciones
AS $$
WITH eligible AS (
    SELECT * FROM comisiones.get_sales_line_payment_eligibility(p_company_id, p_seller_bsale_id, p_from, p_to)
), classified AS (
    SELECT e.*, plan.id AS matched_plan_id, plan.plan_code AS matched_plan_code,
           rate.percentage AS matched_percentage,
           CASE WHEN e.resolution_status <> 'RESOLVED' THEN 'COMMERCIAL_INCIDENT'
                WHEN plan.id IS NULL THEN 'NO_ACTIVE_PLAN'
                WHEN rate.id IS NULL THEN 'NO_FAMILY_RATE'
                ELSE 'RULE_APPLIED' END AS matched_status
    FROM eligible e
    LEFT JOIN LATERAL (
        SELECT cp.id, cp.plan_code
        FROM comisiones.commission_plans cp
        WHERE cp.company_id = e.company_id AND cp.supplier_id = e.real_supplier_id
          AND cp.plan_type = 'FAMILY_FIXED_PERCENT' AND cp.active
          AND (e.full_payment_date AT TIME ZONE 'America/Santiago')::date >= cp.valid_from
          AND (cp.valid_to IS NULL OR (e.full_payment_date AT TIME ZONE 'America/Santiago')::date <= cp.valid_to)
        ORDER BY cp.valid_from DESC, cp.version_no DESC, cp.id LIMIT 1
    ) plan ON true
    LEFT JOIN comisiones.commission_plan_family_rates rate
      ON rate.company_id = e.company_id AND rate.plan_id = plan.id
     AND rate.family_bsale_product_type_id = e.family_bsale_product_type_id
)
SELECT c.company_id, c.document_id, c.document_bsale_id, c.document_number, c.document_type_id,
       c.emission_date, c.customer_bsale_id, c.customer_name, c.detail_id, c.detail_bsale_id,
       c.line_number, c.quantity, c.net_amount, c.variant_id, c.variant_code_snapshot,
       c.variant_description_snapshot, c.product_id, c.current_sku, c.current_product_description,
       c.product_is_active, c.bsale_brand_id, c.real_supplier_id, c.real_supplier_business_name,
       c.family_bsale_product_type_id, c.family_name, c.resolution_status, c.resolution_code,
       c.resolution_message, c.seller_bsale_id, c.seller_name, c.seller_primary_count,
       c.seller_primary_ids, c.seller_is_commissionable, c.seller_is_active, c.receivable_status,
       c.total_amount, c.paid_amount, c.pending_amount, c.full_payment_date, c.matched_plan_id,
       c.matched_plan_code, c.matched_percentage,
       CASE WHEN c.matched_status = 'RULE_APPLIED' THEN round(c.net_amount * c.matched_percentage / 100, 0) ELSE NULL END,
       c.matched_status,
       CASE c.matched_status WHEN 'RULE_APPLIED' THEN 'Porcentaje de Familia aplicado.'
         WHEN 'NO_ACTIVE_PLAN' THEN 'No existe un plan FAMILY_FIXED_PERCENT vigente.'
         WHEN 'NO_FAMILY_RATE' THEN 'El plan vigente no tiene porcentaje para esta Familia.'
         ELSE c.resolution_message END
FROM classified c;
$$;

GRANT EXECUTE ON FUNCTION comisiones.get_sales_line_payment_eligibility(uuid,bigint,date,date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION comisiones.get_sales_line_simulation(uuid,bigint,date,date) TO authenticated, service_role;
