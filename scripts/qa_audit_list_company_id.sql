-- =========================================================================================
-- QA: M1.5G.2 - list_my_inventory_audits expone company_id (contrato ciego Mobile)
-- Ejecutar con:  supabase db query --linked --file scripts/qa_audit_list_company_id.sql
-- Todo se ejecuta en una transaccion que se ROLLBACK al final (no contamina datos).
--
-- Fixture real: Auditoria #1 b169c3c9-0e15-48e7-810c-8ed3fd162d35 (ANA) y
-- Auditoria #2 7ac56229-f5ce-4fa1-876c-83e7a3e45263 (Carlos) en campana
-- a6b261bb-5c91-41db-9db0-7066b4470c52 (empresa d1000000-0000-0000-0000-000000000001).
--
-- Criterios: company_id raiz por auditoria, valor real, filtrado por auditor,
-- contrato ciego (sin teorico/fisico/diferencia/faltante/sobrante/objetivo),
-- campos previos compatibles y los identificadores necesarios para los RPC de ejecucion.
-- =========================================================================================

BEGIN;

CREATE TEMP TABLE _qa_audit_list_results (qa text, result text, detail jsonb);

DO $$
DECLARE
    v_company_id uuid := 'd1000000-0000-0000-0000-000000000001';
    v_campaign_id uuid := 'a6b261bb-5c91-41db-9db0-7066b4470c52';
    v_audit_carlos uuid := '7ac56229-f5ce-4fa1-876c-83e7a3e45263';
    v_audit_ana uuid := 'b169c3c9-0e15-48e7-810c-8ed3fd162d35';
    v_carlos uuid := 'dc9be3b3-bf39-47b2-8ea3-fdd6aa9a4aaa';
    v_ana uuid := 'ba104779-f927-46de-8c6c-300fac1130de';
    v_blind jsonb;
    v_ok boolean;
    v_msg text;
    v_results jsonb := '[]'::jsonb;
    v_row record;
