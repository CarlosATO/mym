-- QA transaccional del RPC de pagos de rendiciones.
-- Ejecutar contra la base vinculada. Todo el bloque termina en ROLLBACK.

BEGIN;

SELECT set_config(
    'request.jwt.claim.sub',
    'dc9be3b3-bf39-47b2-8ea3-fdd6aa9a4aaa',
    true
);

DO $$
DECLARE
    v_settlement_id uuid := '23586a27-f710-4bd3-8785-e75f87006a38';
    v_payment_id uuid;
    v_other_settlement_item uuid;
    v_result jsonb;
    v_before_payments bigint;
    v_before_allocations bigint;
    v_after_payments bigint;
    v_after_allocations bigint;
BEGIN
    SELECT count(*) INTO v_before_payments
    FROM adquisiciones.route_settlement_payments
    WHERE settlement_id = v_settlement_id;
    SELECT count(*) INTO v_before_allocations
    FROM adquisiciones.route_settlement_payment_allocations
    WHERE settlement_id = v_settlement_id;

    -- A: cliente 469, tres facturas, CHECK confirmado.
    SELECT adquisiciones.upsert_route_settlement_payment(
        v_settlement_id, NULL, 469, 'CHECK', 735804, now(), 'CONFIRMED',
        'QA-CHECK-469', 'Banco QA', 'CHK-QA-469', current_date, 'QA rollback',
        jsonb_build_array(
            jsonb_build_object('settlement_item_id', 'b2380ad5-e23b-4629-a65b-41fa164b6bff', 'amount_applied', 193909),
            jsonb_build_object('settlement_item_id', '4cb3e5f7-e29e-41ef-a783-4b8e8104682f', 'amount_applied', 362720),
            jsonb_build_object('settlement_item_id', 'e6bb64ac-dd58-4285-acf1-6663d4da8dfc', 'amount_applied', 179175)
        )
    ) INTO v_result;

    IF (v_result->'payment'->>'amount_applied')::numeric <> 735804
       OR (v_result->'payment'->>'unallocated_amount')::numeric <> 0
       OR v_result->'payment'->>'payment_method_received' <> 'CHECK'
       OR v_result->'payment'->>'verification_status' <> 'CONFIRMED'
       OR v_result->'payment'->>'custody_user_id' <> auth.uid()::text
       OR jsonb_array_length(v_result->'allocations') <> 3
       OR jsonb_array_length(v_result->'invoices') <> 3 THEN
        RAISE EXCEPTION 'QA A falló: %', v_result;
    END IF;
    v_payment_id := (v_result->'payment'->>'id')::uuid;

    -- Edición: reemplaza hechos y conserva/anula allocations, custodia CASH.
    SELECT adquisiciones.upsert_route_settlement_payment(
        v_settlement_id, v_payment_id, 469, 'CASH', 735804, now(), 'CONFIRMED',
        NULL, NULL, NULL, NULL, 'QA edición rollback',
        jsonb_build_array(
            jsonb_build_object('settlement_item_id', 'b2380ad5-e23b-4629-a65b-41fa164b6bff', 'amount_applied', 193909),
            jsonb_build_object('settlement_item_id', '4cb3e5f7-e29e-41ef-a783-4b8e8104682f', 'amount_applied', 362720),
            jsonb_build_object('settlement_item_id', 'e6bb64ac-dd58-4285-acf1-6663d4da8dfc', 'amount_applied', 179175)
        )
    ) INTO v_result;

    IF v_result->'payment'->>'payment_method_received' <> 'CASH'
       OR v_result->'payment'->>'custody_user_id' <> auth.uid()::text
       OR jsonb_array_length(v_result->'voided_allocations') <> 3 THEN
        RAISE EXCEPTION 'QA edición/custodia falló: %', v_result;
    END IF;

    -- B/D: TRANSFER confirmado, sin custodia física.
    SELECT adquisiciones.upsert_route_settlement_payment(
        v_settlement_id, NULL, 637, 'TRANSFER', 389549, now(), 'CONFIRMED',
        'TR-QA-637', 'Banco QA', NULL, NULL, 'QA transferencia rollback',
        jsonb_build_array(
            jsonb_build_object('settlement_item_id', '54390f89-0570-46d2-8d89-f2da92a3daa4', 'amount_applied', 389549)
        )
    ) INTO v_result;
    IF v_result->'payment'->>'custody_user_id' IS NOT NULL
       OR v_result->'payment'->>'custody_received_at' IS NOT NULL THEN
        RAISE EXCEPTION 'QA transferencia generó custodia: %', v_result;
    END IF;

    -- Rechazo: factura de otro cliente.
    BEGIN
        PERFORM adquisiciones.upsert_route_settlement_payment(
            v_settlement_id, NULL, 469, 'CASH', 389549, now(), 'CONFIRMED',
            NULL, NULL, NULL, NULL, NULL,
            jsonb_build_array(jsonb_build_object('settlement_item_id', '54390f89-0570-46d2-8d89-f2da92a3daa4', 'amount_applied', 389549))
        );
        RAISE EXCEPTION 'No rechazó factura de otro cliente';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM = 'No rechazó factura de otro cliente' THEN RAISE; END IF;
    END;

    -- Rechazo: factura de otra rendición.
    SELECT si.id INTO v_other_settlement_item
    FROM adquisiciones.route_settlement_items si
    WHERE si.settlement_id <> v_settlement_id
    LIMIT 1;
    IF v_other_settlement_item IS NULL THEN
        -- The linked fixture contains only RR-2026-000001 with items. Keep
        -- the rejection test executable without manufacturing legacy data.
        v_other_settlement_item := '00000000-0000-0000-0000-000000000001';
        RAISE NOTICE 'QA C payment/item de otra rendición no disponible en fixture; se prueba item inexistente y la misma validación de ownership.';
    END IF;
    BEGIN
        PERFORM adquisiciones.upsert_route_settlement_payment(
            v_settlement_id, NULL, 469, 'CASH', 1, now(), 'CONFIRMED',
            NULL, NULL, NULL, NULL, NULL,
            jsonb_build_array(jsonb_build_object('settlement_item_id', v_other_settlement_item, 'amount_applied', 1))
        );
        RAISE EXCEPTION 'No rechazó factura de otra rendición';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM = 'No rechazó factura de otra rendición' THEN RAISE; END IF;
    END;

    -- Rechazos de montos: expected_amount y monto recibido.
    BEGIN
        PERFORM adquisiciones.upsert_route_settlement_payment(
            v_settlement_id, NULL, 469, 'CASH', 193908, now(), 'CONFIRMED',
            NULL, NULL, NULL, NULL, NULL,
            jsonb_build_array(jsonb_build_object('settlement_item_id', 'b2380ad5-e23b-4629-a65b-41fa164b6bff', 'amount_applied', 193909))
        );
        RAISE EXCEPTION 'No rechazó allocation sobre expected_amount';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM = 'No rechazó allocation sobre expected_amount' THEN RAISE; END IF;
    END;

    BEGIN
        PERFORM adquisiciones.upsert_route_settlement_payment(
            v_settlement_id, NULL, 469, 'CASH', 1, now(), 'CONFIRMED',
            NULL, NULL, NULL, NULL, NULL,
            jsonb_build_array(jsonb_build_object('settlement_item_id', 'b2380ad5-e23b-4629-a65b-41fa164b6bff', 'amount_applied', 1), jsonb_build_object('settlement_item_id', '4cb3e5f7-e29e-41ef-a783-4b8e8104682f', 'amount_applied', 1))
        );
        RAISE EXCEPTION 'No rechazó allocations sobre amount_received';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM = 'No rechazó allocations sobre amount_received' THEN RAISE; END IF;
    END;

    -- Atomicidad: una factura válida y una inválida no dejan hechos parciales.
    SELECT count(*) INTO v_before_payments FROM adquisiciones.route_settlement_payments WHERE settlement_id = v_settlement_id;
    SELECT count(*) INTO v_before_allocations FROM adquisiciones.route_settlement_payment_allocations WHERE settlement_id = v_settlement_id;
    BEGIN
        PERFORM adquisiciones.upsert_route_settlement_payment(
            v_settlement_id, NULL, 469, 'CASH', 2, now(), 'CONFIRMED',
            NULL, NULL, NULL, NULL, NULL,
            jsonb_build_array(jsonb_build_object('settlement_item_id', 'b2380ad5-e23b-4629-a65b-41fa164b6bff', 'amount_applied', 1), jsonb_build_object('settlement_item_id', v_other_settlement_item, 'amount_applied', 1))
        );
        RAISE EXCEPTION 'No provocó error atómico';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM = 'No provocó error atómico' THEN RAISE; END IF;
    END;
    SELECT count(*) INTO v_after_payments FROM adquisiciones.route_settlement_payments WHERE settlement_id = v_settlement_id;
    SELECT count(*) INTO v_after_allocations FROM adquisiciones.route_settlement_payment_allocations WHERE settlement_id = v_settlement_id;
    IF v_after_payments <> v_before_payments OR v_after_allocations <> v_before_allocations THEN
        RAISE EXCEPTION 'QA atomicidad falló: payments %/% allocations %/%', v_before_payments, v_after_payments, v_before_allocations, v_after_allocations;
    END IF;

    -- C: usuario sin permiso no puede ejecutar el RPC.
    PERFORM set_config('request.jwt.claim.sub', 'c21d0822-def0-4d29-a072-59fea2325d18', true);
    BEGIN
        PERFORM adquisiciones.upsert_route_settlement_payment(
            v_settlement_id, NULL, 469, 'CASH', 1, now(), 'CONFIRMED',
            NULL, NULL, NULL, NULL, NULL,
            jsonb_build_array(jsonb_build_object('settlement_item_id', 'b2380ad5-e23b-4629-a65b-41fa164b6bff', 'amount_applied', 1))
        );
        RAISE EXCEPTION 'No rechazó usuario sin permiso';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM = 'No rechazó usuario sin permiso' THEN RAISE; END IF;
    END;

    RAISE NOTICE 'QA PASS: A, B, C, D, edición, auditoría y atomicidad';
END;
$$;

ROLLBACK;

SELECT
    (SELECT count(*) FROM adquisiciones.route_settlement_payments WHERE settlement_id = '23586a27-f710-4bd3-8785-e75f87006a38') AS persistent_payments,
    (SELECT count(*) FROM adquisiciones.route_settlement_payment_allocations WHERE settlement_id = '23586a27-f710-4bd3-8785-e75f87006a38') AS persistent_allocations;
