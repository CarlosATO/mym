-- COMV2-09F: set-based simulation for all active, commissionable V2 sellers.

CREATE OR REPLACE FUNCTION comisiones.get_sales_period_simulation(
    p_company_id uuid,
    p_period_from date,
    p_period_to date
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
    plan_type text, family_percentage numeric, supplier_total_net numeric,
    tier_lower_bound numeric, tier_upper_bound numeric, commission_percent numeric,
    commission_amount numeric, simulation_status text, simulation_message text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, auth, core, portal, comisiones, comercial, integraciones, adquisiciones
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
     AND ds.is_primary
    JOIN comisiones.seller_profiles sp
      ON sp.company_id = ds.company_id AND sp.seller_bsale_id = ds.seller_bsale_id
     AND sp.active AND sp.is_commissionable
    LEFT JOIN primary_sellers ps
      ON ps.company_id = r.company_id AND ps.bsale_document_id = r.bsale_document_id
    WHERE v2_settings.company_id = p_company_id
      AND v2_settings.active
      AND r.company_id = p_company_id AND r.document_type_id = 5
      AND r.receivable_status = 'PAGADA' AND r.pending_amount = 0
      AND (r.last_payment_date AT TIME ZONE 'America/Santiago')::date BETWEEN p_period_from AND p_period_to
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
), eligible AS (
    SELECT r.company_id, r.document_id, r.document_bsale_id::bigint, r.document_number::bigint,
           r.document_type_id, r.emission_date, e.bsale_client_id::bigint AS customer_bsale_id, e.client_name AS customer_name,
           e.detail_id, e.detail_bsale_id::bigint, e.line_number, e.quantity, e.net_amount, e.variant_id,
           r.variant_code_snapshot::text, r.variant_description_snapshot::text, r.product_id,
           r.current_sku::text, r.current_product_description::text, r.product_is_active, r.bsale_brand_id,
           r.real_supplier_id, r.real_supplier_business_name, r.family_bsale_product_type_id,
           r.family_name::text, r.resolution_status::text, r.resolution_code::text, r.resolution_message,
           e.seller_bsale_id, e.seller_name, e.seller_primary_count, e.seller_primary_ids,
           e.seller_is_commissionable, e.seller_is_active, e.receivable_status, e.total_amount,
           e.paid_amount, e.pending_amount, e.last_payment_date AS full_payment_date
    FROM eligible_lines e
    JOIN comisiones.vw_sales_line_resolution r
      ON r.company_id = e.company_id AND r.detail_id = e.detail_id
), supplier_totals AS (
    SELECT e.company_id, e.seller_bsale_id, e.real_supplier_id, sum(e.net_amount) AS supplier_total_net
    FROM eligible e
    WHERE e.resolution_status = 'RESOLVED' AND e.real_supplier_id IS NOT NULL
    GROUP BY e.company_id, e.seller_bsale_id, e.real_supplier_id
), classified AS (
    SELECT e.*, plan.id AS matched_plan_id, plan.plan_code AS matched_plan_code, plan.plan_type AS matched_plan_type,
           totals.supplier_total_net, rate.percentage AS family_matched_percentage,
           tier.lower_bound AS matched_tier_lower, tier.upper_bound AS matched_tier_upper,
           tier.percentage AS tier_matched_percentage,
           CASE
             WHEN e.resolution_status <> 'RESOLVED' THEN 'COMMERCIAL_INCIDENT'
             WHEN plan.id IS NULL THEN 'NO_ACTIVE_PLAN'
             WHEN plan.plan_type = 'SUPPLIER_SALES_TARGET' AND tier.id IS NULL THEN 'NO_SALES_TARGET_TIER'
             WHEN plan.plan_type = 'FAMILY_FIXED_PERCENT' AND rate.id IS NULL THEN 'NO_FAMILY_RATE'
             ELSE 'RULE_APPLIED'
           END AS matched_status
    FROM eligible e
    LEFT JOIN supplier_totals totals
      ON totals.company_id = e.company_id AND totals.seller_bsale_id = e.seller_bsale_id AND totals.real_supplier_id = e.real_supplier_id
    LEFT JOIN LATERAL (
        SELECT cp.id, cp.plan_code, cp.plan_type
        FROM comisiones.commission_plans cp
        WHERE cp.company_id = e.company_id AND cp.supplier_id = e.real_supplier_id AND cp.active
          AND e.full_payment_date::date >= cp.valid_from
          AND (cp.valid_to IS NULL OR e.full_payment_date::date <= cp.valid_to)
        ORDER BY cp.valid_from DESC, cp.version_no DESC, cp.id
        LIMIT 1
    ) plan ON true
    LEFT JOIN LATERAL (
        SELECT t.id, t.lower_bound, t.upper_bound, t.percentage
        FROM comisiones.commission_plan_tiers t
        WHERE t.company_id = e.company_id AND t.plan_id = plan.id AND plan.plan_type = 'SUPPLIER_SALES_TARGET'
          AND totals.supplier_total_net >= t.lower_bound
          AND (t.upper_bound IS NULL OR totals.supplier_total_net <= t.upper_bound)
        ORDER BY t.tier_order
        LIMIT 1
    ) tier ON true
    LEFT JOIN comisiones.commission_plan_family_rates rate
      ON rate.company_id = e.company_id AND rate.plan_id = plan.id AND plan.plan_type = 'FAMILY_FIXED_PERCENT'
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
       c.matched_plan_code, c.matched_plan_type,
       CASE WHEN c.matched_plan_type = 'FAMILY_FIXED_PERCENT' THEN c.family_matched_percentage ELSE NULL END,
       c.supplier_total_net, c.matched_tier_lower, c.matched_tier_upper,
       CASE WHEN c.matched_status = 'RULE_APPLIED' THEN COALESCE(c.family_matched_percentage, c.tier_matched_percentage) ELSE NULL END,
       CASE WHEN c.matched_status = 'RULE_APPLIED' THEN round(c.net_amount * COALESCE(c.family_matched_percentage, c.tier_matched_percentage) / 100, 0) ELSE NULL END,
       c.matched_status,
       CASE c.matched_status
         WHEN 'RULE_APPLIED' THEN 'Regla aplicada.'
         WHEN 'NO_ACTIVE_PLAN' THEN 'No existe un plan vigente para este Supplier.'
         WHEN 'NO_FAMILY_RATE' THEN 'El plan vigente no tiene porcentaje para esta Familia.'
         WHEN 'NO_SALES_TARGET_TIER' THEN 'El total de ventas no alcanza un tramo configurado.'
         ELSE c.resolution_message
       END
FROM classified c
ORDER BY c.full_payment_date DESC, c.document_number DESC, c.line_number, c.seller_bsale_id;
$$;

REVOKE ALL ON FUNCTION comisiones.get_sales_period_simulation(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION comisiones.get_sales_period_simulation(uuid, date, date) TO authenticated, service_role;