BEGIN
    -- QA1: el contrato entrega company_id raiz en cada auditoria de Carlos
    PERFORM set_config('request.jwt.claim.sub', v_carlos::text, true);
    v_blind := inventarios.list_my_inventory_audits();
    v_ok := EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_blind->'audits') a
        WHERE (a->>'audit_id') = v_audit_carlos::text
          AND (a->>'company_id') = v_company_id::text
    );
    v_results := v_results || jsonb_build_object('qa','QA1','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'audits', v_blind->'audits');

    -- QA2: el company_id corresponde exactamente al de inventory_audits
    v_ok := EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_blind->'audits') a
        JOIN inventarios.inventory_audits ia ON ia.id = (a->>'audit_id')::uuid
        WHERE (a->>'company_id') = ia.company_id::text
          AND (a->>'company_id') = v_company_id::text
    );
    v_results := v_results || jsonb_build_object('qa','QA2','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END);

    -- QA3: los campos previos del contrato permanecen compatibles
    v_ok := EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_blind->'audits') a
        WHERE (a->>'audit_id') = v_audit_carlos::text
          AND (a->>'audit_number') IS NOT NULL
          AND (a->>'status') IS NOT NULL
          AND (a->>'campaign_id') IS NOT NULL
          AND (a->>'campaign_name') IS NOT NULL
          AND (a->>'assigned_at') IS NOT NULL
          AND (a->>'product_count') IS NOT NULL
          AND a ? 'products'
    );
    v_results := v_results || jsonb_build_object('qa','QA3','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END);

    -- QA4: el contrato sigue siendo ciego (sin teorico/fisico/diferencia/faltante/sobrante/objetivo)
    v_ok := NOT EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_blind->'audits') a
        WHERE a ? 'previous_result' OR a ? 'theoretical_quantity' OR a ? 'total_theoretical'
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_blind->'audits') a
        CROSS JOIN pg_catalog.jsonb_array_elements(a->'products') p
        WHERE p ? 'theoretical_quantity' OR p ? 'physical_quantity' OR p ? 'difference_quantity'
           OR p ? 'contribution_count' OR p ? 'variance_status' OR p ? 'missing_quantity'
           OR p ? 'excess_quantity'
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_blind->'audits') a
        CROSS JOIN pg_catalog.jsonb_array_elements(a->'products') p
        CROSS JOIN pg_catalog.jsonb_array_elements(p->'locations') l
        WHERE l ? 'theoretical_quantity' OR l ? 'physical_quantity' OR l ? 'difference_quantity'
           OR l ? 'variance_status'
    );
    v_results := v_results || jsonb_build_object('qa','QA4','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END);

    -- QA5: las auditorias de ANA no aparecen para Carlos
    v_ok := NOT EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_blind->'audits') a
        WHERE (a->>'audit_id') = v_audit_ana::text
    );
    v_results := v_results || jsonb_build_object('qa','QA5','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END);

    -- QA6: las auditorias de Carlos no aparecen para ANA (filtrado por auditor)
    PERFORM set_config('request.jwt.claim.sub', v_ana::text, true);
    v_blind := inventarios.list_my_inventory_audits();
    v_ok := NOT EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_blind->'audits') a
        WHERE (a->>'audit_id') = v_audit_carlos::text
    ) AND EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_blind->'audits') a
        WHERE (a->>'audit_id') = v_audit_ana::text
          AND (a->>'company_id') = v_company_id::text
    );
    v_results := v_results || jsonb_build_object('qa','QA6','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'audits', v_blind->'audits');

    -- QA7: con company_id retornado se dispone de todos los identificadores para ejecutar
    PERFORM set_config('request.jwt.claim.sub', v_carlos::text, true);
    v_blind := inventarios.list_my_inventory_audits();
    v_ok := EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_blind->'audits') a
        WHERE (a->>'audit_id') = v_audit_carlos::text
          AND (a->>'company_id') = v_company_id::text
          AND (a->>'campaign_id') IS NOT NULL
          AND (a->>'status') IN ('ASSIGNED','IN_PROGRESS')
          AND pg_catalog.jsonb_array_length(a->'products') > 0
    );
    v_results := v_results || jsonb_build_object('qa','QA7','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END);

    -- QA8: no se altero ningun dato/estado de auditoria (solo lectura)
    SELECT count(*) INTO v_msg FROM inventarios.inventory_audits
    WHERE company_id = v_company_id AND id IN (v_audit_carlos, v_audit_ana);
    v_ok := v_msg = '2';
    v_results := v_results || jsonb_build_object('qa','QA8','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'audits_count', v_msg);

    -- QA9: snapshot de las filas de auditoria retornadas (sin cambios) para trazabilidad
    v_ok := NOT EXISTS (
        SELECT 1 FROM inventarios.inventory_audits ia
        WHERE ia.company_id = v_company_id AND ia.id IN (v_audit_carlos, v_audit_ana)
          AND (ia.started_at IS NOT NULL OR ia.submitted_at IS NOT NULL)
    );
    v_results := v_results || jsonb_build_object('qa','QA9','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END,
        'status', (SELECT jsonb_object_agg(ia.id::text, ia.status) FROM inventarios.inventory_audits ia WHERE ia.company_id = v_company_id AND ia.id IN (v_audit_carlos, v_audit_ana)));

    v_results := v_results || jsonb_build_object('qa','TOTAL','passed', (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(v_results) r WHERE r->>'result' = 'PASSED'), 'failed', (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(v_results) r WHERE r->>'result' = 'FAILED'));
    INSERT INTO _qa_audit_list_results
    SELECT r->>'qa', r->>'result', r - 'qa' - 'result'
    FROM pg_catalog.jsonb_array_elements(v_results) r;
END $$;

SELECT qa, result, pg_catalog.jsonb_pretty(detail) AS detail FROM _qa_audit_list_results ORDER BY 1;

ROLLBACK;
