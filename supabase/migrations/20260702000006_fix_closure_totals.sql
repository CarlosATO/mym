-- Recalcular totales para cierres existentes

DO $$
DECLARE
    r RECORD;
    v_cash NUMERIC;
    v_check NUMERIC;
    v_expenses NUMERIC;
    v_deposits NUMERIC;
    v_pending NUMERIC;
BEGIN
    FOR r IN SELECT id FROM adquisiciones.route_fund_closures LOOP
        
        -- Items
        SELECT COALESCE(SUM(amount), 0) INTO v_cash
        FROM adquisiciones.route_fund_closure_items
        WHERE fund_closure_id = r.id AND payment_method = 'CASH' AND released_at IS NULL;

        SELECT COALESCE(SUM(amount), 0) INTO v_check
        FROM adquisiciones.route_fund_closure_items
        WHERE fund_closure_id = r.id AND payment_method = 'CHECK' AND released_at IS NULL;

        -- Expenses
        SELECT COALESCE(SUM(amount), 0) INTO v_expenses
        FROM adquisiciones.route_fund_closure_expenses
        WHERE fund_closure_id = r.id;

        -- Deposits
        SELECT COALESCE(SUM(amount), 0) INTO v_deposits
        FROM adquisiciones.route_fund_closure_deposits
        WHERE fund_closure_id = r.id;

        v_pending := v_cash + v_check - v_expenses - v_deposits;

        UPDATE adquisiciones.route_fund_closures
        SET 
            total_cash_received = v_cash,
            total_check_received = v_check,
            total_expenses = v_expenses,
            total_deposits = v_deposits,
            total_pending = v_pending,
            difference_amount = CASE WHEN v_pending < 0 THEN v_pending ELSE 0 END
        WHERE id = r.id;
        
    END LOOP;
END $$;
