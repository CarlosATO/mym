-- =========================================================================================
-- QA: M1.5F.3 - Nombre de zona unico en el mismo ambito operativo
-- Ejecutar con:  supabase db query --linked --file scripts/qa_zone_name_unique.sql
-- Todo se ejecuta en una transaccion que se ROLLBACK al final (no contamina datos).
--
-- Validacion minima:
--   1. Crear 'Zona 2' donde no existe            -> permitido
--   2. Crear otra 'Zona 2' en el mismo ambito     -> rechazado (INV_ZONE_NAME_ALREADY_EXISTS)
--   3. ' zona 2 ' / 'ZONA 2' en el mismo ambito   -> rechazado (normalizacion)
--   4. Mismo nombre en otra seccion/bodega        -> permitido
--   5. Zonas duplicadas historicas intactas       -> sin modificacion
-- =========================================================================================

BEGIN;

CREATE TEMP TABLE _qa_zone_results (qa text, result text, detail jsonb);

DO $$
DECLARE
    v_company_id uuid := 'd1000000-0000-0000-0000-000000000001';
    v_admin_actor uuid := 'dc9be3b3-bf39-47b2-8ea3-fdd6aa9a4aaa';
    -- Bodega/seccion DRAFT del inventario QA con snapshot.
    v_session_principal uuid := '7438cfdf-7187-4c95-a8f8-890d6ca5b48a'; -- BODEGA PRINCIPAL
    v_session_respaldo uuid := 'fb489333-71e5-409c-8776-594a2465a467'; -- BODEGA DE RESPALDO
    -- Sesion con duplicados historicos (TERCERA BODEGA, 3 zonas 'Zona 1').
    v_session_historica uuid := '4fd766f8-39bd-4e46-9117-821d48ed7da7';
    v_response jsonb;
    v_ok boolean;
    v_msg text;
    v_results jsonb := '[]'::jsonb;
    v_zones_before bigint;
    v_zones_after bigint;
    v_dup_groups bigint;
BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_admin_actor::text, true);

    SELECT count(*) INTO v_zones_before
    FROM inventarios.session_zones
    WHERE company_id = v_company_id AND session_id = v_session_historica;

    -- QA1: crear 'Zona 2' en BODEGA PRINCIPAL (no existe ahi) -> permitido
    v_response := inventarios.create_inventory_session_zone(
        v_company_id, v_session_principal, 'QA2', 'QA2', 'Zona 2', 0, gen_random_uuid());
    v_ok := (v_response ->> 'entity_id') IS NOT NULL;
    v_results := v_results || jsonb_build_object('qa','QA1','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'entity_id', v_response->>'entity_id', 'state', v_response->>'state');

    -- QA2: crear OTRA 'Zona 2' en el mismo ambito -> rechazado
    BEGIN
        PERFORM inventarios.create_inventory_session_zone(
            v_company_id, v_session_principal, 'QA2B', 'QA2B', 'Zona 2', 0, gen_random_uuid());
        v_ok := false; v_msg := 'no rechazo';
    EXCEPTION WHEN OTHERS THEN
        v_ok := SQLERRM = 'INV_ZONE_NAME_ALREADY_EXISTS'; v_msg := SQLERRM;
    END;
    v_results := v_results || jsonb_build_object('qa','QA2','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'error', v_msg);

    -- QA3a: ' zona 2 ' (espacios al inicio/final) en el mismo ambito -> rechazado
    BEGIN
        PERFORM inventarios.create_inventory_session_zone(
            v_company_id, v_session_principal, 'QA2C', 'QA2C', ' zona 2 ', 0, gen_random_uuid());
        v_ok := false; v_msg := 'no rechazo';
    EXCEPTION WHEN OTHERS THEN
        v_ok := SQLERRM = 'INV_ZONE_NAME_ALREADY_EXISTS'; v_msg := SQLERRM;
    END;
    v_results := v_results || jsonb_build_object('qa','QA3a','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'error', v_msg);

    -- QA3b: 'ZONA 2' (mayusculas) en el mismo ambito -> rechazado
    BEGIN
        PERFORM inventarios.create_inventory_session_zone(
            v_company_id, v_session_principal, 'QA2D', 'QA2D', 'ZONA 2', 0, gen_random_uuid());
        v_ok := false; v_msg := 'no rechazo';
    EXCEPTION WHEN OTHERS THEN
        v_ok := SQLERRM = 'INV_ZONE_NAME_ALREADY_EXISTS'; v_msg := SQLERRM;
    END;
    v_results := v_results || jsonb_build_object('qa','QA3b','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'error', v_msg);

    -- QA4: mismo nombre 'Zona 2' en OTRA seccion (BODEGA DE RESPALDO) -> permitido
    v_response := inventarios.create_inventory_session_zone(
        v_company_id, v_session_respaldo, 'QA2', 'QA2', 'Zona 2', 0, gen_random_uuid());
    v_ok := (v_response ->> 'entity_id') IS NOT NULL;
    v_results := v_results || jsonb_build_object('qa','QA4','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'entity_id', v_response->>'entity_id');

    -- QA5: zonas duplicadas historicas permanecen intactas (mismo set de filas)
    SELECT count(*) INTO v_zones_after
    FROM inventarios.session_zones
    WHERE company_id = v_company_id AND session_id = v_session_historica;
    SELECT count(*) INTO v_dup_groups
    FROM (
        SELECT display_name FROM inventarios.session_zones
        WHERE company_id = v_company_id AND session_id = v_session_historica
        GROUP BY display_name HAVING count(*) > 1
    ) d;
    v_ok := v_zones_before = v_zones_after AND v_zones_before = 3 AND v_dup_groups = 1;
    v_results := v_results || jsonb_build_object('qa','QA5','result', CASE WHEN v_ok THEN 'PASSED' ELSE 'FAILED' END, 'zones_before', v_zones_before, 'zones_after', v_zones_after, 'dup_groups', v_dup_groups);

    v_results := v_results || jsonb_build_object('qa','TOTAL','passed', (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(v_results) r WHERE r->>'result' = 'PASSED'), 'failed', (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(v_results) r WHERE r->>'result' = 'FAILED'));
    INSERT INTO _qa_zone_results
    SELECT r->>'qa', r->>'result', r - 'qa' - 'result'
    FROM pg_catalog.jsonb_array_elements(v_results) r;
END $$;

SELECT qa, result, pg_catalog.jsonb_pretty(detail) AS detail FROM _qa_zone_results ORDER BY 1;

ROLLBACK;
