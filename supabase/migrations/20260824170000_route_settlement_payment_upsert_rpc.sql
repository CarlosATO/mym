-- Atomic payment registration/editing for route settlements.
-- The RPC changes only payment/allocation facts and their audit trail.

CREATE OR REPLACE FUNCTION adquisiciones.upsert_route_settlement_payment(
    p_settlement_id uuid,
    p_payment_id uuid,
    p_customer_bsale_id bigint,
    p_payment_method_received text,
    p_amount_received numeric(14,2),
    p_received_at timestamptz,
    p_verification_status text,
    p_reference_number text DEFAULT NULL,
    p_bank_name text DEFAULT NULL,
    p_check_number text DEFAULT NULL,
    p_check_date date DEFAULT NULL,
    p_notes text DEFAULT NULL,
    p_allocations jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, logistica, integraciones, core, portal
AS $$
DECLARE
    v_actor_user_id uuid := auth.uid();
    v_company_id uuid;
    v_route_guide_id uuid;
    v_settlement_status varchar(30);
    v_workflow_status varchar(30);
    v_settlement_number text;
    v_payment_id uuid;
    v_existing_payment_customer bigint;
    v_existing_payment_settlement uuid;
    v_existing_payment_status varchar(20);
    v_existing_payment_voided_at timestamptz;
    v_old_payment jsonb;
    v_payment_created boolean := false;
    v_payment_amount numeric(14,2);
    v_amount_applied numeric(14,2);
    v_unallocated numeric(14,2);
    v_payment_custody_user_id uuid;
    v_payment_custody_received_at timestamptz;
    v_payment_voided_at timestamptz;
    v_payment_voided_by uuid;
    v_replaced_allocations integer := 0;
    v_voided_allocations jsonb := '[]'::jsonb;
    v_allocation jsonb;
    v_item_id uuid;
    v_amount numeric(14,2);
    v_expected numeric(14,2);
    v_other_applied numeric(14,2);
    v_item_ids uuid[] := ARRAY[]::uuid[];
    v_new_allocations jsonb := '[]'::jsonb;
    v_invoice_results jsonb := '[]'::jsonb;
BEGIN
    IF v_actor_user_id IS NULL THEN
        RAISE EXCEPTION 'Usuario no autenticado.' USING ERRCODE = '28000';
    END IF;

    IF p_settlement_id IS NULL OR p_customer_bsale_id IS NULL THEN
        RAISE EXCEPTION 'settlement_id y customer_bsale_id son obligatorios.';
    END IF;

    IF p_payment_method_received IS NULL
       OR p_payment_method_received NOT IN ('CASH', 'TRANSFER', 'CHECK') THEN
        RAISE EXCEPTION 'Medio de pago recibido no permitido: %.', p_payment_method_received;
    END IF;

    IF p_verification_status IS NULL
       OR p_verification_status NOT IN ('PENDING', 'CONFIRMED', 'REJECTED', 'VOIDED') THEN
        RAISE EXCEPTION 'Estado de verificación no permitido: %.', p_verification_status;
    END IF;

    IF p_amount_received IS NULL OR p_amount_received <= 0 THEN
        RAISE EXCEPTION 'amount_received debe ser mayor que cero.';
    END IF;

    IF p_received_at IS NULL THEN
        RAISE EXCEPTION 'received_at es obligatorio.';
    END IF;

    IF p_allocations IS NULL OR jsonb_typeof(p_allocations) <> 'array' THEN
        RAISE EXCEPTION 'allocations debe ser un arreglo JSON.';
    END IF;

    SELECT
        s.company_id,
        s.route_guide_id,
        s.status,
        s.workflow_status,
        s.settlement_number
    INTO
        v_company_id,
        v_route_guide_id,
        v_settlement_status,
        v_workflow_status,
        v_settlement_number
    FROM adquisiciones.route_settlements s
    WHERE s.id = p_settlement_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Rendición no encontrada.';
    END IF;

    IF NOT core.has_company_access(v_actor_user_id, v_company_id) THEN
        RAISE EXCEPTION 'El usuario no tiene acceso a la empresa de la rendición.';
    END IF;

    IF NOT portal.user_has_permission(v_actor_user_id, 'adquisiciones.route_settlements.update') THEN
        RAISE EXCEPTION 'El usuario no tiene permiso para actualizar rendiciones.';
    END IF;

    IF v_settlement_status IN ('CLOSED', 'CANCELLED')
       OR v_workflow_status IN ('CLOSED', 'CANCELLED') THEN
        RAISE EXCEPTION 'La rendición está cerrada o cancelada y no permite pagos.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM integraciones.bsale_clients c
        WHERE c.company_id = v_company_id
          AND c.bsale_client_id = p_customer_bsale_id
    ) THEN
        RAISE EXCEPTION 'customer_bsale_id % no pertenece a la empresa.', p_customer_bsale_id;
    END IF;

    IF p_payment_id IS NULL
       AND jsonb_array_length(p_allocations) = 0 THEN
        RAISE EXCEPTION 'Un payment nuevo requiere al menos una allocation.';
    END IF;

    IF p_payment_id IS NULL
       AND p_verification_status IN ('REJECTED', 'VOIDED') THEN
        RAISE EXCEPTION 'Un payment nuevo no puede iniciar en estado %.', p_verification_status;
    END IF;

    IF p_payment_id IS NOT NULL THEN
        SELECT
            p.customer_bsale_id,
            p.settlement_id,
            p.verification_status,
            p.voided_at
        INTO
            v_existing_payment_customer,
            v_existing_payment_settlement,
            v_existing_payment_status,
            v_existing_payment_voided_at
        FROM adquisiciones.route_settlement_payments p
        WHERE p.id = p_payment_id
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Payment no encontrado.';
        END IF;

        IF v_existing_payment_settlement <> p_settlement_id
           OR v_existing_payment_customer <> p_customer_bsale_id THEN
            RAISE EXCEPTION 'El payment no pertenece a la misma rendición y cliente enviados.';
        END IF;

        IF v_existing_payment_status = 'VOIDED' OR v_existing_payment_voided_at IS NOT NULL THEN
            RAISE EXCEPTION 'Un payment VOIDED no puede reabrirse.';
        END IF;

        v_payment_id := p_payment_id;

        SELECT jsonb_build_object(
            'id', p.id,
            'amount_received', p.amount_received,
            'payment_method_received', p.payment_method_received,
            'received_at', p.received_at,
            'verification_status', p.verification_status,
            'reference_number', p.reference_number,
            'bank_name', p.bank_name,
            'check_number', p.check_number,
            'check_date', p.check_date,
            'notes', p.notes,
            'custody_user_id', p.custody_user_id,
            'custody_received_at', p.custody_received_at
        )
        INTO v_old_payment
        FROM adquisiciones.route_settlement_payments p
        WHERE p.id = p_payment_id;

        -- An edit must report invoices whose previous active allocations leave
        -- the payment, not only the invoices in the replacement payload.
        SELECT COALESCE(array_agg(a.settlement_item_id), ARRAY[]::uuid[])
        INTO v_item_ids
        FROM adquisiciones.route_settlement_payment_allocations a
        WHERE a.payment_id = p_payment_id
          AND a.voided_at IS NULL;
    END IF;

    IF p_verification_status IN ('REJECTED', 'VOIDED')
       AND jsonb_array_length(p_allocations) > 0 THEN
        RAISE EXCEPTION 'Un payment rechazado o anulado no puede tener allocations activas.';
    END IF;

    -- Validate duplicate item IDs before taking any write action.
    IF EXISTS (
        SELECT 1
        FROM jsonb_to_recordset(p_allocations)
             AS a(settlement_item_id uuid, amount_applied numeric)
        GROUP BY a.settlement_item_id
        HAVING a.settlement_item_id IS NULL OR count(*) > 1
    ) THEN
        RAISE EXCEPTION 'allocations contiene facturas repetidas o settlement_item_id NULL.';
    END IF;

    -- Validate every item and calculate the caps against other active payments.
    FOR v_allocation IN SELECT value FROM jsonb_array_elements(p_allocations) LOOP
        v_item_id := NULLIF(v_allocation->>'settlement_item_id', '')::uuid;
        v_amount := NULLIF(v_allocation->>'amount_applied', '')::numeric(14,2);

        IF v_item_id IS NULL OR v_amount IS NULL OR v_amount <= 0 THEN
            RAISE EXCEPTION 'Cada allocation requiere settlement_item_id y amount_applied mayor que cero.';
        END IF;

        SELECT si.expected_amount
        INTO v_expected
        FROM adquisiciones.route_settlement_items si
        JOIN logistica.route_guide_items gi
          ON gi.id = si.route_guide_item_id
         AND gi.route_guide_id = v_route_guide_id
         AND gi.company_id = v_company_id
        WHERE si.id = v_item_id
          AND si.company_id = v_company_id
          AND si.settlement_id = p_settlement_id
          AND si.customer_bsale_id = p_customer_bsale_id
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'La factura % no pertenece a la rendición, guía o cliente indicado.', v_item_id;
        END IF;

        SELECT COALESCE(sum(a.amount_applied), 0)
        INTO v_other_applied
        FROM adquisiciones.route_settlement_payment_allocations a
        WHERE a.settlement_item_id = v_item_id
          AND a.voided_at IS NULL
          AND (p_payment_id IS NULL OR a.payment_id <> p_payment_id);

        IF v_other_applied + v_amount > v_expected THEN
            RAISE EXCEPTION 'La factura % supera expected_amount: otras aplicaciones %, nueva aplicación %, esperado %.',
                v_item_id, v_other_applied, v_amount, v_expected;
        END IF;

        v_item_ids := array_append(v_item_ids, v_item_id);
        v_amount_applied := COALESCE(v_amount_applied, 0) + v_amount;
    END LOOP;

    IF COALESCE(v_amount_applied, 0) > p_amount_received THEN
        RAISE EXCEPTION 'Las allocations (%) superan amount_received (%).',
            v_amount_applied, p_amount_received;
    END IF;

    -- Replace facts atomically. Previous allocations remain as voided rows.
    IF p_payment_id IS NOT NULL THEN
        SELECT COALESCE(jsonb_agg(
            jsonb_build_object(
                'id', a.id,
                'settlement_item_id', a.settlement_item_id,
                'amount_applied', a.amount_applied
            ) ORDER BY a.created_at, a.id
        ), '[]'::jsonb)
        INTO v_voided_allocations
        FROM adquisiciones.route_settlement_payment_allocations a
        WHERE a.payment_id = v_payment_id
          AND a.voided_at IS NULL;

        UPDATE adquisiciones.route_settlement_payment_allocations a
        SET
            voided_by = v_actor_user_id,
            voided_at = now(),
            void_reason = 'Reemplazada por upsert_route_settlement_payment'
        WHERE a.payment_id = v_payment_id
          AND a.voided_at IS NULL;

        GET DIAGNOSTICS v_replaced_allocations = ROW_COUNT;
    ELSE
        INSERT INTO adquisiciones.route_settlement_payments (
            company_id,
            settlement_id,
            customer_bsale_id,
            payment_method_received,
            amount_received,
            received_at,
            verification_status,
            reference_number,
            bank_name,
            check_number,
            check_date,
            notes,
            custody_user_id,
            custody_received_at,
            created_by
        ) VALUES (
            v_company_id,
            p_settlement_id,
            p_customer_bsale_id,
            p_payment_method_received,
            p_amount_received,
            p_received_at,
            p_verification_status,
            NULLIF(p_reference_number, ''),
            NULLIF(p_bank_name, ''),
            NULLIF(p_check_number, ''),
            p_check_date,
            p_notes,
            CASE WHEN p_verification_status = 'CONFIRMED'
                      AND p_payment_method_received IN ('CASH', 'CHECK')
                 THEN v_actor_user_id END,
            CASE WHEN p_verification_status = 'CONFIRMED'
                      AND p_payment_method_received IN ('CASH', 'CHECK')
                 THEN now() END,
            v_actor_user_id
        )
        RETURNING id INTO v_payment_id;

        v_payment_created := true;
        v_payment_custody_user_id := CASE
            WHEN p_verification_status = 'CONFIRMED'
             AND p_payment_method_received IN ('CASH', 'CHECK')
            THEN v_actor_user_id
        END;
        v_payment_custody_received_at := CASE
            WHEN p_verification_status = 'CONFIRMED'
             AND p_payment_method_received IN ('CASH', 'CHECK')
            THEN now()
        END;
    END IF;

    IF p_payment_id IS NOT NULL THEN
        SELECT custody_user_id, custody_received_at
        INTO v_payment_custody_user_id, v_payment_custody_received_at
        FROM adquisiciones.route_settlement_payments
        WHERE id = v_payment_id;

        IF p_verification_status = 'CONFIRMED'
           AND p_payment_method_received IN ('CASH', 'CHECK') THEN
            v_payment_custody_user_id := COALESCE(v_payment_custody_user_id, v_actor_user_id);
            v_payment_custody_received_at := COALESCE(v_payment_custody_received_at, now());
        ELSE
            v_payment_custody_user_id := NULL;
            v_payment_custody_received_at := NULL;
        END IF;

        v_payment_voided_at := CASE WHEN p_verification_status = 'VOIDED' THEN now() END;
        v_payment_voided_by := CASE WHEN p_verification_status = 'VOIDED' THEN v_actor_user_id END;

        UPDATE adquisiciones.route_settlement_payments
        SET
            payment_method_received = p_payment_method_received,
            amount_received = p_amount_received,
            received_at = p_received_at,
            verification_status = p_verification_status,
            reference_number = NULLIF(p_reference_number, ''),
            bank_name = NULLIF(p_bank_name, ''),
            check_number = NULLIF(p_check_number, ''),
            check_date = p_check_date,
            notes = p_notes,
            custody_user_id = v_payment_custody_user_id,
            custody_received_at = v_payment_custody_received_at,
            updated_by = v_actor_user_id,
            voided_by = v_payment_voided_by,
            voided_at = v_payment_voided_at,
            void_reason = CASE WHEN p_verification_status = 'VOIDED'
                               THEN COALESCE(NULLIF(p_notes, ''), 'Anulado por el usuario')
                          END
        WHERE id = v_payment_id;
    END IF;

    IF p_verification_status NOT IN ('REJECTED', 'VOIDED') THEN
        FOR v_allocation IN SELECT value FROM jsonb_array_elements(p_allocations) LOOP
            v_item_id := (v_allocation->>'settlement_item_id')::uuid;
            v_amount := (v_allocation->>'amount_applied')::numeric(14,2);

            INSERT INTO adquisiciones.route_settlement_payment_allocations (
                company_id,
                settlement_id,
                payment_id,
                settlement_item_id,
                customer_bsale_id,
                amount_applied,
                created_by
            ) VALUES (
                v_company_id,
                p_settlement_id,
                v_payment_id,
                v_item_id,
                p_customer_bsale_id,
                v_amount,
                v_actor_user_id
            )
            RETURNING jsonb_build_object(
                'id', id,
                'settlement_item_id', settlement_item_id,
                'amount_applied', amount_applied
            ) INTO v_allocation;

            v_new_allocations := v_new_allocations || jsonb_build_array(v_allocation);
        END LOOP;
    END IF;

    SELECT COALESCE(sum(a.amount_applied), 0)
    INTO v_amount_applied
    FROM adquisiciones.route_settlement_payment_allocations a
    WHERE a.payment_id = v_payment_id
      AND a.voided_at IS NULL;

    v_payment_amount := p_amount_received;
    v_unallocated := v_payment_amount - v_amount_applied;

    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'settlement_item_id', si.id,
            'invoice_number', si.invoice_number,
            'expected_amount', si.expected_amount,
            'applied_amount', COALESCE(active.applied_amount, 0),
            'pending_amount', GREATEST(si.expected_amount - COALESCE(active.applied_amount, 0), 0),
            'result', CASE
                WHEN COALESCE(active.applied_amount, 0) = 0 THEN 'PENDING'
                WHEN COALESCE(active.applied_amount, 0) < si.expected_amount THEN 'PARTIAL'
                ELSE 'PAID'
            END
        ) ORDER BY si.invoice_number
    ), '[]'::jsonb)
    INTO v_invoice_results
    FROM adquisiciones.route_settlement_items si
    LEFT JOIN LATERAL (
        SELECT sum(a.amount_applied) AS applied_amount
        FROM adquisiciones.route_settlement_payment_allocations a
        WHERE a.settlement_item_id = si.id
          AND a.voided_at IS NULL
    ) active ON true
    WHERE si.id = ANY(v_item_ids);

    INSERT INTO portal.audit_logs (
        schema_name,
        module_code,
        table_name,
        record_id,
        action,
        old_data,
        new_data,
        performed_by,
        event_type,
        severity
    ) VALUES (
        'adquisiciones',
        'ADQUISICIONES',
        'route_settlement_payments',
        v_payment_id,
        CASE WHEN v_payment_created THEN 'INSERT' ELSE 'UPDATE' END,
        jsonb_build_object(
            'settlement_id', p_settlement_id,
            'settlement_number', v_settlement_number,
            'customer_bsale_id', p_customer_bsale_id,
            'payment_method_received', p_payment_method_received,
            'amount_received', p_amount_received,
            'received_at', p_received_at,
             'verification_status', p_verification_status,
             'amount_applied', v_amount_applied,
             'unallocated_amount', v_unallocated,
             'replaced_allocations', v_replaced_allocations,
             'voided_allocations', v_voided_allocations,
             'allocations', v_new_allocations
         ),
         v_old_payment,
        v_actor_user_id,
        'ROUTE_SETTLEMENT_PAYMENT_UPSERTED',
        'INFO'
    );

    RETURN jsonb_build_object(
        'payment', jsonb_build_object(
            'id', v_payment_id,
            'settlement_id', p_settlement_id,
            'customer_bsale_id', p_customer_bsale_id,
            'amount_received', v_payment_amount,
            'amount_applied', v_amount_applied,
            'unallocated_amount', v_unallocated,
            'payment_method_received', p_payment_method_received,
            'verification_status', p_verification_status,
            'custody_user_id', v_payment_custody_user_id,
            'custody_received_at', v_payment_custody_received_at
        ),
        'allocations', v_new_allocations,
        'voided_allocations', v_voided_allocations,
        'invoices', v_invoice_results
    );
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.upsert_route_settlement_payment(
    uuid, uuid, bigint, text, numeric, timestamptz, text, text, text, text, date, text, jsonb
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION adquisiciones.upsert_route_settlement_payment(
    uuid, uuid, bigint, text, numeric, timestamptz, text, text, text, text, date, text, jsonb
) TO authenticated;
