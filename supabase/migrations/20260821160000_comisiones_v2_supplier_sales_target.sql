-- COMV2-09: Supplier REAL sales targets and non-progressive simulation.

GRANT SELECT ON comisiones.commission_plan_tiers TO authenticated, service_role;

CREATE OR REPLACE FUNCTION comisiones.save_supplier_sales_target_plan(
    p_company_id uuid,
    p_plan_id uuid,
    p_plan_code text,
    p_supplier_id uuid,
    p_valid_from date,
    p_valid_to date,
    p_tiers jsonb
)
RETURNS TABLE (plan_id uuid, plan_code text, version_no integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, comisiones, adquisiciones
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_plan comisiones.commission_plans%ROWTYPE;
    v_tier jsonb;
    v_order integer;
    v_expected integer := 1;
    v_lower numeric;
    v_upper numeric;
    v_percentage numeric;
    v_previous_upper numeric;
    v_version integer;
    v_issued boolean := false;
    v_issued_to date;
    v_target_plan_id uuid;
BEGIN
    IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
    IF NOT (portal.has_permission('system.admin') OR portal.has_permission('comisiones.v2.plans.manage')) THEN RAISE EXCEPTION 'PERMISSION_DENIED'; END IF;
    IF NOT core.has_company_access(v_actor, p_company_id) THEN RAISE EXCEPTION 'COMPANY_ACCESS_DENIED'; END IF;
    IF NULLIF(btrim(p_plan_code), '') IS NULL THEN RAISE EXCEPTION 'PLAN_NAME_REQUIRED'; END IF;
    IF p_valid_from IS NULL OR (p_valid_to IS NOT NULL AND p_valid_to < p_valid_from) THEN RAISE EXCEPTION 'INVALID_PLAN_DATES'; END IF;
    IF p_tiers IS NULL OR jsonb_typeof(p_tiers) <> 'array' OR jsonb_array_length(p_tiers) = 0 THEN RAISE EXCEPTION 'TARGET_TIERS_REQUIRED'; END IF;
    IF NOT EXISTS (
        SELECT 1 FROM adquisiciones.suppliers s
        WHERE s.id = p_supplier_id AND s.company_id = p_company_id
          AND s.supplier_kind = 'REAL' AND s.status = 'ACTIVE' AND s.is_active IS TRUE
    ) THEN RAISE EXCEPTION 'SUPPLIER_MUST_BE_REAL_AND_ACTIVE'; END IF;

    FOR v_tier IN SELECT value FROM jsonb_array_elements(p_tiers) ORDER BY (value ->> 'tier_order')::integer LOOP
        v_order := (v_tier ->> 'tier_order')::integer;
        v_lower := (v_tier ->> 'lower_bound')::numeric;
        v_upper := NULLIF(v_tier ->> 'upper_bound', '')::numeric;
        v_percentage := (v_tier ->> 'percentage')::numeric;
        IF v_order IS NULL OR v_order <> v_expected OR v_lower IS NULL OR v_lower < 0 OR v_percentage IS NULL OR v_percentage < 0 OR v_percentage > 100 THEN RAISE EXCEPTION 'INVALID_TARGET_TIER'; END IF;
        IF v_expected = 1 AND v_lower <> 0 THEN RAISE EXCEPTION 'TARGET_TIERS_MUST_START_AT_ZERO'; END IF;
        IF v_previous_upper IS NULL AND v_expected > 1 THEN RAISE EXCEPTION 'TARGET_TIERS_HAVE_OPEN_GAP'; END IF;
        IF v_expected > 1 AND v_lower <> v_previous_upper + 0.01 THEN RAISE EXCEPTION 'TARGET_TIERS_HAVE_GAP'; END IF;
        IF v_upper IS NOT NULL AND v_upper < v_lower THEN RAISE EXCEPTION 'INVALID_TARGET_TIER'; END IF;
        IF v_upper IS NULL AND v_expected < jsonb_array_length(p_tiers) THEN RAISE EXCEPTION 'OPEN_TARGET_TIER_MUST_BE_LAST'; END IF;
        v_previous_upper := v_upper;
        v_expected := v_expected + 1;
    END LOOP;

    IF p_plan_id IS NULL THEN
        SELECT COALESCE(max(cp.version_no), 0) + 1 INTO v_version
        FROM comisiones.commission_plans cp
        WHERE cp.company_id = p_company_id AND cp.plan_code = btrim(p_plan_code);
        INSERT INTO comisiones.commission_plans (company_id, supplier_id, plan_code, version_no, plan_type, valid_from, valid_to, status, active, created_by, updated_by)
        VALUES (p_company_id, p_supplier_id, btrim(p_plan_code), v_version, 'SUPPLIER_SALES_TARGET', p_valid_from, p_valid_to, 'ACTIVE', true, v_actor, v_actor)
        RETURNING * INTO v_plan;
        v_target_plan_id := v_plan.id;
    ELSE
        SELECT * INTO v_plan FROM comisiones.commission_plans cp
        WHERE cp.id = p_plan_id AND cp.company_id = p_company_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'PLAN_NOT_FOUND'; END IF;
        IF v_plan.supplier_id <> p_supplier_id THEN RAISE EXCEPTION 'SUPPLIER_CANNOT_CHANGE'; END IF;
        IF v_plan.plan_type <> 'SUPPLIER_SALES_TARGET' THEN RAISE EXCEPTION 'PLAN_TYPE_CANNOT_CHANGE'; END IF;

        SELECT EXISTS (
            SELECT 1 FROM comisiones.settlement_lines sl
            JOIN comisiones.settlements st ON st.company_id = sl.company_id AND st.id = sl.settlement_id
            WHERE sl.company_id = p_company_id AND sl.plan_id = v_plan.id AND st.status = 'ISSUED'
        ), max(st.period_to)
        INTO v_issued, v_issued_to
        FROM comisiones.settlement_lines sl
        JOIN comisiones.settlements st ON st.company_id = sl.company_id AND st.id = sl.settlement_id
        WHERE sl.company_id = p_company_id AND sl.plan_id = v_plan.id AND st.status = 'ISSUED';

        IF v_issued AND p_valid_from <> v_plan.valid_from THEN
            IF v_issued_to IS NULL OR p_valid_from <= v_issued_to THEN RAISE EXCEPTION 'VERSION_MUST_START_AFTER_ISSUED_PERIOD'; END IF;
            UPDATE comisiones.commission_plans SET valid_to = p_valid_from - 1, updated_by = v_actor WHERE id = v_plan.id;
            SELECT COALESCE(max(cp.version_no), 0) + 1 INTO v_version FROM comisiones.commission_plans cp
            WHERE cp.company_id = p_company_id AND cp.plan_code = btrim(p_plan_code);
            INSERT INTO comisiones.commission_plans (company_id, supplier_id, plan_code, version_no, plan_type, valid_from, valid_to, status, active, supersedes_plan_id, reason, created_by, updated_by)
            VALUES (p_company_id, p_supplier_id, btrim(p_plan_code), v_version, 'SUPPLIER_SALES_TARGET', p_valid_from, p_valid_to, 'ACTIVE', true, v_plan.id, 'Nueva versión posterior a liquidación emitida', v_actor, v_actor)
            RETURNING * INTO v_plan;
            v_target_plan_id := v_plan.id;
        ELSE
            IF v_issued AND p_valid_to IS NOT NULL AND v_issued_to IS NOT NULL AND p_valid_to < v_issued_to THEN RAISE EXCEPTION 'VALID_TO_CANNOT_PRECEDE_ISSUED_PERIOD'; END IF;
            UPDATE comisiones.commission_plans SET plan_code = btrim(p_plan_code), valid_from = p_valid_from, valid_to = p_valid_to, status = 'ACTIVE', active = true, updated_by = v_actor WHERE id = v_plan.id;
            v_target_plan_id := v_plan.id;
        END IF;
    END IF;

    DELETE FROM comisiones.commission_plan_tiers t WHERE t.company_id = p_company_id AND t.plan_id = v_target_plan_id;
    FOR v_tier IN SELECT value FROM jsonb_array_elements(p_tiers) ORDER BY (value ->> 'tier_order')::integer LOOP
        INSERT INTO comisiones.commission_plan_tiers (company_id, plan_id, tier_order, lower_bound, upper_bound, percentage, created_by, updated_by)
        VALUES (p_company_id, v_target_plan_id, (v_tier ->> 'tier_order')::smallint, (v_tier ->> 'lower_bound')::numeric, NULLIF(v_tier ->> 'upper_bound', '')::numeric, (v_tier ->> 'percentage')::numeric, v_actor, v_actor);
    END LOOP;
    RETURN QUERY SELECT cp.id, cp.plan_code, cp.version_no FROM comisiones.commission_plans cp WHERE cp.id = v_target_plan_id;
END;
$$;

REVOKE ALL ON FUNCTION comisiones.save_supplier_sales_target_plan(uuid, uuid, text, uuid, date, date, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION comisiones.save_supplier_sales_target_plan(uuid, uuid, text, uuid, date, date, jsonb) TO authenticated, service_role;

DROP FUNCTION IF EXISTS comisiones.get_sales_line_simulation(uuid, bigint, date, date);
CREATE FUNCTION comisiones.get_sales_line_simulation(
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
WITH eligible AS (
    SELECT * FROM comisiones.get_sales_line_payment_eligibility(p_company_id, p_seller_bsale_id, p_from, p_to)
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
FROM classified c;
$$;

GRANT EXECUTE ON FUNCTION comisiones.get_sales_line_simulation(uuid, bigint, date, date) TO authenticated, service_role;
