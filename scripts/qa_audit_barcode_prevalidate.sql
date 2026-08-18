-- =========================================================================================
-- QA: M1.5G.3 - Prevalidacion read-only de barcode para ejecucion de auditorias
-- Ejecutar con:  supabase db query --linked --file scripts/qa_audit_barcode_prevalidate.sql
-- Todo se ejecuta en una transaccion que se ROLLBACK al final (no contamina datos).
--
-- Fixture real: Auditoria #2 (7ac56229-f5ce-4fa1-876c-83e7a3e45263) asignada a Carlos
-- (IN_PROGRESS), 1 producto (SKU 00022 / variant 4883) LOCATIONS_RESOLVED,
-- ubicacion PA-R03-N01-U00. Campana a6b261bb-5c91-41db-9db0-7066b4470c52.
--
-- Barcodes:
--   principal 4883 = 8424160024430 (integraciones.bsale_variants.bar_code)
--   alias de prueba = 999000000001 (insertado temporal en product_barcode_aliases)
--   snapshot congelado = 999000000002 (insertado temporal en inventory_campaign_snapshot_products
--     para aislar la via de catalogo congelado)
--   barcode de OTRO producto = 022517431603 (variant 1797)
--   barcode desconocido = 000000000000
--
-- Criterios: MATCHED/BARCODE, snapshot congelado, MATCHED/ALIAS, WRONG_PRODUCT,
-- UNRECOGNIZED, producto fuera de auditoria, usuario no asignado, cero mutaciones,
-- guard transaccional intacto y helper compartido (misma semantica contractual).
-- =========================================================================================

BEGIN;

CREATE TEMP TABLE _qa_audit_barcode_results (qa text, result text, detail jsonb);

DO $$
DECLARE
    v_company_id uuid := 'd1000000-0000-0000-0000-000000000001';
    v_campaign_id uuid := 'a6b261bb-5c91-41db-9db0-7066b4470c52';
    v_snapshot_id uuid := 'e8545460-5c04-4039-9a48-4a8934ace851';
    v_audit_id uuid := '7ac56229-f5ce-4fa1-876c-83e7a3e45263';
    v_carlos uuid := 'dc9be3b3-bf39-47b2-8ea3-fdd6aa9a4aaa';
    v_ana uuid := 'ba104779-f927-46de-8c6c-300fac1130de';
    v_audit_product_id uuid := '1883a1b3-4ba1-452f-a521-f0c69d248dad';
    v_other_audit_product uuid := '9009863e-165a-4cb8-adfe-24434d571427';
    v_principal_barcode text := '8424160024430';
    v_alias_barcode text := '999000000001';
    v_snapshot_barcode text := '999000000002';
    v_other_barcode text := '022517431603';
    v_unknown_barcode text := '000000000000';
    v_response jsonb;
    v_ok boolean;
    v_msg text;
    v_results jsonb := '[]'::jsonb;
    v_before_results bigint;
    v_after_results bigint;
    v_before_events bigint;
    v_after_events bigint;
    v_before_status text;
    v_after_status text;
    v_revisions_before bigint;
    v_revisions_after bigint;
    v_helper_count bigint;
