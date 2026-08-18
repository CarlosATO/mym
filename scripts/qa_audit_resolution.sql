-- =========================================================================================
-- QA: Resolucion administrativa de auditorias producto por producto (M1.5H)
-- =========================================================================================
-- Ejecutar con: supabase db query --linked -f scripts/qa_audit_resolution.sql
-- Precondiciones: migracion 20260814160400 aplicada; existe un SUPER_USUARIO activo;
-- adquisiciones.warehouses y logistica.locations no vacias.
--
-- NO toca la Auditoria real #3: todo ocurre en una empresa/campana descartables.
-- El bloque termina con RAISE EXCEPTION (reporte visible); la transaccion aborta y
-- rollback automatico => los fixtures NO dejan residuos.
-- =========================================================================================

DO $$
DECLARE
    v_admin uuid;
    v_regular uuid;
    v_company uuid;
    v_campaign uuid;
    v_session uuid;
    v_snapshot uuid;
    v_wh uuid;
    v_loc1 uuid;
    v_loc2 uuid;
    v_loc3 uuid;
    v_sp_a uuid;
    v_sp_b uuid;
    v_sp_c uuid;
    v_sl1 uuid;
    v_sl2 uuid;
    v_sl3 uuid;
    v_zone1 uuid;
    v_zone2 uuid;
    v_zone3 uuid;
    v_scope1 uuid;
    v_scope2 uuid;
    v_scope3 uuid;
    v_campaign_participant uuid;
    v_session_participant uuid;
    v_task1 uuid;
    v_task2 uuid;
    v_task3 uuid;
    v_count_a uuid;
    v_count_b uuid;
    v_count_c uuid;
    v_audit uuid;
    v_ap_a uuid;
    v_ap_b uuid;
    v_ap_c uuid;
    v_audit_noctx uuid;
    v_ap_noctx uuid;
    v_audit2 uuid;
    v_ap2_a uuid;
    v_audit4 uuid;
    v_ap4_d uuid;
    v_now timestamptz := pg_catalog.now();
    v_report text := '';
    v_line text;
    v_ok boolean;
    v_eff numeric;
    v_audit_status text;
    v_audit_noctx_status text;
    v_v2_count integer;
    v_v2_phys numeric;
    v_ce_audit_rows bigint;
    v_blocked boolean;
    v_error text;
    v_a_expected numeric;
