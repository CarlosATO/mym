-- QA transaccional del RPC de anulación de pagos.
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
    v_result jsonb;
    v_active_allocations bigint;
    v_historical_allocations bigint;
    v_custody_user_id uuid;
    v_custody_received_at timestamptz;
BEGIN
    SELECT adquisiciones.upsert_route_settlement_payment(
        v_settlement_id, NULL, 469, 'CASH', 193909, now(), 'CONFIRMED',
        'QA-VOID-CASH', NULL, NULL, NULL, 'QA void rollback',
        jsonb_build_array(
            jsonb_build_object(
                'settlement_item_id', 'b2380ad5-e23b-4629-a65b-41fa164b6bff',
                'amount_applied', 193909
            )
        )
    ) INTO v_result;

    v_payment_id := (v_result->'payment'->>'id')::uuid;

    BEGIN
        PERFORM adquisiciones.void_route_settlement_payment(v_payment_id, '   ');
        RAISE EXCEPTION 'No rechazó void_reason vacío';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM = 'No rechazó void_reason vacío' THEN RAISE; END IF;
    END;

    SELECT adquisiciones.void_route_settlement_payment(
        v_payment_id,
        'QA: anulación transaccional'
    ) INTO v_result;

    IF v_result->'payment'->>'verification_status' <> 'VOIDED'
       OR v_result->'payment'->>'active_fund' <> 'false'
       OR v_result->'payment'->>'void_reason' <> 'QA: anulación transaccional'
       OR (v_result->'payment'->>'custody_user_id') <> auth.uid()::text
       OR jsonb_array_length(v_result->'voided_allocations') <> 1 THEN
        RAISE EXCEPTION 'QA anulación falló: %', v_result;
    END IF;

    SELECT count(*) INTO v_active_allocations
    FROM adquisiciones.route_settlement_payment_allocations
    WHERE payment_id = v_payment_id
      AND voided_at IS NULL;

    SELECT count(*) INTO v_historical_allocations
    FROM adquisiciones.route_settlement_payment_allocations
    WHERE payment_id = v_payment_id;

    SELECT custody_user_id, custody_received_at
    INTO v_custody_user_id, v_custody_received_at
    FROM adquisiciones.route_settlement_payments
    WHERE id = v_payment_id
      AND verification_status = 'VOIDED';

    IF v_active_allocations <> 0
       OR v_historical_allocations <> 1
       OR v_custody_user_id <> auth.uid()
       OR v_custody_received_at IS NULL THEN
        RAISE EXCEPTION 'QA trazabilidad/custodia falló: active %, histórico %, custody %, custody_at %',
            v_active_allocations, v_historical_allocations, v_custody_user_id, v_custody_received_at;
    END IF;

    BEGIN
        PERFORM adquisiciones.void_route_settlement_payment(
            v_payment_id,
            'QA: segundo intento'
        );
        RAISE EXCEPTION 'No rechazó payment previamente VOIDED';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM = 'No rechazó payment previamente VOIDED' THEN RAISE; END IF;
    END;

    RAISE NOTICE 'QA PASS: anulación, allocations históricas, custodia y reintento';
END;
$$;

ROLLBACK;
