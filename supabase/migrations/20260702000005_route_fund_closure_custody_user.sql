-- MIGRATION: 20260702000005_route_fund_closure_custody_user.sql
-- Añade control de custodio a los fondos.

-- 1. Alter Tables
ALTER TABLE adquisiciones.route_settlement_items 
ADD COLUMN custody_user_id uuid REFERENCES portal.users(id),
ADD COLUMN custody_received_at timestamptz;

ALTER TABLE adquisiciones.route_fund_closures
ADD COLUMN custody_user_id uuid REFERENCES portal.users(id),
ADD COLUMN cancel_reason text;

ALTER TABLE adquisiciones.route_fund_closure_items
ADD COLUMN custody_user_id uuid REFERENCES portal.users(id),
ADD COLUMN custody_received_at timestamptz;

-- 2. Backfill (idempotent)
DO $$
BEGIN
    -- Backfill para route_settlement_items (los que ya están en estados de fondo)
    UPDATE adquisiciones.route_settlement_items
    SET custody_user_id = (SELECT created_by FROM adquisiciones.route_settlements WHERE id = settlement_id),
        custody_received_at = updated_at
    WHERE status IN ('PAID_CASH', 'CHECK_RECEIVED')
      AND custody_user_id IS NULL;

    -- Backfill para route_fund_closures
    UPDATE adquisiciones.route_fund_closures
    SET custody_user_id = created_by
    WHERE custody_user_id IS NULL;

    -- Backfill para route_fund_closure_items
    UPDATE adquisiciones.route_fund_closure_items fci
    SET custody_user_id = fc.custody_user_id,
        custody_received_at = fc.created_at
    FROM adquisiciones.route_fund_closures fc
    WHERE fci.fund_closure_id = fc.id
      AND fci.custody_user_id IS NULL;

    -- Mejor alterar a NOT NULL para las tablas de cierres, que obligatoriamente deben tener custodio
    -- Se omite el constraint si hay datos rotos que no pudieron mapear, pero en este DB sabemos que created_by no es null.
    ALTER TABLE adquisiciones.route_fund_closures ALTER COLUMN custody_user_id SET NOT NULL;
    ALTER TABLE adquisiciones.route_fund_closure_items ALTER COLUMN custody_user_id SET NOT NULL;
END $$;


