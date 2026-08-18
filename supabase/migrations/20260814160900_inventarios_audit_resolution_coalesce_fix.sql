-- =========================================================================================
-- MIGRATION: M1.5H fix - _consolidate_session_official: coalesce sin esquema
-- =========================================================================================
-- coalesce es un constructo del parser, no una funcion pg_catalog; la version
-- aplicada fallaba en runtime. Se corrige a coalesce sin calificacion de esquema.
-- Esquema afectado EXCLUSIVAMENTE: inventarios.
-- =========================================================================================

BEGIN;

CREATE OR REPLACE FUNCTION inventarios._consolidate_session_official(
    p_company_id uuid,
    p_session_id uuid,
    p_actor_id uuid
)
RETURNS uuid
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_session_status text;
    v_snapshot_id uuid;
    v_current_id uuid;
    v_version integer;
    v_new_id uuid;
    v_approved_at timestamptz := pg_catalog.now();
    v_task_count bigint := 0;
    v_cc bigint := 0;
    v_nc bigint := 0;
    v_rc bigint := 0;
    v_ic bigint := 0;
    v_task_row record;
    v_contrib_row record;
    v_prod_key text;
    v_prod jsonb;
    v_manifest jsonb;
    v_products jsonb := '[]'::jsonb;
BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios._consolidate_session_official'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_session_id::text));

    SELECT s.status INTO v_session_status
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.id = p_session_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    IF v_session_status <> 'APPROVED' THEN
        RETURN NULL;
    END IF;

    SELECT os.id INTO v_snapshot_id
    FROM inventarios.operational_snapshots os
    WHERE os.company_id = p_company_id AND os.session_id = p_session_id;
    IF v_snapshot_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT id INTO v_current_id
    FROM inventarios.official_versions ov
    WHERE ov.company_id = p_company_id AND ov.session_id = p_session_id
      AND ov.superseded_at IS NULL
    ORDER BY ov.version_number DESC
    LIMIT 1;
    IF v_current_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT coalesce(pg_catalog.max(version_number), 0) + 1
    INTO v_version
    FROM inventarios.official_versions ov
    WHERE ov.company_id = p_company_id AND ov.session_id = p_session_id;

    v_new_id := pg_catalog.gen_random_uuid();

    -- Calcular los aportes efectivos ANTES de escribir (los CHECKS exigen counts >= 1).
    FOR v_task_row IN
        SELECT t.id FROM inventarios.tasks t
        WHERE t.company_id = p_company_id AND t.session_id = p_session_id
          AND t.cancelled_at IS NULL AND t.cancelled_by IS NULL
        ORDER BY t.id
    LOOP
        v_task_count := v_task_count + 1;
        FOR v_contrib_row IN
            SELECT ec.contribution_count_entry_id, ec.contribution_source,
                   ec.root_count_entry_id, ec.recount_request_id, ec.recount_decision_id,
                   ec.snapshot_product_id, ec.snapshot_id, ec.session_zone_id,
                   ec.task_id, ec.task_cycle,
                   ce.bsale_variant_id,
                   ce.available_quantity, ce.damaged_quantity, ce.expired_quantity,
                   ce.blocked_quantity, ce.other_unavailable_quantity, ce.physical_quantity
            FROM inventarios.get_effective_task_contributions(p_company_id, p_session_id, v_task_row.id) ec
            JOIN inventarios.count_entries ce ON ce.id = ec.contribution_count_entry_id
            ORDER BY ec.task_id, ec.task_cycle, ec.session_zone_id,
                     ec.contribution_source, ec.root_count_entry_id, ec.contribution_count_entry_id
        LOOP
            v_cc := v_cc + 1;
            IF v_contrib_row.contribution_source = 'NORMAL' THEN v_nc := v_nc + 1; END IF;
            IF v_contrib_row.contribution_source = 'RECOUNT' THEN v_rc := v_rc + 1; END IF;

            v_prod_key := v_contrib_row.snapshot_product_id::text;
            v_prod := NULL;
            SELECT value INTO v_prod FROM jsonb_array_elements(v_products)
            WHERE value->>'key' = v_prod_key;
            IF v_prod IS NULL THEN
                v_prod := pg_catalog.jsonb_build_object(
                    'key', v_prod_key, 'snapshot_product_id', v_contrib_row.snapshot_product_id,
                    'snapshot_id', v_contrib_row.snapshot_id,
                    'bsale_variant_id', v_contrib_row.bsale_variant_id,
                    'available_quantity', 0, 'damaged_quantity', 0, 'expired_quantity', 0,
                    'blocked_quantity', 0, 'other_unavailable_quantity', 0,
                    'physical_quantity', 0, 'contribution_count', 0,
                    'normal_contribution_count', 0, 'recount_contribution_count', 0,
                    'manifest', '[]'::jsonb);
                v_products := v_products || v_prod;
            END IF;
            SELECT value INTO v_prod FROM jsonb_array_elements(v_products)
            WHERE value->>'key' = v_prod_key;
            v_prod := v_prod || pg_catalog.jsonb_build_object(
                'available_quantity', (v_prod->>'available_quantity')::numeric + v_contrib_row.available_quantity,
                'damaged_quantity', (v_prod->>'damaged_quantity')::numeric + v_contrib_row.damaged_quantity,
                'expired_quantity', (v_prod->>'expired_quantity')::numeric + v_contrib_row.expired_quantity,
                'blocked_quantity', (v_prod->>'blocked_quantity')::numeric + v_contrib_row.blocked_quantity,
                'other_unavailable_quantity', (v_prod->>'other_unavailable_quantity')::numeric + v_contrib_row.other_unavailable_quantity,
                'physical_quantity', (v_prod->>'physical_quantity')::numeric + v_contrib_row.physical_quantity,
                'contribution_count', (v_prod->>'contribution_count')::integer + 1,
                'normal_contribution_count', (v_prod->>'normal_contribution_count')::integer + CASE WHEN v_contrib_row.contribution_source = 'NORMAL' THEN 1 ELSE 0 END,
                'recount_contribution_count', (v_prod->>'recount_contribution_count')::integer + CASE WHEN v_contrib_row.contribution_source = 'RECOUNT' THEN 1 ELSE 0 END
            );
            v_manifest := v_prod->'manifest';
            v_manifest := v_manifest || pg_catalog.jsonb_build_object(
                'contribution_count_entry_id', v_contrib_row.contribution_count_entry_id,
                'contribution_source', v_contrib_row.contribution_source,
                'root_count_entry_id', v_contrib_row.root_count_entry_id,
                'recount_request_id', v_contrib_row.recount_request_id,
                'recount_decision_id', v_contrib_row.recount_decision_id,
                'task_id', v_contrib_row.task_id,
                'task_cycle', v_contrib_row.task_cycle,
                'session_zone_id', v_contrib_row.session_zone_id
            );
            v_prod := v_prod || pg_catalog.jsonb_build_object('manifest', v_manifest);
            v_products := (
                SELECT pg_catalog.jsonb_agg(CASE WHEN elem->>'key' = v_prod_key THEN v_prod ELSE elem END ORDER BY elem->>'key')
                FROM pg_catalog.jsonb_array_elements(v_products) elem
            );
        END LOOP;
    END LOOP;

    IF v_cc = 0 OR pg_catalog.jsonb_array_length(v_products) = 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_NOT_CONSOLIDATED',
            DETAIL=pg_catalog.jsonb_build_object('message','La sesión no tiene contribuciones efectivas para reconsolidar.','retryable',false)::text;
    END IF;

    -- Marcar la vigente como superseded (FK diferida: la nueva aun no existe).
    UPDATE inventarios.official_versions
    SET superseded_at = v_approved_at,
        superseded_by = p_actor_id,
        supersedes_version_id = v_new_id
    WHERE id = v_current_id AND superseded_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
            DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;

    INSERT INTO inventarios.official_versions (
        id, company_id, session_id, snapshot_id, version_number, task_count,
        contribution_count, normal_contribution_count, recount_contribution_count,
        item_count, approved_at, approved_by, supersedes_version_id,
        superseded_at, superseded_by, created_at, created_by
    )
    VALUES (
        v_new_id, p_company_id, p_session_id, v_snapshot_id, v_version,
        v_task_count, v_cc, v_nc, v_rc,
        pg_catalog.jsonb_array_length(v_products),
        v_approved_at, p_actor_id, NULL, NULL, NULL,
        v_approved_at, p_actor_id
    );

    v_ic := 0;
    FOR v_prod IN SELECT value FROM pg_catalog.jsonb_array_elements(v_products) ORDER BY (value->>'key') LOOP
        INSERT INTO inventarios.official_version_items (
            company_id, official_version_id, session_id, snapshot_id, snapshot_product_id,
            bsale_variant_id, available_quantity, damaged_quantity, expired_quantity,
            blocked_quantity, other_unavailable_quantity, physical_quantity,
            contribution_count, normal_contribution_count, recount_contribution_count,
            contribution_manifest, created_at, created_by
        )
        VALUES (
            p_company_id, v_new_id, p_session_id,
            (v_prod->>'snapshot_id')::uuid, (v_prod->>'snapshot_product_id')::uuid,
            (v_prod->>'bsale_variant_id')::integer,
            (v_prod->>'available_quantity')::numeric, (v_prod->>'damaged_quantity')::numeric,
            (v_prod->>'expired_quantity')::numeric, (v_prod->>'blocked_quantity')::numeric,
            (v_prod->>'other_unavailable_quantity')::numeric, (v_prod->>'physical_quantity')::numeric,
            (v_prod->>'contribution_count')::integer,
            (v_prod->>'normal_contribution_count')::integer,
            (v_prod->>'recount_contribution_count')::integer,
            v_prod->'manifest', v_approved_at, p_actor_id
        );
        v_ic := v_ic + 1;
    END LOOP;

    UPDATE inventarios.official_versions
    SET item_count = v_ic
    WHERE id = v_new_id;

    RETURN v_new_id;
END;
$function$;

COMMIT;
