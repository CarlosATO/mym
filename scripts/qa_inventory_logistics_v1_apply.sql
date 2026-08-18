-- QA remoto transaccional de aplicacion Kardex V1.
-- Los movimientos y fixtures se revierten. Bsale no se modifica.
BEGIN;

CREATE TEMP TABLE qa_apply_results (scenario text, result jsonb) ON COMMIT DROP;

DO $$
DECLARE
    v_company uuid := 'd1000000-0000-0000-0000-000000000001';
    v_admin uuid := 'dc9be3b3-bf39-47b2-8ea3-fdd6aa9a4aaa';
    v_warehouse uuid := 'e4fa8a09-c160-4574-af69-a44a41e5de9c';
    v_location uuid := '046c148f-7048-4de0-a034-30d95adcd657';
    v_session uuid := gen_random_uuid();
    v_snapshot uuid := gen_random_uuid();
    v_zone uuid := gen_random_uuid();
    v_scope uuid := gen_random_uuid();
    v_zone_location uuid := gen_random_uuid();
    v_product_a uuid := gen_random_uuid();
    v_product_b uuid := gen_random_uuid();
    v_product_c uuid := gen_random_uuid();
    v_product_blocked uuid := gen_random_uuid();
    v_ov uuid := gen_random_uuid();
    v_run uuid;
    v_qa_a uuid := '52910beb-05a8-44ed-8080-13a459ffd29c';
    v_qa_b uuid := 'f62f8036-22b7-421a-bc05-27bd8f9c4826';
    v_qa_c uuid := '4998a80c-84d2-4ccf-bc50-a17b95a12279';
    v_qa_blocked uuid := '85dc9942-61a0-4ee1-b1f5-9a99c3892948';
    v_q_a numeric;
    v_q_b numeric;
    v_q_c numeric;
    v_q_blocked numeric;
    v_response jsonb;
    v_second_response jsonb;
    v_balance_a numeric;
    v_balance_b numeric;
    v_balance_c numeric;
    v_moves_before bigint;
    v_moves_after bigint;
    v_trace_applied bigint;
    v_trace_noop bigint;
    v_failed bigint;
