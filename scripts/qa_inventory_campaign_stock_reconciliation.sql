-- QA transaccional del contrato campaign-level.
-- Ejecutar como SQL privilegiado con BEGIN/ROLLBACK. No inserta en Bsale ni Kardex.
BEGIN;

CREATE TEMP TABLE qa_campaign_reconciliation_results (
    scenario text PRIMARY KEY,
    result jsonb NOT NULL
) ON COMMIT DROP;

DO $$
DECLARE
    v_company uuid := 'd1000000-0000-0000-0000-000000000001';
    v_admin uuid := 'dc9be3b3-bf39-47b2-8ea3-fdd6aa9a4aaa';
    v_campaign uuid := gen_random_uuid();
    v_now timestamptz := clock_timestamp();
    v_run uuid;
    v_old_run uuid;
    v_ready_variant integer;
    v_duplicate_variant integer;
    v_mismatch_variant integer;
    v_recount_variant integer;
    v_ready_stock numeric;
    v_duplicate_stock numeric;
    v_mismatch_stock numeric;
    v_recount_stock numeric;
    v_logistics_product uuid;
    v_office integer := 1;
    v_second_office integer := 999999;
    v_warehouse uuid := 'e4fa8a09-c160-4574-af69-a44a41e5de9c';
    v_location_1 uuid := '6c5b3554-7085-44fe-af3b-380014f22025';
    v_location_2 uuid := '3082599f-cc33-4e75-9c14-8d9e6d1bb510';
    v_location_3 uuid := '29beff28-9678-4add-8188-186a1973fb3c';
    v_s1 uuid := gen_random_uuid(); v_s2 uuid := gen_random_uuid();
    v_s3 uuid := gen_random_uuid(); v_s4 uuid := gen_random_uuid();
    v_s5 uuid := gen_random_uuid(); v_s6 uuid := gen_random_uuid();
    v_s7 uuid := gen_random_uuid();
    v_snap1 uuid := gen_random_uuid(); v_snap2 uuid := gen_random_uuid();
    v_snap3 uuid := gen_random_uuid(); v_snap4 uuid := gen_random_uuid();
    v_snap5 uuid := gen_random_uuid(); v_snap6 uuid := gen_random_uuid();
    v_snap7 uuid := gen_random_uuid();
    v_p1 uuid := gen_random_uuid(); v_p2 uuid := gen_random_uuid();
    v_p3 uuid := gen_random_uuid(); v_p4 uuid := gen_random_uuid();
    v_p5 uuid := gen_random_uuid(); v_p6 uuid := gen_random_uuid();
    v_p7 uuid := gen_random_uuid(); v_p8 uuid := gen_random_uuid(); v_p9 uuid := gen_random_uuid();
    v_ov1 uuid := gen_random_uuid(); v_ov2 uuid := gen_random_uuid();
    v_ov3 uuid := gen_random_uuid(); v_ov4 uuid := gen_random_uuid();
    v_ov5 uuid := gen_random_uuid();
    v_refresh jsonb; v_summary jsonb; v_items jsonb; v_detail jsonb;
    v_recon uuid; v_item_id uuid;
    v_count integer;