-- 3. Actualizar la función update_route_settlement para inyectar la custodia
CREATE OR REPLACE FUNCTION adquisiciones.update_route_settlement(
    p_settlement_id uuid,
    p_items jsonb,
    p_notes text,
    p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_company_id uuid;
    v_status varchar;
    v_item jsonb;
    v_item_id uuid;
    v_item_status text;
    v_received numeric;
    v_relevant_count integer;
    v_blocking_pending_count integer;
    v_blocking_difference_count integer;
    v_new_status varchar;
    v_current_item_status varchar;
    v_current_custody_user uuid;
    v_current_custody_received_at timestamptz;
BEGIN
    SELECT company_id, status INTO v_company_id, v_status
    FROM adquisiciones.route_settlements
    WHERE id = p_settlement_id;

    IF NOT FOUND THEN RAISE EXCEPTION 'Rendición no encontrada'; END IF;
    IF auth.uid() != p_user_id THEN RAISE EXCEPTION 'Usuario no coincide'; END IF;
    IF NOT core.has_company_access(p_user_id, v_company_id) THEN RAISE EXCEPTION 'No tiene acceso a la empresa de esta rendición'; END IF;
    IF NOT portal.user_has_permission(p_user_id, 'adquisiciones.route_settlements.update') THEN RAISE EXCEPTION 'No tiene permisos'; END IF;
    IF v_status IN ('CLOSED', 'CANCELLED') THEN RAISE EXCEPTION 'Rendición cerrada o anulada no permite edición'; END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) LOOP
        v_item_id := (v_item->>'id')::uuid;
        v_item_status := v_item->>'status';
        v_received := COALESCE(NULLIF(v_item->>'received_amount', '')::numeric, 0);

        -- Obtener estado actual del ítem para manejo de custodia
        SELECT status, custody_user_id, custody_received_at 
        INTO v_current_item_status, v_current_custody_user, v_current_custody_received_at
        FROM adquisiciones.route_settlement_items
        WHERE id = v_item_id AND settlement_id = p_settlement_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Ítem de rendición no encontrado o sin acceso: %', v_item_id;
        END IF;

        -- Regla de Custodia: 
        -- Si un item ya tiene un custodio y está en estado de fondo, 
        -- no permitir modificaciones por un usuario distinto, a menos que sea superusuario o flujo especial.
        IF v_current_custody_user IS NOT NULL 
           AND v_current_item_status IN ('PAID_CASH', 'CHECK_RECEIVED') 
           AND v_current_custody_user != p_user_id 
        THEN
            IF NOT portal.user_has_permission(p_user_id, 'adquisiciones.route_fund_closures.cancel') THEN 
                RAISE EXCEPTION 'No puedes modificar un fondo que está bajo la custodia de otro usuario.';
            END IF;
        END IF;

        UPDATE adquisiciones.route_settlement_items
        SET
            received_amount = CASE
                WHEN v_item_status IN ('TRANSFER_CONFIRMED', 'CHECK_RECEIVED') AND v_received = 0 THEN expected_amount
                ELSE v_received
            END,
            difference_amount = CASE
                WHEN v_item_status = 'TRANSFER_CONFIRMED' THEN 0
                WHEN v_item_status IN ('CHECK_RECEIVED') AND v_received = 0 THEN 0
                ELSE expected_amount - v_received
            END,
            status = v_item_status,
            notes = NULLIF(v_item->>'notes', ''),
            transfer_confirmed = CASE
                WHEN v_item_status = 'TRANSFER_CONFIRMED' THEN true
                ELSE COALESCE(NULLIF(v_item->>'transfer_confirmed', '')::boolean, transfer_confirmed)
            END,
            transfer_reference = NULLIF(v_item->>'transfer_reference', ''),
            check_received = CASE
                WHEN v_item_status = 'CHECK_RECEIVED' THEN true
                ELSE COALESCE(NULLIF(v_item->>'check_received', '')::boolean, check_received)
            END,
            check_bank = NULLIF(v_item->>'check_bank', ''),
            check_number = NULLIF(v_item->>'check_number', ''),
            check_date = NULLIF(v_item->>'check_date', '')::date,
            check_amount = NULLIF(v_item->>'check_amount', '')::numeric,
            is_pending = CASE
                WHEN v_item_status IN ('PAID_CASH', 'TRANSFER_CONFIRMED', 'CHECK_RECEIVED') AND (expected_amount - v_received = 0 OR v_item_status != 'PAID_CASH') THEN false
                ELSE COALESCE(NULLIF(v_item->>'is_pending', '')::boolean, is_pending)
            END,
            requires_followup = COALESCE(NULLIF(v_item->>'requires_followup', '')::boolean, requires_followup),
            -- Custodia:
            custody_user_id = CASE
                WHEN v_item_status IN ('PAID_CASH', 'CHECK_RECEIVED') THEN
                    CASE
                        -- Si ya tenía custodio asignado (incluso por otro user), mantenlo a menos que el super admin decidiera limpiarlo explícitamente, pero aquí no se limpia explícitamente.
                        WHEN v_current_custody_user IS NOT NULL AND v_current_item_status IN ('PAID_CASH', 'CHECK_RECEIVED') THEN v_current_custody_user
                        -- Si es nuevo en estos estados, asignar p_user_id
                        ELSE p_user_id
                    END
                ELSE NULL -- Si ya no es PAID_CASH o CHECK_RECEIVED, se pierde la custodia
            END,
            custody_received_at = CASE
                WHEN v_item_status IN ('PAID_CASH', 'CHECK_RECEIVED') THEN
                    CASE
                        WHEN v_current_custody_received_at IS NOT NULL AND v_current_item_status IN ('PAID_CASH', 'CHECK_RECEIVED') THEN v_current_custody_received_at
                        ELSE now()
                    END
                ELSE NULL
            END
        WHERE id = v_item_id
          AND settlement_id = p_settlement_id
          AND company_id = v_company_id;

    END LOOP;

    -- Normaliza estados finales ya persistidos para evitar que flags antiguos sigan bloqueando SETTLED.
    UPDATE adquisiciones.route_settlement_items
    SET
        transfer_confirmed = CASE WHEN status = 'TRANSFER_CONFIRMED' THEN true ELSE transfer_confirmed END,
        check_received = CASE WHEN status = 'CHECK_RECEIVED' THEN true ELSE check_received END,
        received_amount = CASE
            WHEN status IN ('TRANSFER_CONFIRMED', 'CHECK_RECEIVED') AND received_amount = 0 THEN expected_amount
            ELSE received_amount
        END,
        difference_amount = CASE
            WHEN status = 'TRANSFER_CONFIRMED' THEN 0
            WHEN status IN ('PAID_CASH', 'CHECK_RECEIVED') THEN expected_amount - CASE WHEN received_amount = 0 THEN expected_amount ELSE received_amount END
            ELSE difference_amount
        END,
        is_pending = CASE
            WHEN status IN ('TRANSFER_CONFIRMED', 'CHECK_RECEIVED') THEN false
            WHEN status = 'PAID_CASH' AND expected_amount = received_amount THEN false
            ELSE is_pending
        END
    WHERE settlement_id = p_settlement_id
      AND company_id = v_company_id;

    -- Usa el método efectivo para calcular si hay pendientes o diferencias
    SELECT count(*) INTO v_relevant_count
    FROM adquisiciones.route_settlement_items
    WHERE settlement_id = p_settlement_id
      AND (
          CASE
            WHEN status = 'PAID_CASH' THEN 'CASH'
            WHEN status = 'TRANSFER_CONFIRMED' THEN 'TRANSFER'
            WHEN status = 'CHECK_RECEIVED' THEN 'CHECK'
            ELSE expected_payment_method
          END
      ) IN ('CASH', 'TRANSFER', 'CHECK');

    SELECT count(*) INTO v_blocking_difference_count
    FROM (
        SELECT
            status,
            requires_followup,
            difference_amount,
            expected_amount,
            received_amount,
            CASE
                WHEN status = 'PAID_CASH' THEN 'CASH'
                WHEN status = 'TRANSFER_CONFIRMED' THEN 'TRANSFER'
                WHEN status = 'CHECK_RECEIVED' THEN 'CHECK'
                ELSE expected_payment_method
            END as effective_payment_method
        FROM adquisiciones.route_settlement_items
        WHERE settlement_id = p_settlement_id
    ) i
    WHERE effective_payment_method IN ('CASH', 'TRANSFER', 'CHECK')
      AND (
        status IN ('PARTIAL_PAYMENT', 'DIFFERENCE', 'NOT_DELIVERED', 'REVIEW_REQUIRED')
        OR requires_followup = true
        OR (effective_payment_method IN ('CASH', 'CHECK') AND difference_amount <> 0)
      );

    SELECT count(*) INTO v_blocking_pending_count
    FROM (
        SELECT
            status,
            is_pending,
            received_amount,
            expected_amount,
            difference_amount,
            transfer_confirmed,
            check_received,
            CASE
                WHEN status = 'PAID_CASH' THEN 'CASH'
                WHEN status = 'TRANSFER_CONFIRMED' THEN 'TRANSFER'
                WHEN status = 'CHECK_RECEIVED' THEN 'CHECK'
                ELSE expected_payment_method
            END as effective_payment_method
        FROM adquisiciones.route_settlement_items
        WHERE settlement_id = p_settlement_id
    ) i
    WHERE effective_payment_method IN ('CASH', 'TRANSFER', 'CHECK')
      AND (
        is_pending = true
        OR status IN ('PENDING_PAYMENT', 'TRANSFER_PENDING', 'CHECK_PENDING', 'REVIEW_REQUIRED')
        OR (effective_payment_method = 'CASH' AND (status <> 'PAID_CASH' OR received_amount <> expected_amount OR difference_amount <> 0))
        OR (effective_payment_method = 'TRANSFER' AND (status <> 'TRANSFER_CONFIRMED' OR COALESCE(transfer_confirmed, false) = false))
        OR (effective_payment_method = 'CHECK' AND (status <> 'CHECK_RECEIVED' OR COALESCE(check_received, false) = false OR difference_amount <> 0))
      );

    IF v_relevant_count = 0 THEN
        v_new_status := 'IN_REVIEW';
    ELSIF v_blocking_difference_count > 0 THEN
        v_new_status := 'SETTLED_WITH_DIFFERENCE';
    ELSIF v_blocking_pending_count > 0 THEN
        v_new_status := 'IN_REVIEW';
    ELSE
        v_new_status := 'SETTLED';
    END IF;

    -- Recalcular totales en route_settlements usando el método efectivo
    WITH items AS (
        SELECT
            *,
            CASE
                WHEN status = 'PAID_CASH' THEN 'CASH'
                WHEN status = 'TRANSFER_CONFIRMED' THEN 'TRANSFER'
                WHEN status = 'CHECK_RECEIVED' THEN 'CHECK'
                ELSE expected_payment_method
            END as effective_payment_method
        FROM adquisiciones.route_settlement_items
        WHERE settlement_id = p_settlement_id
    )
    UPDATE adquisiciones.route_settlements s
    SET
        notes = p_notes,
        status = v_new_status,
        total_cash_received = (SELECT coalesce(sum(received_amount), 0) FROM items WHERE effective_payment_method = 'CASH' AND status = 'PAID_CASH'),
        total_check_received = (SELECT coalesce(sum(received_amount), 0) FROM items WHERE effective_payment_method = 'CHECK'),
        total_transfer_confirmed = (SELECT coalesce(sum(expected_amount), 0) FROM items WHERE effective_payment_method = 'TRANSFER' AND (status = 'TRANSFER_CONFIRMED' OR COALESCE(transfer_confirmed, false) = true)),
        total_cash_difference = (SELECT coalesce(sum(difference_amount), 0) FROM items WHERE effective_payment_method = 'CASH'),
        total_check_difference = (SELECT coalesce(sum(difference_amount), 0) FROM items WHERE effective_payment_method = 'CHECK'),
        total_transfer_pending = (SELECT coalesce(sum(expected_amount), 0) FROM items WHERE effective_payment_method = 'TRANSFER' AND status <> 'TRANSFER_CONFIRMED' AND COALESCE(transfer_confirmed, false) = false),
        total_difference = (SELECT coalesce(sum(difference_amount), 0) FROM items WHERE effective_payment_method IN ('CASH', 'CHECK')),
        paid_count = (SELECT count(*) FROM items WHERE effective_payment_method IN ('CASH', 'TRANSFER', 'CHECK') AND status IN ('PAID_CASH', 'CHECK_RECEIVED', 'TRANSFER_CONFIRMED') AND (status != 'PAID_CASH' OR expected_amount = received_amount)),
        pending_count = (SELECT count(*) FROM items WHERE effective_payment_method IN ('CASH', 'TRANSFER', 'CHECK') AND is_pending = true),
        difference_count = (SELECT count(*) FROM items WHERE effective_payment_method IN ('CASH', 'CHECK') AND difference_amount > 0),
        transfer_pending_count = (SELECT count(*) FROM items WHERE effective_payment_method = 'TRANSFER' AND (status <> 'TRANSFER_CONFIRMED' OR COALESCE(transfer_confirmed, false) = false)),
        total_cash_expected = (SELECT coalesce(sum(expected_amount), 0) FROM items WHERE effective_payment_method = 'CASH'),
        total_check_expected = (SELECT coalesce(sum(expected_amount), 0) FROM items WHERE effective_payment_method = 'CHECK'),
        total_transfer_expected = (SELECT coalesce(sum(expected_amount), 0) FROM items WHERE effective_payment_method = 'TRANSFER')
    WHERE id = p_settlement_id;

    RETURN (
        SELECT jsonb_build_object(
            'id', id,
            'settlement_number', settlement_number,
            'status', status,
            'notes', notes,
            'updated_at', updated_at
        )
        FROM adquisiciones.route_settlements
        WHERE id = p_settlement_id
    );
END;
$$;
