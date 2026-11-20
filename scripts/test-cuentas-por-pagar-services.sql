-- Ejecutar exclusivamente en una base aislada llamada cxp_real_contract.
\set ON_ERROR_STOP on
DO $$ BEGIN IF current_database() <> 'cxp_real_contract' OR inet_server_addr() IS DISTINCT FROM '127.0.0.1'::inet THEN RAISE EXCEPTION 'Solo permitido en base local aislada'; END IF; END $$;
BEGIN;

INSERT INTO auth.users(id) VALUES
    ('20000000-0000-0000-0000-000000000021'),
    ('20000000-0000-0000-0000-000000000022');

INSERT INTO portal.roles(id, name) VALUES
    ('10000000-0000-0000-0000-000000000021', 'FINANZAS'),
    ('10000000-0000-0000-0000-000000000022', 'BODEGA')
ON CONFLICT (name) DO NOTHING;

INSERT INTO portal.users(id, email, nombre, apellido, role_id)
SELECT '20000000-0000-0000-0000-000000000021'::uuid, 'qa-svc-fin@example.invalid', 'Ana', 'Finanzas', id
FROM portal.roles WHERE name = 'FINANZAS'
UNION ALL
SELECT '20000000-0000-0000-0000-000000000022'::uuid, 'qa-svc-bod@example.invalid', 'Beto', 'Bodega', id
FROM portal.roles WHERE name = 'BODEGA';

INSERT INTO core.companies(id, business_name) VALUES
    ('d1000000-0000-0000-0000-000000000001', 'Caylo QA')
ON CONFLICT (id) DO NOTHING;

INSERT INTO core.user_company_access(user_id, company_id, role) VALUES
    ('20000000-0000-0000-0000-000000000021', 'd1000000-0000-0000-0000-000000000001', 'FINANZAS'),
    ('20000000-0000-0000-0000-000000000022', 'd1000000-0000-0000-0000-000000000001', 'BODEGA');

INSERT INTO adquisiciones.suppliers(id, rut, rut_normalized, business_name, credit_days, payment_terms, supplier_kind, company_id) VALUES
    ('30000000-0000-0000-0000-000000000021', '76.555.444-3', '765554443', 'Servicios Generales QA SpA', 30, '30 días', 'REAL', 'd1000000-0000-0000-0000-000000000001'),
    ('30000000-0000-0000-0000-000000000022', '11.111.111-1', '111111111', 'Proveedor Global QA SA', 0, NULL, 'REAL', NULL),
    ('30000000-0000-0000-0000-000000000023', '22.222.222-2', '222222222', 'Pseudoproveedor Bsale QA', 0, NULL, 'BSALE_OPERATIVE', 'd1000000-0000-0000-0000-000000000001');

-- Simular una factura de servicio ya registrada previamente como recepción de oficina (OFFICE).
INSERT INTO adquisiciones.purchase_orders(id, correlative, supplier_id, requested_by, company_id, po_type, status, receipt_status, grand_total) VALUES
    ('40000000-0000-0000-0000-000000000021', 'OC-SVC-1', '30000000-0000-0000-0000-000000000021', '20000000-0000-0000-0000-000000000021', 'd1000000-0000-0000-0000-000000000001', 'SERVICIOS', 'RECEPCION_TOTAL', 'RECEPCION_TOTAL', 119000);

INSERT INTO logistica.purchase_receipts(
    id, company_id, purchase_order_id, receipt_number, receiving_type, status,
    document_type, document_number, document_date,
    receipt_total_net, receipt_total_tax, receipt_total_gross
) VALUES
    ('50000000-0000-0000-0000-000000000021', 'd1000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000021', 'REC-OF-1', 'OFFICE', 'COMPLETED', 'FA', '008801', '2026-11-01', 100000, 19000, 119000);

-- Registrar respaldos reales existentes en el bucket privado cuentas-por-pagar.
INSERT INTO storage.objects(bucket_id, name) VALUES
    ('cuentas-por-pagar', 'd1000000-0000-0000-0000-000000000001/services/fa-8801.pdf'),
    ('cuentas-por-pagar', 'd1000000-0000-0000-0000-000000000001/services/fa-8802.pdf');

SELECT set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000021', true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    v_created jsonb;
    v_id uuid;
    v_detail jsonb;
    v_validated jsonb;
    v_doc_count integer;
