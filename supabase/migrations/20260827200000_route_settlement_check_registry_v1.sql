-- V1: operational registry for Rendicion CHECK Payments.
-- route_settlement_payments.id remains the physical check identity. This table
-- stores only operational state changes that cannot be derived from the Payment.

CREATE TABLE adquisiciones.route_settlement_check_status_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    payment_id uuid NOT NULL REFERENCES adquisiciones.route_settlement_payments(id),
    status varchar(32) NOT NULL,
    changed_at timestamptz NOT NULL DEFAULT now(),
    changed_by uuid NOT NULL REFERENCES portal.users(id),
    reason text,
    CONSTRAINT chk_route_settlement_check_status_history_status
        CHECK (status IN ('ENTREGADO_A_DEPOSITO', 'DEPOSITADO', 'ANULADO'))
);

CREATE INDEX idx_route_settlement_check_status_history_payment
    ON adquisiciones.route_settlement_check_status_history(payment_id, changed_at DESC, id DESC);

CREATE INDEX idx_route_settlement_check_status_history_company_status
    ON adquisiciones.route_settlement_check_status_history(company_id, status, changed_at DESC);

REVOKE ALL ON adquisiciones.route_settlement_check_status_history FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION adquisiciones.record_route_settlement_check_void_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, core, portal
AS $$
DECLARE
    v_actor uuid := COALESCE(NEW.voided_by, NEW.updated_by, auth.uid());
BEGIN
    IF NEW.payment_method_received = 'CHECK'
       AND (NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL
            OR NEW.verification_status = 'VOIDED' AND OLD.verification_status IS DISTINCT FROM 'VOIDED') THEN
        IF v_actor IS NULL THEN
            RAISE EXCEPTION 'La anulacion del cheque requiere usuario.';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM adquisiciones.route_settlement_check_status_history h
            WHERE h.payment_id = NEW.id AND h.status = 'DEPOSITADO'
        ) THEN
            RAISE EXCEPTION 'Un cheque depositado no puede anularse.';
        END IF;

        INSERT INTO adquisiciones.route_settlement_check_status_history(
            company_id, payment_id, status, changed_by, reason
        ) VALUES (
            NEW.company_id, NEW.id, 'ANULADO', v_actor, NEW.void_reason
        );
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_route_settlement_check_void_status
    ON adquisiciones.route_settlement_payments;
CREATE TRIGGER trg_route_settlement_check_void_status
AFTER UPDATE OF verification_status, voided_at, voided_by, void_reason
ON adquisiciones.route_settlement_payments
FOR EACH ROW
EXECUTE FUNCTION adquisiciones.record_route_settlement_check_void_status();

