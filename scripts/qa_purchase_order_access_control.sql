-- QA transaccional: control de acceso a lectura de ordenes de compra.
--
-- Ejecutar contra la base vinculada (postgres) dentro de una transaccion que
-- termina siempre en ROLLBACK. No modifica datos operacionales reales: las OC
-- y accesos usados son fixtures que desaparecen al revertir.
--
--   npx supabase db query --linked --file scripts/qa_purchase_order_access_control.sql

BEGIN;

DO $$
DECLARE
    v_company_a uuid;
    v_company_b uuid;
    v_supplier_a uuid;
    v_supplier_b uuid;
    v_admin_a uuid;
    v_closer uuid;
    v_denied uuid;
    v_po_a uuid;
    v_po_b uuid;
    v_corr_a text;
    v_corr_b text;
    v_result jsonb;
    v_detail jsonb;
    v_close jsonb;
    v_status text;
    v_found boolean;
    v_priv boolean;
BEGIN
    SELECT id INTO v_company_a FROM core.companies WHERE is_active ORDER BY created_at LIMIT 1;
    SELECT id INTO v_company_b FROM core.companies WHERE is_active AND id <> v_company_a ORDER BY created_at LIMIT 1;
    IF v_company_a IS NULL OR v_company_b IS NULL THEN RAISE EXCEPTION 'QA: se requieren al menos dos empresas activas'; END IF;

    SELECT id INTO v_supplier_a FROM adquisiciones.suppliers WHERE company_id = v_company_a AND is_active ORDER BY created_at LIMIT 1;
    SELECT id INTO v_supplier_b FROM adquisiciones.suppliers WHERE company_id = v_company_b AND is_active ORDER BY created_at LIMIT 1;
    IF v_supplier_a IS NULL THEN SELECT id INTO v_supplier_a FROM adquisiciones.suppliers WHERE is_active ORDER BY created_at LIMIT 1; END IF;
    IF v_supplier_b IS NULL THEN v_supplier_b := v_supplier_a; END IF;
    IF v_supplier_a IS NULL THEN RAISE EXCEPTION 'QA: se requiere al menos un proveedor'; END IF;

    SELECT u.id INTO v_admin_a
    FROM portal.users u
    WHERE u.is_active AND u.deleted_at IS NULL
      AND core.has_company_access(u.id, v_company_a)
      AND (portal.user_has_permission(u.id, 'system.admin') OR portal.user_has_permission(u.id, 'adquisiciones.po.view'))
    ORDER BY u.created_at LIMIT 1;

    SELECT u.id INTO v_closer
    FROM portal.users u
    WHERE u.is_active AND u.deleted_at IS NULL
      AND core.has_company_access(u.id, v_company_a)
      AND (portal.user_has_permission(u.id, 'system.admin') OR portal.user_has_permission(u.id, 'adquisiciones.po.update'))
    ORDER BY u.created_at LIMIT 1;

    SELECT u.id INTO v_denied
    FROM portal.users u
    WHERE u.is_active AND u.deleted_at IS NULL
      AND core.has_company_access(u.id, v_company_a)
      AND NOT portal.user_has_permission(u.id, 'system.admin')
      AND NOT portal.user_has_permission(u.id, 'adquisiciones.po.view')
    ORDER BY u.created_at LIMIT 1;

    IF v_admin_a IS NULL THEN RAISE EXCEPTION 'QA: no hay usuario autorizado a ver OC en la empresa A'; END IF;
    IF v_closer IS NULL THEN RAISE EXCEPTION 'QA: no hay usuario autorizado a actualizar OC en la empresa A'; END IF;

    -- ===================== FIXTURES (reversibles) =====================
    v_corr_a := 'QA-ACL-A-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISS');
    v_corr_b := 'QA-ACL-B-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISS');

    INSERT INTO adquisiciones.purchase_orders (
        company_id, correlative, issue_date, supplier_id, requested_by, status,
        receipt_status, invoice_status, po_type, currency, source_type,
        net_total, tax_total, grand_total, created_by, updated_by
    ) VALUES (
        v_company_a, v_corr_a, CURRENT_DATE, v_supplier_a, v_closer, 'RECEPCION_PARCIAL',
        'RECEPCION_PARCIAL', 'PENDIENTE', 'SERVICIOS', 'CLP', 'MANUAL',
        1000, 190, 1190, v_closer, v_closer
    ) RETURNING id INTO v_po_a;

    INSERT INTO adquisiciones.purchase_order_items (
        company_id, po_id, line_number, item_type, product_description, unit,
        quantity, unit_price, discount_percent, tax_rate, quantity_received, created_by, updated_by
    ) VALUES (
        v_company_a, v_po_a, 1, 'SERVICE', 'QA ACL saldo pendiente', 'UN',
        10, 100, 0, 19, 4, v_closer, v_closer
    );

    INSERT INTO adquisiciones.purchase_orders (
        company_id, correlative, issue_date, supplier_id, requested_by, status,
        receipt_status, invoice_status, po_type, currency, source_type,
        net_total, tax_total, grand_total, created_by, updated_by
    ) VALUES (
        v_company_b, v_corr_b, CURRENT_DATE, v_supplier_b, v_closer, 'CONFIRMADA',
        'PENDIENTE', 'PENDIENTE', 'SERVICIOS', 'CLP', 'MANUAL',
        1000, 190, 1190, v_closer, v_closer
    ) RETURNING id INTO v_po_b;

    -- ============ Usuario autorizado consulta las OC de su empresa ============
    PERFORM set_config('request.jwt.claim.sub', v_admin_a::text, true);

    v_result := adquisiciones.get_purchase_orders('{}'::jsonb, v_admin_a, v_company_a);
    IF (v_result->>'total')::int < 1 THEN RAISE EXCEPTION 'QA-FAIL: el usuario autorizado no obtuvo listado'; END IF;
    SELECT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_result->'data') e WHERE e->>'correlative' = v_corr_a
    ) INTO v_found;
    IF NOT v_found THEN RAISE EXCEPTION 'QA-FAIL: el listado no incluye la OC de su empresa'; END IF;
    SELECT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_result->'data') e WHERE e->>'correlative' = v_corr_b
    ) INTO v_found;
    IF v_found THEN RAISE EXCEPTION 'QA-FAIL: el listado de la empresa A incluye una OC de la empresa B'; END IF;

    v_detail := adquisiciones.get_purchase_order_detail(v_po_a, v_admin_a, v_company_a);
    IF v_detail IS NULL OR (v_detail->'po'->>'correlative') <> v_corr_a THEN
        RAISE EXCEPTION 'QA-FAIL: el usuario autorizado no obtuvo el detalle de su empresa';
    END IF;

    -- ============ Aislamiento del detalle entre empresas ============
    v_detail := adquisiciones.get_purchase_order_detail(v_po_b, v_admin_a, v_company_a);
    IF v_detail IS NOT NULL THEN
        RAISE EXCEPTION 'QA-FAIL: se filtro el detalle de una OC de otra empresa';
    END IF;

    -- ============ Usuario de otra empresa no puede listar ni consultar detalle ============
    IF v_denied IS NOT NULL THEN
        PERFORM set_config('request.jwt.claim.sub', v_denied::text, true);

        BEGIN
            PERFORM adquisiciones.get_purchase_orders('{}'::jsonb, v_denied, v_company_b);
            RAISE EXCEPTION 'QA-FAIL: un usuario ajeno listo OC de otra empresa';
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM = 'QA-FAIL: un usuario ajeno listo OC de otra empresa' THEN RAISE; END IF;
            IF position('acceso a la empresa' in lower(SQLERRM)) = 0 THEN
                RAISE EXCEPTION 'QA-FAIL: denegacion inesperada al listar otra empresa: %', SQLERRM;
            END IF;
        END;

        BEGIN
            PERFORM adquisiciones.get_purchase_order_detail(v_po_b, v_denied, v_company_b);
            RAISE EXCEPTION 'QA-FAIL: un usuario ajeno consulto el detalle de otra empresa';
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM = 'QA-FAIL: un usuario ajeno consulto el detalle de otra empresa' THEN RAISE; END IF;
            IF position('acceso a la empresa' in lower(SQLERRM)) = 0 THEN
                RAISE EXCEPTION 'QA-FAIL: denegacion inesperada al ver detalle de otra empresa: %', SQLERRM;
            END IF;
        END;

        -- ============ Usuario sin permisos recibe denegacion correcta ============
        BEGIN
            PERFORM adquisiciones.get_purchase_orders('{}'::jsonb, v_denied, v_company_a);
            RAISE EXCEPTION 'QA-FAIL: un usuario sin permiso listo OC';
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM = 'QA-FAIL: un usuario sin permiso listo OC' THEN RAISE; END IF;
            IF position('permisos insuficientes' in lower(SQLERRM)) = 0 THEN
                RAISE EXCEPTION 'QA-FAIL: denegacion inesperada por permisos: %', SQLERRM;
            END IF;
        END;
    ELSE
        RAISE NOTICE 'QA: sin usuario restringido disponible; se omiten casos de otra empresa y sin permisos';
    END IF;

    -- ============ Identidad de sesion no suplantable ============
    PERFORM set_config('request.jwt.claim.sub', v_admin_a::text, true);
    BEGIN
        PERFORM adquisiciones.get_purchase_orders('{}'::jsonb, gen_random_uuid(), v_company_a);
        RAISE EXCEPTION 'QA-FAIL: se acepto un p_user_id distinto a la sesion';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM = 'QA-FAIL: se acepto un p_user_id distinto a la sesion' THEN RAISE; END IF;
    END;

    -- ============ Ninguna RPC privilegiada es ejecutable por authenticated/anon ============
    v_priv := has_function_privilege('authenticated', 'adquisiciones.get_purchase_orders(jsonb, uuid, uuid)', 'EXECUTE');
    IF v_priv THEN RAISE EXCEPTION 'QA-FAIL: authenticated puede ejecutar get_purchase_orders'; END IF;
    v_priv := has_function_privilege('anon', 'adquisiciones.get_purchase_orders(jsonb, uuid, uuid)', 'EXECUTE');
    IF v_priv THEN RAISE EXCEPTION 'QA-FAIL: anon puede ejecutar get_purchase_orders'; END IF;
    v_priv := has_function_privilege('authenticated', 'adquisiciones.get_purchase_order_detail(uuid, uuid, uuid)', 'EXECUTE');
    IF v_priv THEN RAISE EXCEPTION 'QA-FAIL: authenticated puede ejecutar get_purchase_order_detail'; END IF;
    v_priv := has_function_privilege('authenticated', 'adquisiciones.close_purchase_order_with_pending(uuid, text, uuid, uuid)', 'EXECUTE');
    IF v_priv THEN RAISE EXCEPTION 'QA-FAIL: authenticated puede ejecutar close_purchase_order_with_pending'; END IF;
    v_priv := has_function_privilege('service_role', 'adquisiciones.get_purchase_orders(jsonb, uuid, uuid)', 'EXECUTE');
    IF NOT v_priv THEN RAISE EXCEPTION 'QA-FAIL: service_role no puede ejecutar get_purchase_orders'; END IF;
    v_priv := has_function_privilege('service_role', 'adquisiciones.get_purchase_order_detail(uuid, uuid, uuid)', 'EXECUTE');
    IF NOT v_priv THEN RAISE EXCEPTION 'QA-FAIL: service_role no puede ejecutar get_purchase_order_detail'; END IF;
    v_priv := has_function_privilege('service_role', 'adquisiciones.close_purchase_order_with_pending(uuid, text, uuid, uuid)', 'EXECUTE');
    IF NOT v_priv THEN RAISE EXCEPTION 'QA-FAIL: service_role no puede ejecutar close_purchase_order_with_pending'; END IF;

    -- Un JWT authenticated no puede saltarse la validacion llamando la RPC directo.
    EXECUTE 'SET LOCAL ROLE authenticated';
    BEGIN
        PERFORM adquisiciones.get_purchase_orders('{}'::jsonb, v_admin_a, v_company_a);
        RAISE EXCEPTION 'QA-FAIL: authenticated ejecuto la RPC privilegiada directamente';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
    EXECUTE 'RESET ROLE';

    -- ============ El cierre manual sigue funcionando ============
    PERFORM set_config('request.jwt.claim.sub', v_closer::text, true);
    v_close := adquisiciones.close_purchase_order_with_pending(v_po_a, 'QA cierre ACL', v_closer, v_company_a);
    IF (v_close->>'success')::boolean IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'QA-FAIL: el cierre manual dejo de funcionar: %', v_close;
    END IF;
    SELECT status INTO v_status FROM adquisiciones.purchase_orders WHERE id = v_po_a;
    IF v_status <> 'CERRADA' THEN RAISE EXCEPTION 'QA-FAIL: el cierre no dejo la OC en CERRADA'; END IF;

    RAISE NOTICE 'QA OK: controles de acceso a ordenes de compra validados';
END;
$$;

SELECT 'QA_OK' AS result, 'control de acceso a OC validado en transaccion reversible' AS detail;

ROLLBACK;