BEGIN
    -- 1. La recepción OFFICE/SERVICIOS no aparece en cxp_receipt_candidates (depuración de productos).
    IF EXISTS (SELECT 1 FROM public.cxp_receipt_candidates() WHERE folio = '8801') THEN
        RAISE EXCEPTION 'La recepción OFFICE apareció en cxp_receipt_candidates';
    END IF;

    -- 2a. Rechazo sin archivo de respaldo (NULL).
    BEGIN
        PERFORM public.cxp_create_service_invoice(
            '30000000-0000-0000-0000-000000000021', '8800', 'Servicio sin respaldo',
            '2026-11-01', '2026-12-01', 100000, 19000, 119000, 'PENDING', NULL, NULL, NULL
        );
        RAISE EXCEPTION 'Se permitió crear factura de servicio sin respaldo';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM = 'Se permitió crear factura de servicio sin respaldo' THEN RAISE; END IF;
    END;

    -- 2b. Rechazo con ruta ficticia que no existe en storage.objects.
    BEGIN
        PERFORM public.cxp_create_service_invoice(
            '30000000-0000-0000-0000-000000000021', '8800', 'Servicio ruta ficticia',
            '2026-11-01', '2026-12-01', 100000, 19000, 119000, 'PENDING',
            'd1000000-0000-0000-0000-000000000001/services/no-existe.pdf', 'no-existe.pdf', 'application/pdf'
        );
        RAISE EXCEPTION 'Se permitió crear factura de servicio con ruta inexistente';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM = 'Se permitió crear factura de servicio con ruta inexistente' THEN RAISE; END IF;
    END;

    -- 2c. Intentar ingresar manualmente el mismo RUT + folio (8801) de la recepción OFFICE debe rechazarse.
    BEGIN
        PERFORM public.cxp_create_service_invoice(
            '30000000-0000-0000-0000-000000000021', '8801', 'Servicio duplicado oficina',
            '2026-11-01', '2026-12-01', 100000, 19000, 119000, 'DELIVERED',
            'd1000000-0000-0000-0000-000000000001/services/fa-8801.pdf', 'fa-8801.pdf', 'application/pdf'
        );
        RAISE EXCEPTION 'Se permitió duplicar recepción OFFICE';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM = 'Se permitió duplicar recepción OFFICE' THEN RAISE; END IF;
    END;

    -- 3. Ingreso válido de factura de servicio con adjunto real en storage.objects (inicia en PENDING sin crear registros en Bodega).
    v_created := public.cxp_create_service_invoice(
        '30000000-0000-0000-0000-000000000021', '008802', 'Arriendo mensual bodega',
        '2026-11-05', '2026-12-05', 200000, 38000, 238000, 'PENDING',
        'd1000000-0000-0000-0000-000000000001/services/fa-8802.pdf', 'fa-8802.pdf', 'application/pdf'
    );
    v_id := (v_created->>'id')::uuid;

    IF v_created->>'validation_status' <> 'PENDING'
       OR v_created->>'purchase_type' <> 'SERVICES'
       OR v_created->>'service_delivery_status' <> 'PENDING'
       OR v_created->>'document_folio' <> '8802'
       OR (v_created->>'has_document')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Factura de servicio mal creada: %', v_created;
    END IF;

    -- 4. No permite duplicar el mismo RUT + folio (8802) en cuentas_por_pagar.invoices.
    BEGIN
        PERFORM public.cxp_create_service_invoice(
            '30000000-0000-0000-0000-000000000021', '8802', 'Servicio repetido',
            '2026-11-05', '2026-12-05', 200000, 38000, 238000, 'DELIVERED',
            'd1000000-0000-0000-0000-000000000001/services/fa-8802.pdf', 'fa-8802.pdf', 'application/pdf'
        );
        RAISE EXCEPTION 'Se permitió duplicar factura de servicio';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM = 'Se permitió duplicar factura de servicio' THEN RAISE; END IF;
    END;

    -- 5. Aparece en cxp_service_invoices, cxp_invoice_detail y su adjunto es accesible por cxp_receipt_document_for_invoice.
    IF (SELECT count(*) FROM public.cxp_service_invoices() WHERE id = v_id AND folio = '8802' AND has_document) <> 1 THEN
        RAISE EXCEPTION 'cxp_service_invoices no devolvió la factura creada';
    END IF;

    v_detail := public.cxp_invoice_detail(v_id);
    IF v_detail->'invoice'->>'purchase_type' <> 'SERVICES'
       OR jsonb_array_length(v_detail->'documents') <> 1 THEN
        RAISE EXCEPTION 'cxp_invoice_detail incompleto para servicio: %', v_detail;
    END IF;

    SELECT count(*) INTO v_doc_count FROM public.cxp_receipt_document_for_invoice(v_id, v_id);
    IF v_doc_count <> 1 THEN
        RAISE EXCEPTION 'Adjunto directo de servicio no autorizado en cxp_receipt_document_for_invoice';
    END IF;

    -- 6. Utiliza el flujo de validación del Bloque 3 (PENDING -> VALIDATED).
    v_validated := public.cxp_save_invoice_validation(
        v_id, '2026-11-05', '2026-12-05', 200000, 38000, 238000,
        'NO_PRIOR_PAYMENTS', NULL, NULL, false, NULL, true
    );
    IF v_validated->>'validation_status' <> 'VALIDATED' THEN
        RAISE EXCEPTION 'La validación de factura de servicio falló: %', v_validated;
    END IF;

    -- 6b. Alta rápida de proveedores: cxp_service_suppliers excluye BSALE_OPERATIVE, bloquea RUT inválido y duplicado global/local, y crea proveedor REAL/MANUAL.
    IF EXISTS (SELECT 1 FROM public.cxp_service_suppliers() WHERE id = '30000000-0000-0000-0000-000000000023') THEN
        RAISE EXCEPTION 'cxp_service_suppliers incluyó un proveedor BSALE_OPERATIVE';
    END IF;

    BEGIN
        PERFORM public.cxp_create_service_supplier('76.086.428-9', 'RUT Invalido SpA', NULL, NULL);
        RAISE EXCEPTION 'Se permitió crear proveedor con RUT chileno inválido';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM = 'Se permitió crear proveedor con RUT chileno inválido' THEN RAISE; END IF;
    END;

    BEGIN
        PERFORM public.cxp_create_service_supplier('11.111.111-1', 'Duplicado Global SpA', NULL, NULL);
        RAISE EXCEPTION 'Se permitió duplicar proveedor global por RUT';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM = 'Se permitió duplicar proveedor global por RUT' THEN RAISE; END IF;
    END;

    v_created := public.cxp_create_service_supplier('76086428-5', 'Proveedor Rápido QA SpA', 'pagos@rapido.cl', '+56 9 5555 4444');
    IF v_created->>'rut' <> '76.086.428-5' OR v_created->>'business_name' <> 'Proveedor Rápido QA SpA' THEN
        RAISE EXCEPTION 'Proveedor rápido mal creado: %', v_created;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.cxp_service_suppliers() WHERE id = (v_created->>'id')::uuid) THEN
        RAISE EXCEPTION 'Proveedor rápido creado no aparece en cxp_service_suppliers';
    END IF;

    BEGIN
        PERFORM public.cxp_create_service_supplier('76.086.428-5', 'Otro Nombre Mismo RUT', NULL, NULL);
        RAISE EXCEPTION 'Se permitió duplicar proveedor Caylo por RUT';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM = 'Se permitió duplicar proveedor Caylo por RUT' THEN RAISE; END IF;
    END;
