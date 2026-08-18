-- QA transaccional campaign-level -> Kardex.
-- Todas las fixtures, incluidos movimientos Kardex, revierten al final.
-- No inserta, actualiza ni elimina datos de Bsale.
BEGIN;

CREATE TEMP TABLE qa_campaign_apply_results (scenario text PRIMARY KEY, result jsonb) ON COMMIT DROP;

DO $$
DECLARE
    v_company uuid := 'd1000000-0000-0000-0000-000000000001';
    v_admin uuid := 'dc9be3b3-bf39-47b2-8ea3-fdd6aa9a4aaa';
    v_campaign uuid := gen_random_uuid();
    v_now timestamptz := clock_timestamp();
    v_run uuid; v_old_run uuid;
    v_multi_variant integer; v_positive_variant integer; v_negative_variant integer;
    v_noop_variant integer; v_stale_variant integer; v_blocked_variant integer; v_mismatch_variant integer;
    v_multi_q numeric; v_positive_q numeric; v_negative_q numeric; v_noop_q numeric; v_stale_q numeric; v_blocked_q numeric; v_mismatch_q numeric;
    v_warehouse_1 uuid := 'e4fa8a09-c160-4574-af69-a44a41e5de9c';
    v_warehouse_2 uuid := 'a876ae56-223f-461c-ab9a-41dfe3460aa2';
    v_location_1 uuid := '6c5b3554-7085-44fe-af3b-380014f22025';
    v_location_2 uuid := 'fbe936fd-bcee-4f85-9ed6-437e2fe440c6';
    v_campaign_recon uuid; v_app_id uuid; v_key uuid := gen_random_uuid();
    v_response jsonb; v_replay jsonb; v_item_ids uuid[];
    v_products uuid[]; v_p1 uuid; v_p2 uuid; v_p3 uuid; v_p4 uuid; v_p5 uuid; v_p6 uuid; v_p7 uuid;
    v_s1 uuid := gen_random_uuid(); v_s2 uuid := gen_random_uuid(); v_s3 uuid := gen_random_uuid();
    v_s4 uuid := gen_random_uuid(); v_s5 uuid := gen_random_uuid(); v_s6 uuid := gen_random_uuid(); v_s7 uuid := gen_random_uuid();
    v_snap1 uuid := gen_random_uuid(); v_snap2 uuid := gen_random_uuid(); v_snap3 uuid := gen_random_uuid();
    v_snap4 uuid := gen_random_uuid(); v_snap5 uuid := gen_random_uuid(); v_snap6 uuid := gen_random_uuid(); v_snap7 uuid := gen_random_uuid();
    v_sl1 uuid := gen_random_uuid(); v_sl2 uuid := gen_random_uuid(); v_sl3 uuid := gen_random_uuid();
    v_sl4 uuid := gen_random_uuid(); v_sl5 uuid := gen_random_uuid(); v_sl6 uuid := gen_random_uuid(); v_sl7 uuid := gen_random_uuid();
    v_sp1 uuid := gen_random_uuid(); v_sp2 uuid := gen_random_uuid(); v_sp3 uuid := gen_random_uuid();
    v_sp4 uuid := gen_random_uuid(); v_sp5 uuid := gen_random_uuid(); v_sp6 uuid := gen_random_uuid(); v_sp7 uuid := gen_random_uuid(); v_sp8 uuid := gen_random_uuid();
    v_ov1 uuid := gen_random_uuid(); v_ov2 uuid := gen_random_uuid(); v_ov3 uuid := gen_random_uuid();
    v_ov4 uuid := gen_random_uuid(); v_ov5 uuid := gen_random_uuid(); v_ov6 uuid := gen_random_uuid(); v_ov7 uuid := gen_random_uuid();
    v_initial_kardex bigint; v_final_kardex bigint; v_count bigint; v_failed bigint;
    v_bsale_rows bigint; v_bsale_quantity numeric; v_bsale_fingerprint text; v_bsale_fingerprint_after text;
    v_balance numeric; v_detail jsonb;
