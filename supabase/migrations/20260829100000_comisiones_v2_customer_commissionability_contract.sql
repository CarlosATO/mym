-- COMV2-32A: safe contract for changing customer commissionability only.

CREATE OR REPLACE FUNCTION comercial.set_customer_commissionability(
    p_company_id uuid,
    p_bsale_client_id bigint,
    p_is_commissionable boolean
)
RETURNS TABLE (
    company_id uuid,
    bsale_client_id bigint,
    is_commissionable boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, comercial
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_customer comercial.customers%ROWTYPE;
    v_profile comercial.customer_reporting_profiles%ROWTYPE;
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
    IF p_bsale_client_id IS NULL OR p_bsale_client_id <= 0 THEN
        RAISE EXCEPTION 'INVALID_CLIENT';
    END IF;
    IF p_is_commissionable IS NULL THEN
        RAISE EXCEPTION 'COMMISSIONABILITY_REQUIRED';
    END IF;

    -- Lock the master row so concurrent calls cannot race while creating a profile.
    SELECT c.*
      INTO v_customer
      FROM comercial.customers c
     WHERE c.company_id = p_company_id
       AND c.bsale_client_id = p_bsale_client_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'CLIENT_NOT_FOUND';
    END IF;

    SELECT crp.*
      INTO v_profile
      FROM comercial.customer_reporting_profiles crp
     WHERE crp.company_id = p_company_id
       AND crp.bsale_client_id = p_bsale_client_id
     FOR UPDATE;

    IF FOUND THEN
        IF v_profile.is_internal_account IS TRUE THEN
            RAISE EXCEPTION 'INTERNAL_ACCOUNT_NOT_EDITABLE';
        END IF;

        UPDATE comercial.customer_reporting_profiles
           SET is_commissionable = p_is_commissionable,
               updated_by = v_actor
         WHERE id = v_profile.id;
    ELSE
        INSERT INTO comercial.customer_reporting_profiles (
            company_id,
            bsale_client_id,
            customer_id,
            account_type,
            is_internal_account,
            is_commissionable,
            exclude_from_external_reports,
            created_by,
            updated_by
        ) VALUES (
            p_company_id,
            p_bsale_client_id,
            v_customer.id,
            'EXTERNAL_CUSTOMER',
            false,
            p_is_commissionable,
            false,
            v_actor,
            v_actor
        );
    END IF;

    RETURN QUERY
    SELECT p_company_id, p_bsale_client_id, p_is_commissionable;
END;
$$;

REVOKE ALL ON FUNCTION comercial.set_customer_commissionability(uuid, bigint, boolean)
    FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION comercial.set_customer_commissionability(uuid, bigint, boolean)
    TO authenticated;

COMMENT ON FUNCTION comercial.set_customer_commissionability(uuid, bigint, boolean) IS
    'COMV2-32A changes only is_commissionable for normal customer reporting profiles.';
