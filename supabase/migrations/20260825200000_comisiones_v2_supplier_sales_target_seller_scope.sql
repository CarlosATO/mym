-- COMV2-31A: seller scope for SUPPLIER_SALES_TARGET plans.
-- NULL seller_bsale_id means that the plan applies to every seller.

ALTER TABLE comisiones.commission_plans
    ADD COLUMN seller_bsale_id bigint;

ALTER TABLE comisiones.commission_plans
    ADD CONSTRAINT fk_comisiones_plans_seller_profile
    FOREIGN KEY (company_id, seller_bsale_id)
    REFERENCES comisiones.seller_profiles(company_id, seller_bsale_id)
    ON DELETE RESTRICT;

ALTER TABLE comisiones.commission_plans
    ADD CONSTRAINT chk_comisiones_plans_seller_scope
    CHECK (
        (plan_type = 'SUPPLIER_SALES_TARGET')
        OR seller_bsale_id IS NULL
    );

-- The old exclusion covered every plan for a supplier, which also blocked the
-- supported general + seller-specific combination.
ALTER TABLE comisiones.commission_plans
    DROP CONSTRAINT ex_comisiones_plans_active_supplier_period;

DROP INDEX IF EXISTS comisiones.uq_comisiones_plans_one_active_logical_rule;

CREATE UNIQUE INDEX uq_comisiones_plans_one_active_scoped_logical_rule
    ON comisiones.commission_plans
       (company_id, supplier_id, plan_code, plan_type, seller_bsale_id)
    WHERE active IS TRUE;

CREATE INDEX idx_comisiones_plans_active_supplier_scope_period
    ON comisiones.commission_plans
       (company_id, supplier_id, seller_bsale_id, valid_from, valid_to)
    WHERE active IS TRUE;

CREATE OR REPLACE FUNCTION comisiones.guard_supplier_sales_target_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, comisiones, adquisiciones
AS $$
DECLARE
    v_conflict comisiones.commission_plans%ROWTYPE;
BEGIN
    IF NEW.plan_type = 'FAMILY_FIXED_PERCENT' AND NEW.seller_bsale_id IS NOT NULL THEN
        RAISE EXCEPTION 'FAMILY_PLAN_CANNOT_HAVE_SELLER';
    END IF;

    IF NEW.seller_bsale_id IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM comisiones.seller_profiles sp
           WHERE sp.company_id = NEW.company_id
             AND sp.seller_bsale_id = NEW.seller_bsale_id
             AND sp.active IS TRUE
             AND sp.is_commissionable IS TRUE
       ) THEN
        RAISE EXCEPTION 'SELLER_MUST_BE_ACTIVE_COMMISSIONABLE';
    END IF;

    IF NEW.active IS NOT TRUE THEN
        RETURN NEW;
    END IF;

    -- Serialize all plan changes for this supplier. A target plan conflicts
    -- only with the same scope; a family plan still conflicts with every
    -- target plan, preserving the existing family/target boundary.
    PERFORM pg_advisory_xact_lock(
        hashtextextended(NEW.company_id::text || ':' || NEW.supplier_id::text, 0)
    );

    SELECT cp.*
    INTO v_conflict
    FROM comisiones.commission_plans cp
    WHERE cp.company_id = NEW.company_id
      AND cp.supplier_id = NEW.supplier_id
      AND cp.active IS TRUE
      AND cp.id <> NEW.id
      AND cp.valid_from <= COALESCE(NEW.valid_to, '9999-12-31'::date)
      AND (cp.valid_to IS NULL OR cp.valid_to >= NEW.valid_from)
      AND (
          NEW.plan_type = 'FAMILY_FIXED_PERCENT'
          OR cp.plan_type = 'FAMILY_FIXED_PERCENT'
          OR (
              cp.plan_type = 'SUPPLIER_SALES_TARGET'
              AND NEW.plan_type = 'SUPPLIER_SALES_TARGET'
              AND cp.seller_bsale_id IS NOT DISTINCT FROM NEW.seller_bsale_id
          )
      )
    ORDER BY cp.valid_from DESC, cp.version_no DESC, cp.id
    LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION 'PLAN_SCOPE_ALREADY_COVERED:%:%:%:%',
            v_conflict.plan_code, v_conflict.plan_type,
            v_conflict.valid_from, v_conflict.valid_to;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_supplier_sales_target_scope ON comisiones.commission_plans;
DROP TRIGGER IF EXISTS guard_base_plan_overlap ON comisiones.commission_plans;
CREATE TRIGGER guard_supplier_sales_target_scope
BEFORE INSERT OR UPDATE OF supplier_id, plan_type, seller_bsale_id,
    valid_from, valid_to, active
ON comisiones.commission_plans
FOR EACH ROW EXECUTE FUNCTION comisiones.guard_supplier_sales_target_scope();

-- Extend the already version-aware target save contract without changing the
-- historical seven-argument entry point used by existing clients.
DO $$
DECLARE
    v_definition text;
