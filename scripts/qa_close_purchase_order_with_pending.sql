-- QA transaccional: cierre manual de orden de compra con saldo pendiente.
--
-- Ejecutar contra la base vinculada (postgres) dentro de una transaccion que
-- termina siempre en ROLLBACK. No persiste fixtures ni modifica una OC real:
-- la orden, la recepcion historica y la operacion Bsale se crean dentro de la
-- transaccion y desaparecen al revertir.
--
--   npx supabase db query --linked --file scripts/qa_close_purchase_order_with_pending.sql

BEGIN;

DO $$
DECLARE
    v_company uuid;
    v_actor uuid;
    v_limited_user uuid;
    v_receipt_user uuid;
    v_supplier uuid;
    v_po uuid;
    v_blocked_po uuid;
    v_item uuid;
    v_receipt uuid;
    v_result jsonb;
    v_attempt jsonb;
    v_status text;
    v_closed_with_pending boolean;
    v_closure_reason text;
    v_received_before numeric;
    v_received_after numeric;
    v_quantity_before numeric;
    v_quantity_after numeric;
    v_kardex_before bigint;
    v_kardex_after bigint;
    v_receipts_before bigint;
    v_receipts_after bigint;
    v_bsale_before bigint;
    v_bsale_after bigint;
BEGIN
    SELECT c.id INTO v_company FROM core.companies c WHERE c.is_active ORDER BY c.created_at LIMIT 1;
    IF v_company IS NULL THEN RAISE EXCEPTION 'QA: no hay empresa activa'; END IF;

    SELECT u.id INTO v_actor
    FROM portal.users u
    WHERE u.is_active AND u.deleted_at IS NULL
      AND core.has_company_access(u.id, v_company)
      AND portal.user_has_permission(u.id, 'adquisiciones.po.update')
    ORDER BY u.created_at
    LIMIT 1;
    IF v_actor IS NULL THEN RAISE EXCEPTION 'QA: no hay usuario con adquisiciones.po.update y acceso a la empresa'; END IF;

    SELECT u.id INTO v_limited_user
    FROM portal.users u
    WHERE u.is_active AND u.deleted_at IS NULL
      AND core.has_company_access(u.id, v_company)
      AND NOT portal.user_has_permission(u.id, 'system.admin')
      AND NOT portal.user_has_permission(u.id, 'adquisiciones.po.update')
    ORDER BY u.created_at
    LIMIT 1;

    SELECT s.id INTO v_supplier FROM adquisiciones.suppliers s
    WHERE s.company_id = v_company AND s.is_active ORDER BY s.created_at LIMIT 1;
    IF v_supplier IS NULL THEN RAISE EXCEPTION 'QA: no hay proveedor para la empresa'; END IF;

    -- ===================== FIXTURES (reversibles) =====================
    INSERT INTO adquisiciones.purchase_orders (
        company_id, correlative, issue_date, supplier_id, requested_by, status,
        receipt_status, invoice_status, po_type, currency, source_type,
        net_total, tax_total, grand_total, created_by, updated_by
    ) VALUES (
        v_company, 'QA-CLOSE-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISS'), CURRENT_DATE,
        v_supplier, v_actor, 'RECEPCION_PARCIAL', 'RECEPCION_PARCIAL', 'PENDIENTE',
        'SERVICIOS', 'CLP', 'MANUAL', 1000, 190, 1190, v_actor, v_actor
    ) RETURNING id INTO v_po;

    INSERT INTO adquisiciones.purchase_order_items (
        company_id, po_id, line_number, item_type, product_description, unit,
        quantity, unit_price, discount_percent, tax_rate, quantity_received, created_by, updated_by
    ) VALUES (
        v_company, v_po, 1, 'SERVICE', 'QA cierre con saldo pendiente', 'UN',
        10, 100, 0, 19, 4, v_actor, v_actor
    ) RETURNING id INTO v_item;

    -- A historical receipt that must survive the closure.
    INSERT INTO logistica.purchase_receipts (
        company_id, purchase_order_id, receipt_number, receiving_type, status,
        document_type, document_number, idempotency_key, created_by, received_by
    ) VALUES (
        v_company, v_po, 'QA-REC-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISS'), 'OFFICE', 'COMPLETED',
        'FA', 'QA-DOC-1', gen_random_uuid(), v_actor, v_actor
    ) RETURNING id INTO v_receipt;

    INSERT INTO logistica.purchase_receipt_items (
        company_id, receipt_id, purchase_order_item_id, service_description,
        quantity_ordered, quantity_previously_received, quantity_received, quantity_pending_after, created_by
    ) VALUES (
        v_company, v_receipt, v_item, 'QA cierre con saldo pendiente',
        10, 0, 4, 6, v_actor
    );

    INSERT INTO logistica.receipt_documents (
        company_id, receipt_id, document_type, document_number, created_by
    ) VALUES (
        v_company, v_receipt, 'FA', 'QA-DOC-1', v_actor
    );

    INSERT INTO integraciones.bsale_purchase_receipt_operations (
        company_id, purchase_receipt_id, correlation_code, status, payload_snapshot, created_by
    ) VALUES (
        v_company, v_receipt, 'QA-BSALE-' || gen_random_uuid(), 'PREPARED', '{}'::jsonb, v_actor
    );

    -- A second fixture in a non-permitted state.
    INSERT INTO adquisiciones.purchase_orders (
        company_id, correlative, issue_date, supplier_id, requested_by, status,
        receipt_status, invoice_status, po_type, currency, source_type,
        net_total, tax_total, grand_total, created_by, updated_by
    ) VALUES (
        v_company, 'QA-CLOSE-TOTAL-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISS'), CURRENT_DATE,
        v_supplier, v_actor, 'RECEPCION_TOTAL', 'RECEPCION_TOTAL', 'PENDIENTE',
        'SERVICIOS', 'CLP', 'MANUAL', 1000, 190, 1190, v_actor, v_actor
    ) RETURNING id INTO v_blocked_po;

    SELECT quantity_received, quantity INTO v_received_before, v_quantity_before
    FROM adquisiciones.purchase_order_items WHERE id = v_item;
    SELECT count(*) INTO v_kardex_before FROM logistica.kardex_movements WHERE company_id = v_company;
    SELECT count(*) INTO v_receipts_before FROM logistica.purchase_receipts WHERE company_id = v_company;
    SELECT count(*) INTO v_bsale_before FROM integraciones.bsale_purchase_receipt_operations WHERE company_id = v_company;

    PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);

    -- ============ 1) Rechazo cuando falta motivo ============
    BEGIN
        PERFORM adquisiciones.close_purchase_order_with_pending(v_po, '   ', v_actor, v_company);
        RAISE EXCEPTION 'QA-FAIL: acepto un motivo vacio';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM = 'QA-FAIL: acepto un motivo vacio' THEN RAISE; END IF;
        IF position('motivo de cierre' in lower(SQLERRM)) = 0 THEN
            RAISE EXCEPTION 'QA-FAIL: rechazo por motivo inesperado: %', SQLERRM;
        END IF;
    END;

    -- ============ 2) Rechazo de identidad no confiable (suplantacion) ============
    BEGIN
        PERFORM adquisiciones.close_purchase_order_with_pending(v_po, 'QA suplantacion', gen_random_uuid(), v_company);
        RAISE EXCEPTION 'QA-FAIL: acepto una identidad distinta a la sesion';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM = 'QA-FAIL: acepto una identidad distinta a la sesion' THEN RAISE; END IF;
    END;

    -- ============ 3) Rechazo para usuario sin permiso de actualizacion ============
    IF v_limited_user IS NOT NULL THEN
        PERFORM set_config('request.jwt.claim.sub', v_limited_user::text, true);
        BEGIN
            PERFORM adquisiciones.close_purchase_order_with_pending(v_po, 'QA sin permiso', v_limited_user, v_company);
            RAISE EXCEPTION 'QA-FAIL: acepto un usuario sin adquisiciones.po.update';
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM = 'QA-FAIL: acepto un usuario sin adquisiciones.po.update' THEN RAISE; END IF;
        END;
        PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);
    ELSE
        RAISE NOTICE 'QA: sin usuario restringido disponible; se omite el caso de permiso insuficiente';
    END IF;

    -- ============ 4) Rechazo de estados no permitidos ============
    BEGIN
        PERFORM adquisiciones.close_purchase_order_with_pending(v_blocked_po, 'QA estado invalido', v_actor, v_company);
        RAISE EXCEPTION 'QA-FAIL: acepto una OC RECEPCION_TOTAL';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM = 'QA-FAIL: acepto una OC RECEPCION_TOTAL' THEN RAISE; END IF;
        IF position('RECEPCION_PARCIAL' in SQLERRM) = 0 THEN
            RAISE EXCEPTION 'QA-FAIL: rechazo por estado inesperado: %', SQLERRM;
        END IF;
    END;

    -- ============ 5) Cierre exitoso de la OC parcialmente recibida ============
    v_result := adquisiciones.close_purchase_order_with_pending(v_po, 'El proveedor no entregara el saldo restante', v_actor, v_company);
    IF (v_result->>'success')::boolean IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'QA-FAIL: cierre no exitoso: %', v_result;
    END IF;
    IF (v_result->>'already_closed')::boolean IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'QA-FAIL: el primer cierre se reporto como duplicado';
    END IF;

    SELECT status, closed_with_pending, closure_reason
    INTO v_status, v_closed_with_pending, v_closure_reason
    FROM adquisiciones.purchase_orders WHERE id = v_po;

    IF v_status <> 'CERRADA' THEN RAISE EXCEPTION 'QA-FAIL: estado % distinto de CERRADA', v_status; END IF;
    IF v_closed_with_pending IS DISTINCT FROM true THEN RAISE EXCEPTION 'QA-FAIL: closed_with_pending no quedo marcado'; END IF;
    IF v_closure_reason <> 'El proveedor no entregara el saldo restante' THEN RAISE EXCEPTION 'QA-FAIL: motivo no persistido'; END IF;
    IF NOT EXISTS (
        SELECT 1 FROM adquisiciones.purchase_order_status_history h
        WHERE h.po_id = v_po
          AND h.from_status = 'RECEPCION_PARCIAL'
          AND h.to_status = 'CERRADA'
          AND h.changed_by = v_actor
          AND h.reason = 'El proveedor no entregara el saldo restante'
    ) THEN
        RAISE EXCEPTION 'QA-FAIL: falta el registro de historial con usuario, estado previo y motivo';
    END IF;

    -- ============ 6) Cierre duplicado protegido ============
    v_result := adquisiciones.close_purchase_order_with_pending(v_po, 'Segundo intento', v_actor, v_company);
    IF (v_result->>'success')::boolean IS DISTINCT FROM true
       OR (v_result->>'already_closed')::boolean IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'QA-FAIL: no se detecto el cierre duplicado: %', v_result;
    END IF;
    IF (SELECT count(*) FROM adquisiciones.purchase_order_status_history h WHERE h.po_id = v_po AND h.to_status = 'CERRADA') <> 1 THEN
        RAISE EXCEPTION 'QA-FAIL: el cierre duplicado genero historial extra';
    END IF;

    -- ============ 7) Conservacion exacta de cantidades y documentos ============
    SELECT quantity_received, quantity INTO v_received_after, v_quantity_after
    FROM adquisiciones.purchase_order_items WHERE id = v_item;
    IF v_received_after <> v_received_before THEN RAISE EXCEPTION 'QA-FAIL: quantity_received cambio'; END IF;
    IF v_quantity_after <> v_quantity_before THEN RAISE EXCEPTION 'QA-FAIL: la cantidad solicitada cambio'; END IF;
    IF (v_quantity_before - v_received_before) <> 6 THEN RAISE EXCEPTION 'QA-FAIL: el saldo pendiente esperado no es 6'; END IF;
    IF (SELECT count(*) FROM adquisiciones.purchase_order_items WHERE po_id = v_po) <> 1 THEN
        RAISE EXCEPTION 'QA-FAIL: se alteraron las lineas de la OC';
    END IF;

    -- ============ 8) Recepcion historica y conciliacion Bsale visibles ============
    IF NOT EXISTS (SELECT 1 FROM logistica.purchase_receipts WHERE id = v_receipt AND status = 'COMPLETED') THEN
        RAISE EXCEPTION 'QA-FAIL: la recepcion historica desaparecio';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM logistica.receipt_documents WHERE receipt_id = v_receipt) THEN
        RAISE EXCEPTION 'QA-FAIL: el documento de la recepcion desaparecio';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM integraciones.bsale_purchase_receipt_operations WHERE purchase_receipt_id = v_receipt AND status = 'PREPARED') THEN
        RAISE EXCEPTION 'QA-FAIL: la conciliacion Bsale pendiente desaparecio';
    END IF;
    SELECT count(*) INTO v_receipts_after FROM logistica.purchase_receipts WHERE company_id = v_company;
    SELECT count(*) INTO v_bsale_after FROM integraciones.bsale_purchase_receipt_operations WHERE company_id = v_company;
    IF v_receipts_after <> v_receipts_before THEN RAISE EXCEPTION 'QA-FAIL: cambio el total de recepciones'; END IF;
    IF v_bsale_after <> v_bsale_before THEN RAISE EXCEPTION 'QA-FAIL: cambio el total de operaciones Bsale'; END IF;

    -- ============ 9) Sin movimientos de stock generados por el cierre ============
    SELECT count(*) INTO v_kardex_after FROM logistica.kardex_movements WHERE company_id = v_company;
    IF v_kardex_after <> v_kardex_before THEN RAISE EXCEPTION 'QA-FAIL: el cierre genero movimientos de Kardex'; END IF;

    -- ============ 10) Imposibilidad de ingresar otra recepcion ============
    SELECT u.id INTO v_receipt_user
    FROM portal.users u
    WHERE u.is_active AND u.deleted_at IS NULL
      AND core.has_company_access(u.id, v_company)
      AND (portal.user_has_permission(u.id, 'system.admin') OR portal.user_has_permission(u.id, 'logistica.receptions.create'))
    ORDER BY u.created_at LIMIT 1;

    IF v_receipt_user IS NOT NULL THEN
        PERFORM set_config('request.jwt.claim.sub', v_receipt_user::text, true);
        v_attempt := adquisiciones.create_purchase_receipt_db(
            v_company, v_po, 'OFFICE', NULL, 'QA intento post cierre', 'FA', 'QA-DOC-2', CURRENT_DATE,
            jsonb_build_array(jsonb_build_object(
                'purchase_order_item_id', v_item,
                'quantity_received', 1,
                'condition', 'CONFORME'
            )),
            v_receipt_user, gen_random_uuid(), NULL
        );
        IF (v_attempt->>'success')::boolean IS DISTINCT FROM false THEN
            RAISE EXCEPTION 'QA-FAIL: se permitio una recepcion en una OC cerrada: %', v_attempt;
        END IF;
        PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);
    ELSE
        RAISE NOTICE 'QA: sin usuario con logistica.receptions.create; se omite la prueba de nueva recepcion';
    END IF;

    RAISE NOTICE 'QA OK: cierre manual de OC con saldo pendiente validado (PO %)', v_po;
END;
$$;

ROLLBACK;
