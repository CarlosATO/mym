-- =========================================================================================
-- QA: M1.5G - Ejecucion de auditoria (LOCATIONS_RESOLVED)
-- Ejecutar con:  supabase db query --linked --file scripts/qa_audit_execution.sql
-- Todo se ejecuta en una transaccion que se ROLLBACK al final (no contamina datos).
--
-- Fixture real: Auditoria #2 (7ac56229-f5ce-4fa1-876c-83e7a3e45263) asignada a Carlos,
-- 1 producto (SKU 00022 / variant 4883) LOCATIONS_RESOLVED, ubicacion PA-R03-N01-U00.
--
-- Barcodes del fixture:
--   principal 4883 = 8424160024430 (integraciones.bsale_variants.bar_code)
--   alias de prueba = 999000000001 (insertado en product_barcode_aliases)
--   barcode de OTRO producto = 022517431603 (variant 1797)
--   barcode desconocido = 000000000000
--
-- Criterios cubiertos: inicio, reentrada, captura valida, alias, barcode incorrecto,
-- usuario incorrecto, recaptura (ultima gana), submit incompleto/completo, progreso ciego,
-- reconstruccion ERP, Inventario efectivo inalterado.
-- =========================================================================================

BEGIN;

CREATE TEMP TABLE _qa_audit_exec_results (qa text, result text, detail jsonb);

DO $$
DECLARE
    v_company_id uuid := 'd1000000-0000-0000-0000-000000000001';
    v_campaign_id uuid := 'a6b261bb-5c91-41db-9db0-7066b4470c52';
    v_audit_id uuid := '7ac56229-f5ce-4fa1-876c-83e7a3e45263';
    v_carlos uuid := 'dc9be3b3-bf39-47b2-8ea3-fdd6aa9a4aaa';
    v_ana uuid := 'ba104779-f927-46de-8c6c-300fac1130de';
    v_audit_product_id uuid := '1883a1b3-4ba1-452f-a521-f0c69d248dad';
    v_audit_location_id uuid := 'bb564738-c8ee-489d-9ce7-0fc420607205';
    v_principal_barcode text := '8424160024430';
    v_alias_barcode text := '999000000001';
    v_other_barcode text := '022517431603';
    v_unknown_barcode text := '000000000000';
    v_response jsonb;
    v_ok boolean;
    v_msg text;
    v_results jsonb := '[]'::jsonb;
    v_variances_before integer;
    v_variances_after integer;
    v_entries_before bigint;
    v_entries_after bigint;
    v_progress jsonb;