BEGIN
    SELECT pg_get_functiondef(
        'comisiones.save_supplier_sales_target_plan(uuid,uuid,text,uuid,date,date,jsonb)'::regprocedure
    ) INTO v_definition;

    v_definition := regexp_replace(
        v_definition,
        'p_tiers jsonb[[:space:]]*\)',
        'p_tiers jsonb, p_seller_bsale_id bigint DEFAULT NULL)',
        1,
        1
    );
    IF v_definition = pg_get_functiondef(
        'comisiones.save_supplier_sales_target_plan(uuid,uuid,text,uuid,date,date,jsonb)'::regprocedure
    ) THEN
        RAISE EXCEPTION 'TARGET_SAVE_SIGNATURE_NOT_FOUND';
    END IF;

    v_definition := replace(
        v_definition,
        E'BEGIN\n',
        $body$BEGIN
    IF p_seller_bsale_id IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM comisiones.seller_profiles sp
           WHERE sp.company_id = p_company_id
             AND sp.seller_bsale_id = p_seller_bsale_id
             AND sp.active IS TRUE
             AND sp.is_commissionable IS TRUE
       ) THEN
        RAISE EXCEPTION 'SELLER_MUST_BE_ACTIVE_COMMISSIONABLE';
    END IF;
 $body$
    );
    v_definition := replace(
        v_definition,
        'plan_type, valid_from, valid_to',
        'plan_type, seller_bsale_id, valid_from, valid_to'
    );
    v_definition := replace(
        v_definition,
        '''SUPPLIER_SALES_TARGET'', p_valid_from, p_valid_to',
        '''SUPPLIER_SALES_TARGET'', p_seller_bsale_id, p_valid_from, p_valid_to'
    );
    v_definition := replace(
        v_definition,
        'IF v_plan.plan_type <> ''SUPPLIER_SALES_TARGET'' THEN RAISE EXCEPTION ''PLAN_TYPE_CANNOT_CHANGE''; END IF;',
        'IF v_plan.plan_type <> ''SUPPLIER_SALES_TARGET'' THEN RAISE EXCEPTION ''PLAN_TYPE_CANNOT_CHANGE''; END IF;
         IF v_plan.seller_bsale_id IS DISTINCT FROM p_seller_bsale_id THEN RAISE EXCEPTION ''SELLER_CANNOT_CHANGE''; END IF;'
    );
    EXECUTE v_definition;
END;
$$;

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
    v_seller_bsale_id bigint;
BEGIN
    IF p_plan_id IS NOT NULL THEN
        SELECT cp.seller_bsale_id INTO v_seller_bsale_id
        FROM comisiones.commission_plans cp
        WHERE cp.company_id = p_company_id AND cp.id = p_plan_id;
    END IF;
    RETURN QUERY
    SELECT * FROM comisiones.save_supplier_sales_target_plan(
        p_company_id, p_plan_id, p_plan_code, p_supplier_id,
        p_valid_from, p_valid_to, p_tiers, v_seller_bsale_id
    );
END;
$$;

REVOKE ALL ON FUNCTION comisiones.save_supplier_sales_target_plan(uuid,uuid,text,uuid,date,date,jsonb,bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION comisiones.save_supplier_sales_target_plan(uuid,uuid,text,uuid,date,date,jsonb,bigint) TO authenticated, service_role;

-- Apply seller-specific-first resolution to both existing simulation contracts.
DO $$
DECLARE
    v_definition text;
    v_order_old text := E'ORDER BY cp.valid_from DESC, cp.version_no DESC, cp.id';
    v_order_new text := 'ORDER BY CASE WHEN cp.plan_type = ''SUPPLIER_SALES_TARGET'' AND cp.seller_bsale_id = e.seller_bsale_id THEN 0 ELSE 1 END, cp.valid_from DESC, cp.version_no DESC, cp.id';
BEGIN
    SELECT pg_get_functiondef('comisiones.get_sales_period_simulation(uuid,date,date)'::regprocedure) INTO v_definition;
    IF position('cp.supplier_id = e.real_supplier_id' IN v_definition) = 0
       OR position(v_order_old IN v_definition) = 0 THEN
        RAISE EXCEPTION 'PERIOD_SIMULATION_PLAN_SELECTION_NOT_FOUND';
    END IF;
    v_definition := regexp_replace(
        v_definition,
        'AND cp[.]supplier_id = e[.]real_supplier_id[[:space:]]+AND cp[.]active',
        'AND cp.supplier_id = e.real_supplier_id AND cp.active AND (cp.plan_type <> ''SUPPLIER_SALES_TARGET'' OR cp.seller_bsale_id IS NULL OR cp.seller_bsale_id = e.seller_bsale_id)',
        1,
        1
    );
    v_definition := replace(v_definition, v_order_old, v_order_new);
    EXECUTE v_definition;

END;
$$;

COMMENT ON COLUMN comisiones.commission_plans.seller_bsale_id IS
    'Seller scope for SUPPLIER_SALES_TARGET; NULL applies to all sellers.';
