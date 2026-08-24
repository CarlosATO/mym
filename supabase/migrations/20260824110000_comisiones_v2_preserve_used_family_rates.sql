-- COMV2-20A: never replace family rates already referenced by a settlement snapshot.
-- Draft snapshots are historical working documents too and must retain their FK.

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
    v_used boolean := false;
    v_issued boolean := false;
    v_rates_changed boolean := false;
    v_plan_changed boolean := false;
    v_issued_to date;
    v_target_plan_id uuid;
BEGIN
    IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
    IF NOT (portal.has_permission('system.admin') OR portal.has_permission('comisiones.v2.plans.manage')) THEN RAISE EXCEPTION 'PERMISSION_DENIED'; END IF;
    IF NOT core.has_company_access(v_actor, p_company_id) THEN RAISE EXCEPTION 'COMPANY_ACCESS_DENIED'; END IF;
    IF NULLIF(btrim(p_plan_code), '') IS NULL THEN RAISE EXCEPTION 'PLAN_NAME_REQUIRED'; END IF;
    IF p_valid_from IS NULL OR (p_valid_to IS NOT NULL AND p_valid_to < p_valid_from) THEN RAISE EXCEPTION 'INVALID_PLAN_DATES'; END IF;
    IF p_rates IS NULL OR jsonb_typeof(p_rates) <> 'array' THEN RAISE EXCEPTION 'INVALID_FAMILY_RATES'; END IF;
    IF NOT EXISTS (
        SELECT 1 FROM adquisiciones.suppliers s
        WHERE s.id = p_supplier_id AND s.company_id = p_company_id
          AND s.supplier_kind = 'REAL' AND s.status = 'ACTIVE' AND s.is_active IS TRUE
    ) THEN RAISE EXCEPTION 'SUPPLIER_MUST_BE_REAL_AND_ACTIVE'; END IF;

    FOR v_rate IN SELECT value FROM jsonb_array_elements(p_rates) LOOP
        v_family_id := (v_rate ->> 'family_bsale_product_type_id')::integer;
        v_family_name := COALESCE(NULLIF(btrim(v_rate ->> 'family_name_snapshot'), ''), NULLIF(btrim(v_rate ->> 'family_name'), ''));
        v_percentage := (v_rate ->> 'percentage')::numeric;
        IF v_family_id IS NULL OR v_family_id <= 0 OR v_family_name IS NULL OR v_percentage IS NULL OR v_percentage < 0 OR v_percentage > 100 THEN RAISE EXCEPTION 'INVALID_FAMILY_RATE'; END IF;
        IF NOT EXISTS (
            SELECT 1 FROM comisiones.vw_real_supplier_families f
            WHERE f.company_id = p_company_id AND f.supplier_id = p_supplier_id
              AND f.family_bsale_product_type_id = v_family_id
        ) THEN RAISE EXCEPTION 'FAMILY_NOT_ASSOCIATED_TO_SUPPLIER'; END IF;
    END LOOP;

    IF p_plan_id IS NULL THEN
        SELECT COALESCE(max(cp.version_no), 0) + 1 INTO v_version
        FROM comisiones.commission_plans cp
        WHERE cp.company_id = p_company_id AND cp.plan_code = btrim(p_plan_code);
        INSERT INTO comisiones.commission_plans (company_id, supplier_id, plan_code, version_no, plan_type, valid_from, valid_to, status, active, created_by, updated_by)
        VALUES (p_company_id, p_supplier_id, btrim(p_plan_code), v_version, 'FAMILY_FIXED_PERCENT', p_valid_from, p_valid_to, 'ACTIVE', true, v_actor, v_actor)
        RETURNING * INTO v_plan;
        v_target_plan_id := v_plan.id;
    ELSE
        SELECT * INTO v_plan
        FROM comisiones.commission_plans cp
        WHERE cp.id = p_plan_id AND cp.company_id = p_company_id
        FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'PLAN_NOT_FOUND'; END IF;
        IF v_plan.supplier_id <> p_supplier_id THEN RAISE EXCEPTION 'SUPPLIER_CANNOT_CHANGE'; END IF;
        IF v_plan.plan_type <> 'FAMILY_FIXED_PERCENT' THEN RAISE EXCEPTION 'PLAN_TYPE_CANNOT_CHANGE'; END IF;

        SELECT EXISTS (
            SELECT 1 FROM comisiones.settlement_lines sl
            WHERE sl.company_id = p_company_id
              AND (sl.plan_id = v_plan.id OR sl.family_rate_id IN (
                  SELECT fr.id FROM comisiones.commission_plan_family_rates fr
                  WHERE fr.company_id = p_company_id AND fr.plan_id = v_plan.id
              ))
        ), EXISTS (
            SELECT 1
            FROM comisiones.settlement_lines sl
            JOIN comisiones.settlements st ON st.company_id = sl.company_id AND st.id = sl.settlement_id
            WHERE sl.company_id = p_company_id
              AND (sl.plan_id = v_plan.id OR sl.family_rate_id IN (
                  SELECT fr.id FROM comisiones.commission_plan_family_rates fr
                  WHERE fr.company_id = p_company_id AND fr.plan_id = v_plan.id
              ))
              AND st.status = 'ISSUED'
        ), max(st.period_to) FILTER (WHERE st.status = 'ISSUED')
        INTO v_used, v_issued, v_issued_to
        FROM comisiones.settlement_lines sl
        JOIN comisiones.settlements st ON st.company_id = sl.company_id AND st.id = sl.settlement_id
        WHERE sl.company_id = p_company_id
          AND (sl.plan_id = v_plan.id OR sl.family_rate_id IN (
              SELECT fr.id FROM comisiones.commission_plan_family_rates fr
              WHERE fr.company_id = p_company_id AND fr.plan_id = v_plan.id
          ));

        v_rates_changed := (
            (SELECT count(*) FROM comisiones.commission_plan_family_rates fr WHERE fr.company_id = p_company_id AND fr.plan_id = v_plan.id) <> jsonb_array_length(p_rates)
            OR EXISTS (
                SELECT 1 FROM comisiones.commission_plan_family_rates fr
                WHERE fr.company_id = p_company_id AND fr.plan_id = v_plan.id
                  AND NOT EXISTS (
                      SELECT 1 FROM jsonb_array_elements(p_rates) r
                      WHERE (r ->> 'family_bsale_product_type_id')::integer = fr.family_bsale_product_type_id
                        AND (r ->> 'percentage')::numeric = fr.percentage
                        AND COALESCE(NULLIF(btrim(r ->> 'family_name_snapshot'), ''), NULLIF(btrim(r ->> 'family_name'), '')) = fr.family_name_snapshot
                  )
            )
        );
        v_plan_changed :=
            btrim(p_plan_code) <> v_plan.plan_code
            OR p_valid_from <> v_plan.valid_from
            OR p_valid_to IS DISTINCT FROM v_plan.valid_to
            OR v_rates_changed;

        IF v_issued AND v_plan_changed THEN
            IF v_issued_to IS NULL OR p_valid_from <= v_issued_to THEN RAISE EXCEPTION 'VERSION_MUST_START_AFTER_ISSUED_PERIOD'; END IF;
        END IF;

        IF v_used AND v_plan_changed THEN
            IF p_valid_from > v_plan.valid_from THEN
                UPDATE comisiones.commission_plans
                SET valid_to = p_valid_from - 1, updated_by = v_actor
                WHERE id = v_plan.id;
            ELSE
                UPDATE comisiones.commission_plans
                SET status = 'RETIRED', active = false, updated_by = v_actor
                WHERE id = v_plan.id;
            END IF;
            SELECT COALESCE(max(cp.version_no), 0) + 1 INTO v_version
            FROM comisiones.commission_plans cp
            WHERE cp.company_id = p_company_id AND cp.plan_code = btrim(p_plan_code);
            INSERT INTO comisiones.commission_plans (company_id, supplier_id, plan_code, version_no, plan_type, valid_from, valid_to, status, active, supersedes_plan_id, reason, created_by, updated_by)
            VALUES (p_company_id, p_supplier_id, btrim(p_plan_code), v_version, 'FAMILY_FIXED_PERCENT', p_valid_from, p_valid_to, 'ACTIVE', true, v_plan.id, 'Nueva versión para preservar snapshot de liquidación', v_actor, v_actor)
            RETURNING * INTO v_plan;
            v_target_plan_id := v_plan.id;
        ELSE
            IF v_issued AND p_valid_to IS NOT NULL AND v_issued_to IS NOT NULL AND p_valid_to < v_issued_to THEN RAISE EXCEPTION 'VALID_TO_CANNOT_PRECEDE_ISSUED_PERIOD'; END IF;
            UPDATE comisiones.commission_plans
            SET plan_code = btrim(p_plan_code), valid_from = p_valid_from, valid_to = p_valid_to,
                status = 'ACTIVE', active = true, updated_by = v_actor
            WHERE id = v_plan.id AND company_id = p_company_id;
            v_target_plan_id := v_plan.id;
        END IF;
    END IF;

    DELETE FROM comisiones.commission_plan_family_rates fr
    WHERE fr.company_id = p_company_id AND fr.plan_id = v_target_plan_id;
    FOR v_rate IN SELECT value FROM jsonb_array_elements(p_rates) LOOP
        v_family_id := (v_rate ->> 'family_bsale_product_type_id')::integer;
        v_family_name := COALESCE(NULLIF(btrim(v_rate ->> 'family_name_snapshot'), ''), NULLIF(btrim(v_rate ->> 'family_name'), ''));
        v_percentage := (v_rate ->> 'percentage')::numeric;
        INSERT INTO comisiones.commission_plan_family_rates (company_id, plan_id, family_bsale_product_type_id, family_name_snapshot, percentage, created_by, updated_by)
        VALUES (p_company_id, v_target_plan_id, v_family_id, v_family_name, v_percentage, v_actor, v_actor);
    END LOOP;
    RETURN QUERY SELECT cp.id, cp.plan_code, cp.version_no
    FROM comisiones.commission_plans cp WHERE cp.id = v_target_plan_id;
END;
$$;

REVOKE ALL ON FUNCTION comisiones.save_family_fixed_plan(uuid, uuid, text, uuid, date, date, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION comisiones.save_family_fixed_plan(uuid, uuid, text, uuid, date, date, jsonb) TO authenticated, service_role;
