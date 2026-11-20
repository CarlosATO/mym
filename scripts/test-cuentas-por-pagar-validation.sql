-- Ejecutar exclusivamente en una base aislada llamada cxp_real_contract.
\set ON_ERROR_STOP on
DO $$ BEGIN IF current_database() <> 'cxp_real_contract' OR inet_server_addr() IS DISTINCT FROM '127.0.0.1'::inet THEN RAISE EXCEPTION 'Solo permitido en base local aislada'; END IF; END $$;
BEGIN;

INSERT INTO auth.users(id) VALUES
    ('20000000-0000-0000-0000-000000000011'),
    ('20000000-0000-0000-0000-000000000012');

INSERT INTO portal.roles(id, name) VALUES
    ('10000000-0000-0000-0000-000000000011', 'FINANZAS'),
    ('10000000-0000-0000-0000-000000000012', 'BODEGA')
ON CONFLICT (name) DO NOTHING;

INSERT INTO portal.users(id, email, nombre, apellido, role_id)
SELECT '20000000-0000-0000-0000-000000000011'::uuid, 'qa-finanzas@example.invalid', 'Ana', 'Finanzas', id
FROM portal.roles WHERE name = 'FINANZAS'
UNION ALL
SELECT '20000000-0000-0000-0000-000000000012'::uuid, 'qa-bodega@example.invalid', 'Beto', 'Bodega', id
FROM portal.roles WHERE name = 'BODEGA';

INSERT INTO core.companies(id, business_name) VALUES
    ('d1000000-0000-0000-0000-000000000001', 'Caylo QA')
ON CONFLICT (id) DO NOTHING;

INSERT INTO core.user_company_access(user_id, company_id, role) VALUES
    ('20000000-0000-0000-0000-000000000011', 'd1000000-0000-0000-0000-000000000001', 'FINANZAS'),
    ('20000000-0000-0000-0000-000000000012', 'd1000000-0000-0000-0000-000000000001', 'BODEGA');

INSERT INTO adquisiciones.suppliers(id, rut, business_name, credit_days, payment_terms) VALUES
    ('30000000-0000-0000-0000-000000000011', '76.999.888-7', 'Proveedor Mascotas SpA', 30, '30 días');

INSERT INTO adquisiciones.purchase_orders(id, correlative, supplier_id, requested_by, company_id, grand_total) VALUES
    ('40000000-0000-0000-0000-000000000011', 'OC-901', '30000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000011', 'd1000000-0000-0000-0000-000000000001', 119000),
    ('40000000-0000-0000-0000-000000000012', 'OC-902', '30000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000011', 'd1000000-0000-0000-0000-000000000001', 238000),
    ('40000000-0000-0000-0000-000000000013', 'OC-903', '30000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000011', 'd1000000-0000-0000-0000-000000000001', 59500);

INSERT INTO logistica.purchase_receipts(
    id, company_id, purchase_order_id, receipt_number, receiving_type, status,
    document_type, document_number, document_date,
    receipt_total_net, receipt_total_tax, receipt_total_gross
) VALUES
    ('50000000-0000-0000-0000-000000000011', 'd1000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000011', 'REC-9001', 'WAREHOUSE', 'COMPLETED', 'FA', '004501', '2026-11-01', 100000, 19000, 119000),
    ('50000000-0000-0000-0000-000000000012', 'd1000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000012', 'REC-9002', 'WAREHOUSE', 'COMPLETED', 'FA', '4502', '2026-11-02', 200000, 38000, 238000),
    ('50000000-0000-0000-0000-000000000013', 'd1000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000013', 'REC-9003', 'WAREHOUSE', 'COMPLETED', 'FA', '4503', '2026-11-03', 50000, 9500, 59500);

INSERT INTO logistica.receipt_documents(
    id, company_id, receipt_id, document_type, document_number, storage_bucket, storage_path, file_name, mime_type
) VALUES
    ('70000000-0000-0000-0000-000000000011', 'd1000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000011', 'FA', '4501', 'recepciones', 'd1000000-0000-0000-0000-000000000001/rec-9001.pdf', 'fa-4501.pdf', 'application/pdf'),
    ('70000000-0000-0000-0000-000000000012', 'd1000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000012', 'FA', '4502', 'recepciones', 'd1000000-0000-0000-0000-000000000001/rec-9002.pdf', 'fa-4502.pdf', 'application/pdf');

