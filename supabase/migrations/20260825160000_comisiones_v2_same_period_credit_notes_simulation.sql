-- COMV2-29A: include only SAME_PERIOD credit notes in the period simulation.
-- Historical, out-of-scope and unresolved notes remain outside this contract.

DROP FUNCTION IF EXISTS comisiones.get_sales_period_simulation(uuid, date, date);

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
    commission_amount numeric, simulation_status text, simulation_message text,
    line_kind text, source_document_bsale_id bigint, source_document_number bigint,
    source_document_type_id integer, source_document_line_id uuid,
    source_document_detail_bsale_id bigint, original_invoice_bsale_id bigint,
    original_invoice_number bigint, original_invoice_line_id uuid,
    original_invoice_detail_bsale_id bigint, credit_note_date date
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
    FROM comisiones.vw_v2_real_invoice_receivables r
    CROSS JOIN comisiones.settings v2_settings
    JOIN integraciones.bsale_document_sellers ds
      ON ds.company_id = r.company_id
     AND ds.bsale_document_id = r.bsale_document_id
     AND ds.is_primary
    JOIN comisiones.seller_profiles sp
      ON sp.company_id = ds.company_id
     AND sp.seller_bsale_id = ds.seller_bsale_id
     AND sp.active
     AND sp.is_commissionable
    LEFT JOIN primary_sellers ps
      ON ps.company_id = r.company_id
     AND ps.bsale_document_id = r.bsale_document_id
    WHERE v2_settings.company_id = p_company_id
      AND v2_settings.active
      AND r.company_id = p_company_id
      AND r.document_type_id = 5
      AND r.receivable_status = 'PAGADA'
      AND r.pending_amount = 0
      AND r.last_payment_date::date BETWEEN p_period_from AND p_period_to
      AND r.last_payment_date::date >= v2_settings.first_eligible_full_payment_date
      AND r.is_internal_account = false
      AND r.is_commissionable = true
), eligible_lines AS MATERIALIZED (
    SELECT i.*, d.id AS detail_id, d.bsale_id AS detail_bsale_id,
           d.line_number, d.quantity, d.net_amount, d.variant_id
    FROM eligible_invoices i
    JOIN integraciones.bsale_document_details d
      ON d.company_id = i.company_id
     AND d.bsale_document_id = i.bsale_document_id
    WHERE NOT EXISTS (
        SELECT 1
        FROM comisiones.line_locks lock
        WHERE lock.company_id = d.company_id
          AND lock.source_document_line_id = d.id
          AND lock.status IN ('ACTIVE', 'CONSUMED')
    )
), invoice_lines AS MATERIALIZED (
    SELECT
        e.company_id, r.document_id, e.bsale_document_id::bigint AS document_bsale_id,
        e.document_number::bigint AS document_number, e.document_type_id,
        e.emission_date, e.bsale_client_id::bigint AS customer_bsale_id,
        e.client_name AS customer_name, e.detail_id, e.detail_bsale_id::bigint AS detail_bsale_id,
        e.line_number, e.quantity, e.net_amount, e.variant_id,
        r.variant_code_snapshot::text AS variant_code_snapshot,
        r.variant_description_snapshot::text AS variant_description_snapshot,
        r.product_id, r.current_sku::text AS current_sku,
        r.current_product_description::text AS current_product_description,
        r.product_is_active, r.bsale_brand_id, r.real_supplier_id,
        r.real_supplier_business_name, r.family_bsale_product_type_id,
        r.family_name::text AS family_name, r.resolution_status::text AS resolution_status,
        r.resolution_code::text AS resolution_code, r.resolution_message,
        e.seller_bsale_id, e.seller_name, e.seller_primary_count, e.seller_primary_ids,
        e.seller_is_commissionable, e.seller_is_active, e.receivable_status,
        e.total_amount, e.paid_amount, e.pending_amount, e.last_payment_date AS full_payment_date,
        'INVOICE'::text AS line_kind,
        e.bsale_document_id::bigint AS source_document_bsale_id,
        e.document_number::bigint AS source_document_number,
        e.document_type_id AS source_document_type_id,
        e.detail_id AS source_document_line_id,
        e.detail_bsale_id::bigint AS source_document_detail_bsale_id,
        NULL::bigint AS original_invoice_bsale_id,
        NULL::bigint AS original_invoice_number,
        NULL::uuid AS original_invoice_line_id,
        NULL::bigint AS original_invoice_detail_bsale_id,
        NULL::date AS credit_note_date,
        true AS is_calculable,
        e.bsale_document_id::bigint AS sort_invoice_bsale_id,
        e.document_number::bigint AS sort_invoice_number,
        e.line_number AS sort_line_number,
        0 AS line_kind_order,
        NULL::date AS sort_credit_note_date,
        e.detail_bsale_id::bigint AS sort_source_detail_bsale_id
    FROM eligible_lines e
    JOIN comisiones.vw_sales_line_resolution r
      ON r.company_id = e.company_id
     AND r.detail_id = e.detail_id
), same_period_candidates AS MATERIALIZED (
    SELECT c.*, i.net_amount AS original_current_net_amount,
           nd.line_number AS credit_note_line_number,
           nd.variant_code AS credit_note_variant_code,
           nd.variant_description AS credit_note_variant_description,
           nd.id AS matched_invoice_detail_id
    FROM comisiones.get_credit_note_adjustment_candidates(
        p_company_id, p_period_from, p_period_to
    ) c
    JOIN invoice_lines i
      ON i.company_id = c.company_id
     AND i.detail_id = c.original_invoice_detail_id
    JOIN integraciones.bsale_document_details nd
      ON nd.id = c.credit_note_detail_id
    WHERE c.placement_status = 'SAME_PERIOD'
), candidate_safety AS MATERIALIZED (
    SELECT company_id, original_invoice_detail_id,
           sum(ABS(nc_net_amount)) AS current_nc_net_amount,
           max(ABS(original_current_net_amount)) AS original_net_amount,
           sum(ABS(nc_net_amount)) <= max(ABS(original_current_net_amount)) + 1 AS is_safe
    FROM same_period_candidates
    GROUP BY company_id, original_invoice_detail_id
), credit_note_lines AS MATERIALIZED (
    SELECT
        i.company_id, c.credit_note_document_id AS document_id,
        c.credit_note_bsale_id AS document_bsale_id,
        c.credit_note_number AS document_number, 2 AS document_type_id,
        c.credit_note_date AS emission_date, i.customer_bsale_id, i.customer_name,
        c.credit_note_detail_id AS detail_id,
        c.credit_note_detail_bsale_id AS detail_bsale_id,
        c.credit_note_line_number AS line_number,
        c.nc_quantity AS quantity, c.nc_net_amount AS net_amount, c.variant_id,
        c.credit_note_variant_code AS variant_code_snapshot,
        c.credit_note_variant_description AS variant_description_snapshot,
        i.product_id, i.current_sku, i.current_product_description, i.product_is_active,
        i.bsale_brand_id, i.real_supplier_id, i.real_supplier_business_name,
        i.family_bsale_product_type_id, i.family_name, 'RESOLVED'::text AS resolution_status,
        CASE WHEN s.is_safe THEN 'SAME_PERIOD' ELSE 'SAME_PERIOD_OVER_REVERSAL' END AS resolution_code,
        CASE WHEN s.is_safe
             THEN 'Nota de crédito SAME_PERIOD vinculada a la línea original.'
             ELSE 'Las notas de crédito superan el neto original; no se calcula comisión automática.'
        END AS resolution_message,
        i.seller_bsale_id, i.seller_name, i.seller_primary_count, i.seller_primary_ids,
        i.seller_is_commissionable, i.seller_is_active, i.receivable_status,
        i.total_amount, i.paid_amount, i.pending_amount, i.full_payment_date,
        'CREDIT_NOTE'::text AS line_kind,
        c.credit_note_bsale_id AS source_document_bsale_id,
        c.credit_note_number AS source_document_number,
        2 AS source_document_type_id,
        c.credit_note_detail_id AS source_document_line_id,
        c.credit_note_detail_bsale_id AS source_document_detail_bsale_id,
        c.original_invoice_bsale_id,
        c.original_invoice_number,
        c.original_invoice_detail_id AS original_invoice_line_id,
        c.original_invoice_detail_bsale_id,
        c.credit_note_date,
        s.is_safe AS is_calculable,
        c.original_invoice_bsale_id AS sort_invoice_bsale_id,
        c.original_invoice_number AS sort_invoice_number,
        i.line_number AS sort_line_number,
        1 AS line_kind_order,
        c.credit_note_date AS sort_credit_note_date,
        c.credit_note_detail_bsale_id AS sort_source_detail_bsale_id
    FROM same_period_candidates c
    JOIN invoice_lines i
      ON i.company_id = c.company_id
     AND i.detail_id = c.original_invoice_detail_id
    JOIN candidate_safety s
      ON s.company_id = c.company_id
     AND s.original_invoice_detail_id = c.original_invoice_detail_id
), all_lines AS MATERIALIZED (
    SELECT * FROM invoice_lines
    UNION ALL
    SELECT * FROM credit_note_lines
), supplier_totals AS MATERIALIZED (
    SELECT company_id, seller_bsale_id, real_supplier_id,
           sum(net_amount) AS supplier_total_net
    FROM all_lines
    WHERE is_calculable
      AND resolution_status = 'RESOLVED'
      AND real_supplier_id IS NOT NULL
    GROUP BY company_id, seller_bsale_id, real_supplier_id
), classified AS (
    SELECT e.*, plan.id AS matched_plan_id, plan.plan_code AS matched_plan_code,
           plan.plan_type AS matched_plan_type, totals.supplier_total_net,
           rate.percentage AS family_matched_percentage,
           tier.lower_bound AS matched_tier_lower, tier.upper_bound AS matched_tier_upper,
           tier.percentage AS tier_matched_percentage,
           CASE
             WHEN NOT e.is_calculable THEN 'COMMERCIAL_INCIDENT'
             WHEN e.resolution_status <> 'RESOLVED' THEN 'COMMERCIAL_INCIDENT'
             WHEN plan.id IS NULL THEN 'NO_ACTIVE_PLAN'
             WHEN plan.plan_type = 'SUPPLIER_SALES_TARGET' AND tier.id IS NULL THEN 'NO_SALES_TARGET_TIER'
             WHEN plan.plan_type = 'FAMILY_FIXED_PERCENT' AND rate.id IS NULL THEN 'NO_FAMILY_RATE'
             ELSE 'RULE_APPLIED'
           END AS matched_status
    FROM all_lines e
    LEFT JOIN supplier_totals totals
      ON totals.company_id = e.company_id
     AND totals.seller_bsale_id = e.seller_bsale_id
     AND totals.real_supplier_id = e.real_supplier_id
     AND e.is_calculable
    LEFT JOIN LATERAL (
        SELECT cp.id, cp.plan_code, cp.plan_type
        FROM comisiones.commission_plans cp
        WHERE e.is_calculable
          AND cp.company_id = e.company_id
          AND cp.supplier_id = e.real_supplier_id
          AND cp.active
          AND e.full_payment_date::date >= cp.valid_from
          AND (cp.valid_to IS NULL OR e.full_payment_date::date <= cp.valid_to)
        ORDER BY cp.valid_from DESC, cp.version_no DESC, cp.id
        LIMIT 1
    ) plan ON true
    LEFT JOIN LATERAL (
        SELECT t.id, t.lower_bound, t.upper_bound, t.percentage
        FROM comisiones.commission_plan_tiers t
        WHERE t.company_id = e.company_id
          AND t.plan_id = plan.id
          AND plan.plan_type = 'SUPPLIER_SALES_TARGET'
          AND totals.supplier_total_net >= t.lower_bound
          AND (t.upper_bound IS NULL OR totals.supplier_total_net <= t.upper_bound)
        ORDER BY t.tier_order
        LIMIT 1
    ) tier ON true
    LEFT JOIN comisiones.commission_plan_family_rates rate
      ON rate.company_id = e.company_id
     AND rate.plan_id = plan.id
     AND plan.plan_type = 'FAMILY_FIXED_PERCENT'
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
       CASE WHEN c.is_calculable THEN c.supplier_total_net ELSE NULL END,
       c.matched_tier_lower, c.matched_tier_upper,
       CASE WHEN c.matched_status = 'RULE_APPLIED'
            THEN COALESCE(c.family_matched_percentage, c.tier_matched_percentage) ELSE NULL END,
       CASE WHEN c.matched_status = 'RULE_APPLIED'
            THEN round(c.net_amount * COALESCE(c.family_matched_percentage, c.tier_matched_percentage) / 100, 0)
            ELSE NULL END,
       c.matched_status,
       CASE c.matched_status
         WHEN 'RULE_APPLIED' THEN 'Regla aplicada.'
         WHEN 'NO_ACTIVE_PLAN' THEN 'No existe un plan vigente para este Supplier.'
         WHEN 'NO_FAMILY_RATE' THEN 'El plan vigente no tiene porcentaje para esta Familia.'
         WHEN 'NO_SALES_TARGET_TIER' THEN 'El total de ventas no alcanza un tramo configurado.'
         ELSE c.resolution_message
       END,
       c.line_kind, c.source_document_bsale_id, c.source_document_number,
       c.source_document_type_id, c.source_document_line_id,
       c.source_document_detail_bsale_id, c.original_invoice_bsale_id,
       c.original_invoice_number, c.original_invoice_line_id,
       c.original_invoice_detail_bsale_id, c.credit_note_date
FROM classified c
ORDER BY c.full_payment_date DESC, c.sort_invoice_number DESC, c.sort_line_number,
         c.line_kind_order, c.sort_credit_note_date, c.document_number,
         c.sort_source_detail_bsale_id;
$$;

REVOKE ALL ON FUNCTION comisiones.get_sales_period_simulation(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION comisiones.get_sales_period_simulation(uuid, date, date) TO authenticated, service_role;

COMMENT ON FUNCTION comisiones.get_sales_period_simulation(uuid, date, date) IS
    'COMV2-29A period simulation with invoice rows plus safe SAME_PERIOD credit-note rows. Credit notes use original invoice classification and reduce supplier target totals; HISTORICAL and non-commissionable notes remain excluded.';