BEGIN
    -- Preparacion: alias temporal y barcode congelado temporal (se revierten con ROLLBACK).
    INSERT INTO inventarios.product_barcode_aliases (company_id, barcode, bsale_variant_id, product_id, source, is_active, created_at, created_by)
    VALUES (v_company_id, v_alias_barcode, 4883, NULL, 'ADMIN_REVIEW', true, pg_catalog.now(), v_carlos);

    DELETE FROM inventarios.inventory_campaign_snapshot_products
    WHERE company_id = v_company_id AND campaign_snapshot_id = v_snapshot_id AND bsale_variant_id = 4883;
    INSERT INTO inventarios.inventory_campaign_snapshot_products (
        id, company_id, campaign_snapshot_id, product_id, bsale_variant_id, sku, barcode, name,
        created_at, created_by, is_active)
    VALUES (
        pg_catalog.gen_random_uuid(), v_company_id, v_snapshot_id, NULL, 4883, '00022',
        v_snapshot_barcode, 'SENSE LATA ADULTO CHICKEN Y DUCK 380GR',
        pg_catalog.now(), v_carlos, true);

    -- Snapshot previo de mutaciones (nada debe cambiar durante la prevalidacion).
    PERFORM set_config('request.jwt.claim.sub', v_carlos::text, true);
    SELECT pg_catalog.count(*) INTO v_before_results
    FROM inventarios.inventory_audit_results WHERE company_id = v_company_id AND audit_id = v_audit_id;
    SELECT pg_catalog.count(*) INTO v_before_events
    FROM inventarios.inventory_audit_result_events WHERE company_id = v_company_id AND audit_id = v_audit_id;
    SELECT status INTO v_before_status FROM inventarios.inventory_audits WHERE company_id = v_company_id AND id = v_audit_id;
    SELECT pg_catalog.count(*) INTO v_revisions_before
    FROM inventarios.inventory_audit_results r
    WHERE r.company_id = v_company_id AND r.audit_id = v_audit_id AND r.revision_number > 0;

    -- QA1: barcode principal del producto auditado -> MATCHED / BARCODE
    v_response := inventarios.validate_inventory_audit_barcode(v_company_id, v_audit_id, v_audit_product_id, v_principal_barcode);
    v_ok := v_response->>'status' = 'MATCHED'
        AND (v_response->>'identification_method') = 'BARCODE'
        AND (v_response->>'scanned_code') = v_principal_barcode
        AND (v_response->'product'->>'bsale_variant_id')::int = 4883
        AND (v_response->'product'->>'audit_product_id') = v_audit_product_id::text
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_each(v_response) k WHERE k.key IN ('theoretical_quantity','previous_quantity','difference_quantity','physical_quantity'));
    v_results := v_results || jsonb_build_object('qa','QA1','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'response', v_response);

    -- QA2: barcode congelado del snapshot (aislado) -> MATCHED / BARCODE
    v_response := inventarios.validate_inventory_audit_barcode(v_company_id, v_audit_id, v_audit_product_id, v_snapshot_barcode);
    v_ok := v_response->>'status' = 'MATCHED'
        AND (v_response->>'identification_method') = 'BARCODE'
        AND (v_response->'product'->>'bsale_variant_id')::int = 4883;
    v_results := v_results || jsonb_build_object('qa','QA2','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'response', v_response);

    -- QA3: alias aprobado del mismo producto -> MATCHED / ALIAS
    v_response := inventarios.validate_inventory_audit_barcode(v_company_id, v_audit_id, v_audit_product_id, v_alias_barcode);
    v_ok := v_response->>'status' = 'MATCHED'
        AND (v_response->>'identification_method') = 'ALIAS'
        AND (v_response->'product'->>'bsale_variant_id')::int = 4883;
    v_results := v_results || jsonb_build_object('qa','QA3','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'response', v_response);

    -- QA4: barcode de otro producto -> INV_AUDIT_WRONG_PRODUCT
    BEGIN
        PERFORM inventarios.validate_inventory_audit_barcode(v_company_id, v_audit_id, v_audit_product_id, v_other_barcode);
        v_ok := false; v_msg := 'no rechazo';
    EXCEPTION WHEN OTHERS THEN
        v_ok := SQLERRM = 'INV_AUDIT_WRONG_PRODUCT'; v_msg := SQLERRM;
    END;
    v_results := v_results || jsonb_build_object('qa','QA4','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'error', v_msg);

    -- QA5: barcode desconocido -> INV_AUDIT_BARCODE_UNRECOGNIZED
    BEGIN
        PERFORM inventarios.validate_inventory_audit_barcode(v_company_id, v_audit_id, v_audit_product_id, v_unknown_barcode);
        v_ok := false; v_msg := 'no rechazo';
    EXCEPTION WHEN OTHERS THEN
        v_ok := SQLERRM = 'INV_AUDIT_BARCODE_UNRECOGNIZED'; v_msg := SQLERRM;
    END;
    v_results := v_results || jsonb_build_object('qa','QA5','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'error', v_msg);

    -- QA6: producto que NO pertenece a la auditoria -> rechazo
    BEGIN
        PERFORM inventarios.validate_inventory_audit_barcode(v_company_id, v_audit_id, v_other_audit_product, v_principal_barcode);
        v_ok := false; v_msg := 'no rechazo';
    EXCEPTION WHEN OTHERS THEN
        v_ok := SQLERRM = 'INV_AUDIT_PRODUCT_NOT_FOUND'; v_msg := SQLERRM;
    END;
    v_results := v_results || jsonb_build_object('qa','QA6','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'error', v_msg);

    -- QA7: usuario distinto del auditor asignado -> rechazo
    PERFORM set_config('request.jwt.claim.sub', v_ana::text, true);
    BEGIN
        PERFORM inventarios.validate_inventory_audit_barcode(v_company_id, v_audit_id, v_audit_product_id, v_principal_barcode);
        v_ok := false; v_msg := 'no rechazo';
    EXCEPTION WHEN OTHERS THEN
        v_ok := SQLERRM = 'INV_AUDIT_NOT_ASSIGNED'; v_msg := SQLERRM;
    END;
    v_results := v_results || jsonb_build_object('qa','QA7','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'error', v_msg);

    -- QA8: cero mutaciones durante la prevalidacion (results, events, revisiones, estado)
    PERFORM set_config('request.jwt.claim.sub', v_carlos::text, true);
    SELECT pg_catalog.count(*) INTO v_after_results
    FROM inventarios.inventory_audit_results WHERE company_id = v_company_id AND audit_id = v_audit_id;
    SELECT pg_catalog.count(*) INTO v_after_events
    FROM inventarios.inventory_audit_result_events WHERE company_id = v_company_id AND audit_id = v_audit_id;
    SELECT status INTO v_after_status FROM inventarios.inventory_audits WHERE company_id = v_company_id AND id = v_audit_id;
    SELECT pg_catalog.count(*) INTO v_revisions_after
    FROM inventarios.inventory_audit_results r
    WHERE r.company_id = v_company_id AND r.audit_id = v_audit_id AND r.revision_number > 0;
    v_ok := v_before_results = v_after_results AND v_after_results = 0
        AND v_before_events = v_after_events AND v_after_events = 0
        AND v_before_status = v_after_status AND v_after_status = 'IN_PROGRESS'
        AND v_revisions_before = v_revisions_after AND v_revisions_after = 0;
    v_results := v_results || jsonb_build_object('qa','QA8','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END,
        'results', v_after_results, 'events', v_after_events, 'status', v_after_status, 'revisions', v_revisions_after);

    -- QA9: guard transaccional intacto - record_inventory_audit_result sigue validando al guardar
    BEGIN
        PERFORM inventarios.record_inventory_audit_result(v_company_id, v_audit_id, v_audit_product_id, 'bb564738-c8ee-489d-9ce7-0fc420607205', v_other_barcode, 5, pg_catalog.now(), pg_catalog.gen_random_uuid());
        v_ok := false; v_msg := 'no rechazo';
    EXCEPTION WHEN OTHERS THEN
        v_ok := SQLERRM = 'INV_AUDIT_WRONG_PRODUCT'; v_msg := SQLERRM;
    END;
    v_results := v_results || jsonb_build_object('qa','QA9','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'error', v_msg);

    -- QA10: helper compartido - ambos contratos referencian resolve_audit_barcode (misma semantica)
    SELECT pg_catalog.count(*) INTO v_helper_count
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'inventarios'
      AND p.proname IN ('validate_inventory_audit_barcode','record_inventory_audit_result')
      AND p.prosrc LIKE '%resolve_audit_barcode%';
    v_ok := v_helper_count = 2;
    v_results := v_results || jsonb_build_object('qa','QA10','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'functions_using_helper', v_helper_count);

    v_results := v_results || jsonb_build_object('qa','TOTAL','passed', (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(v_results) r WHERE r->>'result' = 'PASSED'), 'failed', (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(v_results) r WHERE r->>'result' = 'FAILED'));
    INSERT INTO _qa_audit_barcode_results
    SELECT r->>'qa', r->>'result', r - 'qa' - 'result'
    FROM pg_catalog.jsonb_array_elements(v_results) r;
END $$;

SELECT qa, result, pg_catalog.jsonb_pretty(detail) AS detail FROM _qa_audit_barcode_results ORDER BY 1;

ROLLBACK;
