-- QA remoto transaccional de aplicabilidad logistica V1.
-- No inserta en logistica ni integraciones; todos los fixtures son inventarios.
BEGIN;

CREATE TEMP TABLE qa_logistics_v1_results (
    scenario text,
    result jsonb
) ON COMMIT DROP;

DO $$
DECLARE
    v_company uuid := 'd1000000-0000-0000-0000-000000000001';
    v_admin uuid := 'dc9be3b3-bf39-47b2-8ea3-fdd6aa9a4aaa';
    v_session uuid := gen_random_uuid();
    v_snapshot uuid := gen_random_uuid();
    v_zone uuid := gen_random_uuid();
    v_scope uuid := gen_random_uuid();
    v_zone_location uuid := gen_random_uuid();
    v_location uuid := '046c148f-7048-4de0-a034-30d95adcd657';
    v_unmapped_snapshot_location uuid := gen_random_uuid();
    v_ready_product uuid := gen_random_uuid();
    v_non_available_product uuid := gen_random_uuid();
    v_recount_product uuid := gen_random_uuid();
    v_missing_product uuid := gen_random_uuid();
    v_version uuid := gen_random_uuid();
    v_latest_run uuid;
    v_older_run uuid;
    v_q_ready numeric;
    v_q_non_available numeric;
    v_q_recount numeric;
    v_refresh jsonb;
    v_summary jsonb;
    v_row record;