END $$;

-- 7. Rol no autorizado (BODEGA) recibe insufficient_privilege.
SELECT set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000022', true);
DO $$ BEGIN
    BEGIN PERFORM public.cxp_service_invoices(); RAISE EXCEPTION 'acceso no autorizado'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    BEGIN PERFORM public.cxp_create_service_invoice('30000000-0000-0000-0000-000000000021', '9999', 'Test', '2026-11-01', '2026-12-01', 1000, 190, 1190, 'PENDING', NULL, NULL, NULL); RAISE EXCEPTION 'escritura no autorizada'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    BEGIN PERFORM public.cxp_create_service_supplier('76.086.428-5', 'Sin Permiso SpA', NULL, NULL); RAISE EXCEPTION 'alta proveedor no autorizada'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;

RESET ROLE;

-- 8. Confirmar restricción SQL directa (CHECK/trigger), cero escrituras en Bodega y registro de auditoría.
DO $$ BEGIN
    BEGIN
        INSERT INTO cuentas_por_pagar.invoices (
            company_id, supplier_id, issuer_rut, document_type, document_folio,
            issue_date, due_date, net_amount, tax_amount, total_amount,
            origin, validation_status, prior_payment_status, discrepancy_status,
            purchase_type, service_description, service_delivery_status
        ) VALUES (
            'd1000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000021',
            '765554443', 'FA', '8899', '2026-11-05', '2026-12-05',
            100000, 19000, 119000, 'MANUAL', 'PENDING', 'UNREVIEWED', 'NONE',
            'SERVICES', 'Intento directo sin respaldo', 'PENDING'
        );
        RAISE EXCEPTION 'Se permitió INSERT directo SERVICES sin respaldo';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    IF NOT EXISTS (
        SELECT 1
        FROM adquisiciones.suppliers
        WHERE rut_normalized = '760864285'
          AND company_id = 'd1000000-0000-0000-0000-000000000001'
          AND supplier_kind = 'REAL'
          AND source = 'MANUAL'
          AND status = 'ACTIVE'
          AND is_active = true
          AND contact_email = 'pagos@rapido.cl'
          AND contact_phone = '+56 9 5555 4444'
    ) THEN
        RAISE EXCEPTION 'Proveedor rápido no quedó guardado con company_id Caylo, REAL y MANUAL';
    END IF;

    IF (SELECT count(*) FROM logistica.purchase_receipts) <> 1 THEN
        RAISE EXCEPTION 'Se crearon registros inesperados en logistica.purchase_receipts';
    END IF;
    IF (SELECT count(*) FROM portal.audit_logs WHERE schema_name = 'cuentas_por_pagar' AND table_name = 'invoices' AND action = 'INSERT') < 1 THEN
        RAISE EXCEPTION 'Falta registro de auditoría INSERT para factura de servicio';
    END IF;
END $$;

ROLLBACK;