CREATE OR REPLACE FUNCTION adquisiciones.set_route_settlement_check_status(
    p_payment_id uuid,
    p_status text,
    p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, core, portal
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_payment adquisiciones.route_settlement_payments;
    v_current text;
    v_reason text := NULLIF(btrim(p_reason), '');
BEGIN
    IF v_actor IS NULL THEN RAISE EXCEPTION 'No autorizado.'; END IF;
    IF upper(btrim(p_status)) NOT IN ('ENTREGADO_A_DEPOSITO', 'DEPOSITADO') THEN
        RAISE EXCEPTION 'Estado de cheque no permitido.';
    END IF;
    IF v_reason IS NULL THEN RAISE EXCEPTION 'Debe indicar el motivo o referencia del cambio.'; END IF;

    SELECT * INTO v_payment
    FROM adquisiciones.route_settlement_payments
    WHERE id = p_payment_id
    FOR UPDATE;

    IF NOT FOUND THEN RAISE EXCEPTION 'Payment de cheque no encontrado.'; END IF;
    IF v_payment.payment_method_received <> 'CHECK' THEN RAISE EXCEPTION 'El Payment no es un cheque.'; END IF;
    IF NOT core.has_company_access(v_actor, v_payment.company_id) THEN RAISE EXCEPTION 'Usuario o empresa invalidos.'; END IF;
    IF NOT portal.user_has_permission(v_actor, 'adquisiciones.route_fund_closures.update') THEN
        RAISE EXCEPTION 'No tiene permisos para actualizar el estado del cheque.';
    END IF;

    SELECT h.status INTO v_current
    FROM adquisiciones.route_settlement_check_status_history h
    WHERE h.payment_id = v_payment.id
    ORDER BY h.changed_at DESC, h.id DESC
    LIMIT 1;
    v_current := COALESCE(v_current, 'EN_CUSTODIA');
    IF v_payment.voided_at IS NOT NULL OR v_payment.verification_status = 'VOIDED' THEN v_current := 'ANULADO'; END IF;

    IF v_current = 'ANULADO' THEN RAISE EXCEPTION 'El cheque anulado no puede volver a operación.'; END IF;
    IF v_current = 'DEPOSITADO' THEN RAISE EXCEPTION 'El cheque ya está depositado.'; END IF;
    IF upper(btrim(p_status)) = 'ENTREGADO_A_DEPOSITO' AND v_current <> 'EN_CUSTODIA' THEN
        RAISE EXCEPTION 'Transición de cheque inválida: % a ENTREGADO_A_DEPOSITO.', v_current;
    END IF;
    IF upper(btrim(p_status)) = 'DEPOSITADO' AND v_current <> 'ENTREGADO_A_DEPOSITO' THEN
        RAISE EXCEPTION 'El cheque debe estar ENTREGADO_A_DEPOSITO antes de DEPOSITADO.';
    END IF;

    INSERT INTO adquisiciones.route_settlement_check_status_history(
        company_id, payment_id, status, changed_by, reason
    ) VALUES (v_payment.company_id, v_payment.id, upper(btrim(p_status)), v_actor, v_reason);

    INSERT INTO portal.audit_logs(
        schema_name, module_code, table_name, record_id, action, new_data,
        performed_by, event_type, severity
    ) VALUES (
        'adquisiciones', 'ADQUISICIONES', 'route_settlement_payments', v_payment.id,
        'UPDATE', jsonb_build_object('status', upper(btrim(p_status)), 'reason', v_reason),
        v_actor, 'ROUTE_SETTLEMENT_CHECK_STATUS_CHANGED', 'INFO'
    );

    RETURN jsonb_build_object(
        'payment_id', v_payment.id,
        'status', upper(btrim(p_status)),
        'changed_at', now(),
        'changed_by', v_actor,
        'reason', v_reason
    );
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.set_route_settlement_check_status(uuid, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.set_route_settlement_check_status(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION adquisiciones.get_route_settlement_check_registry(
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
    check_date date,
    amount numeric,
    check_number text,
    bank_name text,
    guide_number text,
    settlement_number text,
    settlement_id uuid,
    fund_closure_number text,
    operational_status text,
    received_at timestamptz,
    delivered_to_deposit_at timestamptz,
    deposited_at timestamptz,
    annulled_at timestamptz,
    annulled_by uuid,
    void_reason text
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
    IF v_status IS NOT NULL AND v_status NOT IN ('EN_CUSTODIA', 'ENTREGADO_A_DEPOSITO', 'DEPOSITADO', 'ANULADO') THEN
        RAISE EXCEPTION 'Situación de cheque no permitida.';
    END IF;
    IF p_check_date_from IS NOT NULL AND p_check_date_to IS NOT NULL AND p_check_date_from > p_check_date_to THEN
        RAISE EXCEPTION 'Rango de fecha de cheque inválido.';
    END IF;

    RETURN QUERY
    WITH history AS (
        SELECT h.payment_id,
               max(h.changed_at) FILTER (WHERE h.status = 'ENTREGADO_A_DEPOSITO') AS delivered_at,
               max(h.changed_at) FILTER (WHERE h.status = 'DEPOSITADO') AS deposited_at,
               max(h.changed_at) FILTER (WHERE h.status = 'ANULADO') AS annulled_at,
               (array_agg(h.status ORDER BY h.changed_at DESC, h.id DESC))[1] AS latest_status,
               (array_agg(h.changed_by ORDER BY h.changed_at DESC, h.id DESC))[1] AS latest_changed_by,
               (array_agg(h.reason ORDER BY h.changed_at DESC, h.id DESC))[1] AS latest_reason
        FROM adquisiciones.route_settlement_check_status_history h
        GROUP BY h.payment_id
    ), registry AS (
        SELECT p.id,
               COALESCE(
                   CASE WHEN p.voided_at IS NOT NULL OR p.verification_status = 'VOIDED' THEN 'ANULADO' END,
                   h.latest_status,
                   'EN_CUSTODIA'
               ) AS current_status,
               h.delivered_at, h.deposited_at, h.annulled_at,
               h.latest_changed_by, h.latest_reason
        FROM adquisiciones.route_settlement_payments p
        LEFT JOIN history h ON h.payment_id = p.id
        WHERE p.payment_method_received = 'CHECK'
          AND core.has_company_access(v_actor, p.company_id)
    )
    SELECT p.id, p.id,
           COALESCE(NULLIF(string_agg(DISTINCT si.customer_name, ', '), ''), bc.business_name, 'Cliente no disponible'),
           NULLIF(btrim(bc.code), ''), p.check_date, p.amount_received, p.check_number, p.bank_name,
           g.guide_number, s.settlement_number, s.id, fc.closure_number, r.current_status,
           p.received_at, r.delivered_at, r.deposited_at,
           CASE WHEN r.current_status = 'ANULADO' THEN COALESCE(r.annulled_at, p.voided_at, p.updated_at) END,
           CASE WHEN r.current_status = 'ANULADO' THEN r.latest_changed_by ELSE NULL END,
           CASE WHEN r.current_status = 'ANULADO' THEN COALESCE(r.latest_reason, p.void_reason) ELSE NULL END
    FROM adquisiciones.route_settlement_payments p
    JOIN registry r ON r.id = p.id
    JOIN adquisiciones.route_settlements s ON s.id = p.settlement_id AND s.company_id = p.company_id
    JOIN logistica.route_guides g ON g.id = s.route_guide_id AND g.company_id = p.company_id
    LEFT JOIN integraciones.bsale_clients bc ON bc.company_id = p.company_id AND bc.bsale_client_id = p.customer_bsale_id
    LEFT JOIN adquisiciones.route_settlement_payment_allocations a ON a.payment_id = p.id AND a.voided_at IS NULL
    LEFT JOIN adquisiciones.route_settlement_items si ON si.id = a.settlement_item_id
    LEFT JOIN LATERAL (
        SELECT f.closure_number
        FROM adquisiciones.route_fund_closure_items i
        JOIN adquisiciones.route_fund_closures f ON f.id = i.fund_closure_id
        WHERE i.payment_id = p.id
        ORDER BY f.created_at DESC, f.id DESC
        LIMIT 1
    ) fc ON true
    WHERE core.has_company_access(v_actor, p.company_id)
      AND (p_customer IS NULL OR COALESCE(si.customer_name, bc.business_name, '') ILIKE '%' || p_customer || '%')
      AND (p_check_number IS NULL OR COALESCE(p.check_number, '') ILIKE '%' || p_check_number || '%')
      AND (p_bank IS NULL OR COALESCE(p.bank_name, '') ILIKE '%' || p_bank || '%')
      AND (p_guide_number IS NULL OR g.guide_number ILIKE '%' || p_guide_number || '%')
      AND (p_settlement_number IS NULL OR s.settlement_number ILIKE '%' || p_settlement_number || '%')
      AND (v_status IS NULL OR r.current_status = v_status)
      AND (p_check_date_from IS NULL OR p.check_date >= p_check_date_from)
      AND (p_check_date_to IS NULL OR p.check_date <= p_check_date_to)
    GROUP BY p.id, bc.business_name, bc.code, p.check_date, p.amount_received, p.check_number, p.bank_name,
             g.guide_number, s.settlement_number, s.id, fc.closure_number, r.current_status, p.received_at,
             r.delivered_at, r.deposited_at, r.annulled_at, r.latest_changed_by, r.latest_reason,
             p.voided_at, p.updated_at, p.void_reason
    ORDER BY p.check_date NULLS LAST, p.received_at, p.id;
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.get_route_settlement_check_registry(text, text, text, text, text, text, date, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.get_route_settlement_check_registry(text, text, text, text, text, text, date, date) TO authenticated;
