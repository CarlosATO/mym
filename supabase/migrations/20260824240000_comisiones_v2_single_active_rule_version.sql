-- COMV2-24A: one operational version per logical rule and historical usage.

CREATE UNIQUE INDEX IF NOT EXISTS uq_comisiones_plans_one_active_logical_rule
    ON comisiones.commission_plans (company_id, supplier_id, plan_code, plan_type)
    WHERE active IS TRUE;

-- Keep the existing usage contract, but make it reflect settlement_lines rather
-- than settlement status. The frontend can keep consuming the same field while
-- the backend now reports the information needed before editing.
CREATE OR REPLACE FUNCTION comisiones.get_family_fixed_plan_issued_usage(
    p_company_id uuid,
    p_plan_ids uuid[]
)
RETURNS TABLE (plan_id uuid, has_issued_usage boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, comisiones
AS $$
    SELECT requested.plan_id,
           EXISTS (
               SELECT 1
               FROM comisiones.settlement_lines sl
               WHERE sl.company_id = p_company_id
                 AND (
                     sl.plan_id = requested.plan_id
                     OR sl.family_rate_id IN (
                         SELECT fr.id
                         FROM comisiones.commission_plan_family_rates fr
                         WHERE fr.company_id = p_company_id
                           AND fr.plan_id = requested.plan_id
                     )
                     OR sl.tier_id IN (
                         SELECT t.id
                         FROM comisiones.commission_plan_tiers t
                         WHERE t.company_id = p_company_id
                           AND t.plan_id = requested.plan_id
                     )
                 )
           )
    FROM unnest(COALESCE(p_plan_ids, ARRAY[]::uuid[])) AS requested(plan_id)
    WHERE auth.uid() IS NOT NULL
      AND (portal.has_permission('system.admin')
           OR portal.has_permission('comisiones.v2.read')
           OR portal.has_permission('comisiones.v2.plans.manage'))
      AND core.has_company_access(auth.uid(), p_company_id);
$$;

CREATE OR REPLACE FUNCTION comisiones.save_family_fixed_plan(
    p_company_id uuid, p_plan_id uuid, p_plan_code text, p_supplier_id uuid,
    p_valid_from date, p_valid_to date, p_rates jsonb
)
RETURNS TABLE (plan_id uuid, plan_code text, version_no integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
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
    v_used boolean;
    v_changed boolean;
    v_target uuid;
BEGIN
    IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
    IF NOT (portal.has_permission('system.admin') OR portal.has_permission('comisiones.v2.plans.manage')) THEN RAISE EXCEPTION 'PERMISSION_DENIED'; END IF;
    IF NOT core.has_company_access(v_actor, p_company_id) THEN RAISE EXCEPTION 'COMPANY_ACCESS_DENIED'; END IF;
    IF NULLIF(btrim(p_plan_code), '') IS NULL THEN RAISE EXCEPTION 'PLAN_NAME_REQUIRED'; END IF;
    IF p_valid_from IS NULL OR (p_valid_to IS NOT NULL AND p_valid_to < p_valid_from) THEN RAISE EXCEPTION 'INVALID_PLAN_DATES'; END IF;
    IF p_rates IS NULL OR jsonb_typeof(p_rates) <> 'array' THEN RAISE EXCEPTION 'INVALID_FAMILY_RATES'; END IF;
    IF NOT EXISTS (SELECT 1 FROM adquisiciones.suppliers s WHERE s.id = p_supplier_id AND s.company_id = p_company_id AND s.supplier_kind = 'REAL' AND s.status = 'ACTIVE' AND s.is_active) THEN RAISE EXCEPTION 'SUPPLIER_MUST_BE_REAL_AND_ACTIVE'; END IF;

    FOR v_rate IN SELECT value FROM jsonb_array_elements(p_rates) LOOP
        v_family_id := (v_rate ->> 'family_bsale_product_type_id')::integer;
        v_family_name := COALESCE(NULLIF(btrim(v_rate ->> 'family_name_snapshot'), ''), NULLIF(btrim(v_rate ->> 'family_name'), ''));
        v_percentage := (v_rate ->> 'percentage')::numeric;
        IF v_family_id IS NULL OR v_family_id <= 0 OR v_family_name IS NULL OR v_percentage IS NULL OR v_percentage < 0 OR v_percentage > 100 THEN RAISE EXCEPTION 'INVALID_FAMILY_RATE'; END IF;
        IF NOT EXISTS (SELECT 1 FROM comisiones.vw_real_supplier_families f WHERE f.company_id = p_company_id AND f.supplier_id = p_supplier_id AND f.family_bsale_product_type_id = v_family_id) THEN RAISE EXCEPTION 'FAMILY_NOT_ASSOCIATED_TO_SUPPLIER'; END IF;
    END LOOP;

    PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':' || p_supplier_id::text || ':FAMILY_FIXED_PERCENT', 0));
    IF p_plan_id IS NULL THEN
        SELECT COALESCE(max(cp.version_no), 0) + 1 INTO v_version FROM comisiones.commission_plans cp WHERE cp.company_id = p_company_id AND cp.plan_code = btrim(p_plan_code);
        INSERT INTO comisiones.commission_plans (company_id, supplier_id, plan_code, version_no, plan_type, valid_from, valid_to, status, active, created_by, updated_by)
        VALUES (p_company_id, p_supplier_id, btrim(p_plan_code), v_version, 'FAMILY_FIXED_PERCENT', p_valid_from, p_valid_to, 'ACTIVE', true, v_actor, v_actor) RETURNING * INTO v_plan;
        v_target := v_plan.id;
    ELSE
        SELECT * INTO v_plan FROM comisiones.commission_plans cp WHERE cp.id = p_plan_id AND cp.company_id = p_company_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'PLAN_NOT_FOUND'; END IF;
        IF v_plan.supplier_id <> p_supplier_id THEN RAISE EXCEPTION 'SUPPLIER_CANNOT_CHANGE'; END IF;
        IF v_plan.plan_type <> 'FAMILY_FIXED_PERCENT' THEN RAISE EXCEPTION 'PLAN_TYPE_CANNOT_CHANGE'; END IF;
        SELECT EXISTS (SELECT 1 FROM comisiones.settlement_lines sl WHERE sl.company_id = p_company_id AND (sl.plan_id = v_plan.id OR sl.family_rate_id IN (SELECT fr.id FROM comisiones.commission_plan_family_rates fr WHERE fr.company_id = p_company_id AND fr.plan_id = v_plan.id))) INTO v_used;
        SELECT btrim(p_plan_code) IS DISTINCT FROM v_plan.plan_code
            OR p_valid_from IS DISTINCT FROM v_plan.valid_from
            OR p_valid_to IS DISTINCT FROM v_plan.valid_to
            OR (SELECT count(*) FROM comisiones.commission_plan_family_rates fr WHERE fr.company_id = p_company_id AND fr.plan_id = v_plan.id) <> jsonb_array_length(p_rates)
            OR EXISTS (SELECT 1 FROM comisiones.commission_plan_family_rates fr WHERE fr.company_id = p_company_id AND fr.plan_id = v_plan.id AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_rates) r WHERE (r ->> 'family_bsale_product_type_id')::integer = fr.family_bsale_product_type_id AND (r ->> 'percentage')::numeric = fr.percentage AND COALESCE(NULLIF(btrim(r ->> 'family_name_snapshot'), ''), NULLIF(btrim(r ->> 'family_name'), '')) = fr.family_name_snapshot)) INTO v_changed;
        IF v_used AND v_changed THEN
            UPDATE comisiones.commission_plans SET status = 'RETIRED', active = false, updated_by = v_actor WHERE id = v_plan.id;
            SELECT COALESCE(max(cp.version_no), 0) + 1 INTO v_version FROM comisiones.commission_plans cp WHERE cp.company_id = p_company_id AND cp.plan_code = btrim(p_plan_code);
            INSERT INTO comisiones.commission_plans (company_id, supplier_id, plan_code, version_no, plan_type, valid_from, valid_to, status, active, supersedes_plan_id, reason, created_by, updated_by)
            VALUES (p_company_id, p_supplier_id, btrim(p_plan_code), v_version, 'FAMILY_FIXED_PERCENT', p_valid_from, p_valid_to, 'ACTIVE', true, v_plan.id, 'Nueva versión para preservar snapshot de liquidación', v_actor, v_actor) RETURNING * INTO v_plan;
            v_target := v_plan.id;
        ELSE
            UPDATE comisiones.commission_plans SET plan_code = btrim(p_plan_code), valid_from = p_valid_from, valid_to = p_valid_to, status = 'ACTIVE', active = true, updated_by = v_actor WHERE id = v_plan.id;
            v_target := v_plan.id;
        END IF;
    END IF;

    IF NOT (v_used AND NOT v_changed) THEN
        DELETE FROM comisiones.commission_plan_family_rates WHERE company_id = p_company_id AND plan_id = v_target;
        FOR v_rate IN SELECT value FROM jsonb_array_elements(p_rates) LOOP
            INSERT INTO comisiones.commission_plan_family_rates (company_id, plan_id, family_bsale_product_type_id, family_name_snapshot, percentage, created_by, updated_by)
            VALUES (p_company_id, v_target, (v_rate ->> 'family_bsale_product_type_id')::integer, COALESCE(NULLIF(btrim(v_rate ->> 'family_name_snapshot'), ''), NULLIF(btrim(v_rate ->> 'family_name'), '')), (v_rate ->> 'percentage')::numeric, v_actor, v_actor);
        END LOOP;
    END IF;
    RETURN QUERY SELECT cp.id, cp.plan_code, cp.version_no FROM comisiones.commission_plans cp WHERE cp.id = v_target;
