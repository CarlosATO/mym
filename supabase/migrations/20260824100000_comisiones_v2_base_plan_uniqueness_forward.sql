-- COMV2-16.1: forward-only protection for base-plan and family coverage.

CREATE OR REPLACE FUNCTION comisiones.get_base_plan_conflicts(
    p_company_id uuid,
    p_supplier_id uuid,
    p_valid_from date,
    p_valid_to date,
    p_exclude_plan_id uuid DEFAULT NULL
)
RETURNS TABLE (
    conflict_plan_id uuid,
    conflict_plan_code text,
    conflict_plan_type text,
    conflict_valid_from date,
    conflict_valid_to date
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, auth, core, portal, comisiones, adquisiciones
AS $$
    SELECT cp.id, cp.plan_code, cp.plan_type, cp.valid_from, cp.valid_to
    FROM comisiones.commission_plans cp
    WHERE cp.company_id = p_company_id
      AND cp.supplier_id = p_supplier_id
      AND cp.plan_type IN ('FAMILY_FIXED_PERCENT', 'SUPPLIER_SALES_TARGET')
      AND cp.active IS TRUE
      AND (p_exclude_plan_id IS NULL OR cp.id <> p_exclude_plan_id)
      AND cp.valid_from <= COALESCE(p_valid_to, '9999-12-31'::date)
      AND (cp.valid_to IS NULL OR cp.valid_to >= p_valid_from)
    ORDER BY cp.valid_from DESC, cp.version_no DESC, cp.id
$$;

CREATE OR REPLACE FUNCTION comisiones.get_family_fixed_plan_conflicts(
    p_company_id uuid,
    p_supplier_id uuid,
    p_valid_from date,
    p_valid_to date,
    p_exclude_plan_id uuid DEFAULT NULL
)
RETURNS TABLE (
    family_bsale_product_type_id integer,
    family_name text,
    conflict_plan_id uuid,
    conflict_plan_code text,
    conflict_valid_from date,
    conflict_valid_to date
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, auth, core, portal, comisiones, adquisiciones
AS $$
    SELECT fr.family_bsale_product_type_id,
           fr.family_name_snapshot,
           cp.id,
           cp.plan_code,
           cp.valid_from,
           cp.valid_to
    FROM comisiones.commission_plan_family_rates fr
    JOIN comisiones.commission_plans cp
      ON cp.company_id = fr.company_id AND cp.id = fr.plan_id
    WHERE fr.company_id = p_company_id
      AND cp.supplier_id = p_supplier_id
      AND cp.plan_type = 'FAMILY_FIXED_PERCENT'
      AND cp.active IS TRUE
      AND (p_exclude_plan_id IS NULL OR cp.id <> p_exclude_plan_id)
      AND cp.valid_from <= COALESCE(p_valid_to, '9999-12-31'::date)
      AND (cp.valid_to IS NULL OR cp.valid_to >= p_valid_from)
    ORDER BY fr.family_name_snapshot, cp.valid_from DESC, cp.version_no DESC
$$;

CREATE OR REPLACE FUNCTION comisiones.guard_base_plan_overlap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, comisiones, adquisiciones
AS $$
DECLARE
    v_conflict comisiones.commission_plans%ROWTYPE;
BEGIN
    IF NEW.plan_type NOT IN ('FAMILY_FIXED_PERCENT', 'SUPPLIER_SALES_TARGET') OR NEW.active IS NOT TRUE THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.company_id::text || ':' || NEW.supplier_id::text, 0));
    SELECT cp.* INTO v_conflict
    FROM comisiones.commission_plans cp
    WHERE cp.company_id = NEW.company_id
      AND cp.supplier_id = NEW.supplier_id
      AND cp.plan_type IN ('FAMILY_FIXED_PERCENT', 'SUPPLIER_SALES_TARGET')
      AND cp.active IS TRUE
      AND cp.id <> NEW.id
      AND cp.valid_from <= COALESCE(NEW.valid_to, '9999-12-31'::date)
      AND (cp.valid_to IS NULL OR cp.valid_to >= NEW.valid_from)
    ORDER BY cp.valid_from DESC, cp.version_no DESC, cp.id
    LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'BASE_PLAN_ALREADY_COVERED:%:%:%:%', v_conflict.plan_code, v_conflict.plan_type, v_conflict.valid_from, v_conflict.valid_to;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION comisiones.guard_family_fixed_plan_rate_conflict()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, comisiones, adquisiciones
AS $$
DECLARE
    v_plan comisiones.commission_plans%ROWTYPE;
    v_conflict text;
BEGIN
    SELECT cp.* INTO v_plan
    FROM comisiones.commission_plans cp
    WHERE cp.id = NEW.plan_id AND cp.company_id = NEW.company_id;
    IF NOT FOUND OR v_plan.plan_type <> 'FAMILY_FIXED_PERCENT' OR v_plan.active IS NOT TRUE THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.company_id::text || ':' || v_plan.supplier_id::text, 0));
    SELECT conflict_plan_code INTO v_conflict
    FROM comisiones.get_family_fixed_plan_conflicts(
        NEW.company_id, v_plan.supplier_id, v_plan.valid_from, v_plan.valid_to, NEW.plan_id
    ) conflict
    WHERE conflict.family_bsale_product_type_id = NEW.family_bsale_product_type_id
    LIMIT 1;
    IF v_conflict IS NOT NULL THEN
        RAISE EXCEPTION 'FAMILY_ALREADY_COVERED:%:%', NEW.family_bsale_product_type_id, v_conflict;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_base_plan_overlap ON comisiones.commission_plans;
CREATE TRIGGER guard_base_plan_overlap
BEFORE INSERT OR UPDATE OF supplier_id, plan_type, valid_from, valid_to, active
ON comisiones.commission_plans
FOR EACH ROW EXECUTE FUNCTION comisiones.guard_base_plan_overlap();

DROP TRIGGER IF EXISTS guard_family_fixed_plan_rate_conflict ON comisiones.commission_plan_family_rates;
CREATE TRIGGER guard_family_fixed_plan_rate_conflict
BEFORE INSERT ON comisiones.commission_plan_family_rates
FOR EACH ROW EXECUTE FUNCTION comisiones.guard_family_fixed_plan_rate_conflict();

REVOKE ALL ON FUNCTION comisiones.get_base_plan_conflicts(uuid, uuid, date, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION comisiones.get_base_plan_conflicts(uuid, uuid, date, date, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION comisiones.get_family_fixed_plan_conflicts(uuid, uuid, date, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION comisiones.get_family_fixed_plan_conflicts(uuid, uuid, date, date, uuid) TO authenticated, service_role;
