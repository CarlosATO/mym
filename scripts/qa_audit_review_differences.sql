-- =========================================================================================
-- QA: M1.5F.2 - Scope administrativo de busqueda para auditorias sin ubicacion previa
-- Ejecutar con:  supabase db query --linked --file scripts/qa_audit_review_differences.sql
-- Todo se ejecuta en una transaccion que se ROLLBACK al final (no contamina datos).
--
-- Casos cubiertos (criterios de aceptacion):
--   * producto con ubicaciones conocidas sigue asignandose como hoy;
--   * NO_PREVIOUS_LOCATION sin scope -> INV_AUDIT_SEARCH_SCOPE_REQUIRED;
--   * NO_PREVIOUS_LOCATION con una zona -> exito y scope persistido;
--   * NO_PREVIOUS_LOCATION con varias zonas -> exito;
--   * scope de OTRA campana -> rechazo; UUID arbitrario -> rechazo;
--   * tarea mixta (ubicaciones + scope) en una sola auditoria;
--   * contrato ciego Mobile distingue ambos casos sin filtrar teorico/fisico/diferencia;
--   * crear/definir scope NO modifica el resultado efectivo del Inventario;
--   * el scope queda persistido de forma auditable (quien/cuando/seccion/zona).
-- =========================================================================================

BEGIN;

CREATE TEMP TABLE _qa_audit_results (qa text, result text, detail jsonb);

DO $$
DECLARE
    v_company_id uuid := 'd1000000-0000-0000-0000-000000000001';
    v_campaign_id uuid := 'a6b261bb-5c91-41db-9db0-7066b4470c52';
    v_admin_actor uuid := 'dc9be3b3-bf39-47b2-8ea3-fdd6aa9a4aaa';
    v_ana uuid := 'f9e55d97-54cd-47d4-a179-c79f31bcef56';
    v_carlos_counter uuid := 'fad8f099-08e8-4f2e-a8e9-8e3daff0cf6d';
    v_carlos_admin uuid := '1c666897-aa1e-46f0-b100-3082f58180b8';
    v_foreign_counter uuid := '486f5ca4-2923-460a-b9ab-e12d6a125cd6';
    v_ana_user uuid := 'ba104779-f927-46de-8c6c-300fac1130de';
    -- Seccion TERCERA BODEGA del inventario QA y sus zonas habilitadas.
    v_scope_session uuid := '4fd766f8-39bd-4e46-9117-821d48ed7da7';
    v_zone_1 uuid := 'd02295c5-60cf-447a-bdde-1eb062063d99';
    v_zone_2 uuid := '7b0da253-9ccc-4e71-9b32-1dca2b6526c5';
    v_zone_3 uuid := '92f4dd79-a610-4ed3-972d-934749ef5dc3';
    -- Session de OTRA campana (QA-M1.5E-TRACE2) -> debe rechazarse.
    v_foreign_session uuid := '2c135e6d-01ec-4b04-a26f-66d60a51f8c7';
    v_response jsonb;
    v_state text;
    v_ok boolean;
    v_msg text;
    v_candidates jsonb;
    v_blind jsonb;
    v_scopes jsonb;
    v_variances_before integer;
    v_variances_after integer;
    v_results jsonb := '[]'::jsonb;
    v_scope_count integer;
    v_audit_products bigint;
    v_audit_locations bigint;
    v_audit_scope_rows bigint;
BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_admin_actor::text, true);

    v_variances_before := (inventarios.list_inventory_campaign_variances(v_company_id, v_campaign_id, '', '', '', 1, 1, 'SKU', 'ASC')->>'total')::int;

    -- QA1: Candidatos solo con diferencia <> 0
    v_candidates := inventarios.list_inventory_audit_candidates(v_company_id, v_campaign_id, '', '', 1, 100, 'SKU', 'ASC');
    v_ok := (v_candidates->>'total')::int > 0
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_candidates->'items') it WHERE (it->>'difference_quantity')::numeric = 0);
    v_results := v_results || jsonb_build_object('qa','QA1','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'total', v_candidates->>'total');

    -- QA2: Filtros FALTANTE y SOBRANTE
    v_ok := NOT EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(inventarios.list_inventory_audit_candidates(v_company_id, v_campaign_id, '', 'FALTANTE', 1, 10, 'SKU', 'ASC')->'items') it
        WHERE (it->>'variance_status') <> 'FALTANTE'
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(inventarios.list_inventory_audit_candidates(v_company_id, v_campaign_id, '', 'SOBRANTE', 1, 10, 'SKU', 'ASC')->'items') it
        WHERE (it->>'variance_status') <> 'SOBRANTE'
    );
    v_results := v_results || jsonb_build_object('qa','QA2','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END);

    -- QA3: Candidatos exponen scope_status (4877 NO_PREVIOUS_LOCATION / 1587 LOCATIONS_RESOLVED)
    v_candidates := inventarios.list_inventory_audit_candidates(v_company_id, v_campaign_id, '', '', 1, 100, 'SKU', 'ASC');
    v_ok := EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_candidates->'items') it
        WHERE (it->>'bsale_variant_id')::int = 4877 AND (it->>'scope_status') = 'NO_PREVIOUS_LOCATION'
    ) AND EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_candidates->'items') it
        WHERE (it->>'bsale_variant_id')::int = 1587 AND (it->>'scope_status') = 'LOCATIONS_RESOLVED'
    );
    v_results := v_results || jsonb_build_object('qa','QA3','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END);

    -- QA4: Producto con ubicaciones conocidas sigue asignandose como hoy (sin scope)
    v_response := inventarios.create_inventory_audit(v_company_id, v_campaign_id, v_ana, ARRAY[1587], gen_random_uuid());
    v_ok := v_response->>'state' = 'ASSIGNED'
        AND (v_response->'data'->'products'->0->>'scope_status') = 'LOCATIONS_RESOLVED'
        AND (v_response->'data'->'products'->0->>'location_count')::int >= 1
        AND (v_response->'data'->'products'->0->>'search_scope_count')::int = 0;
    v_results := v_results || jsonb_build_object('qa','QA4','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'products', v_response->'data'->'products');

    -- QA5: NO_PREVIOUS_LOCATION SIN scope -> INV_AUDIT_SEARCH_SCOPE_REQUIRED
    BEGIN
        PERFORM inventarios.create_inventory_audit(v_company_id, v_campaign_id, v_ana, ARRAY[1931], gen_random_uuid());
        v_ok := false; v_msg := 'no rechazo';
    EXCEPTION WHEN OTHERS THEN
        v_ok := SQLERRM = 'INV_AUDIT_SEARCH_SCOPE_REQUIRED'; v_msg := SQLERRM;
    END;
    v_results := v_results || jsonb_build_object('qa','QA5','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'error', v_msg);

    -- QA6: NO_PREVIOUS_LOCATION con UNA zona -> exito y scope persistido
    v_response := inventarios.create_inventory_audit(
        v_company_id, v_campaign_id, v_ana, ARRAY[1931], gen_random_uuid(),
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'bsale_variant_id', 1931, 'session_id', v_scope_session, 'zone_ids', pg_catalog.jsonb_build_array(v_zone_1))));
    v_ok := v_response->>'state' = 'ASSIGNED'
        AND (v_response->'data'->'products'->0->>'scope_status') = 'NO_PREVIOUS_LOCATION'
        AND (v_response->'data'->'products'->0->>'search_scope_count')::int = 1;
    SELECT count(*) INTO v_scope_count FROM inventarios.inventory_audit_search_scopes
    WHERE audit_product_id = (SELECT id FROM inventarios.inventory_audit_products WHERE audit_id = (v_response->>'entity_id')::uuid AND bsale_variant_id = 1931);
    v_ok := v_ok AND v_scope_count = 1;
    v_results := v_results || jsonb_build_object('qa','QA6','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'products', v_response->'data'->'products', 'scope_rows', v_scope_count);

    -- QA7: NO_PREVIOUS_LOCATION con VARIAS zonas -> exito
    v_response := inventarios.create_inventory_audit(
        v_company_id, v_campaign_id, v_ana, ARRAY[3511], gen_random_uuid(),
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'bsale_variant_id', 3511, 'session_id', v_scope_session,
            'zone_ids', pg_catalog.jsonb_build_array(v_zone_1, v_zone_2))));
    SELECT count(*) INTO v_scope_count FROM inventarios.inventory_audit_search_scopes
    WHERE audit_product_id = (SELECT id FROM inventarios.inventory_audit_products WHERE audit_id = (v_response->>'entity_id')::uuid AND bsale_variant_id = 3511);
    v_ok := v_response->>'state' = 'ASSIGNED'
        AND (v_response->'data'->'products'->0->>'search_scope_count')::int = 2
        AND v_scope_count = 2;
    v_results := v_results || jsonb_build_object('qa','QA7','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'scope_rows', v_scope_count);

    -- QA8: UUID arbitrario de seccion -> INV_AUDIT_SEARCH_SCOPE_INVALID
    BEGIN
        PERFORM inventarios.create_inventory_audit(
            v_company_id, v_campaign_id, v_ana, ARRAY[4879], gen_random_uuid(),
            pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
                'bsale_variant_id', 4879, 'session_id', gen_random_uuid(), 'zone_ids', pg_catalog.jsonb_build_array(v_zone_1))));
        v_ok := false; v_msg := 'no rechazo';
    EXCEPTION WHEN OTHERS THEN
        v_ok := SQLERRM = 'INV_AUDIT_SEARCH_SCOPE_INVALID'; v_msg := SQLERRM;
    END;
    v_results := v_results || jsonb_build_object('qa','QA8','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'error', v_msg);

    -- QA9: Scope de OTRA campana -> INV_AUDIT_SEARCH_SCOPE_INVALID
    BEGIN
        PERFORM inventarios.create_inventory_audit(
            v_company_id, v_campaign_id, v_ana, ARRAY[4880], gen_random_uuid(),
            pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
                'bsale_variant_id', 4880, 'session_id', v_foreign_session, 'zone_ids', pg_catalog.jsonb_build_array(v_zone_1))));
        v_ok := false; v_msg := 'no rechazo';
    EXCEPTION WHEN OTHERS THEN
        v_ok := SQLERRM = 'INV_AUDIT_SEARCH_SCOPE_INVALID'; v_msg := SQLERRM;
    END;
    v_results := v_results || jsonb_build_object('qa','QA9','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'error', v_msg);

    -- QA10: Tarea MIXTA en UNA auditoria (ubicaciones conocidas + scope de busqueda)
    v_response := inventarios.create_inventory_audit(
        v_company_id, v_campaign_id, v_carlos_counter, ARRAY[6930, 4882], gen_random_uuid(),
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'bsale_variant_id', 4882, 'session_id', v_scope_session, 'zone_ids', pg_catalog.jsonb_build_array(v_zone_3))));
    v_audit_products := (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(v_response->'data'->'products'));
    v_audit_locations := (SELECT pg_catalog.count(*) FROM inventarios.inventory_audit_locations WHERE audit_id = (v_response->>'entity_id')::uuid);
    v_audit_scope_rows := (SELECT pg_catalog.count(*) FROM inventarios.inventory_audit_search_scopes WHERE audit_id = (v_response->>'entity_id')::uuid);
    v_ok := v_audit_products = 2
        AND EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_response->'data'->'products') p
                    WHERE (p->>'bsale_variant_id')::int = 6930 AND (p->>'scope_status') = 'LOCATIONS_RESOLVED')
        AND EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_response->'data'->'products') p
                    WHERE (p->>'bsale_variant_id')::int = 4882 AND (p->>'scope_status') = 'NO_PREVIOUS_LOCATION' AND (p->>'search_scope_count')::int = 1)
        AND v_audit_locations >= 1 AND v_audit_scope_rows = 1;
    v_results := v_results || jsonb_build_object('qa','QA10','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'products', v_response->'data'->'products', 'locations', v_audit_locations, 'scope_rows', v_audit_scope_rows);

    -- QA11: producto ya en auditoria activa -> rechazo
    BEGIN
        PERFORM inventarios.create_inventory_audit(v_company_id, v_campaign_id, v_ana, ARRAY[1587], gen_random_uuid());
        v_ok := false; v_msg := 'no rechazo';
    EXCEPTION WHEN OTHERS THEN
        v_ok := SQLERRM = 'INV_AUDIT_PRODUCT_ALREADY_ASSIGNED'; v_msg := SQLERRM;
    END;
    v_results := v_results || jsonb_build_object('qa','QA11','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'error', v_msg);

    -- QA12: participante no elegible (ADMINISTRATOR) -> rechazo
    BEGIN
        PERFORM inventarios.create_inventory_audit(v_company_id, v_campaign_id, v_carlos_admin, ARRAY[4902], gen_random_uuid());
        v_ok := false; v_msg := 'no rechazo';
    EXCEPTION WHEN OTHERS THEN
        v_ok := SQLERRM = 'INV_AUDIT_PARTICIPANT_NOT_ELIGIBLE'; v_msg := SQLERRM;
    END;
    v_results := v_results || jsonb_build_object('qa','QA12','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'error', v_msg);

    -- QA13: participante de OTRA campana -> rechazo
    BEGIN
        PERFORM inventarios.create_inventory_audit(v_company_id, v_campaign_id, v_foreign_counter, ARRAY[5043], gen_random_uuid());
        v_ok := false; v_msg := 'no rechazo';
    EXCEPTION WHEN OTHERS THEN
        v_ok := SQLERRM = 'INV_AUDIT_PARTICIPANT_NOT_ELIGIBLE'; v_msg := SQLERRM;
    END;
    v_results := v_results || jsonb_build_object('qa','QA13','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'error', v_msg);

    -- QA14: producto SIN diferencia -> rechazo
    BEGIN
        PERFORM inventarios.create_inventory_audit(v_company_id, v_campaign_id, v_ana, ARRAY[6217], gen_random_uuid());
        v_ok := false; v_msg := 'no rechazo';
    EXCEPTION WHEN OTHERS THEN
        v_ok := SQLERRM = 'INV_AUDIT_PRODUCT_NO_DIFFERENCE'; v_msg := SQLERRM;
    END;
    v_results := v_results || jsonb_build_object('qa','QA14','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'error', v_msg);

    -- QA15: idempotencia (misma llave -> REPLAY)
    DECLARE v_key uuid := gen_random_uuid();
    BEGIN
        v_response := inventarios.create_inventory_audit(v_company_id, v_campaign_id, v_ana, ARRAY[6090], v_key);
        v_response := inventarios.create_inventory_audit(v_company_id, v_campaign_id, v_ana, ARRAY[6090], v_key);
        v_ok := (v_response->>'replayed')::boolean = true AND v_response->>'state' = 'ASSIGNED';
    END;
    v_results := v_results || jsonb_build_object('qa','QA15','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'replayed', v_response->>'replayed');

    -- QA16: list_inventory_audit_search_scopes entrega solo secciones del Inventario con sus zonas
    v_scopes := inventarios.list_inventory_audit_search_scopes(v_company_id, v_campaign_id);
        v_ok := EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_array_elements(v_scopes->'sections') sec
            WHERE (sec->>'session_id')::uuid = v_scope_session
              AND pg_catalog.jsonb_array_length(sec->'zones') = 3
              AND NOT EXISTS (
                  SELECT 1 FROM pg_catalog.jsonb_array_elements(sec->'zones') z
                  WHERE (z->>'zone_id')::uuid IS DISTINCT FROM v_zone_1
                    AND (z->>'zone_id')::uuid IS DISTINCT FROM v_zone_2
                    AND (z->>'zone_id')::uuid IS DISTINCT FROM v_zone_3
              )
        ) AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_array_elements(v_scopes->'sections') sec
            WHERE (sec->>'session_id')::uuid = v_foreign_session
        );
    v_results := v_results || jsonb_build_object('qa','QA16','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'sections', v_scopes->'sections');

    -- QA17: candidatos reflejan estado de auditoria (selectable=false + active_audits + scope_count)
    v_candidates := inventarios.list_inventory_audit_candidates(v_company_id, v_campaign_id, '', '', 1, 100, 'SKU', 'ASC');
    v_ok := NOT EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_candidates->'items') it
        WHERE (it->>'bsale_variant_id')::int = 1587 AND (it->>'selectable')::boolean = true
    ) AND EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_candidates->'items') it
        WHERE (it->>'bsale_variant_id')::int = 1587 AND (it->>'audit_status') = 'ASSIGNED'
    ) AND EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_candidates->'active_audits') a
        WHERE (a->>'search_scope_count') IS NOT NULL
    );
    v_results := v_results || jsonb_build_object('qa','QA17','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'active_audits', v_candidates->'active_audits');

    -- QA18: contrato ciego Mobile distingue ambos casos sin filtrar cantidades previas
    PERFORM set_config('request.jwt.claim.sub', v_ana_user::text, true);
    v_blind := inventarios.list_my_inventory_audits();
    v_ok := NOT EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_blind->'audits') a
        CROSS JOIN pg_catalog.jsonb_array_elements(a->'products') p
        WHERE p ? 'theoretical_quantity' OR p ? 'physical_quantity' OR p ? 'difference_quantity' OR p ? 'contribution_count' OR a ? 'previous_result'
    ) AND EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_blind->'audits') a
        CROSS JOIN pg_catalog.jsonb_array_elements(a->'products') p
        WHERE (p->>'bsale_variant_id')::int = 1587
          AND (p->>'scope_status') = 'LOCATIONS_RESOLVED'
          AND pg_catalog.jsonb_array_length(p->'locations') > 0
          AND (p->>'search_scope') IS NULL
    ) AND EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_blind->'audits') a
        CROSS JOIN pg_catalog.jsonb_array_elements(a->'products') p
        WHERE (p->>'bsale_variant_id')::int = 1931
          AND (p->>'scope_status') = 'NO_PREVIOUS_LOCATION'
          AND p->'locations' = '[]'::jsonb
          AND (p->'search_scope'->>'session_id')::uuid = v_scope_session
          AND pg_catalog.jsonb_array_length(p->'search_scope'->'zones') = 1
          AND (p->'search_scope'->'zones'->0->>'zone_id')::uuid = v_zone_1
    ) AND EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_blind->'audits') a
        CROSS JOIN pg_catalog.jsonb_array_elements(a->'products') p
        WHERE (p->>'bsale_variant_id')::int = 3511
          AND pg_catalog.jsonb_array_length(p->'search_scope'->'zones') = 2
    );
    v_results := v_results || jsonb_build_object('qa','QA18','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'audits', v_blind->'audits');

    -- QA19: el resultado efectivo (Informe Global) NO cambia al crear auditorias con scope
    PERFORM set_config('request.jwt.claim.sub', v_admin_actor::text, true);
    v_variances_after := (inventarios.list_inventory_campaign_variances(v_company_id, v_campaign_id, '', '', '', 1, 1, 'SKU', 'ASC')->>'total')::int;
    v_ok := v_variances_before = v_variances_after AND v_variances_before > 0;
    v_results := v_results || jsonb_build_object('qa','QA19','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'before', v_variances_before, 'after', v_variances_after);

    v_results := v_results || jsonb_build_object('qa','TOTAL','passed', (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(v_results) r WHERE r->>'result' = 'PASSED'), 'failed', (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(v_results) r WHERE r->>'result' = 'FAILED'));
    INSERT INTO _qa_audit_results
    SELECT r->>'qa', r->>'result', r - 'qa' - 'result'
    FROM pg_catalog.jsonb_array_elements(v_results) r;
END $$;

SELECT qa, result, pg_catalog.jsonb_pretty(detail) AS detail FROM _qa_audit_results ORDER BY 1;

ROLLBACK;