END;
$$;

CREATE OR REPLACE FUNCTION comisiones.save_supplier_sales_target_plan(
    p_company_id uuid, p_plan_id uuid, p_plan_code text, p_supplier_id uuid,
    p_valid_from date, p_valid_to date, p_tiers jsonb
)
RETURNS TABLE (plan_id uuid, plan_code text, version_no integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, comisiones, adquisiciones
AS $$
DECLARE
    v_actor uuid := auth.uid(); v_plan comisiones.commission_plans%ROWTYPE;
    v_tier jsonb; v_expected integer := 1; v_order integer; v_lower numeric; v_upper numeric; v_percentage numeric; v_previous_upper numeric;
    v_version integer; v_used boolean; v_changed boolean; v_target uuid;
BEGIN
    IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
    IF NOT (portal.has_permission('system.admin') OR portal.has_permission('comisiones.v2.plans.manage')) THEN RAISE EXCEPTION 'PERMISSION_DENIED'; END IF;
    IF NOT core.has_company_access(v_actor, p_company_id) THEN RAISE EXCEPTION 'COMPANY_ACCESS_DENIED'; END IF;
    IF NULLIF(btrim(p_plan_code), '') IS NULL THEN RAISE EXCEPTION 'PLAN_NAME_REQUIRED'; END IF;
    IF p_valid_from IS NULL OR (p_valid_to IS NOT NULL AND p_valid_to < p_valid_from) THEN RAISE EXCEPTION 'INVALID_PLAN_DATES'; END IF;
    IF p_tiers IS NULL OR jsonb_typeof(p_tiers) <> 'array' OR jsonb_array_length(p_tiers) = 0 THEN RAISE EXCEPTION 'TARGET_TIERS_REQUIRED'; END IF;
    IF NOT EXISTS (SELECT 1 FROM adquisiciones.suppliers s WHERE s.id = p_supplier_id AND s.company_id = p_company_id AND s.supplier_kind = 'REAL' AND s.status = 'ACTIVE' AND s.is_active) THEN RAISE EXCEPTION 'SUPPLIER_MUST_BE_REAL_AND_ACTIVE'; END IF;
    FOR v_tier IN SELECT value FROM jsonb_array_elements(p_tiers) ORDER BY (value ->> 'tier_order')::integer LOOP
        v_order := (v_tier ->> 'tier_order')::integer; v_lower := (v_tier ->> 'lower_bound')::numeric; v_upper := NULLIF(v_tier ->> 'upper_bound', '')::numeric; v_percentage := (v_tier ->> 'percentage')::numeric;
        IF v_order IS NULL OR v_order <> v_expected OR v_lower IS NULL OR v_lower <> trunc(v_lower) OR v_lower < 0 OR v_percentage IS NULL OR v_percentage < 0 OR v_percentage > 100 OR (v_upper IS NOT NULL AND (v_upper <> trunc(v_upper) OR v_upper < v_lower)) OR (v_expected = 1 AND v_lower <> 0) OR (v_expected > 1 AND v_previous_upper IS NULL) OR (v_expected > 1 AND v_lower <> v_previous_upper + 1) OR (v_upper IS NULL AND v_expected < jsonb_array_length(p_tiers)) THEN RAISE EXCEPTION 'INVALID_TARGET_TIER'; END IF;
        v_previous_upper := v_upper; v_expected := v_expected + 1;
    END LOOP;

    PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':' || p_supplier_id::text || ':SUPPLIER_SALES_TARGET', 0));
    IF p_plan_id IS NULL THEN
        SELECT COALESCE(max(cp.version_no), 0) + 1 INTO v_version FROM comisiones.commission_plans cp WHERE cp.company_id = p_company_id AND cp.plan_code = btrim(p_plan_code);
        INSERT INTO comisiones.commission_plans (company_id, supplier_id, plan_code, version_no, plan_type, valid_from, valid_to, status, active, created_by, updated_by) VALUES (p_company_id, p_supplier_id, btrim(p_plan_code), v_version, 'SUPPLIER_SALES_TARGET', p_valid_from, p_valid_to, 'ACTIVE', true, v_actor, v_actor) RETURNING * INTO v_plan; v_target := v_plan.id;
    ELSE
        SELECT * INTO v_plan FROM comisiones.commission_plans cp WHERE cp.id = p_plan_id AND cp.company_id = p_company_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'PLAN_NOT_FOUND'; END IF;
        IF v_plan.supplier_id <> p_supplier_id THEN RAISE EXCEPTION 'SUPPLIER_CANNOT_CHANGE'; END IF;
        IF v_plan.plan_type <> 'SUPPLIER_SALES_TARGET' THEN RAISE EXCEPTION 'PLAN_TYPE_CANNOT_CHANGE'; END IF;
        SELECT EXISTS (SELECT 1 FROM comisiones.settlement_lines sl WHERE sl.company_id = p_company_id AND (sl.plan_id = v_plan.id OR sl.tier_id IN (SELECT t.id FROM comisiones.commission_plan_tiers t WHERE t.company_id = p_company_id AND t.plan_id = v_plan.id))) INTO v_used;
        SELECT btrim(p_plan_code) IS DISTINCT FROM v_plan.plan_code
            OR p_valid_from IS DISTINCT FROM v_plan.valid_from
            OR p_valid_to IS DISTINCT FROM v_plan.valid_to
            OR (SELECT count(*) FROM comisiones.commission_plan_tiers t WHERE t.company_id = p_company_id AND t.plan_id = v_plan.id) <> jsonb_array_length(p_tiers)
            OR EXISTS (SELECT 1 FROM comisiones.commission_plan_tiers t WHERE t.company_id = p_company_id AND t.plan_id = v_plan.id AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_tiers) r WHERE (r ->> 'tier_order')::integer = t.tier_order AND (r ->> 'lower_bound')::numeric = t.lower_bound AND NULLIF(r ->> 'upper_bound', '')::numeric IS NOT DISTINCT FROM t.upper_bound AND (r ->> 'percentage')::numeric = t.percentage)) INTO v_changed;
        IF v_used AND v_changed THEN
            UPDATE comisiones.commission_plans SET status = 'RETIRED', active = false, updated_by = v_actor WHERE id = v_plan.id;
            SELECT COALESCE(max(cp.version_no), 0) + 1 INTO v_version FROM comisiones.commission_plans cp WHERE cp.company_id = p_company_id AND cp.plan_code = btrim(p_plan_code);
            INSERT INTO comisiones.commission_plans (company_id, supplier_id, plan_code, version_no, plan_type, valid_from, valid_to, status, active, supersedes_plan_id, reason, created_by, updated_by) VALUES (p_company_id, p_supplier_id, btrim(p_plan_code), v_version, 'SUPPLIER_SALES_TARGET', p_valid_from, p_valid_to, 'ACTIVE', true, v_plan.id, 'Nueva versión para preservar snapshot de liquidación', v_actor, v_actor) RETURNING * INTO v_plan; v_target := v_plan.id;
        ELSE
            UPDATE comisiones.commission_plans SET plan_code = btrim(p_plan_code), valid_from = p_valid_from, valid_to = p_valid_to, status = 'ACTIVE', active = true, updated_by = v_actor WHERE id = v_plan.id; v_target := v_plan.id;
        END IF;
    END IF;
    IF NOT (v_used AND NOT v_changed) THEN
        DELETE FROM comisiones.commission_plan_tiers WHERE company_id = p_company_id AND plan_id = v_target;
        FOR v_tier IN SELECT value FROM jsonb_array_elements(p_tiers) ORDER BY (value ->> 'tier_order')::integer LOOP
            INSERT INTO comisiones.commission_plan_tiers (company_id, plan_id, tier_order, lower_bound, upper_bound, percentage, created_by, updated_by) VALUES (p_company_id, v_target, (v_tier ->> 'tier_order')::smallint, (v_tier ->> 'lower_bound')::numeric, NULLIF(v_tier ->> 'upper_bound', '')::numeric, (v_tier ->> 'percentage')::numeric, v_actor, v_actor);
        END LOOP;
    END IF;
    RETURN QUERY SELECT cp.id, cp.plan_code, cp.version_no FROM comisiones.commission_plans cp WHERE cp.id = v_target;