BEGIN
    SELECT r.id INTO v_run
    FROM integraciones.bsale_sync_runs r
    WHERE r.company_id = v_company AND r.status = 'COMPLETED'
    ORDER BY r.completed_at DESC NULLS LAST, r.started_at DESC NULLS LAST, r.id DESC
    LIMIT 1;
    SELECT coalesce(sum(quantity), 0) INTO v_q_a FROM integraciones.bsale_stock_current
    WHERE company_id = v_company AND variant_id = 6976 AND bsale_sync_run_id = v_run;
    SELECT coalesce(sum(quantity), 0) INTO v_q_b FROM integraciones.bsale_stock_current
    WHERE company_id = v_company AND variant_id = 6977 AND bsale_sync_run_id = v_run;
    SELECT coalesce(sum(quantity), 0) INTO v_q_c FROM integraciones.bsale_stock_current
    WHERE company_id = v_company AND variant_id = 7005 AND bsale_sync_run_id = v_run;
    SELECT coalesce(sum(quantity), 0) INTO v_q_blocked FROM integraciones.bsale_stock_current
    WHERE company_id = v_company AND variant_id = 7008 AND bsale_sync_run_id = v_run;
    IF v_run IS NULL OR v_q_a <= 5 OR v_q_b <= 0 OR v_q_c <= 0 OR v_q_blocked <= 0 THEN
        RAISE EXCEPTION 'QA precondicion Bsale insuficiente';
    END IF;

    INSERT INTO inventarios.sessions (
        id, company_id, session_number, name, inventory_type, status, scope_mode,
        warehouse_id, responsible_user_id, prepared_at, started_at, reviewed_at,
        approved_at, approved_by, created_at, created_by, updated_at, updated_by
    ) VALUES (
        v_session, v_company, 930000 + floor(random() * 9999)::integer,
        'QA logistics V1 apply', 'GENERAL', 'APPROVED', 'GENERAL', v_warehouse,
        v_admin, now(), now(), now(), now(), v_admin, now(), v_admin, now(), v_admin
    );
    INSERT INTO inventarios.operational_snapshots (
        id, company_id, session_id, completion_status, captured_at, captured_by,
        created_at, created_by
    ) VALUES (v_snapshot, v_company, v_session, 'PENDING', now(), v_admin, now(), v_admin);
    INSERT INTO inventarios.snapshot_locations (
        id, company_id, snapshot_id, location_id, warehouse_id, code, is_active, created_by
    ) VALUES (gen_random_uuid(), v_company, v_snapshot, v_location, v_warehouse,
              'QA-APPLY-LOCATION', true, v_admin);
    SELECT id INTO v_scope FROM inventarios.snapshot_locations
    WHERE company_id = v_company AND snapshot_id = v_snapshot AND location_id = v_location;
    INSERT INTO inventarios.session_location_scopes (
        id, company_id, session_id, location_id, inclusion_type, created_by
    ) VALUES (gen_random_uuid(), v_company, v_session, v_location, 'INCLUDED', v_admin);
    INSERT INTO inventarios.session_zones (
        id, company_id, session_id, snapshot_id, zone_code, scan_code, display_name, created_by
    ) VALUES (v_zone, v_company, v_session, v_snapshot, 'QA-APPLY', 'QA-APPLY', 'QA apply', v_admin);
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
        (v_product_a, v_company, v_snapshot, v_qa_a, 6976, 'QA-A', 'QA APPLY POSITIVE', v_admin),
        (v_product_b, v_company, v_snapshot, v_qa_b, 6977, 'QA-B', 'QA APPLY NEGATIVE', v_admin),
        (v_product_c, v_company, v_snapshot, v_qa_c, 7005, 'QA-C', 'QA APPLY NOOP', v_admin),
        (v_product_blocked, v_company, v_snapshot, v_qa_blocked, 7008, 'QA-BLOCKED', 'QA APPLY BLOCKED', v_admin);
    INSERT INTO inventarios.official_versions (
        id, company_id, session_id, snapshot_id, version_number, task_count,
        contribution_count, normal_contribution_count, recount_contribution_count,
        item_count, approved_at, approved_by, created_at, created_by
    ) VALUES (v_ov, v_company, v_session, v_snapshot, 1, 1, 4, 3, 1, 4,
              now(), v_admin, now(), v_admin);
    INSERT INTO inventarios.official_version_items (
        company_id, official_version_id, session_id, snapshot_id, snapshot_product_id,
        bsale_variant_id, available_quantity, damaged_quantity, expired_quantity,
        blocked_quantity, other_unavailable_quantity, physical_quantity,
        contribution_count, normal_contribution_count, recount_contribution_count,
        contribution_manifest, location_resolution_status, created_at, created_by
    ) VALUES
        (v_company, v_ov, v_session, v_snapshot, v_product_a, 6976, v_q_a, 0, 0, 0, 0, v_q_a, 1, 1, 0, '[]', 'RESOLVED', now(), v_admin),
        (v_company, v_ov, v_session, v_snapshot, v_product_b, 6977, v_q_b, 0, 0, 0, 0, v_q_b, 1, 1, 0, '[]', 'RESOLVED', now(), v_admin),
        (v_company, v_ov, v_session, v_snapshot, v_product_c, 7005, v_q_c, 0, 0, 0, 0, v_q_c, 1, 1, 0, '[]', 'RESOLVED', now(), v_admin),
        (v_company, v_ov, v_session, v_snapshot, v_product_blocked, 7008, v_q_blocked, 0, 0, 0, 0, v_q_blocked, 1, 0, 1, '[]', 'UNRESOLVED_RECOUNT', now(), v_admin);
    INSERT INTO inventarios.official_version_location_items (
        company_id, official_version_id, session_id, snapshot_id, snapshot_product_id,
        snapshot_location_id, theoretical_quantity, available_quantity,
        damaged_quantity, expired_quantity, blocked_quantity, other_unavailable_quantity,
        physical_quantity, valuation_status, created_by
    ) VALUES
        (v_company, v_ov, v_session, v_snapshot, v_product_a, v_scope, v_q_a, v_q_a, 0, 0, 0, 0, v_q_a, 'NOT_APPLICABLE', v_admin),
        (v_company, v_ov, v_session, v_snapshot, v_product_b, v_scope, v_q_b, v_q_b, 0, 0, 0, 0, v_q_b, 'NOT_APPLICABLE', v_admin),
        (v_company, v_ov, v_session, v_snapshot, v_product_c, v_scope, v_q_c, v_q_c, 0, 0, 0, 0, v_q_c, 'NOT_APPLICABLE', v_admin),
        (v_company, v_ov, v_session, v_snapshot, v_product_blocked, v_scope, v_q_blocked, v_q_blocked, 0, 0, 0, 0, v_q_blocked, 'NOT_APPLICABLE', v_admin);
    SET LOCAL session_replication_role = origin;

    -- Saldos iniciales: A objetivo-5, B objetivo+5, C objetivo exacto.
    INSERT INTO logistica.kardex_movements (
        company_id, product_id, warehouse_id, location_id, movement_type,
        source_type, source_id, quantity, notes, created_by
    ) VALUES
        (v_company, v_qa_a, v_warehouse, v_location, 'IN', 'ADJUSTMENT', gen_random_uuid(), v_q_a - 5, 'QA initial A', v_admin),
        (v_company, v_qa_b, v_warehouse, v_location, 'IN', 'ADJUSTMENT', gen_random_uuid(), v_q_b + 5, 'QA initial B', v_admin),
        (v_company, v_qa_c, v_warehouse, v_location, 'IN', 'ADJUSTMENT', gen_random_uuid(), v_q_c, 'QA initial C', v_admin);

    SELECT count(*) INTO v_moves_before FROM logistica.kardex_movements WHERE company_id = v_company;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin::text)::text, true);
    SELECT inventarios.refresh_inventory_stock_reconciliation(v_company, v_ov, v_run)
    INTO v_response;
    SELECT inventarios.apply_inventory_logistics_v1(
        v_company, v_ov,
        ARRAY(
            SELECT id FROM inventarios.inventory_stock_reconciliations
            WHERE company_id = v_company AND official_version_id = v_ov
            ORDER BY bsale_variant_id, id
        ),
        gen_random_uuid()
    ) INTO v_response;
    INSERT INTO qa_apply_results VALUES ('apply_batch', v_response);

    SELECT sum(CASE WHEN movement_type IN ('IN','TRANSFER_IN','ADJUSTMENT') THEN quantity ELSE -quantity END)
    INTO v_balance_a FROM logistica.kardex_movements WHERE company_id=v_company AND product_id=v_qa_a AND location_id=v_location;
    SELECT sum(CASE WHEN movement_type IN ('IN','TRANSFER_IN','ADJUSTMENT') THEN quantity ELSE -quantity END)
    INTO v_balance_b FROM logistica.kardex_movements WHERE company_id=v_company AND product_id=v_qa_b AND location_id=v_location;
    SELECT sum(CASE WHEN movement_type IN ('IN','TRANSFER_IN','ADJUSTMENT') THEN quantity ELSE -quantity END)
    INTO v_balance_c FROM logistica.kardex_movements WHERE company_id=v_company AND product_id=v_qa_c AND location_id=v_location;
    SELECT count(*) INTO v_moves_after FROM logistica.kardex_movements WHERE company_id = v_company;
    SELECT count(*) FILTER (WHERE result='APPLIED'), count(*) FILTER (WHERE result='NO_OP')
    INTO v_trace_applied, v_trace_noop
    FROM inventarios.inventory_logistics_application_items i
    JOIN inventarios.inventory_logistics_applications a ON a.id=i.application_id
    WHERE a.official_version_id=v_ov;
    SELECT count(*) INTO v_failed FROM inventarios.inventory_logistics_applications
    WHERE official_version_id=v_ov AND status='FAILED';
    INSERT INTO qa_apply_results VALUES ('balances_and_trace', jsonb_build_object(
        'target_a',v_q_a,'final_a',v_balance_a,
        'target_b',v_q_b,'final_b',v_balance_b,
        'target_c',v_q_c,'final_c',v_balance_c,
        'kardex_rows_before',v_moves_before,'kardex_rows_after',v_moves_after,
        'trace_applied_lines',v_trace_applied,'trace_noop_lines',v_trace_noop,
        'failed_products',v_failed
    ));
    IF v_balance_a <> v_q_a OR v_balance_b <> v_q_b OR v_balance_c <> v_q_c
       OR v_trace_applied <> 2 OR v_trace_noop <> 1 OR v_failed <> 1 THEN
        RAISE EXCEPTION 'QA delta/trace failed';
    END IF;

    SELECT inventarios.apply_inventory_logistics_v1(
        v_company, v_ov,
        ARRAY(
            SELECT id FROM inventarios.inventory_stock_reconciliations
            WHERE company_id = v_company AND official_version_id = v_ov
            ORDER BY bsale_variant_id, id
        ),
        gen_random_uuid()
    ) INTO v_second_response;
    SELECT count(*) INTO v_moves_after FROM logistica.kardex_movements WHERE company_id = v_company;
    INSERT INTO qa_apply_results VALUES ('second_execution', jsonb_build_object(
        'response', v_second_response, 'kardex_rows_after_second', v_moves_after
    ));
    IF v_moves_after <> v_moves_before + 2 THEN
        RAISE EXCEPTION 'QA idempotency failed';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM inventarios.inventory_stock_reconciliations
        WHERE official_version_id=v_ov AND logistics_application_status='APPLIED'
          AND bsale_variant_id IN (6976,6977,7005) GROUP BY official_version_id HAVING count(*)=3
    ) THEN RAISE EXCEPTION 'QA application status failed'; END IF;
END;
$$;

SELECT scenario, result FROM qa_apply_results ORDER BY scenario;
ROLLBACK;
