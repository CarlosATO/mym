-- =========================================================================================
-- QA: M1.5G.3 - No regresion de record_inventory_audit_result tras refactor del helper
-- Ejecutar con:  supabase db query --linked --file scripts/qa_audit_record_no_regression.sql
-- Todo se ejecuta en una transaccion que se ROLLBACK al final (no contamina datos).
--
-- La Auditoria #2 quedo IN_PROGRESS por una prueba manual previa; este QA la restaura a
-- ASSIGNED DENTRO de la transaccion (solo para reproducir el fixture del flujo original)
-- y valida que el flujo completo de ejecucion sigue funcionando con la misma semantica
-- tras el refactor de record_inventory_audit_result hacia el helper compartido.
-- El ROLLBACK final deja la base como estaba (IN_PROGRESS, sin resultados).
-- =========================================================================================

BEGIN;

CREATE TEMP TABLE _qa_audit_record_results (qa text, result text, detail jsonb);

DO $$
DECLARE
    v_company_id uuid := 'd1000000-0000-0000-0000-000000000001';
    v_audit_id uuid := '7ac56229-f5ce-4fa1-876c-83e7a3e45263';
    v_carlos uuid := 'dc9be3b3-bf39-47b2-8ea3-fdd6aa9a4aaa';
    v_audit_product_id uuid := '1883a1b3-4ba1-452f-a521-f0c69d248dad';
    v_audit_location_id uuid := 'bb564738-c8ee-489d-9ce7-0fc420607205';
    v_principal_barcode text := '8424160024430';
    v_unknown_barcode text := '000000000000';
    v_response jsonb;
    v_ok boolean;
    v_msg text;
    v_results jsonb := '[]'::jsonb;
BEGIN
    -- Restaurar fixture a ASSIGNED dentro de la transaccion (se revierte con ROLLBACK).
    UPDATE inventarios.inventory_audits
    SET status = 'ASSIGNED', started_at = NULL, started_by = NULL
    WHERE company_id = v_company_id AND id = v_audit_id;
    UPDATE inventarios.inventory_audit_products
    SET status = 'ASSIGNED'
    WHERE company_id = v_company_id AND audit_id = v_audit_id;

    PERFORM set_config('request.jwt.claim.sub', v_carlos::text, true);

    -- QA1: capturar sin iniciar -> rechazo INV_AUDIT_NOT_STARTED
    BEGIN
        PERFORM inventarios.record_inventory_audit_result(v_company_id, v_audit_id, v_audit_product_id, v_audit_location_id, v_principal_barcode, 7, pg_catalog.now(), pg_catalog.gen_random_uuid());
        v_ok := false; v_msg := 'no rechazo';
    EXCEPTION WHEN OTHERS THEN
        v_ok := SQLERRM = 'INV_AUDIT_NOT_STARTED'; v_msg := SQLERRM;
    END;
    v_results := v_results || jsonb_build_object('qa','QA1','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'error', v_msg);

    -- QA2: iniciar -> IN_PROGRESS
    v_response := inventarios.start_inventory_audit(v_company_id, v_audit_id, pg_catalog.gen_random_uuid());
    v_ok := v_response->>'state' = 'IN_PROGRESS';
    v_results := v_results || jsonb_build_object('qa','QA2','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'state', v_response->>'state');

    -- QA3: captura valida con barcode principal -> BARCODE, qty 7, revision 1
    v_response := inventarios.record_inventory_audit_result(v_company_id, v_audit_id, v_audit_product_id, v_audit_location_id, v_principal_barcode, 7, pg_catalog.now(), pg_catalog.gen_random_uuid());
    v_ok := (v_response->'data'->>'identification_method') = 'BARCODE'
        AND (v_response->'data'->>'physical_quantity')::numeric = 7
        AND (v_response->'data'->>'revision_number')::int = 1;
    v_results := v_results || jsonb_build_object('qa','QA3','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'data', v_response->'data');

    -- QA4: barcode desconocido al guardar -> rechazo (guard definitivo intacto)
    BEGIN
        PERFORM inventarios.record_inventory_audit_result(v_company_id, v_audit_id, v_audit_product_id, v_audit_location_id, v_unknown_barcode, 5, pg_catalog.now(), pg_catalog.gen_random_uuid());
        v_ok := false; v_msg := 'no rechazo';
    EXCEPTION WHEN OTHERS THEN
        v_ok := SQLERRM = 'INV_AUDIT_BARCODE_UNRECOGNIZED'; v_msg := SQLERRM;
    END;
    v_results := v_results || jsonb_build_object('qa','QA4','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'error', v_msg);

    -- QA5: recaptura misma ubicacion -> ultima gana, revision 2 (no suma)
    v_response := inventarios.record_inventory_audit_result(v_company_id, v_audit_id, v_audit_product_id, v_audit_location_id, v_principal_barcode, 9, pg_catalog.now(), pg_catalog.gen_random_uuid());
    SELECT r.physical_quantity::text INTO v_msg FROM inventarios.inventory_audit_results r
    WHERE r.company_id = v_company_id AND r.audit_product_id = v_audit_product_id AND r.audit_location_id = v_audit_location_id;
    v_ok := (v_response->'data'->>'physical_quantity')::numeric = 9
        AND (v_response->'data'->>'revision_number')::int = 2
        AND v_msg::numeric = 9;
    v_results := v_results || jsonb_build_object('qa','QA5','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'stored_qty', v_msg, 'revision', 2);

    -- QA6: submit completo -> SUBMITTED
    v_response := inventarios.submit_inventory_audit(v_company_id, v_audit_id, pg_catalog.gen_random_uuid());
    v_ok := v_response->>'state' = 'SUBMITTED';
    v_results := v_results || jsonb_build_object('qa','QA6','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'state', v_response->>'state');

    -- QA7: progreso ciego (pendientes = 0, contadas = 1)
    v_response := inventarios.list_my_inventory_audit_progress(v_company_id, v_audit_id);
    v_ok := (v_response->>'pending_locations')::int = 0 AND (v_response->>'counted_locations')::int = 1;
    v_results := v_results || jsonb_build_object('qa','QA7','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'pending', v_response->>'pending_locations', 'counted', v_response->>'counted_locations');

    v_results := v_results || jsonb_build_object('qa','TOTAL','passed', (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(v_results) r WHERE r->>'result' = 'PASSED'), 'failed', (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(v_results) r WHERE r->>'result' = 'FAILED'));
    INSERT INTO _qa_audit_record_results
    SELECT r->>'qa', r->>'result', r - 'qa' - 'result'
    FROM pg_catalog.jsonb_array_elements(v_results) r;
END $$;

SELECT qa, result, pg_catalog.jsonb_pretty(detail) AS detail FROM _qa_audit_record_results ORDER BY 1;

ROLLBACK;