BEGIN
    -- Snapshot del Inventario efectivo (Informe Global + count_entries de la campana).
    PERFORM set_config('request.jwt.claim.sub', v_carlos::text, true);
    v_variances_before := (inventarios.list_inventory_campaign_variances(v_company_id, v_campaign_id, '', '', '', 1, 1, 'SKU', 'ASC')->>'total')::int;
    SELECT pg_catalog.count(*) INTO v_entries_before
    FROM inventarios.count_entries ce
    JOIN inventarios.sessions s ON s.company_id = ce.company_id AND s.id = ce.session_id
    WHERE ce.company_id = v_company_id AND s.campaign_id = v_campaign_id;

    -- QA1: iniciar con usuario NO asignado (ANA) -> rechazo
    PERFORM set_config('request.jwt.claim.sub', v_ana::text, true);
    BEGIN
        PERFORM inventarios.start_inventory_audit(v_company_id, v_audit_id, gen_random_uuid());
        v_ok := false; v_msg := 'no rechazo';
    EXCEPTION WHEN OTHERS THEN
        v_ok := SQLERRM = 'INV_AUDIT_NOT_ASSIGNED'; v_msg := SQLERRM;
    END;
    v_results := v_results || jsonb_build_object('qa','QA1','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'error', v_msg);

    -- QA2: capturar sin iniciar (ASSIGNED) -> rechazo
    PERFORM set_config('request.jwt.claim.sub', v_carlos::text, true);
    BEGIN
        PERFORM inventarios.record_inventory_audit_result(v_company_id, v_audit_id, v_audit_product_id, v_audit_location_id, v_principal_barcode, 7, pg_catalog.now(), gen_random_uuid());
        v_ok := false; v_msg := 'no rechazo';
    EXCEPTION WHEN OTHERS THEN
        v_ok := SQLERRM = 'INV_AUDIT_NOT_STARTED'; v_msg := SQLERRM;
    END;
    v_results := v_results || jsonb_build_object('qa','QA2','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'error', v_msg);

    -- QA3: iniciar auditoria -> IN_PROGRESS, trazado quien/cuando
    v_response := inventarios.start_inventory_audit(v_company_id, v_audit_id, gen_random_uuid());
    v_ok := v_response->>'state' = 'IN_PROGRESS'
        AND (v_response->'data'->>'already_started')::boolean = false
        AND (v_response->'data'->>'started_by') = v_carlos::text;
    v_results := v_results || jsonb_build_object('qa','QA3','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'data', v_response->'data');

    -- QA4: reentrada segura (ya IN_PROGRESS) -> no-op
    v_response := inventarios.start_inventory_audit(v_company_id, v_audit_id, gen_random_uuid());
    v_ok := v_response->>'state' = 'IN_PROGRESS'
        AND (v_response->'data'->>'already_started')::boolean = true;
    v_results := v_results || jsonb_build_object('qa','QA4','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'data', v_response->'data');

    -- QA5: submit incompleto (ninguna ubicacion registrada) -> rechazo
    BEGIN
        PERFORM inventarios.submit_inventory_audit(v_company_id, v_audit_id, gen_random_uuid());
        v_ok := false; v_msg := 'no rechazo';
    EXCEPTION WHEN OTHERS THEN
        v_ok := SQLERRM = 'INV_AUDIT_SUBMIT_INCOMPLETE'; v_msg := SQLERRM;
    END;
    v_results := v_results || jsonb_build_object('qa','QA5','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'error', v_msg);

    -- QA6: captura valida con barcode principal -> aceptado (BARCODE)
    v_response := inventarios.record_inventory_audit_result(v_company_id, v_audit_id, v_audit_product_id, v_audit_location_id, v_principal_barcode, 7, pg_catalog.now(), gen_random_uuid());
    v_ok := (v_response->'data'->>'identification_method') = 'BARCODE'
        AND (v_response->'data'->>'physical_quantity')::numeric = 7
        AND (v_response->'data'->>'revision_number')::int = 1;
    v_results := v_results || jsonb_build_object('qa','QA6','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'data', v_response->'data');

    -- QA7: recaptura misma ubicacion (qty 9) -> ultima gana, revision 2, NO suma (7+9!=16)
    v_response := inventarios.record_inventory_audit_result(v_company_id, v_audit_id, v_audit_product_id, v_audit_location_id, v_principal_barcode, 9, pg_catalog.now(), gen_random_uuid());
    v_ok := (v_response->'data'->>'physical_quantity')::numeric = 9
        AND (v_response->'data'->>'revision_number')::int = 2;
    SELECT r.physical_quantity::text INTO v_msg FROM inventarios.inventory_audit_results r
    WHERE r.company_id = v_company_id AND r.audit_product_id = v_audit_product_id AND r.audit_location_id = v_audit_location_id;
    v_ok := v_ok AND v_msg::numeric = 9;
    v_results := v_results || jsonb_build_object('qa','QA7','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'stored_qty', v_msg, 'revision', 2);

    -- QA8: alias autorizado aceptado (ALIAS) -> qty 5, revision 3
    INSERT INTO inventarios.product_barcode_aliases (company_id, barcode, bsale_variant_id, product_id, source, is_active, created_at, created_by)
    VALUES (v_company_id, v_alias_barcode, 4883, NULL, 'ADMIN_REVIEW', true, pg_catalog.now(), v_carlos);
    v_response := inventarios.record_inventory_audit_result(v_company_id, v_audit_id, v_audit_product_id, v_audit_location_id, v_alias_barcode, 5, pg_catalog.now(), gen_random_uuid());
    v_ok := (v_response->'data'->>'identification_method') = 'ALIAS'
        AND (v_response->'data'->>'physical_quantity')::numeric = 5
        AND (v_response->'data'->>'revision_number')::int = 3;
    v_results := v_results || jsonb_build_object('qa','QA8','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'data', v_response->'data');

    -- QA9: barcode de OTRO producto -> rechazo
    BEGIN
        PERFORM inventarios.record_inventory_audit_result(v_company_id, v_audit_id, v_audit_product_id, v_audit_location_id, v_other_barcode, 5, pg_catalog.now(), gen_random_uuid());
        v_ok := false; v_msg := 'no rechazo';
    EXCEPTION WHEN OTHERS THEN
        v_ok := SQLERRM = 'INV_AUDIT_WRONG_PRODUCT'; v_msg := SQLERRM;
    END;
    v_results := v_results || jsonb_build_object('qa','QA9','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'error', v_msg);

    -- QA10: barcode desconocido -> rechazo (bloqueo documentado del flujo manual)
    BEGIN
        PERFORM inventarios.record_inventory_audit_result(v_company_id, v_audit_id, v_audit_product_id, v_audit_location_id, v_unknown_barcode, 5, pg_catalog.now(), gen_random_uuid());
        v_ok := false; v_msg := 'no rechazo';
    EXCEPTION WHEN OTHERS THEN
        v_ok := SQLERRM = 'INV_AUDIT_BARCODE_UNRECOGNIZED'; v_msg := SQLERRM;
    END;
    v_results := v_results || jsonb_build_object('qa','QA10','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'error', v_msg);

    -- QA11: captura con usuario NO asignado -> rechazo
    PERFORM set_config('request.jwt.claim.sub', v_ana::text, true);
    BEGIN
        PERFORM inventarios.record_inventory_audit_result(v_company_id, v_audit_id, v_audit_product_id, v_audit_location_id, v_principal_barcode, 5, pg_catalog.now(), gen_random_uuid());
        v_ok := false; v_msg := 'no rechazo';
    EXCEPTION WHEN OTHERS THEN
        v_ok := SQLERRM = 'INV_AUDIT_NOT_ASSIGNED'; v_msg := SQLERRM;
    END;
    v_results := v_results || jsonb_build_object('qa','QA11','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'error', v_msg);

    -- QA11b: ubicacion NO incluida en el alcance -> rechazo
    PERFORM set_config('request.jwt.claim.sub', v_carlos::text, true);
    BEGIN
        PERFORM inventarios.record_inventory_audit_result(v_company_id, v_audit_id, v_audit_product_id, gen_random_uuid(), v_principal_barcode, 5, pg_catalog.now(), gen_random_uuid());
        v_ok := false; v_msg := 'no rechazo';
    EXCEPTION WHEN OTHERS THEN
        v_ok := SQLERRM = 'INV_AUDIT_LOCATION_NOT_IN_SCOPE'; v_msg := SQLERRM;
    END;
    v_results := v_results || jsonb_build_object('qa','QA11b','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'error', v_msg);

    -- QA12: progreso ciego (contado + pendientes) sin cantidades previas
    v_progress := inventarios.list_my_inventory_audit_progress(v_company_id, v_audit_id);
    v_ok := NOT EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_progress->'products') p
        CROSS JOIN pg_catalog.jsonb_array_elements(p->'locations') l
        WHERE l ? 'theoretical_quantity' OR l ? 'difference_quantity' OR l ? 'variance_status' OR p ? 'previous_result'
    ) AND EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_progress->'products') p
        CROSS JOIN pg_catalog.jsonb_array_elements(p->'locations') l
        WHERE (l->>'status') = 'COUNTED' AND (l->>'physical_quantity')::numeric = 5
    ) AND (v_progress->>'pending_locations')::int = 0
      AND (v_progress->>'counted_locations')::int = 1;
    v_results := v_results || jsonb_build_object('qa','QA12','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'progress', v_progress);

    -- QA13: submit completo -> SUBMITTED, trazado
    v_response := inventarios.submit_inventory_audit(v_company_id, v_audit_id, gen_random_uuid());
    v_ok := v_response->>'state' = 'SUBMITTED'
        AND (v_response->'data'->>'submitted_by') = v_carlos::text;
    v_results := v_results || jsonb_build_object('qa','QA13','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'data', v_response->'data');

    -- QA13b: submit de nuevo (ya SUBMITTED) -> idempotente
    v_response := inventarios.submit_inventory_audit(v_company_id, v_audit_id, gen_random_uuid());
    v_ok := (v_response->'data'->>'already_submitted')::boolean = true AND v_response->>'state' = 'SUBMITTED';
    v_results := v_results || jsonb_build_object('qa','QA13b','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'data', v_response->'data');

    -- QA14: reconstruccion ERP -> total auditado desde ubicaciones (5)
    v_response := inventarios.get_inventory_audit_results(v_company_id, v_audit_id);
    v_ok := (v_response->>'total_audited')::numeric = 5
        AND (v_response->'products'->0->>'total_audited')::numeric = 5
        AND (v_response->'products'->0->'locations'->0->>'physical_quantity')::numeric = 5;
    v_results := v_results || jsonb_build_object('qa','QA14','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'total_audited', v_response->>'total_audited', 'products', v_response->'products');

    -- QA15: Inventario efectivo INALTERADO (varianzas y count_entries iguales)
    v_variances_after := (inventarios.list_inventory_campaign_variances(v_company_id, v_campaign_id, '', '', '', 1, 1, 'SKU', 'ASC')->>'total')::int;
    SELECT pg_catalog.count(*) INTO v_entries_after
    FROM inventarios.count_entries ce
    JOIN inventarios.sessions s ON s.company_id = ce.company_id AND s.id = ce.session_id
    WHERE ce.company_id = v_company_id AND s.campaign_id = v_campaign_id;
    v_ok := v_variances_before = v_variances_after AND v_entries_before = v_entries_after AND v_variances_before > 0;
    v_results := v_results || jsonb_build_object('qa','QA15','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'variances_before', v_variances_before, 'variances_after', v_variances_after, 'entries_before', v_entries_before, 'entries_after', v_entries_after);

    v_results := v_results || jsonb_build_object('qa','TOTAL','passed', (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(v_results) r WHERE r->>'result' = 'PASSED'), 'failed', (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(v_results) r WHERE r->>'result' = 'FAILED'));
    INSERT INTO _qa_audit_exec_results
    SELECT r->>'qa', r->>'result', r - 'qa' - 'result'
    FROM pg_catalog.jsonb_array_elements(v_results) r;
END $$;

SELECT qa, result, pg_catalog.jsonb_pretty(detail) AS detail FROM _qa_audit_exec_results ORDER BY 1;

ROLLBACK;
