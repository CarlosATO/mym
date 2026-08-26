-- QA transaccional del universo completo de facturas de una Guía.
-- Ejecutar contra la base vinculada. El bloque termina siempre en ROLLBACK.

BEGIN;

SELECT set_config(
    'request.jwt.claim.sub',
    'dc9be3b3-bf39-47b2-8ea3-fdd6aa9a4aaa',
    true
);

DO $$
DECLARE
    v_user_id uuid := 'dc9be3b3-bf39-47b2-8ea3-fdd6aa9a4aaa';
    v_guide_id uuid;
    v_other_guide_id uuid;
    v_settlement_id uuid;
    v_result jsonb;
    v_detail jsonb;
    v_invoice_count integer;
    v_client_count integer;
    v_unresolved integer;
    v_expected numeric;
BEGIN
    SELECT id INTO v_guide_id
    FROM logistica.route_guides
    WHERE guide_number = 'GR-2026-000001';
    IF v_guide_id IS NULL THEN RAISE EXCEPTION 'QA: GR-2026-000001 no encontrada'; END IF;

    SELECT (adquisiciones.create_route_settlement_from_guide(v_guide_id, v_user_id)->>'settlement_id')::uuid
    INTO v_settlement_id;

    SELECT count(*), count(DISTINCT customer_bsale_id), sum(amount)
    INTO v_invoice_count, v_client_count, v_expected
    FROM logistica.route_guide_items
    WHERE route_guide_id = v_guide_id
      AND NULLIF(btrim(invoice_number), '') IS NOT NULL
      AND payment_method_normalized <> 'UNKNOWN';

    IF v_invoice_count <> 23 OR v_client_count <> 15 OR v_expected <> 5186892 THEN
        RAISE EXCEPTION 'QA GR-2026-000001 fixture inesperado: invoices %, clients %, total %',
            v_invoice_count, v_client_count, v_expected;
    END IF;

    IF (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id) <> 23
       OR (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method = 'CASH') <> 9
       OR (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method = 'CHECK') <> 0
       OR (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method = 'TRANSFER') <> 8
       OR (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method = 'CREDIT') <> 6
       OR (SELECT sum(expected_amount) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id) <> 5186892 THEN
        RAISE EXCEPTION 'QA universo/totales de Rendición falló';
    END IF;

    v_detail := adquisiciones.get_route_settlement_detail(v_settlement_id);
    IF (v_detail->'settlement'->>'invoice_count')::integer <> 23
       OR (v_detail->'settlement'->>'customer_count')::integer <> 15
       OR (v_detail->'settlement'->>'total_expected')::numeric <> 5186892
       OR (v_detail->'settlement'->>'resolved_invoice_count')::integer <> 0
       OR (v_detail->'settlement'->>'unresolved_invoice_count')::integer <> 23
       OR (v_detail->'settlement'->>'can_close')::boolean IS DISTINCT FROM false
       OR jsonb_array_length(v_detail->'clients') <> 15 THEN
        RAISE EXCEPTION 'QA read-model GR-2026-000001 falló: %', v_detail->'settlement';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_detail->'clients') c
        CROSS JOIN LATERAL jsonb_array_elements(c->'invoices') i
        WHERE i->>'expected_payment_method' IS NULL
           OR i->>'expected_payment_method_original' IS NULL
           OR i->>'payment_method_received' IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'QA separación medio esperado/real falló';
    END IF;

    SELECT g.id INTO v_other_guide_id
    FROM logistica.route_guides g
    WHERE g.status = 'DISPATCHED'
      AND g.id <> v_guide_id
      AND NOT EXISTS (
          SELECT 1 FROM adquisiciones.route_settlements s WHERE s.route_guide_id = g.id
      )
      AND EXISTS (
          SELECT 1 FROM logistica.route_guide_items i
          WHERE i.route_guide_id = g.id
            AND NULLIF(btrim(i.invoice_number), '') IS NOT NULL
            AND i.payment_method_normalized <> 'UNKNOWN'
      )
      AND NOT EXISTS (
          SELECT 1 FROM logistica.route_guide_items i
          WHERE i.route_guide_id = g.id
            AND i.payment_method_normalized IN ('CASH', 'CHECK')
      )
    LIMIT 1;
    IF v_other_guide_id IS NULL THEN
        RAISE EXCEPTION 'QA: no existe una Guía DISPATCHED 100%% TRANSFER/CREDIT disponible';
    END IF;

    v_result := adquisiciones.create_route_settlement_from_guide(v_other_guide_id, v_user_id);
    IF COALESCE((v_result->>'created')::boolean, false) IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'QA Guía sin CASH/CHECK no creó Rendición: %', v_result;
    END IF;

    RAISE NOTICE 'QA PASS: universo completo, read-model, cuatro medios y Guía sin CASH/CHECK';
END;
$$;

ROLLBACK;

SELECT
    (SELECT count(*) FROM adquisiciones.route_settlements WHERE route_guide_id = (SELECT id FROM logistica.route_guides WHERE guide_number = 'GR-2026-000001')) AS persistent_target_settlements,
    (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id IN (SELECT id FROM adquisiciones.route_settlements WHERE route_guide_id = (SELECT id FROM logistica.route_guides WHERE guide_number = 'GR-2026-000001'))) AS persistent_target_items;