BEGIN
    SELECT id INTO v_run
    FROM integraciones.bsale_sync_runs
    WHERE company_id = v_company AND status = 'COMPLETED'
    ORDER BY completed_at DESC NULLS LAST, started_at DESC NULLS LAST, id DESC LIMIT 1;
    SELECT id INTO v_old_run
    FROM integraciones.bsale_sync_runs
    WHERE company_id = v_company AND status = 'COMPLETED' AND id <> v_run
    ORDER BY completed_at DESC NULLS LAST, started_at DESC NULLS LAST, id DESC LIMIT 1;
    IF v_run IS NULL OR v_old_run IS NULL THEN
        RAISE EXCEPTION 'QA precondition: two completed Bsale runs are required';
    END IF;

    SELECT variant_id, sum(quantity) INTO v_ready_variant, v_ready_stock
    FROM integraciones.bsale_stock_current
    WHERE company_id = v_company AND bsale_sync_run_id = v_run AND office_id = v_office
    GROUP BY variant_id HAVING sum(quantity) >= 2 ORDER BY variant_id LIMIT 1;
    SELECT variant_id, sum(quantity) INTO v_duplicate_variant, v_duplicate_stock
    FROM integraciones.bsale_stock_current
    WHERE company_id = v_company AND bsale_sync_run_id = v_run AND office_id = v_office
      AND variant_id <> v_ready_variant AND quantity > 0
    GROUP BY variant_id ORDER BY variant_id LIMIT 1;
    SELECT variant_id, sum(quantity) INTO v_mismatch_variant, v_mismatch_stock
    FROM integraciones.bsale_stock_current
    WHERE company_id = v_company AND bsale_sync_run_id = v_run AND office_id = v_office
      AND variant_id NOT IN (v_ready_variant, v_duplicate_variant) AND quantity > 0
    GROUP BY variant_id ORDER BY variant_id LIMIT 1;
    SELECT variant_id, sum(quantity) INTO v_recount_variant, v_recount_stock
    FROM integraciones.bsale_stock_current
    WHERE company_id = v_company AND bsale_sync_run_id = v_run AND office_id = v_office
      AND variant_id NOT IN (v_ready_variant, v_duplicate_variant, v_mismatch_variant) AND quantity > 0
    GROUP BY variant_id ORDER BY variant_id LIMIT 1;
    IF v_ready_variant IS NULL OR v_duplicate_variant IS NULL OR v_mismatch_variant IS NULL OR v_recount_variant IS NULL THEN
        RAISE EXCEPTION 'QA precondition: four positive Bsale variants are required';
    END IF;
    SELECT p.id INTO v_logistics_product
    FROM adquisiciones.products p
    WHERE p.company_id = v_company
      AND NOT EXISTS (SELECT 1 FROM logistica.kardex_movements km WHERE km.company_id=v_company AND km.product_id=p.id)
    LIMIT 1;
    IF v_logistics_product IS NULL THEN RAISE EXCEPTION 'QA precondition: product without Kardex is required'; END IF;

    INSERT INTO inventarios.inventory_campaigns
        (id, company_id, name, campaign_type, status, planned_at, started_at, approved_at,
         site_scope, product_scope,
         approved_by, created_at, created_by, updated_at, updated_by)
    VALUES (v_campaign, v_company, 'QA campaign reconciliation ' || v_campaign, 'GENERAL',
            'APPROVED', v_now, v_now, v_now, 'ALL_INTERNAL', 'ALL', v_admin, v_now, v_admin, v_now, v_admin);

    -- Two approved sessions for one variant/office. Their physical stock is split
    -- across two locations and must aggregate without merging the lines.
    INSERT INTO inventarios.sessions
        (id, company_id, session_number, name, inventory_type, status, warehouse_id,
         bsale_office_id, scope_mode, responsible_user_id, campaign_id, prepared_at,
         started_at, reviewed_at, approved_at, approved_by, created_at, created_by,
         updated_at, updated_by, cancelled_at, cancelled_by, cancellation_reason)
    VALUES
      (v_s1, v_company, 990001, 'QA approved A', 'GENERAL', 'APPROVED', v_warehouse, v_office, 'GENERAL', v_admin, v_campaign, v_now, v_now, v_now, v_now, v_admin, v_now, v_admin, v_now, v_admin, NULL, NULL, NULL),
      (v_s2, v_company, 990002, 'QA approved B', 'GENERAL', 'APPROVED', v_warehouse, v_office, 'GENERAL', v_admin, v_campaign, v_now, v_now, v_now, v_now, v_admin, v_now, v_admin, v_now, v_admin, NULL, NULL, NULL),
      (v_s3, v_company, 990003, 'QA second office', 'GENERAL', 'APPROVED', v_warehouse, v_second_office, 'GENERAL', v_admin, v_campaign, v_now, v_now, v_now, v_now, v_admin, v_now, v_admin, v_now, v_admin, NULL, NULL, NULL),
      (v_s4, v_company, 990004, 'QA mismatch', 'GENERAL', 'APPROVED', v_warehouse, v_office, 'GENERAL', v_admin, v_campaign, v_now, v_now, v_now, v_now, v_admin, v_now, v_admin, v_now, v_admin, NULL, NULL, NULL),
      (v_s5, v_company, 990005, 'QA recount', 'GENERAL', 'APPROVED', v_warehouse, v_office, 'GENERAL', v_admin, v_campaign, v_now, v_now, v_now, v_now, v_admin, v_now, v_admin, v_now, v_admin, NULL, NULL, NULL),
      (v_s6, v_company, 990006, 'QA cancelled', 'GENERAL', 'CANCELLED', v_warehouse, v_office, 'GENERAL', v_admin, v_campaign, NULL, NULL, NULL, NULL, NULL, v_now, v_admin, v_now, v_admin, v_now, v_admin, 'QA cancellation'),
      (v_s7, v_company, 990007, 'QA invalid source', 'GENERAL', 'DRAFT', v_warehouse, v_office, 'GENERAL', v_admin, v_campaign, NULL, NULL, NULL, NULL, NULL, v_now, v_admin, v_now, v_admin, NULL, NULL, NULL);

    INSERT INTO inventarios.operational_snapshots
        (id, company_id, session_id, completion_status, captured_at, captured_by, created_at, created_by)
    VALUES (v_snap1, v_company, v_s1, 'PENDING', v_now, v_admin, v_now, v_admin),
           (v_snap2, v_company, v_s2, 'PENDING', v_now, v_admin, v_now, v_admin),
           (v_snap3, v_company, v_s3, 'PENDING', v_now, v_admin, v_now, v_admin),
           (v_snap4, v_company, v_s4, 'PENDING', v_now, v_admin, v_now, v_admin),
           (v_snap5, v_company, v_s5, 'PENDING', v_now, v_admin, v_now, v_admin),
           (v_snap6, v_company, v_s6, 'PENDING', v_now, v_admin, v_now, v_admin),
           (v_snap7, v_company, v_s7, 'PENDING', v_now, v_admin, v_now, v_admin);

    INSERT INTO inventarios.snapshot_locations
        (id, company_id, snapshot_id, location_id, warehouse_id, code, is_active, created_by)
    VALUES (gen_random_uuid(), v_company, v_snap1, v_location_1, v_warehouse, 'QA-L1', true, v_admin),
           (gen_random_uuid(), v_company, v_snap2, v_location_2, v_warehouse, 'QA-L2', true, v_admin),
           (gen_random_uuid(), v_company, v_snap3, v_location_3, v_warehouse, 'QA-L3', true, v_admin),
           (gen_random_uuid(), v_company, v_snap4, v_location_1, v_warehouse, 'QA-L4', true, v_admin),
           (gen_random_uuid(), v_company, v_snap4, v_location_2, v_warehouse, 'QA-L4-M', true, v_admin),
           (gen_random_uuid(), v_company, v_snap5, v_location_2, v_warehouse, 'QA-L5', true, v_admin),
           (gen_random_uuid(), v_company, v_snap5, v_location_1, v_warehouse, 'QA-L5-DUP', true, v_admin);

    INSERT INTO inventarios.snapshot_products (id, company_id, snapshot_id, product_id, bsale_variant_id, sku, name, created_by)
    VALUES (v_p1, v_company, v_snap1, v_logistics_product, v_ready_variant, 'QA-READY-A', 'QA READY A', v_admin),
           (v_p2, v_company, v_snap2, v_logistics_product, v_ready_variant, 'QA-READY-B', 'QA READY B', v_admin),
           (v_p3, v_company, v_snap3, v_logistics_product, v_ready_variant, 'QA-OFFICE-2', 'QA OFFICE 2', v_admin),
           (v_p4, v_company, v_snap4, v_logistics_product, v_duplicate_variant, 'QA-DUPLICATE', 'QA DUPLICATE', v_admin),
           (v_p9, v_company, v_snap4, NULL, v_mismatch_variant, 'QA-MISMATCH', 'QA MISMATCH', v_admin),
           (v_p5, v_company, v_snap5, v_logistics_product, v_recount_variant, 'QA-RECOUNT', 'QA RECOUNT', v_admin),
           (v_p8, v_company, v_snap5, NULL, v_duplicate_variant, 'QA-DUPLICATE-2', 'QA DUPLICATE 2', v_admin),
           (v_p6, v_company, v_snap6, NULL, v_mismatch_variant, 'QA-CANCELLED', 'QA CANCELLED', v_admin),
           (v_p7, v_company, v_snap7, v_logistics_product, 999999937, 'QA-INVALID', 'QA INVALID', v_admin);

    -- Official versions and lines are fixture data, not an application path.
    SET LOCAL session_replication_role = replica;
    INSERT INTO inventarios.official_versions
        (id, company_id, session_id, snapshot_id, version_number, task_count, contribution_count,
         normal_contribution_count, recount_contribution_count, item_count, approved_at, approved_by, created_at, created_by)
    VALUES (v_ov1, v_company, v_s1, v_snap1, 1, 1, 1, 1, 0, 1, v_now, v_admin, v_now, v_admin),
           (v_ov2, v_company, v_s2, v_snap2, 1, 1, 1, 1, 0, 1, v_now, v_admin, v_now, v_admin),
           (v_ov3, v_company, v_s3, v_snap3, 1, 1, 1, 1, 0, 1, v_now, v_admin, v_now, v_admin),
           (v_ov4, v_company, v_s4, v_snap4, 1, 1, 1, 1, 0, 2, v_now, v_admin, v_now, v_admin),
           (v_ov5, v_company, v_s5, v_snap5, 1, 1, 1, 0, 1, 2, v_now, v_admin, v_now, v_admin);
    INSERT INTO inventarios.official_version_items
        (company_id, official_version_id, session_id, snapshot_id, snapshot_product_id, bsale_variant_id,
         available_quantity, damaged_quantity, expired_quantity, blocked_quantity, other_unavailable_quantity,
         physical_quantity, contribution_count, normal_contribution_count, recount_contribution_count,
         contribution_manifest, location_resolution_status, created_at, created_by)
    VALUES
      (v_company, v_ov1, v_s1, v_snap1, v_p1, v_ready_variant, 1,0,0,0,0, 1,1,1,0,'[]','RESOLVED',v_now,v_admin),
      (v_company, v_ov2, v_s2, v_snap2, v_p2, v_ready_variant, v_ready_stock-1,0,0,0,0, v_ready_stock-1,1,1,0,'[]','RESOLVED',v_now,v_admin),
      (v_company, v_ov3, v_s3, v_snap3, v_p3, v_ready_variant, 1,0,0,0,0, 1,1,1,0,'[]','RESOLVED',v_now,v_admin),
      (v_company, v_ov4, v_s4, v_snap4, v_p4, v_duplicate_variant, v_duplicate_stock,0,0,0,0, v_duplicate_stock,1,1,0,'[]','RESOLVED',v_now,v_admin),
      (v_company, v_ov4, v_s4, v_snap4, v_p9, v_mismatch_variant, v_mismatch_stock+1,0,0,0,0, v_mismatch_stock+1,1,1,0,'[]','RESOLVED',v_now,v_admin),
      (v_company, v_ov5, v_s5, v_snap5, v_p5, v_recount_variant, v_recount_stock,0,0,0,0, v_recount_stock,1,0,1,'[]','UNRESOLVED_RECOUNT',v_now,v_admin),
      (v_company, v_ov5, v_s5, v_snap5, v_p8, v_duplicate_variant, v_duplicate_stock,0,0,0,0, v_duplicate_stock,1,1,0,'[]','RESOLVED',v_now,v_admin);
    INSERT INTO inventarios.official_version_location_items
        (company_id, official_version_id, session_id, snapshot_id, snapshot_product_id, snapshot_location_id,
         theoretical_quantity, available_quantity, damaged_quantity, expired_quantity, blocked_quantity,
         other_unavailable_quantity, physical_quantity, valuation_status, created_by)
    SELECT v_company, x.ov, x.sid, x.snap, x.pid, sl.id, x.qty, x.qty, 0,0,0,0,x.qty,'NOT_APPLICABLE',v_admin
    FROM (VALUES
      (v_ov1,v_s1,v_snap1,v_p1,1::numeric,v_location_1),
      (v_ov2,v_s2,v_snap2,v_p2,(v_ready_stock-1),v_location_2),
      (v_ov3,v_s3,v_snap3,v_p3,1::numeric,v_location_3),
      (v_ov4,v_s4,v_snap4,v_p4,v_duplicate_stock,v_location_1),
      (v_ov4,v_s4,v_snap4,v_p9,v_mismatch_stock+1,v_location_2),
      (v_ov5,v_s5,v_snap5,v_p5,v_recount_stock,v_location_2),
      (v_ov5,v_s5,v_snap5,v_p8,v_duplicate_stock,v_location_1)
    ) x(ov,sid,snap,pid,qty,location_id)
    JOIN inventarios.snapshot_locations sl ON sl.company_id=v_company AND sl.snapshot_id=x.snap AND sl.location_id=x.location_id;
    INSERT INTO inventarios.session_product_scopes
        (company_id, session_id, bsale_variant_id, inclusion_type, created_at, created_by)
    VALUES (v_company, v_s7, 999999937, 'INCLUDED', v_now, v_admin);
    SET LOCAL session_replication_role = origin;

    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin::text)::text, true);
    SELECT inventarios.refresh_inventory_campaign_stock_reconciliation(v_company, v_campaign) INTO v_refresh;
    SELECT inventarios.get_inventory_campaign_stock_reconciliation_summary(v_company, v_campaign) INTO v_summary;
    INSERT INTO qa_campaign_reconciliation_results VALUES ('summary_initial', v_summary || jsonb_build_object('refresh', v_refresh));

    SELECT count(*) INTO v_count FROM inventarios.inventory_campaign_reconciliations WHERE company_id=v_company AND campaign_id=v_campaign;
    IF v_count <> 1 THEN RAISE EXCEPTION 'campaign reconciliation cardinality FAILED'; END IF;
    SELECT count(*) INTO v_count FROM inventarios.inventory_campaign_reconciliation_sources src JOIN inventarios.sessions s ON s.id=src.session_id WHERE src.reconciliation_id=(v_refresh->>'reconciliation_id')::uuid;
    IF v_count <> 7 THEN RAISE EXCEPTION 'source cardinality FAILED: %', v_count; END IF;

    SELECT id INTO v_recon FROM inventarios.inventory_campaign_reconciliations WHERE company_id=v_company AND campaign_id=v_campaign;
    SELECT jsonb_agg(to_jsonb(i) ORDER BY i.bsale_variant_id, i.bsale_office_id) INTO v_items FROM inventarios.inventory_campaign_reconciliation_items i WHERE i.reconciliation_id=v_recon;
    INSERT INTO qa_campaign_reconciliation_results VALUES ('items_initial', coalesce(v_items,'[]'::jsonb));

    IF NOT EXISTS (SELECT 1 FROM inventarios.inventory_campaign_reconciliation_items WHERE reconciliation_id=v_recon AND bsale_variant_id=v_ready_variant AND bsale_office_id=v_office AND physical_quantity=v_ready_stock AND reconciliation_status='READY') THEN RAISE EXCEPTION 'aggregate READY FAILED'; END IF;
    IF (SELECT count(*) FROM inventarios.inventory_campaign_reconciliation_lines l JOIN inventarios.inventory_campaign_reconciliation_items i ON i.id=l.reconciliation_item_id WHERE i.reconciliation_id=v_recon AND i.bsale_variant_id=v_ready_variant AND i.bsale_office_id=v_office) <> 2 THEN RAISE EXCEPTION 'separate locations FAILED'; END IF;
    IF (SELECT count(*) FROM inventarios.inventory_campaign_reconciliation_items WHERE reconciliation_id=v_recon AND bsale_variant_id=v_ready_variant) <> 2 THEN RAISE EXCEPTION 'two offices independence FAILED'; END IF;
    IF NOT EXISTS (SELECT 1 FROM inventarios.inventory_campaign_reconciliation_sources WHERE reconciliation_id=v_recon AND session_id=v_s6 AND source_status='CANCELLED_EXCLUDED') THEN RAISE EXCEPTION 'cancelled traceability FAILED'; END IF;
    IF EXISTS (SELECT 1 FROM inventarios.inventory_campaign_reconciliation_items i JOIN inventarios.official_version_items oi ON oi.bsale_variant_id=i.bsale_variant_id WHERE i.reconciliation_id=v_recon AND oi.session_id=v_s6) THEN RAISE EXCEPTION 'cancelled physical contribution FAILED'; END IF;
    IF NOT EXISTS (SELECT 1 FROM inventarios.inventory_campaign_reconciliation_items WHERE reconciliation_id=v_recon AND bsale_variant_id=999999937 AND bsale_quantity IS NULL AND 'BSALE_STOCK_UNAVAILABLE'=ANY(logistics_block_reasons)) THEN RAISE EXCEPTION 'unavailable stock FAILED'; END IF;
    IF NOT EXISTS (SELECT 1 FROM inventarios.inventory_campaign_reconciliation_items WHERE reconciliation_id=v_recon AND bsale_variant_id=v_mismatch_variant AND reconciliation_status='MISMATCH') THEN RAISE EXCEPTION 'mismatch FAILED'; END IF;
    IF NOT EXISTS (SELECT 1 FROM inventarios.inventory_campaign_reconciliation_items WHERE reconciliation_id=v_recon AND bsale_variant_id=v_recount_variant AND 'UNRESOLVED_RECOUNT'=ANY(logistics_block_reasons)) THEN RAISE EXCEPTION 'recount guard FAILED'; END IF;
    IF NOT EXISTS (SELECT 1 FROM inventarios.inventory_campaign_reconciliation_items WHERE reconciliation_id=v_recon AND bsale_variant_id=v_duplicate_variant AND 'DUPLICATE_LOGISTICS_LOCATION'=ANY(logistics_block_reasons)) THEN RAISE EXCEPTION 'duplicate location guard FAILED'; END IF;
    IF NOT EXISTS (SELECT 1 FROM inventarios.inventory_campaign_reconciliation_items WHERE reconciliation_id=v_recon AND bsale_variant_id=999999937 AND reconciliation_status='BLOCKED') THEN RAISE EXCEPTION 'invalid source scope FAILED'; END IF;
    SELECT id INTO v_item_id FROM inventarios.inventory_campaign_reconciliation_items
    WHERE reconciliation_id=v_recon AND bsale_variant_id=v_ready_variant AND bsale_office_id=v_office;
    SELECT inventarios.get_inventory_campaign_stock_reconciliation_item_detail(v_company, v_campaign, v_item_id) INTO v_detail;
    IF jsonb_array_length(v_detail->'lines') <> 2 OR jsonb_array_length(v_detail->'sources') <> 2 THEN RAISE EXCEPTION 'detail contract FAILED'; END IF;
    INSERT INTO qa_campaign_reconciliation_results VALUES ('detail_contract', jsonb_build_object('source_count',2,'line_count',2));

    PERFORM inventarios.refresh_inventory_campaign_stock_reconciliation(v_company, v_campaign);
    SELECT count(*) INTO v_count FROM inventarios.inventory_campaign_reconciliation_sources WHERE reconciliation_id=v_recon;
    IF v_count <> 7 THEN RAISE EXCEPTION 'refresh sources duplication FAILED'; END IF;
    SELECT count(*) INTO v_count FROM inventarios.inventory_campaign_reconciliation_items WHERE reconciliation_id=v_recon;
    IF v_count <> 6 THEN RAISE EXCEPTION 'refresh items duplication FAILED: %', v_count; END IF;
    INSERT INTO qa_campaign_reconciliation_results VALUES ('refresh_idempotency', jsonb_build_object('sources',7,'items',v_count));

    -- A later completed run makes non-applied items stale in read RPCs.
    SELECT id INTO v_item_id FROM inventarios.inventory_campaign_reconciliation_items WHERE reconciliation_id=v_recon AND reconciliation_status <> 'APPLIED' LIMIT 1;
    SELECT inventarios.get_inventory_campaign_stock_reconciliation_summary(v_company, v_campaign) INTO v_summary;
    IF (v_summary->>'stale_count')::integer <> 0 THEN RAISE EXCEPTION 'unexpected initial stale count'; END IF;
    UPDATE inventarios.inventory_campaign_reconciliations SET latest_bsale_sync_run_id=v_old_run WHERE id=v_recon;
    UPDATE inventarios.inventory_campaign_reconciliation_items
    SET bsale_sync_run_id=v_old_run
    WHERE reconciliation_id=v_recon AND reconciliation_status <> 'APPLIED';
    SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.bsale_variant_id, x.bsale_office_id), '[]'::jsonb)
    INTO v_items
    FROM inventarios.list_inventory_campaign_stock_reconciliation_items(v_company, v_campaign) x;
    SELECT inventarios.get_inventory_campaign_stock_reconciliation_summary(v_company, v_campaign) INTO v_summary;
    IF (v_summary->>'stale_count')::integer <> (SELECT count(*) FROM inventarios.inventory_campaign_reconciliation_items WHERE reconciliation_id=v_recon) THEN RAISE EXCEPTION 'stale summary FAILED'; END IF;
    INSERT INTO qa_campaign_reconciliation_results VALUES ('stale_read', coalesce(v_items,'[]'::jsonb));
    PERFORM inventarios.refresh_inventory_campaign_stock_reconciliation(v_company, v_campaign);
    SELECT inventarios.get_inventory_campaign_stock_reconciliation_summary(v_company, v_campaign) INTO v_summary;
    IF (v_summary->>'stale_count')::integer <> 0 THEN RAISE EXCEPTION 'stale revalidation FAILED'; END IF;
    SELECT count(*) INTO v_count
    FROM inventarios.inventory_campaign_reconciliation_lines l
    JOIN inventarios.inventory_campaign_reconciliation_items i ON i.id=l.reconciliation_item_id
    WHERE i.reconciliation_id=v_recon;
    IF v_count <> 7 THEN RAISE EXCEPTION 'refresh lines duplication FAILED: %', v_count; END IF;
    INSERT INTO qa_campaign_reconciliation_results VALUES ('stale_revalidation', jsonb_build_object('stale_count',0,'line_count',v_count));
END;
$$;

SELECT scenario, result FROM qa_campaign_reconciliation_results ORDER BY scenario;
ROLLBACK;
