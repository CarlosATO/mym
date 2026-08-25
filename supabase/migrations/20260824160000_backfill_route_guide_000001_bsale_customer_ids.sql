-- Resolve the Bsale customer identity for GR-2026-000001 / RR-2026-000001.
-- This is a scoped, auditable data migration. It intentionally changes only
-- customer_bsale_id on the 23 guide and settlement items in this route.

DO $$
DECLARE
    v_company_id uuid := 'd1000000-0000-0000-0000-000000000001';
    v_guide_id uuid := '24a8be95-f0b3-4dc9-a2b2-c5fd78d35592';
    v_settlement_id uuid := '23586a27-f710-4bd3-8785-e75f87006a38';
    v_guide_count integer;
    v_settlement_count integer;
    v_bad integer;
    v_rows integer;
    v_distinct_clients integer;
    v_outside_guide_before integer;
    v_outside_settlement_before integer;
    v_outside_guide_after integer;
    v_outside_settlement_after integer;
    v_status varchar;
    v_total_route_amount numeric(14,2);
    v_total_difference numeric(14,2);
    v_workflow_status varchar;
    v_financial_result varchar;
BEGIN
    -- The migration must target the exact known records, not a name match.
    IF NOT EXISTS (
        SELECT 1 FROM logistica.route_guides
        WHERE id = v_guide_id
          AND company_id = v_company_id
          AND guide_number = 'GR-2026-000001'
    ) THEN
        RAISE EXCEPTION 'La guía objetivo no existe o no coincide con la empresa/número esperado.';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM adquisiciones.route_settlements
        WHERE id = v_settlement_id
          AND company_id = v_company_id
          AND route_guide_id = v_guide_id
          AND settlement_number = 'RR-2026-000001'
    ) THEN
        RAISE EXCEPTION 'La rendición objetivo no existe o no corresponde a la guía objetivo.';
    END IF;

    SELECT status, total_route_amount, total_difference, workflow_status, financial_result
    INTO v_status, v_total_route_amount, v_total_difference, v_workflow_status, v_financial_result
    FROM adquisiciones.route_settlements
    WHERE id = v_settlement_id;

    IF v_status <> 'SETTLED_WITH_DIFFERENCE'
       OR v_total_route_amount <> 5186892
       OR v_total_difference <> 601584
       OR v_workflow_status IS NOT NULL
       OR v_financial_result IS NOT NULL THEN
        RAISE EXCEPTION 'La rendición objetivo no está en el estado financiero/workflow esperado.';
    END IF;

    IF EXISTS (
        SELECT 1 FROM adquisiciones.route_settlement_payments
        WHERE settlement_id = v_settlement_id
    ) OR EXISTS (
        SELECT 1 FROM adquisiciones.route_settlement_payment_allocations
        WHERE settlement_id = v_settlement_id
    ) THEN
        RAISE EXCEPTION 'La rendición objetivo ya contiene payments o allocations.';
    END IF;

    SELECT count(*) INTO v_guide_count
    FROM logistica.route_guide_items
    WHERE route_guide_id = v_guide_id
      AND company_id = v_company_id;

    IF v_guide_count <> 23 THEN
        RAISE EXCEPTION 'Se esperaban 23 guide_items y se encontraron %.', v_guide_count;
    END IF;

    SELECT count(*) INTO v_settlement_count
    FROM adquisiciones.route_settlement_items
    WHERE settlement_id = v_settlement_id
      AND company_id = v_company_id;

    IF v_settlement_count <> 23 THEN
        RAISE EXCEPTION 'Se esperaban 23 settlement_items y se encontraron %.', v_settlement_count;
    END IF;

    -- Every settlement item must point to one of the exact guide items and
    -- preserve the invoice and expected amount snapshot.
    SELECT count(*) INTO v_bad
    FROM adquisiciones.route_settlement_items si
    LEFT JOIN logistica.route_guide_items gi
      ON gi.id = si.route_guide_item_id
     AND gi.route_guide_id = v_guide_id
     AND gi.company_id = v_company_id
     AND gi.invoice_number = si.invoice_number
     AND gi.amount = si.expected_amount
    WHERE si.settlement_id = v_settlement_id
      AND (gi.id IS NULL OR si.company_id <> v_company_id);

    IF v_bad <> 0 THEN
        RAISE EXCEPTION 'Hay % settlement_items que no corresponden exactamente a la guía objetivo.', v_bad;
    END IF;

    SELECT count(DISTINCT route_guide_item_id) INTO v_bad
    FROM adquisiciones.route_settlement_items
    WHERE settlement_id = v_settlement_id;

    IF v_bad <> 23 THEN
        RAISE EXCEPTION 'Los settlement_items no representan 23 guide_items distintos: %.', v_bad;
    END IF;

    -- Exactly one Bsale invoice candidate per guide invoice, by company,
    -- invoice number and invoice document type. No customer_name matching.
    SELECT count(*) INTO v_bad
    FROM logistica.route_guide_items gi
    WHERE gi.route_guide_id = v_guide_id
      AND (
          SELECT count(*)
          FROM integraciones.bsale_documents d
          WHERE d.company_id = v_company_id
            AND d.number::text = gi.invoice_number
            AND d.document_type_id = 5
      ) <> 1;

    IF v_bad <> 0 THEN
        RAISE EXCEPTION '% guide_items no tienen exactamente un documento Bsale candidato.', v_bad;
    END IF;

    SELECT count(*) INTO v_bad
    FROM logistica.route_guide_items gi
    JOIN integraciones.bsale_documents d
      ON d.company_id = v_company_id
     AND d.number::text = gi.invoice_number
     AND d.document_type_id = 5
    LEFT JOIN integraciones.bsale_clients c
      ON c.company_id = v_company_id
     AND c.bsale_client_id = d.client_id
    WHERE gi.route_guide_id = v_guide_id
      AND (
          d.client_id IS NULL
          OR c.bsale_client_id IS NULL
          OR d.total_amount IS NULL
          OR d.total_amount <> gi.amount
      );

    IF v_bad <> 0 THEN
        RAISE EXCEPTION '% facturas fallan identidad Bsale, cliente o monto.', v_bad;
    END IF;

    SELECT count(*) INTO v_bad
    FROM adquisiciones.route_settlement_items si
    JOIN logistica.route_guide_items gi ON gi.id = si.route_guide_item_id
    JOIN integraciones.bsale_documents d
      ON d.company_id = v_company_id
     AND d.number::text = gi.invoice_number
     AND d.document_type_id = 5
    WHERE si.settlement_id = v_settlement_id
      AND d.total_amount <> si.expected_amount;

    IF v_bad <> 0 THEN
        RAISE EXCEPTION '% settlement_items no coinciden en monto con Bsale.', v_bad;
    END IF;

    SELECT count(*) INTO v_outside_guide_before
    FROM logistica.route_guide_items
    WHERE route_guide_id <> v_guide_id
      AND customer_bsale_id IS NOT NULL;

    SELECT count(*) INTO v_outside_settlement_before
    FROM adquisiciones.route_settlement_items
    WHERE settlement_id <> v_settlement_id
      AND customer_bsale_id IS NOT NULL;

    -- Existing non-null values, if any, may only already equal the Bsale
    -- source value. This prevents silently replacing an unexpected identity.
    SELECT count(*) INTO v_bad
    FROM logistica.route_guide_items gi
    JOIN integraciones.bsale_documents d
      ON d.company_id = v_company_id
     AND d.number::text = gi.invoice_number
     AND d.document_type_id = 5
    WHERE gi.route_guide_id = v_guide_id
      AND gi.customer_bsale_id IS NOT NULL
      AND gi.customer_bsale_id <> d.client_id;

    IF v_bad <> 0 THEN
        RAISE EXCEPTION '% guide_items ya tienen una identidad Bsale distinta.', v_bad;
    END IF;

    UPDATE logistica.route_guide_items gi
    SET customer_bsale_id = d.client_id
    FROM integraciones.bsale_documents d
    WHERE gi.route_guide_id = v_guide_id
      AND gi.company_id = v_company_id
      AND d.company_id = v_company_id
      AND d.number::text = gi.invoice_number
      AND d.document_type_id = 5;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 23 THEN
        RAISE EXCEPTION 'Se actualizaron % guide_items; se esperaban 23.', v_rows;
    END IF;

    UPDATE adquisiciones.route_settlement_items si
    SET customer_bsale_id = gi.customer_bsale_id
    FROM logistica.route_guide_items gi
    WHERE si.settlement_id = v_settlement_id
      AND si.company_id = v_company_id
      AND gi.id = si.route_guide_item_id
      AND gi.route_guide_id = v_guide_id
      AND gi.company_id = v_company_id;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 23 THEN
        RAISE EXCEPTION 'Se actualizaron % settlement_items; se esperaban 23.', v_rows;
    END IF;

    SELECT count(*) INTO v_outside_guide_after
    FROM logistica.route_guide_items
    WHERE route_guide_id <> v_guide_id
      AND customer_bsale_id IS NOT NULL;

    SELECT count(*) INTO v_outside_settlement_after
    FROM adquisiciones.route_settlement_items
    WHERE settlement_id <> v_settlement_id
      AND customer_bsale_id IS NOT NULL;

    IF v_outside_guide_after <> v_outside_guide_before
       OR v_outside_settlement_after <> v_outside_settlement_before THEN
        RAISE EXCEPTION 'La migración modificó identidades fuera del alcance objetivo.';
    END IF;

    SELECT count(DISTINCT customer_bsale_id) INTO v_distinct_clients
    FROM logistica.route_guide_items
    WHERE route_guide_id = v_guide_id;

    IF v_distinct_clients <> 15 THEN
        RAISE EXCEPTION 'Se esperaban 15 clientes Bsale y se encontraron %.', v_distinct_clients;
    END IF;

    IF EXISTS (
        SELECT 1 FROM logistica.route_guide_items
        WHERE route_guide_id = v_guide_id
          AND customer_bsale_id IS NULL
    ) OR EXISTS (
        SELECT 1 FROM adquisiciones.route_settlement_items
        WHERE settlement_id = v_settlement_id
          AND customer_bsale_id IS NULL
    ) THEN
        RAISE EXCEPTION 'Quedaron identidades Bsale NULL en el alcance objetivo.';
    END IF;

    IF (SELECT count(*) FROM logistica.route_guide_items
        WHERE route_guide_id = v_guide_id
          AND invoice_number IN ('23815', '23823', '23825')
          AND customer_bsale_id = 469) <> 3 THEN
        RAISE EXCEPTION 'El grupo Bsale 469 no coincide con 23815/23823/23825.';
    END IF;

    IF (SELECT count(*) FROM logistica.route_guide_items
        WHERE route_guide_id = v_guide_id
          AND invoice_number IN ('23816', '23821')
          AND customer_bsale_id = 637) <> 2 THEN
        RAISE EXCEPTION 'El grupo Bsale 637 no coincide con 23816/23821.';
    END IF;
END;
$$;
