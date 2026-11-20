-- Ejecutar exclusivamente en una base aislada llamada cxp_real_contract.
\set ON_ERROR_STOP on
DO $$ BEGIN IF current_database() <> 'cxp_real_contract' OR inet_server_addr() IS DISTINCT FROM '127.0.0.1'::inet THEN RAISE EXCEPTION 'Solo permitido en base local aislada'; END IF; END $$;
BEGIN;

INSERT INTO auth.users(id) VALUES ('20000000-0000-0000-0000-000000000031');
INSERT INTO portal.roles(id, name) VALUES ('10000000-0000-0000-0000-000000000031', 'FINANZAS') ON CONFLICT (name) DO NOTHING;
INSERT INTO portal.users(id, email, nombre, apellido, role_id)
SELECT '20000000-0000-0000-0000-000000000031', 'qa-supplier-fin@example.invalid', 'Ana', 'Finanzas', id FROM portal.roles WHERE name = 'FINANZAS';
INSERT INTO core.companies(id, business_name) VALUES
    ('d1000000-0000-0000-0000-000000000001', 'Caylo QA'),
    ('d1000000-0000-0000-0000-000000000031', 'Otra empresa QA') ON CONFLICT (id) DO NOTHING;
INSERT INTO core.user_company_access(user_id, company_id, role) VALUES
    ('20000000-0000-0000-0000-000000000031', 'd1000000-0000-0000-0000-000000000001', 'FINANZAS');

INSERT INTO adquisiciones.suppliers(id, rut, rut_normalized, business_name, supplier_kind, company_id, is_active, status) VALUES
    ('30000000-0000-0000-0000-000000000031', '11.111.111-1', '111111111', 'Real Caylo QA', 'REAL', 'd1000000-0000-0000-0000-000000000001', true, 'ACTIVE'),
    ('30000000-0000-0000-0000-000000000032', '22.222.222-2', '222222222', 'Real global QA', 'REAL', NULL, true, 'ACTIVE'),
    ('30000000-0000-0000-0000-000000000033', '33.333.333-3', '333333333', 'Inactivo QA', 'REAL', 'd1000000-0000-0000-0000-000000000001', false, 'ACTIVE'),
    ('30000000-0000-0000-0000-000000000034', '44.444.444-4', '444444444', 'Estado inactivo QA', 'REAL', 'd1000000-0000-0000-0000-000000000001', true, 'INACTIVE'),
    ('30000000-0000-0000-0000-000000000035', '55.555.555-5', '555555555', 'Operativo Bsale QA', 'BSALE_OPERATIVE', 'd1000000-0000-0000-0000-000000000001', true, 'ACTIVE'),
    ('30000000-0000-0000-0000-000000000036', '66.666.666-6', '666666666', 'Otra empresa QA', 'REAL', 'd1000000-0000-0000-0000-000000000031', true, 'ACTIVE');
INSERT INTO storage.objects(bucket_id, name) VALUES
    ('cuentas-por-pagar', 'd1000000-0000-0000-0000-000000000001/services/supplier-validation.pdf');

SELECT set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000031', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
    v_supplier uuid;
    v_invoice jsonb;
BEGIN
    FOREACH v_supplier IN ARRAY ARRAY[
        '30000000-0000-0000-0000-000000000033'::uuid,
        '30000000-0000-0000-0000-000000000034'::uuid,
        '30000000-0000-0000-0000-000000000035'::uuid,
        '30000000-0000-0000-0000-000000000036'::uuid
    ] LOOP
        IF EXISTS (SELECT 1 FROM public.cxp_service_suppliers() WHERE id = v_supplier) THEN
            RAISE EXCEPTION 'Proveedor no autorizado en catálogo: %', v_supplier;
        END IF;
        BEGIN
            PERFORM public.cxp_create_service_invoice(v_supplier, '9100', 'Servicio QA', '2026-11-01', '2026-12-01', 1000, 190, 1190, 'PENDING',
                'd1000000-0000-0000-0000-000000000001/services/supplier-validation.pdf', 'supplier-validation.pdf', 'application/pdf');
            RAISE EXCEPTION 'Se permitió facturar al proveedor no autorizado: %', v_supplier;
        EXCEPTION WHEN raise_exception THEN
            IF SQLERRM <> 'Proveedor inexistente o sin acceso para Caylo' THEN RAISE; END IF;
        END;
    END LOOP;

    FOREACH v_supplier IN ARRAY ARRAY[
        '30000000-0000-0000-0000-000000000031'::uuid,
        '30000000-0000-0000-0000-000000000032'::uuid
    ] LOOP
        IF NOT EXISTS (SELECT 1 FROM public.cxp_service_suppliers() WHERE id = v_supplier) THEN
            RAISE EXCEPTION 'Proveedor válido ausente del catálogo: %', v_supplier;
        END IF;
        v_invoice := public.cxp_create_service_invoice(v_supplier, '9101', 'Servicio QA', '2026-11-01', '2026-12-01', 1000, 190, 1190, 'PENDING',
            'd1000000-0000-0000-0000-000000000001/services/supplier-validation.pdf', 'supplier-validation.pdf', 'application/pdf');
        IF (v_invoice->>'supplier_id')::uuid IS DISTINCT FROM v_supplier OR v_invoice->>'purchase_type' IS DISTINCT FROM 'SERVICES' THEN
            RAISE EXCEPTION 'Factura válida incorrecta: %', v_invoice;
        END IF;
    END LOOP;
END $$;
ROLLBACK;
