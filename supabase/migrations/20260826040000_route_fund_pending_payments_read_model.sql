-- Pending physical funds are sourced from confirmed settlement payments.
-- Legacy closure items remain readable, while new closures can claim exact payments.

ALTER TABLE adquisiciones.route_fund_closure_items
    ADD COLUMN IF NOT EXISTS payment_id uuid
        REFERENCES adquisiciones.route_settlement_payments(id);

CREATE INDEX IF NOT EXISTS idx_route_fund_closure_items_payment
    ON adquisiciones.route_fund_closure_items (company_id, payment_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_route_fund_closure_items_active_payment
    ON adquisiciones.route_fund_closure_items (payment_id)
    WHERE payment_id IS NOT NULL AND released_at IS NULL;

CREATE OR REPLACE FUNCTION adquisiciones.validate_route_fund_closure_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones
AS $$
DECLARE
    v_payment record;
    v_closure record;
BEGIN
    IF NEW.payment_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT settlement_id, company_id, payment_method_received, custody_user_id
    INTO v_payment
    FROM adquisiciones.route_settlement_payments
    WHERE id = NEW.payment_id;

    IF NOT FOUND OR v_payment.company_id <> NEW.company_id THEN
        RAISE EXCEPTION 'El Payment no pertenece a la empresa del cierre.';
    END IF;
    IF v_payment.settlement_id <> NEW.route_settlement_id THEN
        RAISE EXCEPTION 'El Payment no pertenece a la rendición indicada.';
    END IF;
    IF v_payment.payment_method_received NOT IN ('CASH', 'CHECK') THEN
        RAISE EXCEPTION 'Sólo efectivo y cheques pueden incorporarse a Cierre de Fondos.';
    END IF;
    IF v_payment.custody_user_id IS NULL OR NEW.custody_user_id IS DISTINCT FROM v_payment.custody_user_id THEN
        RAISE EXCEPTION 'El custodio del Payment no coincide con el custodio del fondo.';
    END IF;

    SELECT custody_user_id, company_id
    INTO v_closure
    FROM adquisiciones.route_fund_closures
    WHERE id = NEW.fund_closure_id;

    IF NOT FOUND OR v_closure.company_id <> NEW.company_id
       OR v_closure.custody_user_id IS DISTINCT FROM v_payment.custody_user_id THEN
        RAISE EXCEPTION 'No se pueden mezclar custodios en un Cierre de Fondos.';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_route_fund_closure_payment
    ON adquisiciones.route_fund_closure_items;
CREATE TRIGGER trg_validate_route_fund_closure_payment
    BEFORE INSERT OR UPDATE OF payment_id, custody_user_id, route_settlement_id, fund_closure_id
    ON adquisiciones.route_fund_closure_items
    FOR EACH ROW
    EXECUTE FUNCTION adquisiciones.validate_route_fund_closure_payment();

CREATE OR REPLACE FUNCTION adquisiciones.get_pending_route_fund_groups(p_company_id uuid)
RETURNS SETOF jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, adquisiciones, logistica
AS $$
WITH active_confirmed_payments AS (
    SELECT
        p.id,
        p.settlement_id,
        p.payment_method_received,
        p.amount_received,
        p.custody_user_id,
        p.custody_received_at
    FROM adquisiciones.route_settlement_payments p
    JOIN adquisiciones.route_settlements s
      ON s.company_id = p.company_id
     AND s.id = p.settlement_id
     AND s.workflow_status = 'CLOSED'
    WHERE p.company_id = p_company_id
      AND p.verification_status = 'CONFIRMED'
      AND p.voided_at IS NULL
      AND p.payment_method_received IN ('CASH', 'CHECK')
      AND NOT EXISTS (
          SELECT 1
          FROM adquisiciones.route_fund_closure_items ci
          JOIN adquisiciones.route_fund_closures fc
            ON fc.company_id = ci.company_id
           AND fc.id = ci.fund_closure_id
          WHERE ci.company_id = p.company_id
            AND ci.released_at IS NULL
            AND fc.status <> 'CANCELLED'
            AND (
                ci.payment_id = p.id
                OR (ci.payment_id IS NULL AND ci.route_settlement_id = p.settlement_id)
            )
      )
),
settlement_expenses AS (
    SELECT
        e.route_settlement_id,
        COALESCE(sum(e.amount) FILTER (WHERE e.status = 'ACTIVE' AND e.voided_at IS NULL), 0)::numeric(14,2) AS active_expenses
    FROM adquisiciones.route_fund_closure_expenses e
    WHERE e.company_id = p_company_id
    GROUP BY e.route_settlement_id
),
grouped AS (
    SELECT
        p.settlement_id,
        s.settlement_number,
        s.settlement_date,
        s.route_guide_id,
        g.guide_number,
        p.custody_user_id,
        max(p.custody_received_at) AS custody_received_at,
        sum(p.amount_received) FILTER (WHERE p.payment_method_received = 'CASH')::numeric(14,2) AS cash_received,
        sum(p.amount_received) FILTER (WHERE p.payment_method_received = 'CHECK')::numeric(14,2) AS checks_received,
        count(*) FILTER (WHERE p.payment_method_received = 'CHECK')::integer AS check_count,
        COALESCE(se.active_expenses, 0)::numeric(14,2) AS active_route_expenses,
        jsonb_agg(p.id ORDER BY p.id) AS payment_ids
    FROM active_confirmed_payments p
    JOIN adquisiciones.route_settlements s ON s.id = p.settlement_id
    JOIN logistica.route_guides g
      ON g.company_id = s.company_id
     AND g.id = s.route_guide_id
    LEFT JOIN settlement_expenses se ON se.route_settlement_id = p.settlement_id
    GROUP BY
        p.settlement_id, s.settlement_number, s.settlement_date,
        s.route_guide_id, g.guide_number, p.custody_user_id,
        se.active_expenses
)
SELECT jsonb_build_object(
    'route_settlement_id', settlement_id,
    'settlement_number', settlement_number,
    'settlement_date', settlement_date,
    'route_guide_id', route_guide_id,
    'guide_number', guide_number,
    'custody_user_id', custody_user_id,
    'custody_received_at', custody_received_at,
    'cash_received', COALESCE(cash_received, 0),
    'active_route_expenses', active_route_expenses,
    'net_cash_pending', GREATEST(COALESCE(cash_received, 0) - active_route_expenses, 0),
    'checks_received', COALESCE(checks_received, 0),
    'check_count', check_count,
    'payment_ids', payment_ids
)
FROM grouped
ORDER BY settlement_date, settlement_number, custody_user_id;
$$;

COMMENT ON FUNCTION adquisiciones.get_pending_route_fund_groups(uuid) IS
    'Read model of physical cash and checks pending from CLOSED route settlements; excludes active fund-closure claims and voided expenses.';

COMMENT ON COLUMN adquisiciones.route_fund_closure_items.payment_id IS
    'Exact route_settlement_payment claimed by this closure item; NULL is retained only for historical legacy items.';
