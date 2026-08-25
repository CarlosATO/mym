-- COMV2-22A: preserve target tiers referenced by any settlement snapshot.
-- Historical references are independent of settlement status.

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
    v_used boolean := false;
    v_tiers_changed boolean := false;
    v_plan_changed boolean := false;
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
        IF v_order IS NULL OR v_order <> v_expected OR v_lower IS NULL OR v_lower <> trunc(v_lower) OR v_lower < 0
           OR v_percentage IS NULL OR v_percentage < 0 OR v_percentage > 100 THEN
            RAISE EXCEPTION 'INVALID_TARGET_TIER';
        END IF;
        IF v_upper IS NOT NULL AND v_upper <> trunc(v_upper) THEN RAISE EXCEPTION 'INVALID_TARGET_TIER'; END IF;
        IF v_expected = 1 AND v_lower <> 0 THEN RAISE EXCEPTION 'TARGET_TIERS_MUST_START_AT_ZERO'; END IF;
        IF v_previous_upper IS NULL AND v_expected > 1 THEN RAISE EXCEPTION 'TARGET_TIERS_HAVE_OPEN_GAP'; END IF;
        IF v_expected > 1 AND v_lower <> v_previous_upper + 1 THEN RAISE EXCEPTION 'TARGET_TIERS_HAVE_GAP'; END IF;
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
        SELECT * INTO v_plan
        FROM comisiones.commission_plans cp
        WHERE cp.id = p_plan_id AND cp.company_id = p_company_id
        FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'PLAN_NOT_FOUND'; END IF;
        IF v_plan.supplier_id <> p_supplier_id THEN RAISE EXCEPTION 'SUPPLIER_CANNOT_CHANGE'; END IF;
        IF v_plan.plan_type <> 'SUPPLIER_SALES_TARGET' THEN RAISE EXCEPTION 'PLAN_TYPE_CANNOT_CHANGE'; END IF;

        -- Any settlement line is historical, including DRAFT and CANCELLED lines.
        SELECT EXISTS (
            SELECT 1
            FROM comisiones.settlement_lines sl
            WHERE sl.company_id = p_company_id
              AND (sl.plan_id = v_plan.id OR sl.tier_id IN (
                  SELECT t.id
                  FROM comisiones.commission_plan_tiers t
                  WHERE t.company_id = p_company_id AND t.plan_id = v_plan.id
              ))
        ) INTO v_used;

        SELECT count(*) <> jsonb_array_length(p_tiers)
            OR EXISTS (
                SELECT 1
                FROM comisiones.commission_plan_tiers t
                WHERE t.company_id = p_company_id AND t.plan_id = v_plan.id
                  AND NOT EXISTS (
                      SELECT 1
                      FROM jsonb_array_elements(p_tiers) r
                      WHERE (r ->> 'tier_order')::integer = t.tier_order
                        AND (r ->> 'lower_bound')::numeric = t.lower_bound
                        AND NULLIF(r ->> 'upper_bound', '')::numeric IS NOT DISTINCT FROM t.upper_bound
                        AND (r ->> 'percentage')::numeric = t.percentage
                  )
            )
        INTO v_tiers_changed
        FROM comisiones.commission_plan_tiers t
        WHERE t.company_id = p_company_id AND t.plan_id = v_plan.id;

        v_plan_changed := btrim(p_plan_code) IS DISTINCT FROM v_plan.plan_code
            OR p_valid_from IS DISTINCT FROM v_plan.valid_from
            OR p_valid_to IS DISTINCT FROM v_plan.valid_to
            OR v_tiers_changed;

        IF v_used AND v_plan_changed THEN
            -- Retiring first prevents an active-period exclusion conflict and leaves
            -- every historical plan/tier ID and snapshot untouched.
            UPDATE comisiones.commission_plans
            SET status = 'RETIRED', active = false, updated_by = v_actor
            WHERE id = v_plan.id AND company_id = p_company_id;

            SELECT COALESCE(max(cp.version_no), 0) + 1 INTO v_version
            FROM comisiones.commission_plans cp
            WHERE cp.company_id = p_company_id AND cp.plan_code = btrim(p_plan_code);
            INSERT INTO comisiones.commission_plans (company_id, supplier_id, plan_code, version_no, plan_type, valid_from, valid_to, status, active, supersedes_plan_id, reason, created_by, updated_by)
            VALUES (p_company_id, p_supplier_id, btrim(p_plan_code), v_version, 'SUPPLIER_SALES_TARGET', p_valid_from, p_valid_to, 'ACTIVE', true, v_plan.id, 'Nueva versión para preservar snapshot de liquidación', v_actor, v_actor)
            RETURNING * INTO v_plan;
            v_target_plan_id := v_plan.id;
        ELSE
            UPDATE comisiones.commission_plans
            SET plan_code = btrim(p_plan_code), valid_from = p_valid_from, valid_to = p_valid_to,
                status = 'ACTIVE', active = true, updated_by = v_actor
            WHERE id = v_plan.id AND company_id = p_company_id;
            v_target_plan_id := v_plan.id;
        END IF;
    END IF;

    DELETE FROM comisiones.commission_plan_tiers t
    WHERE t.company_id = p_company_id AND t.plan_id = v_target_plan_id;
    FOR v_tier IN SELECT value FROM jsonb_array_elements(p_tiers) ORDER BY (value ->> 'tier_order')::integer LOOP
        INSERT INTO comisiones.commission_plan_tiers (company_id, plan_id, tier_order, lower_bound, upper_bound, percentage, created_by, updated_by)
        VALUES (p_company_id, v_target_plan_id, (v_tier ->> 'tier_order')::smallint, (v_tier ->> 'lower_bound')::numeric, NULLIF(v_tier ->> 'upper_bound', '')::numeric, (v_tier ->> 'percentage')::numeric, v_actor, v_actor);
    END LOOP;
    RETURN QUERY SELECT cp.id, cp.plan_code, cp.version_no
    FROM comisiones.commission_plans cp WHERE cp.id = v_target_plan_id;
END;
$$;

REVOKE ALL ON FUNCTION comisiones.save_supplier_sales_target_plan(uuid, uuid, text, uuid, date, date, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION comisiones.save_supplier_sales_target_plan(uuid, uuid, text, uuid, date, date, jsonb) TO authenticated, service_role;
