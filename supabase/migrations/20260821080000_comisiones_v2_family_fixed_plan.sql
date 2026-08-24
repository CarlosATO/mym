-- COMV2-06: FAMILY_FIXED_PERCENT configuration and simulation contracts.
-- All writes remain isolated in comisiones. Eligibility is delegated to the
-- already validated COMV2 payment eligibility function.

INSERT INTO portal.permissions (code, name, description, module_id)
SELECT
    'comisiones.v2.plans.manage',
    'Configurar planes de Comisiones V2',
    'Crear y actualizar planes V2 por Familia para Suppliers REAL',
    id
FROM portal.modules
WHERE code = 'comercial'
ON CONFLICT (code) DO NOTHING;

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM portal.roles r
JOIN portal.permissions p ON p.code = 'comisiones.v2.plans.manage'
WHERE r.name IN ('SUPER_USUARIO', 'GERENCIA', 'FINANZAS')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE VIEW comisiones.vw_real_suppliers
WITH (security_invoker = true) AS
SELECT s.company_id, s.id AS supplier_id,
       COALESCE(NULLIF(btrim(s.business_name), ''), NULLIF(btrim(s.fantasy_name), '')) AS supplier_name,
       s.rut
FROM adquisiciones.suppliers s
WHERE s.supplier_kind = 'REAL'
  AND s.status = 'ACTIVE'
  AND s.is_active IS TRUE;

CREATE OR REPLACE VIEW comisiones.vw_real_supplier_families
WITH (security_invoker = true) AS
SELECT r.company_id,
       r.real_supplier_id AS supplier_id,
       r.family_bsale_product_type_id,
       max(r.family_name) AS family_name,
       count(*)::bigint AS resolved_lines
FROM comisiones.vw_sales_line_resolution r
JOIN adquisiciones.suppliers s
  ON s.company_id = r.company_id
 AND s.id = r.real_supplier_id
 AND s.supplier_kind = 'REAL'
 AND s.status = 'ACTIVE'
 AND s.is_active IS TRUE
WHERE r.resolution_status = 'RESOLVED'
  AND r.real_supplier_id IS NOT NULL
  AND r.family_bsale_product_type_id IS NOT NULL
GROUP BY r.company_id, r.real_supplier_id, r.family_bsale_product_type_id;

GRANT SELECT ON comisiones.vw_real_suppliers TO authenticated, service_role;
GRANT SELECT ON comisiones.vw_real_supplier_families TO authenticated, service_role;

CREATE OR REPLACE FUNCTION comisiones.save_family_fixed_plan(
    p_company_id uuid,
    p_plan_id uuid,
    p_plan_code text,
    p_supplier_id uuid,
    p_valid_from date,
    p_valid_to date,
    p_rates jsonb
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
    v_rate jsonb;
    v_family_id integer;
    v_family_name text;
    v_percentage numeric;
    v_version integer;
BEGIN
    IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
    IF NOT (portal.has_permission('system.admin') OR portal.has_permission('comisiones.v2.plans.manage')) THEN
        RAISE EXCEPTION 'PERMISSION_DENIED';
    END IF;
    IF NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'COMPANY_ACCESS_DENIED';
    END IF;
    IF NULLIF(btrim(p_plan_code), '') IS NULL THEN RAISE EXCEPTION 'PLAN_NAME_REQUIRED'; END IF;
    IF p_valid_from IS NULL OR (p_valid_to IS NOT NULL AND p_valid_to < p_valid_from) THEN
        RAISE EXCEPTION 'INVALID_PLAN_DATES';
    END IF;
    IF p_rates IS NULL OR jsonb_typeof(p_rates) <> 'array' THEN RAISE EXCEPTION 'INVALID_FAMILY_RATES'; END IF;

    IF NOT EXISTS (
        SELECT 1 FROM adquisiciones.suppliers s
        WHERE s.id = p_supplier_id AND s.company_id = p_company_id
          AND s.supplier_kind = 'REAL' AND s.status = 'ACTIVE' AND s.is_active IS TRUE
    ) THEN RAISE EXCEPTION 'SUPPLIER_MUST_BE_REAL_AND_ACTIVE'; END IF;

    IF p_plan_id IS NULL THEN
        SELECT COALESCE(max(cp.version_no), 0) + 1 INTO v_version
        FROM comisiones.commission_plans cp
        WHERE cp.company_id = p_company_id AND cp.plan_code = btrim(p_plan_code);

        INSERT INTO comisiones.commission_plans (
            company_id, supplier_id, plan_code, version_no, plan_type,
            valid_from, valid_to, status, active, created_by, updated_by
        ) VALUES (
            p_company_id, p_supplier_id, btrim(p_plan_code), v_version, 'FAMILY_FIXED_PERCENT',
            p_valid_from, p_valid_to, 'ACTIVE', true, v_actor, v_actor
        ) RETURNING * INTO v_plan;
    ELSE
        SELECT * INTO v_plan
        FROM comisiones.commission_plans cp
        WHERE cp.id = p_plan_id
          AND cp.company_id = p_company_id
          AND cp.supplier_id = p_supplier_id
          AND cp.plan_type = 'FAMILY_FIXED_PERCENT'
        FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'PLAN_NOT_FOUND'; END IF;

        UPDATE comisiones.commission_plans cp
        SET plan_code = btrim(p_plan_code), valid_from = p_valid_from, valid_to = p_valid_to,
            status = 'ACTIVE', active = true, updated_by = v_actor
        WHERE cp.id = v_plan.id AND cp.company_id = p_company_id;
        v_plan.plan_code := btrim(p_plan_code);
        v_plan.valid_from := p_valid_from;
        v_plan.valid_to := p_valid_to;
    END IF;

    DELETE FROM comisiones.commission_plan_family_rates fr
    WHERE fr.company_id = p_company_id AND fr.plan_id = v_plan.id;

    FOR v_rate IN SELECT value FROM jsonb_array_elements(p_rates) LOOP
        v_family_id := (v_rate ->> 'family_bsale_product_type_id')::integer;
        v_family_name := NULLIF(btrim(v_rate ->> 'family_name'), '');
        v_percentage := (v_rate ->> 'percentage')::numeric;
        IF v_family_id IS NULL OR v_family_id <= 0 OR v_family_name IS NULL
           OR v_percentage IS NULL OR v_percentage < 0 OR v_percentage > 100 THEN
            RAISE EXCEPTION 'INVALID_FAMILY_RATE';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM comisiones.vw_real_supplier_families f
            WHERE f.company_id = p_company_id AND f.supplier_id = p_supplier_id
              AND f.family_bsale_product_type_id = v_family_id
        ) THEN RAISE EXCEPTION 'FAMILY_NOT_ASSOCIATED_TO_SUPPLIER'; END IF;

        INSERT INTO comisiones.commission_plan_family_rates (
            company_id, plan_id, family_bsale_product_type_id, family_name_snapshot, percentage,
            created_by, updated_by
        ) VALUES (
            p_company_id, v_plan.id, v_family_id, v_family_name, v_percentage, v_actor, v_actor
        );
    END LOOP;

    RETURN QUERY SELECT v_plan.id, v_plan.plan_code, v_plan.version_no;