END;
$$;

REVOKE ALL ON FUNCTION comisiones.get_family_fixed_plan_issued_usage(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION comisiones.get_family_fixed_plan_issued_usage(uuid, uuid[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION comisiones.save_family_fixed_plan(uuid, uuid, text, uuid, date, date, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION comisiones.save_family_fixed_plan(uuid, uuid, text, uuid, date, date, jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION comisiones.save_supplier_sales_target_plan(uuid, uuid, text, uuid, date, date, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION comisiones.save_supplier_sales_target_plan(uuid, uuid, text, uuid, date, date, jsonb) TO authenticated, service_role;

-- Conservative data repair: if a supersedes chain ever contains more than one
-- active row, retain only its greatest version. Historical rows are untouched.
DO $$
BEGIN
    WITH RECURSIVE chain AS (
        SELECT cp.id, cp.id AS root_id
        FROM comisiones.commission_plans cp
        WHERE cp.supersedes_plan_id IS NULL
        UNION ALL
        SELECT child.id, chain.root_id
        FROM chain
        JOIN comisiones.commission_plans child ON child.supersedes_plan_id = chain.id
    ), duplicates AS (
        SELECT c.root_id, cp.id,
               row_number() OVER (PARTITION BY c.root_id ORDER BY cp.version_no DESC, cp.id DESC) AS rn
        FROM chain c
        JOIN comisiones.commission_plans cp ON cp.id = c.id
        WHERE cp.active IS TRUE
    )
    UPDATE comisiones.commission_plans cp
    SET status = 'RETIRED', active = false, updated_at = now()
    FROM duplicates d
    WHERE cp.id = d.id AND d.rn > 1;
END;
$$;
