-- Derive the current physical location of a route settlement check from the
-- operational records. The V1 status history is retained for compatibility,
-- but is not authoritative for custody, fund closures, or deposits.
--
-- Deposit history created before the individual relation remains legacy and is
-- not attributed to any check. New deposits use the relation added later.

DROP FUNCTION IF EXISTS adquisiciones.get_route_settlement_check_registry(text, text, text, text, text, text, date, date);

CREATE FUNCTION adquisiciones.get_route_settlement_check_registry(
    p_customer text DEFAULT NULL,
    p_check_number text DEFAULT NULL,
    p_bank text DEFAULT NULL,
    p_guide_number text DEFAULT NULL,
    p_settlement_number text DEFAULT NULL,
    p_status text DEFAULT NULL,
    p_check_date_from date DEFAULT NULL,
    p_check_date_to date DEFAULT NULL
) RETURNS TABLE (
    payment_id uuid,
    cheque_id uuid,
    customer_name text,
    customer_rut text,
    customer_tax_id text,
    check_date date,
    amount numeric,
    check_number text,
    bank_name text,
    guide_id uuid,
    guide_number text,
    settlement_id uuid,
    settlement_number text,
    settlement_received_at timestamptz,
    original_custodian_id uuid,
    original_custodian_name text,
    fund_closure_id uuid,
    fund_closure_number text,
    fund_closure_status text,
    fund_closure_at timestamptz,
    deposit_id uuid,
    deposit_reference_number text,
    deposit_status text,
    deposit_amount numeric,
    received_at timestamptz,
    delivered_to_deposit_at timestamptz,
    deposited_at timestamptz,
    annulled_at timestamptz,
    annulled_by uuid,
    void_reason text,
    operational_status text,
    current_location text,
    current_holder_name text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, logistica, integraciones, core, portal
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_status text := NULLIF(upper(btrim(p_status)), '');
BEGIN
    IF v_actor IS NULL THEN RAISE EXCEPTION 'No autorizado.'; END IF;
    IF NOT portal.user_has_permission(v_actor, 'adquisiciones.route_fund_closures.view') THEN
        RAISE EXCEPTION 'No tiene permisos para consultar cheques.';
    END IF;
    IF v_status IS NOT NULL AND v_status NOT IN (
        'CON_CUSTODIO', 'EN_TESORERIA', 'ENTREGADO_A_DEPOSITO', 'DEPOSITADO', 'ANULADO'
    ) THEN
        RAISE EXCEPTION 'Situación de cheque no permitida.';
    END IF;
    IF p_check_date_from IS NOT NULL AND p_check_date_to IS NOT NULL AND p_check_date_from > p_check_date_to THEN
        RAISE EXCEPTION 'Rango de fecha de cheque inválido.';
    END IF;

    RETURN QUERY
    WITH active_closure AS (
        SELECT DISTINCT ON (i.payment_id)
            i.payment_id,
            f.id AS fund_closure_id,
            f.closure_number,
            f.status AS fund_closure_status,
            f.created_at AS fund_closure_at
        FROM adquisiciones.route_fund_closure_items i
        JOIN adquisiciones.route_fund_closures f ON f.id = i.fund_closure_id
        WHERE i.payment_id IS NOT NULL
          AND i.released_at IS NULL
          AND f.status IN ('OPEN', 'PARTIAL', 'CLOSED', 'WITH_DIFFERENCE')
        ORDER BY i.payment_id, f.created_at DESC, f.id DESC
    ),
    active_deposit AS (
        SELECT DISTINCT ON (dc.payment_id)
            dc.payment_id,
            d.id AS deposit_id,
            d.reference_number,
            d.status AS deposit_status,
            d.amount AS deposit_amount,
            d.deposit_date
        FROM adquisiciones.route_fund_closure_deposit_checks dc
        JOIN adquisiciones.route_fund_closure_deposits d ON d.id = dc.deposit_id
        WHERE d.status = 'ACTIVE'
        ORDER BY dc.payment_id, d.deposit_date DESC, d.created_at DESC, d.id DESC
    ),
    registry AS (
        SELECT
            p.id,
            p.company_id,
            p.settlement_id,
            p.customer_bsale_id,
            p.check_date,
            p.amount_received,
            p.check_number,
            p.bank_name,
            p.custody_user_id,
            p.received_at,
            p.voided_at,
            p.voided_by,
            p.void_reason,
            ac.fund_closure_id,
            ac.closure_number,
            ac.fund_closure_status,
            ac.fund_closure_at,
            CASE
                WHEN p.voided_at IS NOT NULL OR p.verification_status = 'VOIDED' THEN 'ANULADO'
                WHEN ad.deposit_id IS NOT NULL THEN 'DEPOSITADO'
                WHEN ac.fund_closure_id IS NOT NULL THEN 'EN_TESORERIA'
                ELSE 'CON_CUSTODIO'
            END AS current_location
            ,ad.deposit_id, ad.reference_number, ad.deposit_status, ad.deposit_amount, ad.deposit_date
        FROM adquisiciones.route_settlement_payments p
        LEFT JOIN active_closure ac ON ac.payment_id = p.id
        LEFT JOIN active_deposit ad ON ad.payment_id = p.id
        WHERE p.payment_method_received = 'CHECK'
          AND core.has_company_access(v_actor, p.company_id)
    )
    SELECT
        p.id,
        p.id,
        COALESCE(NULLIF(string_agg(DISTINCT si.customer_name, ', '), ''), bc.business_name, 'Cliente no disponible'),
        NULLIF(btrim(bc.code), ''),
        NULLIF(btrim(bc.code), ''),
        p.check_date,
        p.amount_received,
        p.check_number,
        p.bank_name,
        g.id,
        g.guide_number,
        s.id,
        s.settlement_number,
        p.received_at,
        p.custody_user_id,
        NULLIF(btrim(concat_ws(' ', u.nombre, u.apellido)), ''),
        p.fund_closure_id,
        p.closure_number,
        p.fund_closure_status,
        p.fund_closure_at,
        p.deposit_id,
        p.reference_number,
        p.deposit_status,
        p.deposit_amount,
        p.received_at,
        NULL::timestamptz,
        CASE WHEN p.deposit_id IS NOT NULL THEN p.deposit_date::timestamptz END,
        CASE WHEN p.current_location = 'ANULADO' THEN COALESCE(p.voided_at, p.received_at) END,
        CASE WHEN p.current_location = 'ANULADO' THEN p.voided_by END,
        CASE WHEN p.current_location = 'ANULADO' THEN p.void_reason END,
        p.current_location,
        p.current_location,
        CASE
            WHEN p.current_location = 'CON_CUSTODIO' THEN NULLIF(btrim(concat_ws(' ', u.nombre, u.apellido)), '')
            WHEN p.current_location = 'EN_TESORERIA' THEN 'Tesorería'
        END
    FROM registry p
    JOIN adquisiciones.route_settlements s ON s.id = p.settlement_id AND s.company_id = p.company_id
    JOIN logistica.route_guides g ON g.id = s.route_guide_id AND g.company_id = p.company_id
    LEFT JOIN integraciones.bsale_clients bc ON bc.company_id = p.company_id AND bc.bsale_client_id = p.customer_bsale_id
    LEFT JOIN portal.users u ON u.id = p.custody_user_id
    LEFT JOIN adquisiciones.route_settlement_payment_allocations a ON a.payment_id = p.id AND a.voided_at IS NULL
    LEFT JOIN adquisiciones.route_settlement_items si ON si.id = a.settlement_item_id
    WHERE (p_customer IS NULL OR COALESCE(si.customer_name, bc.business_name, '') ILIKE '%' || p_customer || '%')
      AND (p_check_number IS NULL OR COALESCE(p.check_number, '') ILIKE '%' || p_check_number || '%')
      AND (p_bank IS NULL OR COALESCE(p.bank_name, '') ILIKE '%' || p_bank || '%')
      AND (p_guide_number IS NULL OR g.guide_number ILIKE '%' || p_guide_number || '%')
      AND (p_settlement_number IS NULL OR s.settlement_number ILIKE '%' || p_settlement_number || '%')
      AND (v_status IS NULL OR p.current_location = v_status)
      AND (p_check_date_from IS NULL OR p.check_date >= p_check_date_from)
      AND (p_check_date_to IS NULL OR p.check_date <= p_check_date_to)
    GROUP BY p.id, p.company_id, p.settlement_id, p.customer_bsale_id, p.check_date,
             p.amount_received, p.check_number, p.bank_name, p.custody_user_id,
             p.received_at, p.voided_at, p.voided_by, p.void_reason,
             p.fund_closure_id, p.closure_number, p.fund_closure_status,
             p.fund_closure_at, p.deposit_id, p.reference_number, p.deposit_status,
             p.deposit_amount, p.deposit_date, p.current_location, bc.business_name, bc.code,
             g.id, g.guide_number, s.id, s.settlement_number, u.nombre, u.apellido
    ORDER BY p.check_date NULLS LAST, p.received_at, p.id;
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.get_route_settlement_check_registry(text, text, text, text, text, text, date, date)
    FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.get_route_settlement_check_registry(text, text, text, text, text, text, date, date)
    TO authenticated;