END;
$$;

CREATE OR REPLACE FUNCTION comisiones.get_sales_line_simulation(
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
    family_percentage numeric, commission_amount numeric, simulation_status text, simulation_message text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, auth, core, portal, comisiones, comercial, integraciones, adquisiciones
AS $$
WITH eligible AS (
    SELECT * FROM comisiones.get_sales_line_payment_eligibility(
        p_company_id, p_seller_bsale_id, p_from, p_to
    )
), classified AS (
    SELECT e.*, plan.id AS matched_plan_id, plan.plan_code AS matched_plan_code,
           rate.percentage AS matched_percentage,
           CASE
             WHEN e.resolution_status <> 'RESOLVED' THEN 'COMMERCIAL_INCIDENT'
             WHEN plan.id IS NULL THEN 'NO_ACTIVE_PLAN'
             WHEN rate.id IS NULL THEN 'NO_FAMILY_RATE'
             ELSE 'RULE_APPLIED'
           END AS matched_status
    FROM eligible e
    LEFT JOIN LATERAL (
        SELECT cp.id, cp.plan_code
        FROM comisiones.commission_plans cp
        WHERE cp.company_id = e.company_id AND cp.supplier_id = e.real_supplier_id
          AND cp.plan_type = 'FAMILY_FIXED_PERCENT' AND cp.active
          AND e.full_payment_date::date >= cp.valid_from
          AND (cp.valid_to IS NULL OR e.full_payment_date::date <= cp.valid_to)
        ORDER BY cp.valid_from DESC, cp.version_no DESC, cp.id
        LIMIT 1
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
       CASE WHEN c.matched_status = 'RULE_APPLIED'
            THEN round(c.net_amount * c.matched_percentage / 100, 0) ELSE NULL END,
       c.matched_status,
       CASE c.matched_status
         WHEN 'RULE_APPLIED' THEN 'Porcentaje de Familia aplicado.'
         WHEN 'NO_ACTIVE_PLAN' THEN 'No existe un plan FAMILY_FIXED_PERCENT vigente.'
         WHEN 'NO_FAMILY_RATE' THEN 'El plan vigente no tiene porcentaje para esta Familia.'
         ELSE c.resolution_message
       END
FROM classified c;
$$;

GRANT EXECUTE ON FUNCTION comisiones.save_family_fixed_plan(uuid, uuid, text, uuid, date, date, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION comisiones.get_sales_line_simulation(uuid, bigint, date, date) TO authenticated, service_role;