BEGIN
    -- ---------- Identidad ----------
    SELECT u.id INTO v_admin
    FROM portal.users u JOIN portal.roles r ON r.id = u.role_id
    WHERE r.name = 'SUPER_USUARIO' AND u.is_active = true AND u.deleted_at IS NULL
    LIMIT 1;
    IF v_admin IS NULL THEN RAISE EXCEPTION 'QA precondicion: no existe SUPER_USUARIO activo'; END IF;

    SELECT u.id INTO v_regular
    FROM portal.users u JOIN portal.roles r ON r.id = u.role_id
    WHERE r.name <> 'SUPER_USUARIO' AND u.is_active = true AND u.deleted_at IS NULL
    LIMIT 1;

    SELECT id INTO v_wh FROM adquisiciones.warehouses LIMIT 1;
    IF v_wh IS NULL THEN RAISE EXCEPTION 'QA precondicion: adquisiciones.warehouses vacia'; END IF;
    SELECT id INTO v_loc1 FROM logistica.locations ORDER BY id LIMIT 1 OFFSET 0;
    SELECT id INTO v_loc2 FROM logistica.locations ORDER BY id LIMIT 1 OFFSET 1;
    SELECT id INTO v_loc3 FROM logistica.locations ORDER BY id LIMIT 1 OFFSET 2;

    -- ---------- Empresa y campana descartables ----------
    INSERT INTO core.companies (id, business_name, trade_name, is_active)
    VALUES (gen_random_uuid(), 'QA AUDIT RESOLUTION SCRATCH', 'QA-AUDIT', true) RETURNING id INTO v_company;
    INSERT INTO core.user_company_access (user_id, company_id, role, is_default, is_active)
    VALUES (v_admin, v_company, 'SUPER_USUARIO', true, true);

    INSERT INTO inventarios.inventory_campaigns (company_id, id, name, campaign_type, status, site_scope, product_scope, planned_at, started_at, created_by, updated_by)
    VALUES (v_company, gen_random_uuid(), 'QA-AUDIT-RESOLUTION', 'GENERAL', 'IN_PROGRESS', 'ALL_INTERNAL', 'ALL',
            v_now - interval '1 hour', v_now, v_admin, v_admin)
    RETURNING id INTO v_campaign;

    INSERT INTO inventarios.inventory_campaign_participants (company_id, campaign_id, user_id, participant_role, active_from, created_by)
    VALUES (v_company, v_campaign, v_admin, 'COUNTER', v_now - interval '1 day', v_admin)
    RETURNING id INTO v_campaign_participant;

    -- ---------- Session (APROBADA para testear re-consolidacion) ----------
    INSERT INTO inventarios.sessions (company_id, id, session_number, name, inventory_type, status, warehouse_id, bsale_office_id, scope_mode, responsible_user_id, campaign_id, prepared_at, started_at, reviewed_at, approved_at, approved_by, created_at, created_by, updated_at, updated_by)
    VALUES (v_company, gen_random_uuid(), 1, 'QA SESSION', 'GENERAL', 'APPROVED', v_wh, 1, 'GENERAL', v_admin, v_campaign,
            v_now - interval '3 hours', v_now - interval '2 hours', v_now - interval '90 minutes', v_now - interval '1 hour', v_admin,
            v_now - interval '4 hours', v_admin, v_now - interval '4 hours', v_admin)
    RETURNING id INTO v_session;

    INSERT INTO inventarios.operational_snapshots (id, company_id, session_id, snapshot_version, completion_status, captured_at, captured_by, created_by)
    VALUES (gen_random_uuid(), v_company, v_session, 1, 'PENDING', v_now - interval '2 hours', v_admin, v_admin)
    RETURNING id INTO v_snapshot;

    -- ---------- Snapshot de producto / ubicaciones ----------
    INSERT INTO inventarios.snapshot_products (id, company_id, snapshot_id, bsale_variant_id, sku, name, created_by)
    VALUES (gen_random_uuid(), v_company, v_snapshot, 746216, '746216', 'PRODUCTO A (caso real SKU)', v_admin) RETURNING id INTO v_sp_a;
    INSERT INTO inventarios.snapshot_products (id, company_id, snapshot_id, bsale_variant_id, sku, name, created_by)
    VALUES (gen_random_uuid(), v_company, v_snapshot, 900001, '900001', 'PRODUCTO B', v_admin) RETURNING id INTO v_sp_b;
    INSERT INTO inventarios.snapshot_products (id, company_id, snapshot_id, bsale_variant_id, sku, name, created_by)
    VALUES (gen_random_uuid(), v_company, v_snapshot, 900002, '900002', 'PRODUCTO C', v_admin) RETURNING id INTO v_sp_c;

    INSERT INTO inventarios.snapshot_locations (id, company_id, snapshot_id, location_id, warehouse_id, code, name, is_active, created_by)
    VALUES (gen_random_uuid(), v_company, v_snapshot, v_loc1, v_wh, 'QA-LOC-1', 'Ubicacion 1', true, v_admin) RETURNING id INTO v_sl1;
    INSERT INTO inventarios.snapshot_locations (id, company_id, snapshot_id, location_id, warehouse_id, code, name, is_active, created_by)
    VALUES (gen_random_uuid(), v_company, v_snapshot, v_loc2, v_wh, 'QA-LOC-2', 'Ubicacion 2', true, v_admin) RETURNING id INTO v_sl2;
    INSERT INTO inventarios.snapshot_locations (id, company_id, snapshot_id, location_id, warehouse_id, code, name, is_active, created_by)
    VALUES (gen_random_uuid(), v_company, v_snapshot, v_loc3, v_wh, 'QA-LOC-3', 'Ubicacion 3', true, v_admin) RETURNING id INTO v_sl3;

    -- ---------- Zonas / scopes / tareas (una ubicacion por zona) ----------
    INSERT INTO inventarios.session_location_scopes (company_id, session_id, location_id, inclusion_type, created_by)
    VALUES (v_company, v_session, v_loc1, 'INCLUDED', v_admin) RETURNING id INTO v_scope1;
    INSERT INTO inventarios.session_location_scopes (company_id, session_id, location_id, inclusion_type, created_by)
    VALUES (v_company, v_session, v_loc2, 'INCLUDED', v_admin) RETURNING id INTO v_scope2;
    INSERT INTO inventarios.session_location_scopes (company_id, session_id, location_id, inclusion_type, created_by)
    VALUES (v_company, v_session, v_loc3, 'INCLUDED', v_admin) RETURNING id INTO v_scope3;

    INSERT INTO inventarios.session_zones (id, company_id, session_id, snapshot_id, zone_code, scan_code, display_name, priority, is_enabled, created_by)
    VALUES (gen_random_uuid(), v_company, v_session, v_snapshot, 'QA-Z1', 'QA-Z1', 'Zona 1', 1, true, v_admin) RETURNING id INTO v_zone1;
    INSERT INTO inventarios.session_zones (id, company_id, session_id, snapshot_id, zone_code, scan_code, display_name, priority, is_enabled, created_by)
    VALUES (gen_random_uuid(), v_company, v_session, v_snapshot, 'QA-Z2', 'QA-Z2', 'Zona 2', 2, true, v_admin) RETURNING id INTO v_zone2;
    INSERT INTO inventarios.session_zones (id, company_id, session_id, snapshot_id, zone_code, scan_code, display_name, priority, is_enabled, created_by)
    VALUES (gen_random_uuid(), v_company, v_session, v_snapshot, 'QA-Z3', 'QA-Z3', 'Zona 3', 3, true, v_admin) RETURNING id INTO v_zone3;

    INSERT INTO inventarios.session_zone_locations (company_id, session_id, snapshot_id, session_zone_id, session_location_scope_id, snapshot_location_id, location_id, created_by)
    VALUES (v_company, v_session, v_snapshot, v_zone1, v_scope1, v_sl1, v_loc1, v_admin);
    INSERT INTO inventarios.session_zone_locations (company_id, session_id, snapshot_id, session_zone_id, session_location_scope_id, snapshot_location_id, location_id, created_by)
    VALUES (v_company, v_session, v_snapshot, v_zone2, v_scope2, v_sl2, v_loc2, v_admin);
    INSERT INTO inventarios.session_zone_locations (company_id, session_id, snapshot_id, session_zone_id, session_location_scope_id, snapshot_location_id, location_id, created_by)
    VALUES (v_company, v_session, v_snapshot, v_zone3, v_scope3, v_sl3, v_loc3, v_admin);

    INSERT INTO inventarios.session_participants (company_id, session_id, user_id, functional_role, active_from, created_by)
    VALUES (v_company, v_session, v_admin, 'COUNTER', v_now - interval '1 day', v_admin) RETURNING id INTO v_session_participant;

    INSERT INTO inventarios.tasks (id, company_id, session_id, session_zone_id, task_kind, status, version, validation_cycle, opened_at, completed_at, completed_by, created_by, updated_by)
    VALUES (gen_random_uuid(), v_company, v_session, v_zone1, 'PRIMARY', 'COMPLETED', 1, 1, v_now - interval '2 hours', v_now - interval '100 minutes', v_admin, v_admin, v_admin) RETURNING id INTO v_task1;
    INSERT INTO inventarios.tasks (id, company_id, session_id, session_zone_id, task_kind, status, version, validation_cycle, opened_at, completed_at, completed_by, created_by, updated_by)
    VALUES (gen_random_uuid(), v_company, v_session, v_zone2, 'PRIMARY', 'COMPLETED', 1, 1, v_now - interval '2 hours', v_now - interval '90 minutes', v_admin, v_admin, v_admin) RETURNING id INTO v_task2;
    INSERT INTO inventarios.tasks (id, company_id, session_id, session_zone_id, task_kind, status, version, validation_cycle, opened_at, completed_at, completed_by, created_by, updated_by)
    VALUES (gen_random_uuid(), v_company, v_session, v_zone3, 'PRIMARY', 'COMPLETED', 1, 1, v_now - interval '2 hours', v_now - interval '80 minutes', v_admin, v_admin, v_admin) RETURNING id INTO v_task3;

    -- ---------- Conteos efectivos NORMAL ----------
    INSERT INTO inventarios.count_entries (company_id, session_id, snapshot_id, session_zone_id, task_id, task_cycle, session_participant_id, counted_by, snapshot_product_id, snapshot_location_id, bsale_variant_id, identification_method, scanned_code, capture_source, captured_at, server_received_at, physical_quantity, available_quantity, created_by)
    VALUES (v_company, v_session, v_snapshot, v_zone1, v_task1, 1, v_session_participant, v_admin, v_sp_a, v_sl1, 746216, 'BARCODE', '746216', 'WEB', v_now - interval '2 hours', v_now, 1, 1, v_admin) RETURNING id INTO v_count_a;
    INSERT INTO inventarios.count_entries (company_id, session_id, snapshot_id, session_zone_id, task_id, task_cycle, session_participant_id, counted_by, snapshot_product_id, snapshot_location_id, bsale_variant_id, identification_method, scanned_code, capture_source, captured_at, server_received_at, physical_quantity, available_quantity, created_by)
    VALUES (v_company, v_session, v_snapshot, v_zone2, v_task2, 1, v_session_participant, v_admin, v_sp_b, v_sl2, 900001, 'BARCODE', '900001', 'WEB', v_now - interval '2 hours', v_now, 4, 4, v_admin) RETURNING id INTO v_count_b;
    INSERT INTO inventarios.count_entries (company_id, session_id, snapshot_id, session_zone_id, task_id, task_cycle, session_participant_id, counted_by, snapshot_product_id, snapshot_location_id, bsale_variant_id, identification_method, scanned_code, capture_source, captured_at, server_received_at, physical_quantity, available_quantity, created_by)
    VALUES (v_company, v_session, v_snapshot, v_zone3, v_task3, 1, v_session_participant, v_admin, v_sp_c, v_sl3, 900002, 'BARCODE', '900002', 'WEB', v_now - interval '2 hours', v_now, 7, 7, v_admin) RETURNING id INTO v_count_c;

    -- ---------- official_version v1 (session ya consolidada) ----------
    INSERT INTO inventarios.official_versions (company_id, session_id, snapshot_id, version_number, task_count, contribution_count, normal_contribution_count, recount_contribution_count, item_count, approved_at, approved_by, created_at, created_by)
    VALUES (v_company, v_session, v_snapshot, 1, 3, 3, 3, 0, 3, v_now - interval '1 hour', v_admin, v_now - interval '1 hour', v_admin);
    INSERT INTO inventarios.official_version_items (company_id, official_version_id, session_id, snapshot_id, snapshot_product_id, bsale_variant_id, available_quantity, damaged_quantity, expired_quantity, blocked_quantity, other_unavailable_quantity, physical_quantity, contribution_count, normal_contribution_count, recount_contribution_count, contribution_manifest, created_at, created_by)
    SELECT v_company, ov.id, v_session, v_snapshot, v_sp_a, 746216, 1, 0, 0, 0, 0, 1, 1, 1, 0,
           jsonb_build_array(jsonb_build_object('contribution_count_entry_id', v_count_a, 'contribution_source', 'NORMAL')),
           v_now - interval '1 hour', v_admin
    FROM inventarios.official_versions ov WHERE ov.company_id = v_company AND ov.session_id = v_session AND ov.version_number = 1;
    INSERT INTO inventarios.official_version_items (company_id, official_version_id, session_id, snapshot_id, snapshot_product_id, bsale_variant_id, available_quantity, damaged_quantity, expired_quantity, blocked_quantity, other_unavailable_quantity, physical_quantity, contribution_count, normal_contribution_count, recount_contribution_count, contribution_manifest, created_at, created_by)
    SELECT v_company, ov.id, v_session, v_snapshot, v_sp_b, 900001, 4, 0, 0, 0, 0, 4, 1, 1, 0,
           jsonb_build_array(jsonb_build_object('contribution_count_entry_id', v_count_b, 'contribution_source', 'NORMAL')),
           v_now - interval '1 hour', v_admin
    FROM inventarios.official_versions ov WHERE ov.company_id = v_company AND ov.session_id = v_session AND ov.version_number = 1;
    INSERT INTO inventarios.official_version_items (company_id, official_version_id, session_id, snapshot_id, snapshot_product_id, bsale_variant_id, available_quantity, damaged_quantity, expired_quantity, blocked_quantity, other_unavailable_quantity, physical_quantity, contribution_count, normal_contribution_count, recount_contribution_count, contribution_manifest, created_at, created_by)
    SELECT v_company, ov.id, v_session, v_snapshot, v_sp_c, 900002, 7, 0, 0, 0, 0, 7, 1, 1, 0,
           jsonb_build_array(jsonb_build_object('contribution_count_entry_id', v_count_c, 'contribution_source', 'NORMAL')),
           v_now - interval '1 hour', v_admin
    FROM inventarios.official_versions ov WHERE ov.company_id = v_company AND ov.session_id = v_session AND ov.version_number = 1;

    -- ---------- Auditoria #1 (A/B/C SUBMITTED) ----------
    INSERT INTO inventarios.inventory_audits (company_id, campaign_id, audit_number, status, assigned_participant_id, assigned_user_id, created_by, started_at, started_by, submitted_at, submitted_by)
    VALUES (v_company, v_campaign, 1, 'SUBMITTED', v_campaign_participant, v_admin, v_admin, v_now - interval '50 minutes', v_admin, v_now - interval '30 minutes', v_admin)
    RETURNING id INTO v_audit;

    INSERT INTO inventarios.inventory_audit_products (company_id, campaign_id, audit_id, bsale_variant_id, product_id, sku, name, theoretical_quantity, physical_quantity, difference_quantity, variance_status, scope_status, status)
    VALUES (v_company, v_campaign, v_audit, 746216, NULL, '746216', 'PRODUCTO A', 55, 1, -54, 'FALTANTE', 'LOCATIONS_RESOLVED', 'SUBMITTED') RETURNING id INTO v_ap_a;
    INSERT INTO inventarios.inventory_audit_products (company_id, campaign_id, audit_id, bsale_variant_id, product_id, sku, name, theoretical_quantity, physical_quantity, difference_quantity, variance_status, scope_status, status)
    VALUES (v_company, v_campaign, v_audit, 900001, NULL, '900001', 'PRODUCTO B', 4, 4, 0, 'SIN_DIFERENCIA', 'LOCATIONS_RESOLVED', 'SUBMITTED') RETURNING id INTO v_ap_b;
    INSERT INTO inventarios.inventory_audit_products (company_id, campaign_id, audit_id, bsale_variant_id, product_id, sku, name, theoretical_quantity, physical_quantity, difference_quantity, variance_status, scope_status, status)
    VALUES (v_company, v_campaign, v_audit, 900002, NULL, '900002', 'PRODUCTO C', 7, 7, 0, 'SIN_DIFERENCIA', 'LOCATIONS_RESOLVED', 'SUBMITTED') RETURNING id INTO v_ap_c;

    INSERT INTO inventarios.inventory_audit_locations (company_id, audit_id, audit_product_id, session_id, snapshot_location_id, location_id, location_code, location_name)
    VALUES (v_company, v_audit, v_ap_a, v_session, v_sl1, v_loc1, 'QA-LOC-1', 'Ubicacion 1');
    INSERT INTO inventarios.inventory_audit_locations (company_id, audit_id, audit_product_id, session_id, snapshot_location_id, location_id, location_code, location_name)
    VALUES (v_company, v_audit, v_ap_b, v_session, v_sl2, v_loc2, 'QA-LOC-2', 'Ubicacion 2');
    INSERT INTO inventarios.inventory_audit_locations (company_id, audit_id, audit_product_id, session_id, snapshot_location_id, location_id, location_code, location_name)
    VALUES (v_company, v_audit, v_ap_c, v_session, v_sl3, v_loc3, 'QA-LOC-3', 'Ubicacion 3');

    INSERT INTO inventarios.inventory_audit_results (company_id, campaign_id, audit_id, audit_product_id, audit_location_id, bsale_variant_id, location_id, location_code, location_name, scanned_code, identification_method, physical_quantity, audited_by, captured_at, recorded_at, revision_number, created_by)
    SELECT v_company, v_campaign, v_audit, v_ap_a, al.id, 746216, v_loc1, 'QA-LOC-1', 'Ubicacion 1', '746216', 'BARCODE', 54, v_admin, v_now - interval '40 minutes', v_now, 1, v_admin
    FROM inventarios.inventory_audit_locations al WHERE al.company_id = v_company AND al.audit_product_id = v_ap_a;
    INSERT INTO inventarios.inventory_audit_results (company_id, campaign_id, audit_id, audit_product_id, audit_location_id, bsale_variant_id, location_id, location_code, location_name, scanned_code, identification_method, physical_quantity, audited_by, captured_at, recorded_at, revision_number, created_by)
    SELECT v_company, v_campaign, v_audit, v_ap_b, al.id, 900001, v_loc2, 'QA-LOC-2', 'Ubicacion 2', '900001', 'BARCODE', 0, v_admin, v_now - interval '40 minutes', v_now, 1, v_admin
    FROM inventarios.inventory_audit_locations al WHERE al.company_id = v_company AND al.audit_product_id = v_ap_b;
    INSERT INTO inventarios.inventory_audit_results (company_id, campaign_id, audit_id, audit_product_id, audit_location_id, bsale_variant_id, location_id, location_code, location_name, scanned_code, identification_method, physical_quantity, audited_by, captured_at, recorded_at, revision_number, created_by)
    SELECT v_company, v_campaign, v_audit, v_ap_c, al.id, 900002, v_loc3, 'QA-LOC-3', 'Ubicacion 3', '900002', 'BARCODE', 5, v_admin, v_now - interval '40 minutes', v_now, 1, v_admin
    FROM inventarios.inventory_audit_locations al WHERE al.company_id = v_company AND al.audit_product_id = v_ap_c;

    -- ---------- Auditoria sin contexto (para NO_CONTEXT) ----------
    INSERT INTO inventarios.inventory_audits (company_id, campaign_id, audit_number, status, assigned_participant_id, assigned_user_id, created_by, started_at, started_by, submitted_at, submitted_by)
    VALUES (v_company, v_campaign, 2, 'SUBMITTED', v_campaign_participant, v_admin, v_admin, v_now - interval '50 minutes', v_admin, v_now - interval '30 minutes', v_admin)
    RETURNING id INTO v_audit_noctx;
    INSERT INTO inventarios.inventory_audit_products (company_id, campaign_id, audit_id, bsale_variant_id, product_id, sku, name, theoretical_quantity, physical_quantity, difference_quantity, variance_status, scope_status, status)
    VALUES (v_company, v_campaign, v_audit_noctx, 900003, NULL, '900003', 'PRODUCTO SIN CONTEXTO', 3, 0, -3, 'FALTANTE', 'LOCATIONS_RESOLVED', 'SUBMITTED') RETURNING id INTO v_ap_noctx;
    INSERT INTO inventarios.inventory_audit_locations (company_id, audit_id, audit_product_id, session_id, snapshot_location_id, location_id, location_code, location_name)
    VALUES (v_company, v_audit_noctx, v_ap_noctx, NULL, NULL, v_loc1, 'QA-NOCTX', 'Sin contexto');
    INSERT INTO inventarios.inventory_audit_results (company_id, campaign_id, audit_id, audit_product_id, audit_location_id, bsale_variant_id, location_id, location_code, location_name, scanned_code, identification_method, physical_quantity, audited_by, captured_at, recorded_at, revision_number, created_by)
    SELECT v_company, v_campaign, v_audit_noctx, v_ap_noctx, al.id, 900003, v_loc1, 'QA-NOCTX', 'Sin contexto', '900003', 'BARCODE', 2, v_admin, v_now - interval '40 minutes', v_now, 1, v_admin
    FROM inventarios.inventory_audit_locations al WHERE al.company_id = v_company AND al.audit_product_id = v_ap_noctx;

    -- ========================================================================
    -- TESTS
    -- ========================================================================
    -- Contexto de auth = administrador (SUPER_USUARIO).
    PERFORM pg_catalog.set_config('request.jwt.claims', pg_catalog.json_build_object('sub', v_admin::text)::text, false);

    -- A. PREVIEW 1 -> 54 (nunca 55)
    SELECT (x->>'current_effective_quantity')::numeric, (x->>'audited_total')::numeric,
           (x->>'result_if_approved')::numeric, (x->>'applicable')::boolean
    INTO v_eff, v_a_expected, v_v2_phys, v_ok
    FROM inventarios.preview_inventory_audit_product_resolution(v_company, v_audit, v_ap_a) x;
    v_line := 'A.preview 1->54: current=' || v_eff || ' audited=' || v_a_expected
              || ' result_if_approved=' || v_v2_phys || ' applicable=' || v_ok
              || CASE WHEN v_eff = 1 AND v_a_expected = 54 AND v_v2_phys = 54 AND v_ok THEN ' [PASS]' ELSE ' [FAIL]' END;
    v_report := v_report || v_line || E'\n';

    -- G. USUARIO NO AUTORIZADO NO RESUELVE
    v_blocked := false;
    IF v_regular IS NOT NULL THEN
        PERFORM pg_catalog.set_config('request.jwt.claims', pg_catalog.json_build_object('sub', v_regular::text)::text, false);
        BEGIN
            PERFORM inventarios.resolve_inventory_audit_product(v_company, v_audit, v_ap_a, 'APPROVE', NULL, gen_random_uuid());
        EXCEPTION WHEN OTHERS THEN
            v_blocked := true;
        END;
        PERFORM pg_catalog.set_config('request.jwt.claims', pg_catalog.json_build_object('sub', v_admin::text)::text, false);
    END IF;
    v_report := v_report || 'G.no-autorizado bloqueado: ' || CASE WHEN v_blocked THEN '[PASS]' ELSE '[FAIL]' END || E'\n';

    -- H. NO_CONTEXT BLOQUEA APPROVE SIN MUTACIONES
    v_blocked := false;
    BEGIN
        PERFORM inventarios.resolve_inventory_audit_product(v_company, v_audit_noctx, v_ap_noctx, 'APPROVE', NULL, gen_random_uuid());
    EXCEPTION WHEN OTHERS THEN
        v_blocked := true;
        v_error := SQLSTATE;
    END;
    SELECT count(*) INTO v_ce_audit_rows FROM inventarios.count_entries ce
    WHERE ce.company_id = v_company AND ce.capture_source = 'AUDIT' AND ce.audit_result_id IN (
        SELECT r.id FROM inventarios.inventory_audit_results r WHERE r.audit_product_id = v_ap_noctx);
    v_report := v_report || 'H.NO_CONTEXT bloquea (sqlstate=' || v_error || ', sinteticos_creados=' || v_ce_audit_rows || '): '
              || CASE WHEN v_blocked AND v_ce_audit_rows = 0 THEN '[PASS]' ELSE '[FAIL]' END || E'\n';

    -- B. APPROVE PRODUCTO A: 1 -> 54, nunca 55
    PERFORM inventarios.resolve_inventory_audit_product(v_company, v_audit, v_ap_a, 'APPROVE', 'QA aprobacion A', gen_random_uuid());
    SELECT pg_catalog.sum(ce.physical_quantity) INTO v_eff
    FROM inventarios.tasks t
    CROSS JOIN LATERAL inventarios.get_effective_task_contributions(v_company, v_session, t.id) g
    JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
    WHERE t.company_id = v_company AND t.session_id = v_session AND ce.bsale_variant_id = 746216;
    v_report := v_report || 'B.APPROVE A efectivo=' || coalesce(v_eff, 0) || ' (esperado 54, nunca 55): '
              || CASE WHEN coalesce(v_eff, 0) = 54 THEN '[PASS]' ELSE '[FAIL]' END || E'\n';

    -- J. RE-CONSOLIDACION session APPROVED -> nueva official_version encadenada
    SELECT pg_catalog.count(*) INTO v_v2_count FROM inventarios.official_versions ov
    WHERE ov.company_id = v_company AND ov.session_id = v_session;
    SELECT ov.version_number INTO v_a_expected FROM inventarios.official_versions ov
    WHERE ov.company_id = v_company AND ov.session_id = v_session AND ov.superseded_at IS NULL;
    SELECT ovi.physical_quantity INTO v_v2_phys FROM inventarios.official_versions ov
    JOIN inventarios.official_version_items ovi ON ovi.official_version_id = ov.id
    WHERE ov.company_id = v_company AND ov.session_id = v_session AND ov.superseded_at IS NULL
      AND ovi.bsale_variant_id = 746216;
    v_report := v_report || 'J.reconsolidacion versions=' || v_v2_count || ' vigente_vN=' || v_a_expected
              || ' physical(A)_vigente=' || coalesce(v_v2_phys, 0) || ': '
              || CASE WHEN v_v2_count = 2 AND v_a_expected = 2 AND coalesce(v_v2_phys, 0) = 54 THEN '[PASS]' ELSE '[FAIL]' END || E'\n';

    -- E. AISLACION: APPROVE A no afecta B ni C
    SELECT pg_catalog.sum(ce.physical_quantity) INTO v_eff
    FROM inventarios.tasks t
    CROSS JOIN LATERAL inventarios.get_effective_task_contributions(v_company, v_session, t.id) g
    JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
    WHERE t.company_id = v_company AND t.session_id = v_session AND ce.bsale_variant_id = 900001;
    v_ok := coalesce(v_eff, 0) = 4;
    SELECT pg_catalog.sum(ce.physical_quantity) INTO v_eff
    FROM inventarios.tasks t
    CROSS JOIN LATERAL inventarios.get_effective_task_contributions(v_company, v_session, t.id) g
    JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
    WHERE t.company_id = v_company AND t.session_id = v_session AND ce.bsale_variant_id = 900002;
    v_ok := v_ok AND coalesce(v_eff, 0) = 7;
    v_report := v_report || 'E.aislacion: B=4, C=7 tras APPROVE A (B=' || (SELECT coalesce(sum(ce.physical_quantity),0) FROM inventarios.tasks t CROSS JOIN LATERAL inventarios.get_effective_task_contributions(v_company, v_session, t.id) g JOIN inventarios.count_entries ce ON ce.id=g.contribution_count_entry_id WHERE t.company_id=v_company AND t.session_id=v_session AND ce.bsale_variant_id=900001) || ', C=' || (SELECT coalesce(sum(ce.physical_quantity),0) FROM inventarios.tasks t CROSS JOIN LATERAL inventarios.get_effective_task_contributions(v_company, v_session, t.id) g JOIN inventarios.count_entries ce ON ce.id=g.contribution_count_entry_id WHERE t.company_id=v_company AND t.session_id=v_session AND ce.bsale_variant_id=900002) || '): ' || CASE WHEN v_ok THEN '[PASS]' ELSE '[FAIL]' END || E'\n';

    -- C. CANTIDAD 0 REEMPLAZA POSITIVA (B: 4 -> 0)
    PERFORM inventarios.resolve_inventory_audit_product(v_company, v_audit, v_ap_b, 'APPROVE', 'QA aprobacion B a 0', gen_random_uuid());
    SELECT pg_catalog.sum(ce.physical_quantity) INTO v_eff
    FROM inventarios.tasks t
    CROSS JOIN LATERAL inventarios.get_effective_task_contributions(v_company, v_session, t.id) g
    JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
    WHERE t.company_id = v_company AND t.session_id = v_session AND ce.bsale_variant_id = 900001;
    v_report := v_report || 'C.cantidad 0: efectivo B=' || coalesce(v_eff, 0) || ' (esperado 0): '
              || CASE WHEN coalesce(v_eff, 0) = 0 THEN '[PASS]' ELSE '[FAIL]' END || E'\n';

    -- D. REJECT PRODUCTO C conserva el fisico
    PERFORM inventarios.resolve_inventory_audit_product(v_company, v_audit, v_ap_c, 'REJECT', 'QA rechazo C', gen_random_uuid());
    SELECT pg_catalog.sum(ce.physical_quantity) INTO v_eff
    FROM inventarios.tasks t
    CROSS JOIN LATERAL inventarios.get_effective_task_contributions(v_company, v_session, t.id) g
    JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
    WHERE t.company_id = v_company AND t.session_id = v_session AND ce.bsale_variant_id = 900002;
    v_report := v_report || 'D.REJECT conserva: efectivo C=' || coalesce(v_eff, 0) || ' (esperado 7): '
              || CASE WHEN coalesce(v_eff, 0) = 7 THEN '[PASS]' ELSE '[FAIL]' END || E'\n';

    -- F. ESTADO PADRE con decisiones mixtas
    SELECT a.status INTO v_audit_status FROM inventarios.inventory_audits a WHERE a.id = v_audit;
    v_report := v_report || 'F.estado padre=' || v_audit_status || ' (esperado RESOLVED): '
              || CASE WHEN v_audit_status = 'RESOLVED' THEN '[PASS]' ELSE '[FAIL]' END || E'\n';

    -- K. SIN DOBLE CONTEO: overlay AUDIT fuera de get_effective_count_entries
    SELECT count(*) INTO v_ce_audit_rows FROM inventarios.get_effective_count_entries(v_company, v_session, NULL, NULL) ec
    JOIN inventarios.count_entries ce ON ce.id = ec.effective_count_entry_id
    WHERE ce.capture_source = 'AUDIT';
    v_report := v_report || 'K.sin doble conteo: raices AUDIT=' || v_ce_audit_rows || ' (esperado 0): '
              || CASE WHEN v_ce_audit_rows = 0 THEN '[PASS]' ELSE '[FAIL]' END || E'\n';

    -- I. SEGUNDA AUDITORIA reemplaza el AUDIT previo (A: 54 -> 60)
    INSERT INTO inventarios.inventory_audits (company_id, campaign_id, audit_number, status, assigned_participant_id, assigned_user_id, created_by, started_at, started_by, submitted_at, submitted_by)
    VALUES (v_company, v_campaign, 3, 'SUBMITTED', v_campaign_participant, v_admin, v_admin, v_now, v_admin, v_now, v_admin)
    RETURNING id INTO v_audit2;
    INSERT INTO inventarios.inventory_audit_products (company_id, campaign_id, audit_id, bsale_variant_id, product_id, sku, name, theoretical_quantity, physical_quantity, difference_quantity, variance_status, scope_status, status)
    VALUES (v_company, v_campaign, v_audit2, 746216, NULL, '746216', 'PRODUCTO A', 54, 54, 0, 'SIN_DIFERENCIA', 'LOCATIONS_RESOLVED', 'SUBMITTED') RETURNING id INTO v_ap2_a;
    INSERT INTO inventarios.inventory_audit_locations (company_id, audit_id, audit_product_id, session_id, snapshot_location_id, location_id, location_code, location_name)
    VALUES (v_company, v_audit2, v_ap2_a, v_session, v_sl1, v_loc1, 'QA-LOC-1', 'Ubicacion 1');
    INSERT INTO inventarios.inventory_audit_results (company_id, campaign_id, audit_id, audit_product_id, audit_location_id, bsale_variant_id, location_id, location_code, location_name, scanned_code, identification_method, physical_quantity, audited_by, captured_at, recorded_at, revision_number, created_by)
    SELECT v_company, v_campaign, v_audit2, v_ap2_a, al.id, 746216, v_loc1, 'QA-LOC-1', 'Ubicacion 1', '746216', 'BARCODE', 60, v_admin, v_now, v_now, 1, v_admin
    FROM inventarios.inventory_audit_locations al WHERE al.company_id = v_company AND al.audit_product_id = v_ap2_a;

    PERFORM inventarios.resolve_inventory_audit_product(v_company, v_audit2, v_ap2_a, 'APPROVE', 'QA segunda ronda A', gen_random_uuid());
    SELECT pg_catalog.sum(ce.physical_quantity) INTO v_eff
    FROM inventarios.tasks t
    CROSS JOIN LATERAL inventarios.get_effective_task_contributions(v_company, v_session, t.id) g
    JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
    WHERE t.company_id = v_company AND t.session_id = v_session AND ce.bsale_variant_id = 746216;
    v_report := v_report || 'I.segunda auditoria: efectivo A=' || coalesce(v_eff, 0) || ' (esperado 60, nunca 114): '
              || CASE WHEN coalesce(v_eff, 0) = 60 THEN '[PASS]' ELSE '[FAIL]' END || E'\n';

    -- L. CIERRE GLOBAL: no bloquea y terminaliza pendientes sin aplicar
    INSERT INTO inventarios.inventory_audits (company_id, campaign_id, audit_number, status, assigned_participant_id, assigned_user_id, created_by, started_at, started_by, submitted_at, submitted_by)
    VALUES (v_company, v_campaign, 4, 'SUBMITTED', v_campaign_participant, v_admin, v_admin, v_now, v_admin, v_now, v_admin)
    RETURNING id INTO v_audit4;
    INSERT INTO inventarios.inventory_audit_products (company_id, campaign_id, audit_id, bsale_variant_id, product_id, sku, name, theoretical_quantity, physical_quantity, difference_quantity, variance_status, scope_status, status)
    VALUES (v_company, v_campaign, v_audit4, 900004, NULL, '900004', 'PRODUCTO D PENDIENTE', 2, 2, 0, 'SIN_DIFERENCIA', 'LOCATIONS_RESOLVED', 'SUBMITTED') RETURNING id INTO v_ap4_d;

    UPDATE inventarios.inventory_campaigns c
    SET status = 'APPROVED', approved_at = v_now, approved_by = v_admin, updated_at = v_now, updated_by = v_admin
    WHERE c.company_id = v_company AND c.id = v_campaign;

    SELECT ap.status INTO v_audit_noctx_status FROM inventarios.inventory_audit_products ap WHERE ap.id = v_ap4_d;
    SELECT a.status INTO v_audit_status FROM inventarios.inventory_audits a WHERE a.id = v_audit4;
    v_report := v_report || 'L.cierre: producto D=' || v_audit_noctx_status || ' (esperado CANCELLED), auditoria #4=' || v_audit_status || ' (esperado CANCELLED): '
              || CASE WHEN v_audit_noctx_status = 'CANCELLED' AND v_audit_status = 'CANCELLED' THEN '[PASS]' ELSE '[FAIL]' END || E'\n';

    -- RESULTADO FINAL por variante (sin doble conteo)
    v_report := v_report || 'FINAL fisicos: A=' || (SELECT coalesce(sum(ce.physical_quantity),0) FROM inventarios.tasks t CROSS JOIN LATERAL inventarios.get_effective_task_contributions(v_company, v_session, t.id) g JOIN inventarios.count_entries ce ON ce.id=g.contribution_count_entry_id WHERE t.company_id=v_company AND t.session_id=v_session AND ce.bsale_variant_id=746216)
      || ' B=' || (SELECT coalesce(sum(ce.physical_quantity),0) FROM inventarios.tasks t CROSS JOIN LATERAL inventarios.get_effective_task_contributions(v_company, v_session, t.id) g JOIN inventarios.count_entries ce ON ce.id=g.contribution_count_entry_id WHERE t.company_id=v_company AND t.session_id=v_session AND ce.bsale_variant_id=900001)
      || ' C=' || (SELECT coalesce(sum(ce.physical_quantity),0) FROM inventarios.tasks t CROSS JOIN LATERAL inventarios.get_effective_task_contributions(v_company, v_session, t.id) g JOIN inventarios.count_entries ce ON ce.id=g.contribution_count_entry_id WHERE t.company_id=v_company AND t.session_id=v_session AND ce.bsale_variant_id=900002) || E'\n';

    RAISE EXCEPTION 'QA-AUDIT-RESOLUTION%', E'\n' || v_report;
END;
$$;
