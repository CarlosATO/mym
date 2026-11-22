-- Ejecutar exclusivamente en una base local aislada cxp_real_contract.
\set ON_ERROR_STOP on
DO $$ BEGIN IF current_database() <> 'cxp_real_contract' OR inet_server_addr() IS DISTINCT FROM '127.0.0.1'::inet THEN RAISE EXCEPTION 'Solo permitido en base local aislada'; END IF; END $$;
BEGIN;
INSERT INTO core.companies(id, business_name) VALUES
    ('d1000000-0000-0000-0000-000000000001', 'Caylo QA'),
    ('d1000000-0000-0000-0000-000000000099', 'Otra empresa QA') ON CONFLICT (id) DO NOTHING;
INSERT INTO adquisiciones.suppliers(id, business_name, rut, supplier_kind, company_id, is_active, status) VALUES
    ('31000000-0000-0000-0000-000000000001', 'Válido Caylo', '76.086.428-5', 'REAL', 'd1000000-0000-0000-0000-000000000001', true, 'ACTIVE'),
    ('31000000-0000-0000-0000-000000000002', 'Válido global', '11.111.111-1', 'REAL', NULL, true, 'ACTIVE'),
    ('31000000-0000-0000-0000-000000000003', 'Sin RUT', NULL, 'REAL', NULL, true, 'ACTIVE'),
    ('31000000-0000-0000-0000-000000000004', 'DV incorrecto', '76.086.428-9', 'REAL', NULL, true, 'ACTIVE'),
    ('31000000-0000-0000-0000-000000000005', 'Inactivo', '10000000-8', 'REAL', NULL, false, 'ACTIVE'),
    ('31000000-0000-0000-0000-000000000006', 'Estado inactivo', '10000001-6', 'REAL', NULL, true, 'INACTIVE'),
    ('31000000-0000-0000-0000-000000000007', 'Operativo', '10000002-4', 'BSALE_OPERATIVE', NULL, true, 'ACTIVE'),
    ('31000000-0000-0000-0000-000000000008', 'Otra empresa', '10000003-2', 'REAL', 'd1000000-0000-0000-0000-000000000099', true, 'ACTIVE'),
    ('31000000-0000-0000-0000-000000000009', 'Estado nulo', '10000004-0', 'REAL', NULL, true, NULL),
    ('31000000-0000-0000-0000-000000000010', 'Actividad nula', '10000005-9', 'REAL', NULL, NULL, 'ACTIVE');

DO $$
DECLARE v_ids uuid[];
BEGIN
    SELECT array_agg(id ORDER BY id) INTO v_ids FROM public.cxp_service_suppliers()
    WHERE id BETWEEN '31000000-0000-0000-0000-000000000001' AND '31000000-0000-0000-0000-000000000010';
    IF v_ids IS DISTINCT FROM ARRAY['31000000-0000-0000-0000-000000000001'::uuid, '31000000-0000-0000-0000-000000000002'::uuid] THEN
        RAISE EXCEPTION 'Catálogo de Servicios incorrecto: %', v_ids;
    END IF;
END $$;
ROLLBACK;