BEGIN
    SELECT r.id INTO v_latest_run
    FROM integraciones.bsale_sync_runs r
    WHERE r.company_id = v_company AND r.status = 'COMPLETED'
    ORDER BY r.completed_at DESC NULLS LAST, r.started_at DESC NULLS LAST, r.id DESC
    LIMIT 1;
    SELECT r.id INTO v_older_run
    FROM integraciones.bsale_sync_runs r
    WHERE r.company_id = v_company AND r.status = 'COMPLETED' AND r.id <> v_latest_run
    ORDER BY r.completed_at DESC NULLS LAST, r.started_at DESC NULLS LAST, r.id DESC
    LIMIT 1;
    SELECT coalesce(sum(quantity), 0) INTO v_q_ready
    FROM integraciones.bsale_stock_current
    WHERE company_id = v_company AND variant_id = 6976 AND bsale_sync_run_id = v_latest_run;
    SELECT coalesce(sum(quantity), 0) INTO v_q_non_available
    FROM integraciones.bsale_stock_current
    WHERE company_id = v_company AND variant_id = 6977 AND bsale_sync_run_id = v_latest_run;
    SELECT coalesce(sum(quantity), 0) INTO v_q_recount
    FROM integraciones.bsale_stock_current
    WHERE company_id = v_company AND variant_id = 7005 AND bsale_sync_run_id = v_latest_run;
    IF v_latest_run IS NULL OR v_older_run IS NULL OR v_q_ready = 0 THEN
        RAISE EXCEPTION 'QA precondicion: faltan corridas Bsale o stock existente';
    END IF;

    INSERT INTO inventarios.sessions (
        id, company_id, session_number, name, inventory_type, status, scope_mode,
        responsible_user_id, prepared_at, started_at, reviewed_at, approved_at,
        approved_by, created_at, created_by, updated_at, updated_by
    ) VALUES (
        v_session, v_company, 920000 + floor(random() * 9999)::integer,
        'QA logistics V1 applicability', 'GENERAL', 'APPROVED', 'GENERAL', v_admin,
        now(), now(), now(), now(), v_admin, now(), v_admin, now(), v_admin
    );
    INSERT INTO inventarios.operational_snapshots (
        id, company_id, session_id, completion_status, captured_at, captured_by,
        created_at, created_by
    ) VALUES (v_snapshot, v_company, v_session, 'PENDING', now(), v_admin, now(), v_admin);
    INSERT INTO inventarios.snapshot_locations (
        id, company_id, snapshot_id, location_id, warehouse_id, code, is_active, created_by
    ) VALUES
        (gen_random_uuid(), v_company, v_snapshot, v_location,
         'e4fa8a09-c160-4574-af69-a44a41e5de9c', 'QA-VALID', true, v_admin),
        (v_unmapped_snapshot_location, v_company, v_snapshot, NULL, NULL,
         'QA-UNMAPPED', false, v_admin);
    SELECT id INTO v_scope
    FROM inventarios.snapshot_locations
    WHERE company_id = v_company AND snapshot_id = v_snapshot AND location_id = v_location;
    INSERT INTO inventarios.session_location_scopes (
        id, company_id, session_id, location_id, inclusion_type, created_by
    ) VALUES (gen_random_uuid(), v_company, v_session, v_location, 'INCLUDED', v_admin);
    INSERT INTO inventarios.session_zones (
        id, company_id, session_id, snapshot_id, zone_code, scan_code,
        display_name, created_by
    ) VALUES (v_zone, v_company, v_session, v_snapshot, 'QA-LOGISTICS',
              'QA-LOGISTICS', 'QA logistics', v_admin);
    INSERT INTO inventarios.session_zone_locations (
        id, company_id, session_id, snapshot_id, session_zone_id,
        session_location_scope_id, snapshot_location_id, location_id, created_by
    ) VALUES (v_zone_location, v_company, v_session, v_snapshot, v_zone,
              (SELECT id FROM inventarios.session_location_scopes
               WHERE company_id = v_company AND session_id = v_session),
              v_scope, v_location, v_admin);

    SET LOCAL session_replication_role = replica;
    INSERT INTO inventarios.snapshot_products
        (id, company_id, snapshot_id, product_id, bsale_variant_id, sku, name, created_by)
    VALUES
        (v_ready_product, v_company, v_snapshot, '52910beb-05a8-44ed-8080-13a459ffd29c', 6976, 'QA-6976', 'QA READY', v_admin),
        (v_non_available_product, v_company, v_snapshot, 'f62f8036-22b7-421a-bc05-27bd8f9c4826', 6977, 'QA-6977', 'QA NON AVAILABLE', v_admin),
        (v_recount_product, v_company, v_snapshot, '4998a80c-84a8-4ccf-bc50-a17b95a12279', 7005, 'QA-7005', 'QA RECOUNT', v_admin),
        (v_missing_product, v_company, v_snapshot, '4998a80c-84d2-4ccf-bc50-a17b95a12279', 99999999, 'QA-MISSING', 'QA MISSING OFFICIAL', v_admin);
    INSERT INTO inventarios.official_versions (
        id, company_id, session_id, snapshot_id, version_number, task_count,
        contribution_count, normal_contribution_count, recount_contribution_count,
        item_count, approved_at, approved_by, created_at, created_by
    ) VALUES (v_version, v_company, v_session, v_snapshot, 1, 1, 4, 3, 1, 4,
              now(), v_admin, now(), v_admin);
    INSERT INTO inventarios.official_version_items (
        company_id, official_version_id, session_id, snapshot_id, snapshot_product_id,
        bsale_variant_id, available_quantity, damaged_quantity, expired_quantity,
        blocked_quantity, other_unavailable_quantity, physical_quantity,
        contribution_count, normal_contribution_count, recount_contribution_count,
        contribution_manifest, location_resolution_status, created_at, created_by
    ) VALUES
        (v_company, v_version, v_session, v_snapshot, v_ready_product, 6976, v_q_ready, 0, 0, 0, 0, v_q_ready, 1, 1, 0, '[]', 'RESOLVED', now(), v_admin),
        (v_company, v_version, v_session, v_snapshot, v_non_available_product, 6977, 0, v_q_non_available, 0, 0, 0, v_q_non_available, 1, 1, 0, '[]', 'RESOLVED', now(), v_admin),
        (v_company, v_version, v_session, v_snapshot, v_recount_product, 7005, v_q_recount, 0, 0, 0, 0, v_q_recount, 1, 0, 1, '[]', 'UNRESOLVED_RECOUNT', now(), v_admin),
        (v_company, v_version, v_session, v_snapshot, v_missing_product, 99999999, 0, 0, 0, 0, 0, 0, 1, 1, 0, '[]', 'RESOLVED', now(), v_admin);
    INSERT INTO inventarios.official_version_location_items (
        company_id, official_version_id, session_id, snapshot_id, snapshot_product_id,
        snapshot_location_id, theoretical_quantity, available_quantity,
        damaged_quantity, expired_quantity, blocked_quantity, other_unavailable_quantity,
        physical_quantity, valuation_status, created_by
    ) VALUES
        (v_company, v_version, v_session, v_snapshot, v_ready_product, v_scope, v_q_ready, v_q_ready, 0, 0, 0, 0, v_q_ready, 'NOT_APPLICABLE', v_admin),
        (v_company, v_version, v_session, v_snapshot, v_non_available_product, v_scope, v_q_non_available, 0, v_q_non_available, 0, 0, 0, v_q_non_available, 'NOT_APPLICABLE', v_admin),
        (v_company, v_version, v_session, v_snapshot, v_recount_product, v_scope, v_q_recount, v_q_recount, 0, 0, 0, 0, v_q_recount, 'NOT_APPLICABLE', v_admin),
        (v_company, v_version, v_session, v_snapshot, v_missing_product, v_unmapped_snapshot_location, 0, 0, 0, 0, 0, 0, 0, 'NOT_APPLICABLE', v_admin);
    SET LOCAL session_replication_role = origin;

    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin::text)::text, true);
    SELECT inventarios.refresh_inventory_stock_reconciliation(v_company, v_version, v_latest_run)
    INTO v_refresh;
    INSERT INTO qa_logistics_v1_results VALUES ('refresh', v_refresh);
    SELECT inventarios.get_inventory_stock_reconciliation_summary(v_company, v_version)
    INTO v_summary;
    INSERT INTO qa_logistics_v1_results VALUES ('summary_contract', v_summary);
    SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.bsale_variant_id), '[]'::jsonb)
    INTO v_summary
    FROM inventarios.list_inventory_stock_reconciliation_products(v_company, v_version) p;
    INSERT INTO qa_logistics_v1_results VALUES ('list_contract', v_summary);

    FOR v_row IN
        SELECT bsale_variant_id, reconciliation_status, logistics_applicability_status,
               logistics_block_reasons, logistics_scope_location_count,
               logistics_explicit_location_count
        FROM inventarios.inventory_stock_reconciliations
        WHERE company_id = v_company AND official_version_id = v_version
        ORDER BY bsale_variant_id
    LOOP
        INSERT INTO qa_logistics_v1_results
        VALUES ('product_' || v_row.bsale_variant_id, to_jsonb(v_row));
    END LOOP;

    IF NOT EXISTS (
        SELECT 1 FROM inventarios.inventory_stock_reconciliations
        WHERE official_version_id = v_version AND bsale_variant_id = 6976
          AND reconciliation_status = 'READY'
          AND logistics_applicability_status = 'READY'
          AND cardinality(logistics_block_reasons) = 0
    ) THEN RAISE EXCEPTION 'QA READY failed'; END IF;
    IF NOT EXISTS (
        SELECT 1 FROM inventarios.inventory_stock_reconciliations
        WHERE official_version_id = v_version AND bsale_variant_id = 6977
          AND 'NON_AVAILABLE_PHYSICAL_STOCK' = ANY(logistics_block_reasons)
    ) THEN RAISE EXCEPTION 'QA NON_AVAILABLE failed'; END IF;
    IF NOT EXISTS (
        SELECT 1 FROM inventarios.inventory_stock_reconciliations
        WHERE official_version_id = v_version AND bsale_variant_id = 7005
          AND 'UNRESOLVED_RECOUNT' = ANY(logistics_block_reasons)
    ) THEN RAISE EXCEPTION 'QA RECOUNT failed'; END IF;
    IF NOT EXISTS (
        SELECT 1 FROM inventarios.inventory_stock_reconciliations
        WHERE official_version_id = v_version AND bsale_variant_id = 99999999
          AND 'UNMAPPED_LOCATION' = ANY(logistics_block_reasons)
          AND 'MISSING_OFFICIAL_LOCATION' = ANY(logistics_block_reasons)
    ) THEN RAISE EXCEPTION 'QA missing/unmapped location failed'; END IF;

    IF v_older_run IS NOT NULL THEN
        PERFORM inventarios.refresh_inventory_stock_reconciliation(v_company, v_version, v_older_run);
        IF NOT EXISTS (
            SELECT 1 FROM inventarios.inventory_stock_reconciliations
            WHERE official_version_id = v_version AND bsale_variant_id = 6976
              AND 'BSALE_STALE' = ANY(logistics_block_reasons)
        ) THEN RAISE EXCEPTION 'QA BSALE_STALE failed'; END IF;
    END IF;

    INSERT INTO qa_logistics_v1_results
    SELECT 'kardex_fixture_scope', jsonb_build_object(
        'positive_kardex_rows', count(*)
    ) FROM logistica.kardex_movements
    WHERE company_id = v_company;
END;
$$;

SELECT scenario, result FROM qa_logistics_v1_results ORDER BY scenario;
ROLLBACK;
