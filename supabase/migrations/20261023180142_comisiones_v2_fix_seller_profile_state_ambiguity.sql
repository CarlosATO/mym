-- COMV2: qualify seller profile columns in the applied state update RPC.
-- This replaces only the function definition and its unchanged execution ACL.

CREATE OR REPLACE FUNCTION comisiones.update_seller_profile_state(
    p_company_id uuid,
    p_seller_bsale_id bigint,
    p_active boolean,
    p_is_commissionable boolean
)
RETURNS TABLE (
    seller_bsale_id bigint,
    seller_name text,
    is_commissionable boolean,
    active boolean,
    seller_type text,
    updated_at timestamptz,
    updated_by uuid
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, comisiones
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_before comisiones.seller_profiles%ROWTYPE;
BEGIN
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'AUTH_REQUIRED';
    END IF;
    IF NOT (portal.has_permission('system.admin') OR portal.has_permission('comisiones.v2.plans.manage')) THEN
        RAISE EXCEPTION 'PERMISSION_DENIED';
    END IF;
    IF NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'COMPANY_ACCESS_DENIED';
    END IF;
    IF p_seller_bsale_id IS NULL OR p_seller_bsale_id <= 0 OR p_active IS NULL OR p_is_commissionable IS NULL THEN
        RAISE EXCEPTION 'INVALID_SELLER_PROFILE_STATE';
    END IF;

    SELECT sp.* INTO v_before
    FROM comisiones.seller_profiles AS sp
    WHERE sp.company_id = p_company_id
      AND sp.seller_bsale_id = p_seller_bsale_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'SELLER_PROFILE_NOT_FOUND';
    END IF;

    UPDATE comisiones.seller_profiles AS sp
    SET active = p_active,
        is_commissionable = p_is_commissionable,
        updated_by = v_actor
    WHERE sp.company_id = p_company_id
      AND sp.seller_bsale_id = p_seller_bsale_id;

    INSERT INTO comisiones.audit_events (
        company_id, actor_user_id, event_type, entity_type, entity_id,
        before_data, after_data, reason
    )
    VALUES (
        p_company_id, v_actor, 'SELLER_PROFILE_STATE_UPDATED', 'SELLER_PROFILE', v_before.id,
        jsonb_build_object(
            'active', v_before.active,
            'is_commissionable', v_before.is_commissionable
        ),
        jsonb_build_object(
            'active', p_active,
            'is_commissionable', p_is_commissionable
        ),
        'Administración de vendedores V2'
    );

    RETURN QUERY
    SELECT sp.seller_bsale_id, sp.seller_name, sp.is_commissionable, sp.active,
           sp.seller_type, sp.updated_at, sp.updated_by
    FROM comisiones.seller_profiles AS sp
    WHERE sp.company_id = p_company_id
      AND sp.seller_bsale_id = p_seller_bsale_id;
END;
$$;

REVOKE ALL ON FUNCTION comisiones.update_seller_profile_state(uuid, bigint, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION comisiones.update_seller_profile_state(uuid, bigint, boolean, boolean) TO authenticated, service_role;