SELECT set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000011', true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    v_ids uuid[];
    v_inv1 uuid;
    v_inv2 uuid;
    v_inv3 uuid;
    v_detail jsonb;
    v_saved jsonb;
    v_doc_count integer;
BEGIN
    SELECT array_agg(candidate_id) INTO v_ids FROM public.cxp_receipt_candidates();
    PERFORM public.cxp_incorporate_receipts(v_ids);

    SELECT id INTO v_inv1 FROM cuentas_por_pagar.invoices WHERE document_folio = '4501';
    SELECT id INTO v_inv2 FROM cuentas_por_pagar.invoices WHERE document_folio = '4502';
    SELECT id INTO v_inv3 FROM cuentas_por_pagar.invoices WHERE document_folio = '4503';

    -- 1. Detalle incluye proveedor, OC, recepciones, referencia y documento PDF
    v_detail := public.cxp_invoice_detail(v_inv1);
    IF v_detail->'invoice'->>'validation_status' <> 'PENDING'
       OR (v_detail->'reference'->>'reference_gross_rounded')::numeric <> 119000
       OR jsonb_array_length(v_detail->'purchase_orders') <> 1
       OR jsonb_array_length(v_detail->'receipts') <> 1
       OR jsonb_array_length(v_detail->'documents') <> 1 THEN
        RAISE EXCEPTION 'cxp_invoice_detail incompleto: %', v_detail;
    END IF;

    -- 2. Respaldo PDF autorizado por factura y bloqueado si pertenece a otra factura
    SELECT count(*) INTO v_doc_count FROM public.cxp_receipt_document_for_invoice(v_inv1, '70000000-0000-0000-0000-000000000011');
    IF v_doc_count <> 1 THEN RAISE EXCEPTION 'Documento propio no encontrado'; END IF;
    SELECT count(*) INTO v_doc_count FROM public.cxp_receipt_document_for_invoice(v_inv1, '70000000-0000-0000-0000-000000000012');
    IF v_doc_count <> 0 THEN RAISE EXCEPTION 'Se permitió documento de otra factura'; END IF;

    -- 3. Bloqueos de validación (UNREVIEWED, sin vencimiento, discrepancia sin resolver, desglose inválido)
    BEGIN
        PERFORM public.cxp_save_invoice_validation(v_inv1, '2026-11-01', '2026-12-01', 100000, 19000, 119000, 'UNREVIEWED', NULL, NULL, false, NULL, true);
        RAISE EXCEPTION 'Se permitió validar con UNREVIEWED';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM = 'Se permitió validar con UNREVIEWED' THEN RAISE; END IF;
    END;

    BEGIN
        PERFORM public.cxp_save_invoice_validation(v_inv1, '2026-11-01', NULL, 100000, 19000, 119000, 'NO_PRIOR_PAYMENTS', NULL, NULL, false, NULL, true);
        RAISE EXCEPTION 'Se permitió validar sin vencimiento';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM = 'Se permitió validar sin vencimiento' THEN RAISE; END IF;
    END;

    BEGIN
        PERFORM public.cxp_save_invoice_validation(v_inv1, '2026-11-01', '2026-12-01', 100000, 18000, 119000, 'NO_PRIOR_PAYMENTS', NULL, NULL, false, NULL, true);
        RAISE EXCEPTION 'Se permitió validar con neto+iva inconsistente';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM = 'Se permitió validar con neto+iva inconsistente' THEN RAISE; END IF;
    END;

    BEGIN
        PERFORM public.cxp_save_invoice_validation(v_inv1, '2026-11-01', '2026-12-01', NULL, NULL, 125000, 'NO_PRIOR_PAYMENTS', NULL, NULL, false, NULL, true);
        RAISE EXCEPTION 'Se permitió validar con discrepancia sin resolver';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM = 'Se permitió validar con discrepancia sin resolver' THEN RAISE; END IF;
    END;

    -- 4. Guardar borrador con diferencia sin resolver conserva PENDING
    v_saved := public.cxp_save_invoice_validation(v_inv1, '2026-11-01', '2026-12-01', NULL, NULL, 125000, 'NO_PRIOR_PAYMENTS', NULL, NULL, false, NULL, false);
    IF v_saved->>'validation_status' <> 'PENDING' OR v_saved->>'discrepancy_status' <> 'UNRESOLVED' THEN
        RAISE EXCEPTION 'Guardado con discrepancia no conservó PENDING/UNRESOLVED: %', v_saved;
    END IF;

    -- 5. Confirmación exitosa sin discrepancias (FA 4501)
    v_saved := public.cxp_save_invoice_validation(v_inv1, '2026-11-01', '2026-12-01', 100000, 19000, 119000, 'NO_PRIOR_PAYMENTS', NULL, NULL, false, NULL, true);
    IF v_saved->>'validation_status' <> 'VALIDATED' OR v_saved->>'discrepancy_status' <> 'NONE' THEN
        RAISE EXCEPTION 'Validación FA 4501 falló: %', v_saved;
    END IF;

    -- 6. No permite revalidar una factura ya VALIDATED
    BEGIN
        PERFORM public.cxp_save_invoice_validation(v_inv1, '2026-11-01', '2026-12-01', 100000, 19000, 119000, 'NO_PRIOR_PAYMENTS', NULL, NULL, false, NULL, true);
        RAISE EXCEPTION 'Se permitió re-editar factura VALIDATED';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM = 'Se permitió re-editar factura VALIDATED' THEN RAISE; END IF;
    END;

    -- 7. Validación con pagos parciales anteriores + saldo inicial (FA 4502)
    v_saved := public.cxp_save_invoice_validation(v_inv2, '2026-11-02', '2026-12-02', 200000, 38000, 238000, 'PARTIAL_PRIOR_PAYMENTS', 100000, '2026-11-15', false, NULL, true);
    IF v_saved->>'validation_status' <> 'VALIDATED' OR (v_saved->>'historical_initial_balance')::numeric <> 100000 THEN
        RAISE EXCEPTION 'Validación saldo parcial falló: %', v_saved;
    END IF;

    -- 8. Validación con discrepancia resuelta y pago total anterior (FA 4503)
    v_saved := public.cxp_save_invoice_validation(v_inv3, '2026-11-03', '2026-12-03', NULL, NULL, 65000, 'FULLY_PAID_PRIOR', 0, '2026-11-15', true, 'Incluye flete confirmado según documento PDF adjunto.', true);
    IF v_saved->>'validation_status' <> 'VALIDATED' OR v_saved->>'discrepancy_status' <> 'RESOLVED' OR (v_saved->>'historical_initial_balance')::numeric <> 0 THEN
        RAISE EXCEPTION 'Validación con discrepancia resuelta falló: %', v_saved;
    END IF;

    -- 9. Bandeja y resúmenes reflejan el estado actualizado y auditoría registrada
    IF (SELECT count(*) FROM public.cxp_invoice_summaries() WHERE validation_status = 'VALIDATED') <> 3 THEN
        RAISE EXCEPTION 'cxp_invoice_summaries no reflejó las 3 validaciones';
    END IF;
    IF (SELECT count(*) FROM public.cxp_receipt_candidates() WHERE invoice_status = 'VALIDATED') <> 3 THEN
        RAISE EXCEPTION 'cxp_receipt_candidates no reflejó las 3 validaciones';
    END IF;
END $$;

-- 10. Rol no autorizado (BODEGA) recibe insufficient_privilege
SELECT set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000012', true);
DO $$ BEGIN
    BEGIN PERFORM public.cxp_invoice_summaries(); RAISE EXCEPTION 'acceso no autorizado summaries'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    BEGIN PERFORM public.cxp_invoice_detail('00000000-0000-0000-0000-000000000001'::uuid); RAISE EXCEPTION 'acceso no autorizado detail'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    BEGIN PERFORM public.cxp_save_invoice_validation('00000000-0000-0000-0000-000000000001'::uuid, '2026-11-01', '2026-12-01', NULL, NULL, 1000, 'NO_PRIOR_PAYMENTS', NULL, NULL, false, NULL, false); RAISE EXCEPTION 'escritura no autorizada'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;

RESET ROLE;
DO $$ BEGIN
    IF (SELECT count(*) FROM portal.audit_logs WHERE schema_name = 'cuentas_por_pagar' AND table_name = 'invoices' AND action = 'UPDATE') < 3 THEN
        RAISE EXCEPTION 'Faltan registros de auditoría para las validaciones';
    END IF;
END $$;

ROLLBACK;