BEGIN
    SELECT id INTO v_run FROM integraciones.bsale_sync_runs WHERE company_id=v_company AND status='COMPLETED'
    ORDER BY completed_at DESC NULLS LAST, started_at DESC NULLS LAST, id DESC LIMIT 1;
    SELECT id INTO v_old_run FROM integraciones.bsale_sync_runs WHERE company_id=v_company AND status='COMPLETED' AND id<>v_run
    ORDER BY completed_at DESC NULLS LAST, started_at DESC NULLS LAST, id DESC LIMIT 1;
    IF v_run IS NULL OR v_old_run IS NULL THEN RAISE EXCEPTION 'QA requires two completed Bsale runs'; END IF;

    SELECT variant_id, sum(quantity) INTO v_multi_variant, v_multi_q FROM integraciones.bsale_stock_current
    WHERE company_id=v_company AND bsale_sync_run_id=v_run GROUP BY variant_id HAVING sum(quantity)>=2 ORDER BY variant_id LIMIT 1;
    SELECT variant_id, sum(quantity) INTO v_positive_variant, v_positive_q FROM integraciones.bsale_stock_current
    WHERE company_id=v_company AND bsale_sync_run_id=v_run AND variant_id<>v_multi_variant GROUP BY variant_id HAVING sum(quantity)>=2 ORDER BY variant_id LIMIT 1;
    SELECT variant_id, sum(quantity) INTO v_negative_variant, v_negative_q FROM integraciones.bsale_stock_current
    WHERE company_id=v_company AND bsale_sync_run_id=v_run AND variant_id NOT IN (v_multi_variant,v_positive_variant) GROUP BY variant_id HAVING sum(quantity)>0 ORDER BY variant_id LIMIT 1;
    SELECT variant_id, sum(quantity) INTO v_noop_variant, v_noop_q FROM integraciones.bsale_stock_current
    WHERE company_id=v_company AND bsale_sync_run_id=v_run AND variant_id NOT IN (v_multi_variant,v_positive_variant,v_negative_variant) GROUP BY variant_id HAVING sum(quantity)>0 ORDER BY variant_id LIMIT 1;
    SELECT variant_id, sum(quantity) INTO v_stale_variant, v_stale_q FROM integraciones.bsale_stock_current
    WHERE company_id=v_company AND bsale_sync_run_id=v_run AND variant_id NOT IN (v_multi_variant,v_positive_variant,v_negative_variant,v_noop_variant) GROUP BY variant_id HAVING sum(quantity)>0 ORDER BY variant_id LIMIT 1;
    SELECT variant_id, sum(quantity) INTO v_blocked_variant, v_blocked_q FROM integraciones.bsale_stock_current
    WHERE company_id=v_company AND bsale_sync_run_id=v_run AND variant_id NOT IN (v_multi_variant,v_positive_variant,v_negative_variant,v_noop_variant,v_stale_variant) GROUP BY variant_id HAVING sum(quantity)>0 ORDER BY variant_id LIMIT 1;
    SELECT variant_id, sum(quantity) INTO v_mismatch_variant, v_mismatch_q FROM integraciones.bsale_stock_current
    WHERE company_id=v_company AND bsale_sync_run_id=v_run AND variant_id NOT IN (v_multi_variant,v_positive_variant,v_negative_variant,v_noop_variant,v_stale_variant,v_blocked_variant) GROUP BY variant_id HAVING sum(quantity)>0 ORDER BY variant_id LIMIT 1;
    IF v_multi_variant IS NULL OR v_positive_variant IS NULL OR v_negative_variant IS NULL OR v_noop_variant IS NULL OR v_stale_variant IS NULL OR v_blocked_variant IS NULL OR v_mismatch_variant IS NULL THEN
        RAISE EXCEPTION 'QA requires seven positive Bsale variants';
    END IF;
    SELECT count(*), coalesce(sum(quantity),0), md5(coalesce(string_agg(id::text || ':' || coalesce(quantity,0)::text, ',' ORDER BY id),''))
    INTO v_bsale_rows, v_bsale_quantity, v_bsale_fingerprint
    FROM integraciones.bsale_stock_current WHERE company_id=v_company;
    SELECT array_agg(id ORDER BY id) INTO v_products FROM (
        SELECT p.id FROM adquisiciones.products p
        WHERE p.company_id=v_company AND NOT EXISTS (SELECT 1 FROM logistica.kardex_movements km WHERE km.company_id=v_company AND km.product_id=p.id)
        LIMIT 7
    ) x;
    IF cardinality(v_products) <> 7 THEN RAISE EXCEPTION 'QA requires seven products without Kardex'; END IF;
    v_p1:=v_products[1]; v_p2:=v_products[2]; v_p3:=v_products[3]; v_p4:=v_products[4]; v_p5:=v_products[5]; v_p6:=v_products[6]; v_p7:=v_products[7];

    INSERT INTO inventarios.inventory_campaigns
        (id,company_id,name,campaign_type,status,planned_at,started_at,approved_at,site_scope,product_scope,approved_by,created_at,created_by,updated_at,updated_by)
    VALUES (v_campaign,v_company,'QA campaign logistics apply '||v_campaign,'GENERAL','APPROVED',v_now,v_now,v_now,'ALL_INTERNAL','ALL',v_admin,v_now,v_admin,v_now,v_admin);
    INSERT INTO inventarios.sessions
        (id,company_id,session_number,name,inventory_type,status,warehouse_id,bsale_office_id,scope_mode,responsible_user_id,campaign_id,prepared_at,started_at,reviewed_at,approved_at,approved_by,created_at,created_by,updated_at,updated_by)
    VALUES
      (v_s1,v_company,991001,'QA multi warehouse 1','GENERAL','APPROVED',v_warehouse_1,1,'GENERAL',v_admin,v_campaign,v_now,v_now,v_now,v_now,v_admin,v_now,v_admin,v_now,v_admin),
      (v_s2,v_company,991002,'QA multi warehouse 2','GENERAL','APPROVED',v_warehouse_2,1,'GENERAL',v_admin,v_campaign,v_now,v_now,v_now,v_now,v_admin,v_now,v_admin,v_now,v_admin),
      (v_s3,v_company,991003,'QA positive','GENERAL','APPROVED',v_warehouse_1,1,'GENERAL',v_admin,v_campaign,v_now,v_now,v_now,v_now,v_admin,v_now,v_admin,v_now,v_admin),
      (v_s4,v_company,991004,'QA negative','GENERAL','APPROVED',v_warehouse_1,1,'GENERAL',v_admin,v_campaign,v_now,v_now,v_now,v_now,v_admin,v_now,v_admin,v_now,v_admin),
      (v_s5,v_company,991005,'QA noop','GENERAL','APPROVED',v_warehouse_1,1,'GENERAL',v_admin,v_campaign,v_now,v_now,v_now,v_now,v_admin,v_now,v_admin,v_now,v_admin),
      (v_s6,v_company,991006,'QA stale','GENERAL','APPROVED',v_warehouse_1,1,'GENERAL',v_admin,v_campaign,v_now,v_now,v_now,v_now,v_admin,v_now,v_admin,v_now,v_admin),
      (v_s7,v_company,991007,'QA blocked and mismatch','GENERAL','APPROVED',v_warehouse_1,1,'GENERAL',v_admin,v_campaign,v_now,v_now,v_now,v_now,v_admin,v_now,v_admin,v_now,v_admin);
    INSERT INTO inventarios.operational_snapshots (id,company_id,session_id,completion_status,captured_at,captured_by,created_at,created_by)
    VALUES (v_snap1,v_company,v_s1,'PENDING',v_now,v_admin,v_now,v_admin),(v_snap2,v_company,v_s2,'PENDING',v_now,v_admin,v_now,v_admin),(v_snap3,v_company,v_s3,'PENDING',v_now,v_admin,v_now,v_admin),(v_snap4,v_company,v_s4,'PENDING',v_now,v_admin,v_now,v_admin),(v_snap5,v_company,v_s5,'PENDING',v_now,v_admin,v_now,v_admin),(v_snap6,v_company,v_s6,'PENDING',v_now,v_admin,v_now,v_admin),(v_snap7,v_company,v_s7,'PENDING',v_now,v_admin,v_now,v_admin);
    INSERT INTO inventarios.snapshot_locations (id,company_id,snapshot_id,location_id,warehouse_id,code,is_active,created_by)
    VALUES (v_sl1,v_company,v_snap1,v_location_1,v_warehouse_1,'QA-CAL1',true,v_admin),(v_sl2,v_company,v_snap2,v_location_2,v_warehouse_2,'QA-CAL2',true,v_admin),(v_sl3,v_company,v_snap3,v_location_1,v_warehouse_1,'QA-POS',true,v_admin),(v_sl4,v_company,v_snap4,v_location_1,v_warehouse_1,'QA-NEG',true,v_admin),(v_sl5,v_company,v_snap5,v_location_1,v_warehouse_1,'QA-NOP',true,v_admin),(v_sl6,v_company,v_snap6,v_location_1,v_warehouse_1,'QA-STALE',true,v_admin),(v_sl7,v_company,v_snap7,v_location_1,v_warehouse_1,'QA-BLOCK',true,v_admin);
    INSERT INTO inventarios.snapshot_products (id,company_id,snapshot_id,product_id,bsale_variant_id,sku,name,created_by)
    VALUES (v_sp1,v_company,v_snap1,v_p1,v_multi_variant,'QA-CAL1','QA',v_admin),(v_sp2,v_company,v_snap2,v_p1,v_multi_variant,'QA-CAL2','QA',v_admin),(v_sp3,v_company,v_snap3,v_p2,v_positive_variant,'QA-POS','QA',v_admin),(v_sp4,v_company,v_snap4,v_p3,v_negative_variant,'QA-NEG','QA',v_admin),(v_sp5,v_company,v_snap5,v_p4,v_noop_variant,'QA-NOP','QA',v_admin),(v_sp6,v_company,v_snap6,v_p5,v_stale_variant,'QA-STALE','QA',v_admin),(v_sp7,v_company,v_snap7,v_p6,v_blocked_variant,'QA-BLOCK','QA',v_admin),(v_sp8,v_company,v_snap7,NULL,v_mismatch_variant,'QA-MISMATCH','QA',v_admin);
    SET LOCAL session_replication_role=replica;
    INSERT INTO inventarios.official_versions (id,company_id,session_id,snapshot_id,version_number,task_count,contribution_count,normal_contribution_count,recount_contribution_count,item_count,approved_at,approved_by,created_at,created_by)
    VALUES (v_ov1,v_company,v_s1,v_snap1,1,1,1,1,0,1,v_now,v_admin,v_now,v_admin),(v_ov2,v_company,v_s2,v_snap2,1,1,1,1,0,1,v_now,v_admin,v_now,v_admin),(v_ov3,v_company,v_s3,v_snap3,1,1,1,1,0,1,v_now,v_admin,v_now,v_admin),(v_ov4,v_company,v_s4,v_snap4,1,1,1,1,0,1,v_now,v_admin,v_now,v_admin),(v_ov5,v_company,v_s5,v_snap5,1,1,1,1,0,1,v_now,v_admin,v_now,v_admin),(v_ov6,v_company,v_s6,v_snap6,1,1,1,1,0,1,v_now,v_admin,v_now,v_admin),(v_ov7,v_company,v_s7,v_snap7,1,1,1,1,0,2,v_now,v_admin,v_now,v_admin);
    INSERT INTO inventarios.official_version_items (company_id,official_version_id,session_id,snapshot_id,snapshot_product_id,bsale_variant_id,available_quantity,damaged_quantity,expired_quantity,blocked_quantity,other_unavailable_quantity,physical_quantity,contribution_count,normal_contribution_count,recount_contribution_count,contribution_manifest,location_resolution_status,created_at,created_by)
    VALUES (v_company,v_ov1,v_s1,v_snap1,v_sp1,v_multi_variant,1,0,0,0,0,1,1,1,0,'[]','RESOLVED',v_now,v_admin),(v_company,v_ov2,v_s2,v_snap2,v_sp2,v_multi_variant,v_multi_q-1,0,0,0,0,v_multi_q-1,1,1,0,'[]','RESOLVED',v_now,v_admin),(v_company,v_ov3,v_s3,v_snap3,v_sp3,v_positive_variant,v_positive_q,0,0,0,0,v_positive_q,1,1,0,'[]','RESOLVED',v_now,v_admin),(v_company,v_ov4,v_s4,v_snap4,v_sp4,v_negative_variant,v_negative_q,0,0,0,0,v_negative_q,1,1,0,'[]','RESOLVED',v_now,v_admin),(v_company,v_ov5,v_s5,v_snap5,v_sp5,v_noop_variant,v_noop_q,0,0,0,0,v_noop_q,1,1,0,'[]','RESOLVED',v_now,v_admin),(v_company,v_ov6,v_s6,v_snap6,v_sp6,v_stale_variant,v_stale_q,0,0,0,0,v_stale_q,1,1,0,'[]','RESOLVED',v_now,v_admin),(v_company,v_ov7,v_s7,v_snap7,v_sp7,v_blocked_variant,v_blocked_q,0,0,0,0,v_blocked_q,1,1,0,'[]','UNRESOLVED_RECOUNT',v_now,v_admin),(v_company,v_ov7,v_s7,v_snap7,v_sp8,v_mismatch_variant,v_mismatch_q+1,0,0,0,0,v_mismatch_q+1,1,1,0,'[]','RESOLVED',v_now,v_admin);
    INSERT INTO inventarios.official_version_location_items (company_id,official_version_id,session_id,snapshot_id,snapshot_product_id,snapshot_location_id,theoretical_quantity,available_quantity,damaged_quantity,expired_quantity,blocked_quantity,other_unavailable_quantity,physical_quantity,valuation_status,created_by)
    VALUES (v_company,v_ov1,v_s1,v_snap1,v_sp1,v_sl1,1,1,0,0,0,0,1,'NOT_APPLICABLE',v_admin),(v_company,v_ov2,v_s2,v_snap2,v_sp2,v_sl2,v_multi_q-1,v_multi_q-1,0,0,0,0,v_multi_q-1,'NOT_APPLICABLE',v_admin),(v_company,v_ov3,v_s3,v_snap3,v_sp3,v_sl3,v_positive_q,v_positive_q,0,0,0,0,v_positive_q,'NOT_APPLICABLE',v_admin),(v_company,v_ov4,v_s4,v_snap4,v_sp4,v_sl4,v_negative_q,v_negative_q,0,0,0,0,v_negative_q,'NOT_APPLICABLE',v_admin),(v_company,v_ov5,v_s5,v_snap5,v_sp5,v_sl5,v_noop_q,v_noop_q,0,0,0,0,v_noop_q,'NOT_APPLICABLE',v_admin),(v_company,v_ov6,v_s6,v_snap6,v_sp6,v_sl6,v_stale_q,v_stale_q,0,0,0,0,v_stale_q,'NOT_APPLICABLE',v_admin),(v_company,v_ov7,v_s7,v_snap7,v_sp7,v_sl7,v_blocked_q,v_blocked_q,0,0,0,0,v_blocked_q,'NOT_APPLICABLE',v_admin),(v_company,v_ov7,v_s7,v_snap7,v_sp8,v_sl7,v_mismatch_q+1,v_mismatch_q+1,0,0,0,0,v_mismatch_q+1,'NOT_APPLICABLE',v_admin);
    SET LOCAL session_replication_role=origin;
    INSERT INTO logistica.kardex_movements (company_id,product_id,warehouse_id,location_id,movement_type,source_type,source_id,quantity,notes,created_by)
    VALUES (v_company,v_p2,v_warehouse_1,v_location_1,'IN','ADJUSTMENT',gen_random_uuid(),v_positive_q-2,'QA initial positive',v_admin),(v_company,v_p3,v_warehouse_1,v_location_1,'IN','ADJUSTMENT',gen_random_uuid(),v_negative_q+3,'QA initial negative',v_admin),(v_company,v_p4,v_warehouse_1,v_location_1,'IN','ADJUSTMENT',gen_random_uuid(),v_noop_q,'QA initial noop',v_admin);

    PERFORM set_config('request.jwt.claims',json_build_object('sub',v_admin::text)::text,true);
    SELECT inventarios.refresh_inventory_campaign_stock_reconciliation(v_company,v_campaign) INTO v_response;
    SELECT id INTO v_campaign_recon FROM inventarios.inventory_campaign_reconciliations WHERE company_id=v_company AND campaign_id=v_campaign;
    UPDATE inventarios.inventory_campaign_reconciliation_items SET bsale_sync_run_id=v_old_run WHERE reconciliation_id=v_campaign_recon AND bsale_variant_id=v_stale_variant;
    SELECT id INTO v_campaign_recon FROM inventarios.inventory_campaign_reconciliations WHERE company_id=v_company AND campaign_id=v_campaign;
    SELECT array_agg(id ORDER BY id) INTO v_item_ids FROM inventarios.inventory_campaign_reconciliation_items WHERE reconciliation_id=v_campaign_recon;
    SELECT count(*) INTO v_initial_kardex FROM logistica.kardex_movements WHERE company_id=v_company;
    SELECT inventarios.apply_inventory_campaign_logistics(v_company,v_campaign,v_item_ids,v_key) INTO v_response;
    INSERT INTO qa_campaign_apply_results VALUES ('partial_application',v_response);

    SELECT count(*) INTO v_count FROM logistica.kardex_movements WHERE company_id=v_company;
    IF v_count <> v_initial_kardex + 4 THEN RAISE EXCEPTION 'delta movement count FAILED: %',v_count-v_initial_kardex; END IF;
    SELECT coalesce(sum(CASE WHEN movement_type IN ('IN','TRANSFER_IN','ADJUSTMENT') THEN quantity ELSE -quantity END),0) INTO v_balance FROM logistica.kardex_movements WHERE company_id=v_company AND product_id=v_p1 AND warehouse_id=v_warehouse_1 AND location_id=v_location_1;
    IF v_balance <> 1 THEN RAISE EXCEPTION 'multi warehouse location 1 FAILED'; END IF;
    SELECT coalesce(sum(CASE WHEN movement_type IN ('IN','TRANSFER_IN','ADJUSTMENT') THEN quantity ELSE -quantity END),0) INTO v_balance FROM logistica.kardex_movements WHERE company_id=v_company AND product_id=v_p1 AND warehouse_id=v_warehouse_2 AND location_id=v_location_2;
    IF v_balance <> v_multi_q-1 THEN RAISE EXCEPTION 'multi warehouse location 2 FAILED'; END IF;
    SELECT coalesce(sum(CASE WHEN movement_type IN ('IN','TRANSFER_IN','ADJUSTMENT') THEN quantity ELSE -quantity END),0) INTO v_balance FROM logistica.kardex_movements WHERE company_id=v_company AND product_id=v_p2 AND warehouse_id=v_warehouse_1 AND location_id=v_location_1;
    IF v_balance <> v_positive_q THEN RAISE EXCEPTION 'positive delta FAILED'; END IF;
    SELECT coalesce(sum(CASE WHEN movement_type IN ('IN','TRANSFER_IN','ADJUSTMENT') THEN quantity ELSE -quantity END),0) INTO v_balance FROM logistica.kardex_movements WHERE company_id=v_company AND product_id=v_p3 AND warehouse_id=v_warehouse_1 AND location_id=v_location_1;
    IF v_balance <> v_negative_q THEN RAISE EXCEPTION 'negative delta FAILED'; END IF;
    SELECT count(*) FILTER (WHERE result='NO_OP'), count(*) FILTER (WHERE result='FAILED') INTO v_count, v_failed FROM inventarios.inventory_campaign_logistics_application_items ai JOIN inventarios.inventory_campaign_logistics_applications a ON a.id=ai.application_id WHERE a.campaign_id=v_campaign;
    IF v_count <> 1 OR v_failed <> 3 THEN RAISE EXCEPTION 'trace failure isolation FAILED noop=% failed=% response=%',v_count,v_failed,v_response; END IF;
    IF NOT EXISTS (SELECT 1 FROM inventarios.inventory_campaign_reconciliation_items WHERE reconciliation_id=v_campaign_recon AND bsale_variant_id=v_multi_variant AND reconciliation_status='APPLIED') THEN RAISE EXCEPTION 'item APPLIED FAILED'; END IF;
    IF NOT EXISTS (SELECT 1 FROM inventarios.inventory_campaign_reconciliation_items WHERE reconciliation_id=v_campaign_recon AND bsale_variant_id=v_stale_variant AND reconciliation_status<>'APPLIED') THEN RAISE EXCEPTION 'stale item applied unexpectedly'; END IF;
    INSERT INTO qa_campaign_apply_results VALUES ('balances_trace',jsonb_build_object('movement_delta',4,'noop_lines',1,'failed_items',3));

    SELECT inventarios.apply_inventory_campaign_logistics(
        v_company, v_campaign,
        ARRAY[(SELECT id FROM inventarios.inventory_campaign_reconciliation_items WHERE reconciliation_id=v_campaign_recon AND bsale_variant_id=v_multi_variant)],
        gen_random_uuid()) INTO v_response;
    IF v_response->>'status' <> 'FAILED' OR v_response->'items'->0->>'failure_reason' <> 'INV_CAMPAIGN_ITEM_ALREADY_APPLIED' THEN
        RAISE EXCEPTION 'second successful application was not rejected: %', v_response;
    END IF;
    SELECT count(*) INTO v_final_kardex FROM logistica.kardex_movements WHERE company_id=v_company;
    IF v_final_kardex <> v_initial_kardex + 4 THEN RAISE EXCEPTION 'second application changed Kardex'; END IF;
    INSERT INTO qa_campaign_apply_results VALUES ('second_application_rejected',jsonb_build_object('kardex_rows',v_final_kardex));

    SELECT inventarios.apply_inventory_campaign_logistics(v_company,v_campaign,v_item_ids,v_key) INTO v_replay;
    SELECT count(*) INTO v_count FROM logistica.kardex_movements WHERE company_id=v_company;
    IF v_count <> v_initial_kardex + 4 THEN RAISE EXCEPTION 'idempotent replay duplicated Kardex'; END IF;
    INSERT INTO qa_campaign_apply_results VALUES ('idempotent_replay',jsonb_build_object('replayed',v_replay->>'replayed','kardex_rows',v_count));

    BEGIN
        PERFORM inventarios.apply_inventory_logistics_v1(v_company,v_ov1,ARRAY[]::uuid[],gen_random_uuid());
        RAISE EXCEPTION 'session-level cutover did not reject';
    EXCEPTION WHEN OTHERS THEN
        IF sqlerrm <> 'INV_LOGISTICS_SESSION_FLOW_DEPRECATED' THEN RAISE; END IF;
    END;
    INSERT INTO qa_campaign_apply_results VALUES ('session_cutover',jsonb_build_object('rejected',true));
    SELECT count(*), coalesce(sum(quantity),0), md5(coalesce(string_agg(id::text || ':' || coalesce(quantity,0)::text, ',' ORDER BY id),''))
    INTO v_final_kardex, v_balance, v_bsale_fingerprint_after
    FROM integraciones.bsale_stock_current WHERE company_id=v_company;
    IF v_final_kardex <> v_bsale_rows OR v_balance <> v_bsale_quantity OR v_bsale_fingerprint_after <> v_bsale_fingerprint THEN
        RAISE EXCEPTION 'Bsale changed during application';
    END IF;
    INSERT INTO qa_campaign_apply_results VALUES ('bsale_unchanged',jsonb_build_object('rows',v_final_kardex));
    SELECT inventarios.get_inventory_campaign_stock_reconciliation_item_detail(v_company,v_campaign,(SELECT id FROM inventarios.inventory_campaign_reconciliation_items WHERE reconciliation_id=v_campaign_recon AND bsale_variant_id=v_multi_variant AND bsale_office_id=1)) INTO v_detail;
    IF jsonb_array_length(v_detail->'lines') <> 2 THEN RAISE EXCEPTION 'trace detail lines FAILED'; END IF;
END;
$$;

SELECT scenario,result FROM qa_campaign_apply_results ORDER BY scenario;
ROLLBACK;
