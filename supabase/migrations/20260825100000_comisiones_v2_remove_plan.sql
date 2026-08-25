-- COMV2-25A: safely remove an ACTIVE commission plan.
-- Unused plans are physically removed only when no inbound historical or
-- configuration reference can make the delete unsafe. Used plans are retired.

CREATE OR REPLACE FUNCTION comisiones.remove_commission_plan(
    p_company_id uuid,
    p_plan_id uuid
)
RETURNS TABLE (
    result text,
    plan_id uuid,
    plan_code text,
    version_no integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, comisiones
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_plan comisiones.commission_plans%ROWTYPE;
    v_before jsonb;
    v_after jsonb;
    v_used boolean;
    v_delete_blocked boolean;
    v_result text;
BEGIN
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'AUTH_REQUIRED';
    END IF;
    IF NOT (
        portal.has_permission('system.admin')
        OR portal.has_permission('comisiones.v2.plans.manage')
    ) THEN
        RAISE EXCEPTION 'PERMISSION_DENIED';
    END IF;
    IF NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'COMPANY_ACCESS_DENIED';
    END IF;
    IF p_plan_id IS NULL THEN
        RAISE EXCEPTION 'PLAN_ID_REQUIRED';
    END IF;

    -- Match the lock key used by the save RPCs so save, versioning and removal
    -- cannot make conflicting decisions concurrently.
    SELECT cp.supplier_id, cp.plan_type
    INTO v_plan.supplier_id, v_plan.plan_type
    FROM comisiones.commission_plans cp
    WHERE cp.company_id = p_company_id
      AND cp.id = p_plan_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PLAN_NOT_FOUND';
    END IF;
    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            p_company_id::text || ':' || v_plan.supplier_id::text || ':' || v_plan.plan_type,
            0
        )
    );

    SELECT *
    INTO v_plan
    FROM comisiones.commission_plans cp
    WHERE cp.company_id = p_company_id
      AND cp.id = p_plan_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PLAN_NOT_FOUND';
    END IF;
    IF v_plan.status <> 'ACTIVE' OR v_plan.active IS NOT TRUE THEN
        RAISE EXCEPTION 'PLAN_NOT_ACTIVE';
    END IF;

    v_before := to_jsonb(v_plan);

    -- A historical reference is independent of settlement status. The child
    -- configuration IDs are checked as well as the plan snapshot ID.
    SELECT EXISTS (
        SELECT 1
        FROM comisiones.settlement_lines sl
        WHERE sl.company_id = p_company_id
          AND sl.plan_id = v_plan.id
    )
    OR EXISTS (
        SELECT 1
        FROM comisiones.settlement_lines sl
        JOIN comisiones.commission_plan_family_rates fr
          ON fr.company_id = sl.company_id
         AND fr.id = sl.family_rate_id
        WHERE sl.company_id = p_company_id
          AND fr.plan_id = v_plan.id
    )
    OR EXISTS (
        SELECT 1
        FROM comisiones.settlement_lines sl
        JOIN comisiones.commission_plan_tiers t
          ON t.company_id = sl.company_id
         AND t.id = sl.tier_id
        WHERE sl.company_id = p_company_id
          AND t.plan_id = v_plan.id
    )
    INTO v_used;

    -- These inbound references are RESTRICT FKs. If present, preserve the
    -- complete object graph by retiring rather than attempting a delete.
    SELECT EXISTS (
        SELECT 1
        FROM comisiones.commission_plan_exceptions e
        WHERE e.company_id = p_company_id
          AND e.plan_id = v_plan.id
    )
    OR EXISTS (
        SELECT 1
        FROM comisiones.commission_plans child
        WHERE child.company_id = p_company_id
          AND child.supersedes_plan_id = v_plan.id
    )
    INTO v_delete_blocked;

    IF v_used OR v_delete_blocked THEN
        UPDATE comisiones.commission_plans cp
        SET status = 'RETIRED', active = false, updated_by = v_actor
        WHERE cp.company_id = p_company_id
          AND cp.id = v_plan.id;
        SELECT to_jsonb(cp)
        INTO v_after
        FROM comisiones.commission_plans cp
        WHERE cp.company_id = p_company_id
          AND cp.id = v_plan.id;
        v_result := 'ARCHIVED';

        INSERT INTO comisiones.audit_events (
            company_id, actor_user_id, event_type, entity_type, entity_id,
            before_data, after_data, reason
        ) VALUES (
            p_company_id, v_actor, 'COMMISSION_PLAN_ARCHIVED', 'COMMISSION_PLAN',
            v_plan.id, v_before, v_after,
            CASE WHEN v_used
                THEN 'Retiro por referencias históricas en settlement_lines'
                ELSE 'Retiro por referencias persistentes del plan'
            END
        );
    ELSE
        IF v_plan.plan_type = 'FAMILY_FIXED_PERCENT' THEN
            DELETE FROM comisiones.commission_plan_family_rates fr
            WHERE fr.company_id = p_company_id
              AND fr.plan_id = v_plan.id;
        ELSE
            DELETE FROM comisiones.commission_plan_tiers t
            WHERE t.company_id = p_company_id
              AND t.plan_id = v_plan.id;
        END IF;
        DELETE FROM comisiones.commission_plans cp
        WHERE cp.company_id = p_company_id
          AND cp.id = v_plan.id;
        v_result := 'DELETED';

        INSERT INTO comisiones.audit_events (
            company_id, actor_user_id, event_type, entity_type, entity_id,
            before_data, after_data, reason
        ) VALUES (
            p_company_id, v_actor, 'COMMISSION_PLAN_DELETED', 'COMMISSION_PLAN',
            v_plan.id, v_before, NULL,
            'Eliminación física sin referencias persistentes'
        );
    END IF;

    RETURN QUERY SELECT v_result, v_plan.id, v_plan.plan_code, v_plan.version_no;
END;
$$;

REVOKE ALL ON FUNCTION comisiones.remove_commission_plan(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION comisiones.remove_commission_plan(uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION comisiones.remove_commission_plan(uuid, uuid) IS
    'Removes an unused ACTIVE plan or retires it when historical or inbound references require preservation.';
