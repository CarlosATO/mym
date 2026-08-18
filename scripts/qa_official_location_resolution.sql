-- QA transaccional del contrato oficial por ubicacion.
-- Ejecutar con: supabase db query --linked -f scripts/qa_official_location_resolution.sql
BEGIN;

DO $$
DECLARE
    v_company uuid := 'd1000000-0000-0000-0000-000000000001';
    v_user uuid := '034c6464-5b14-4383-a145-dcef8674151f';
    v_session uuid := gen_random_uuid();
    v_snapshot uuid := gen_random_uuid();
    v_zone uuid := gen_random_uuid();
    v_task uuid := gen_random_uuid();
    v_location uuid := gen_random_uuid();
    v_product_a uuid := gen_random_uuid();
    v_product_b uuid := gen_random_uuid();
    v_product_c uuid := gen_random_uuid();
    v_product_d uuid := gen_random_uuid();
    v_count_a uuid := gen_random_uuid();
    v_count_b uuid := gen_random_uuid();
    v_count_c uuid := gen_random_uuid();
    v_count_d uuid := gen_random_uuid();
    v_version uuid := gen_random_uuid();
    v_now timestamptz := clock_timestamp();
    v_status text;
    v_location_count bigint;
    v_total numeric;
    v_pass boolean := true;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM core.companies WHERE id = v_company)
       OR NOT EXISTS (SELECT 1 FROM portal.users WHERE id = v_user) THEN
        RAISE EXCEPTION 'QA precondicion: company/user fixture base no existe';
    END IF;

    INSERT INTO inventarios.sessions (
        id, company_id, session_number, name, inventory_type, status, scope_mode,
        responsible_user_id, prepared_at, started_at, reviewed_at, approved_at,
        approved_by, created_at, created_by, updated_at, updated_by
    ) VALUES (
        v_session, v_company, 900000 + floor(random() * 9999)::integer,
        'QA official location resolution', 'GENERAL', 'APPROVED', 'GENERAL',
        v_user, v_now, v_now, v_now, v_now, v_user, v_now, v_user, v_now, v_user
    );
    INSERT INTO inventarios.operational_snapshots (
        id, company_id, session_id, completion_status, captured_at, captured_by,
        created_at, created_by
    ) VALUES (v_snapshot, v_company, v_session, 'PENDING', v_now, v_user, v_now, v_user);
    INSERT INTO inventarios.session_zones (
        id, company_id, session_id, snapshot_id, zone_code, scan_code,
        display_name, created_by
    ) VALUES (v_zone, v_company, v_session, v_snapshot, 'QA-OFFICIAL-ZONE',
              'QA-OFFICIAL-ZONE', 'QA official zone', v_user);
    INSERT INTO inventarios.tasks (
        id, company_id, session_id, session_zone_id, task_kind, status,
        version, validation_cycle, created_by, updated_by
    ) VALUES (v_task, v_company, v_session, v_zone, 'PRIMARY', 'COMPLETED',
              1, 1, v_user, v_user);
    INSERT INTO inventarios.snapshot_locations (
        id, company_id, snapshot_id, location_id, code, name, is_active, created_by
    ) VALUES (v_location, v_company, v_snapshot,
              '046c148f-7048-4de0-a034-30d95adcd657', 'QA-OFFICIAL-LOCATION',
              'QA location', true, v_user);

    INSERT INTO inventarios.snapshot_products
        (id, company_id, snapshot_id, bsale_variant_id, sku, name, created_by)
    VALUES
        (v_product_a, v_company, v_snapshot, 999991, 'QA-999991', 'QA NORMAL', v_user),
        (v_product_b, v_company, v_snapshot, 999992, 'QA-999992', 'QA AUDIT', v_user),
        (v_product_c, v_company, v_snapshot, 999993, 'QA-999993', 'QA RECOUNT', v_user),
        (v_product_d, v_company, v_snapshot, 999994, 'QA-999994', 'QA AUDIT AFTER RECOUNT', v_user);

    -- La FK audit_result_id se satisface solo para el fixture; el bloque revierte todo.
    SET LOCAL session_replication_role = replica;
    INSERT INTO inventarios.count_entries (
        id, company_id, session_id, snapshot_id, session_zone_id, task_id,
        task_cycle, counted_by, snapshot_product_id, snapshot_location_id,
        bsale_variant_id, identification_method, capture_source, captured_at,
        physical_quantity, available_quantity, created_by, audit_result_id
    ) VALUES
        (v_count_a, v_company, v_session, v_snapshot, v_zone, v_task, 1, v_user, v_product_a, v_location, 999991, 'BARCODE', 'AUDIT', v_now, 10, 10, v_user, gen_random_uuid()),
        (v_count_b, v_company, v_session, v_snapshot, v_zone, v_task, 1, v_user, v_product_b, v_location, 999992, 'BARCODE', 'AUDIT', v_now, 10, 10, v_user, gen_random_uuid()),
        (v_count_c, v_company, v_session, v_snapshot, v_zone, v_task, 1, v_user, v_product_c, v_location, 999993, 'BARCODE', 'AUDIT', v_now, 10, 10, v_user, gen_random_uuid()),
        (v_count_d, v_company, v_session, v_snapshot, v_zone, v_task, 1, v_user, v_product_d, v_location, 999994, 'BARCODE', 'AUDIT', v_now, 10, 10, v_user, gen_random_uuid());
    SET LOCAL session_replication_role = origin;

    INSERT INTO inventarios.official_versions (
        id, company_id, session_id, snapshot_id, version_number, task_count,
        contribution_count, normal_contribution_count, recount_contribution_count,
        item_count, approved_at, approved_by, created_at, created_by
    ) VALUES (v_version, v_company, v_session, v_snapshot, 1, 1, 4, 3, 1, 4,
              v_now, v_user, v_now, v_user);

    INSERT INTO inventarios.official_version_items (
        company_id, official_version_id, session_id, snapshot_id, snapshot_product_id,
        bsale_variant_id, available_quantity, damaged_quantity, expired_quantity,
        blocked_quantity, other_unavailable_quantity, physical_quantity,
        contribution_count, normal_contribution_count, recount_contribution_count,
        contribution_manifest, created_at, created_by
    ) VALUES
        (v_company, v_version, v_session, v_snapshot, v_product_a, 999991, 10, 0, 0, 0, 0, 10, 1, 1, 0, jsonb_build_array(jsonb_build_object('contribution_count_entry_id', v_count_a, 'contribution_source', 'NORMAL')), v_now, v_user),
        (v_company, v_version, v_session, v_snapshot, v_product_b, 999992, 10, 0, 0, 0, 0, 10, 1, 1, 0, jsonb_build_array(jsonb_build_object('contribution_count_entry_id', v_count_b, 'contribution_source', 'AUDIT')), v_now, v_user),
        (v_company, v_version, v_session, v_snapshot, v_product_c, 999993, 10, 0, 0, 0, 0, 10, 1, 0, 1, jsonb_build_array(jsonb_build_object('contribution_count_entry_id', v_count_c, 'contribution_source', 'RECOUNT')), v_now, v_user);

    -- El reemplazo exacto representa una auditoria posterior que no reconstruyo ubicaciones.
    SET LOCAL session_replication_role = replica;
    INSERT INTO inventarios.inventory_audit_resolution_replaced_contributions (
        id, company_id, resolution_id, item_id, audit_product_id,
        replaced_count_entry_id, replaced_source, created_by
    ) VALUES (gen_random_uuid(), v_company, gen_random_uuid(), gen_random_uuid(),
              gen_random_uuid(), v_count_d, 'RECOUNT', v_user);
    SET LOCAL session_replication_role = origin;
    INSERT INTO inventarios.official_version_items (
        company_id, official_version_id, session_id, snapshot_id, snapshot_product_id,
        bsale_variant_id, available_quantity, damaged_quantity, expired_quantity,
        blocked_quantity, other_unavailable_quantity, physical_quantity,
        contribution_count, normal_contribution_count, recount_contribution_count,
        contribution_manifest, created_at, created_by
    ) VALUES (v_company, v_version, v_session, v_snapshot, v_product_d, 999994,
              10, 0, 0, 0, 0, 10, 1, 1, 0,
              jsonb_build_array(jsonb_build_object('contribution_count_entry_id', v_count_d, 'contribution_source', 'AUDIT')),
              v_now, v_user);

    SELECT location_resolution_status INTO v_status FROM inventarios.official_version_items WHERE snapshot_product_id = v_product_a;
    SELECT count(*) INTO v_location_count FROM inventarios.official_version_location_items WHERE snapshot_product_id = v_product_a;
    v_pass := v_pass AND v_status = 'RESOLVED' AND v_location_count = 1;
    RAISE NOTICE 'NORMAL: status=% location_rows=%', v_status, v_location_count;

    SELECT location_resolution_status INTO v_status FROM inventarios.official_version_items WHERE snapshot_product_id = v_product_b;
    SELECT count(*) INTO v_location_count FROM inventarios.official_version_location_items WHERE snapshot_product_id = v_product_b;
    v_pass := v_pass AND v_status = 'RESOLVED' AND v_location_count = 1;
    RAISE NOTICE 'AUDIT sin RECOUNT lineage: status=% location_rows=%', v_status, v_location_count;

    SELECT location_resolution_status INTO v_status FROM inventarios.official_version_items WHERE snapshot_product_id = v_product_c;
    SELECT count(*) INTO v_location_count FROM inventarios.official_version_location_items WHERE snapshot_product_id = v_product_c;
    v_pass := v_pass AND v_status = 'UNRESOLVED_RECOUNT' AND v_location_count = 0;
    RAISE NOTICE 'RECOUNT: status=% location_rows=%', v_status, v_location_count;

    SELECT location_resolution_status INTO v_status FROM inventarios.official_version_items WHERE snapshot_product_id = v_product_d;
    SELECT count(*) INTO v_location_count FROM inventarios.official_version_location_items WHERE snapshot_product_id = v_product_d;
    v_pass := v_pass AND v_status = 'UNRESOLVED_RECOUNT' AND v_location_count = 0;
    RAISE NOTICE 'AUDIT posterior sin reconstruccion: status=% location_rows=%', v_status, v_location_count;

    SELECT sum(physical_quantity) INTO v_total FROM inventarios.official_version_items WHERE official_version_id = v_version;
    v_pass := v_pass AND v_total = 40;
    RAISE NOTICE 'official_version_items total fisico=% esperado=40', v_total;
    IF NOT v_pass THEN RAISE EXCEPTION 'QA official location resolution FAILED'; END IF;
    RAISE NOTICE 'QA official location resolution PASS';
END;
$$;

ROLLBACK;
