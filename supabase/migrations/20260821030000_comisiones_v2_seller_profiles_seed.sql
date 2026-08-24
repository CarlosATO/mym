-- COMV2-04: initial, idempotent copy of the validated V1 seller configuration.
-- V1 is read only as the source of this one-time seed; V2 owns the resulting rows.

DO $$
DECLARE
    v_conflicts integer;
BEGIN
    IF EXISTS (
        SELECT 1
        FROM comercial.commission_seller_profiles v1
        WHERE v1.seller_bsale_id IS NULL
           OR v1.seller_bsale_id <= 0
    ) THEN
        RAISE EXCEPTION 'COMV2-04: V1 contains an invalid seller_bsale_id';
    END IF;

    SELECT count(*)
    INTO v_conflicts
    FROM comercial.commission_seller_profiles v1
    JOIN comisiones.seller_profiles v2
      ON v2.company_id = v1.company_id
     AND v2.seller_bsale_id = v1.seller_bsale_id
    WHERE v2.seller_name IS DISTINCT FROM v1.seller_name
       OR v2.is_commissionable IS DISTINCT FROM v1.is_commissionable
       OR v2.active IS DISTINCT FROM v1.active
       OR v2.seller_type IS DISTINCT FROM v1.seller_type;

    IF v_conflicts > 0 THEN
        RAISE EXCEPTION 'COMV2-04: % existing V2 seller profile(s) differ from V1; no rows were changed', v_conflicts;
    END IF;

    INSERT INTO comisiones.seller_profiles (
        company_id,
        seller_bsale_id,
        seller_name,
        is_commissionable,
        active,
        seller_type
    )
    SELECT
        v1.company_id,
        v1.seller_bsale_id,
        v1.seller_name,
        v1.is_commissionable,
        v1.active,
        v1.seller_type
    FROM comercial.commission_seller_profiles v1
    ON CONFLICT (company_id, seller_bsale_id) DO NOTHING;
END $$;

GRANT SELECT ON comisiones.seller_profiles TO authenticated;
