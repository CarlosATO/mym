-- QA read-only de los contratos campaign-level ampliados.
-- Las fixtures se crean dentro de la transaccion y se revierten; los RPC
-- consultados no deben escribir en Inventarios, Kardex ni Bsale.
BEGIN;

CREATE TEMP TABLE qa_campaign_read_results (scenario text PRIMARY KEY, result jsonb) ON COMMIT DROP;

DO $$
DECLARE
    v_company uuid := 'd1000000-0000-0000-0000-000000000001';
    v_admin uuid := 'dc9be3b3-bf39-47b2-8ea3-fdd6aa9a4aaa';
    v_campaign uuid := gen_random_uuid();
    v_session uuid := gen_random_uuid();
    v_snapshot uuid := gen_random_uuid();
    v_location uuid := gen_random_uuid();
    v_snapshot_location uuid := gen_random_uuid();
    v_product_1 uuid; v_product_2 uuid;
    v_snapshot_product_1 uuid := gen_random_uuid(); v_snapshot_product_2 uuid := gen_random_uuid();
    v_version uuid := gen_random_uuid();
    v_official_item_1 uuid := gen_random_uuid(); v_official_item_2 uuid := gen_random_uuid();
    v_line_1 uuid := gen_random_uuid(); v_line_2 uuid := gen_random_uuid();
    v_reconciliation uuid := gen_random_uuid();
    v_item_1 uuid := gen_random_uuid(); v_item_2 uuid := gen_random_uuid();
    v_application uuid := gen_random_uuid(); v_application_item uuid := gen_random_uuid();
    v_warehouse uuid := 'e4fa8a09-c160-4574-af69-a44a41e5de9c';
    v_list jsonb; v_applied_detail jsonb; v_pending_detail jsonb;
    v_bsale_rows bigint; v_bsale_rows_after bigint; v_campaign_rows bigint; v_recon_rows bigint; v_scope_count bigint;
BEGIN
    SELECT (array_agg(id ORDER BY id))[1], (array_agg(id ORDER BY id))[2]
    INTO v_product_1, v_product_2
    FROM (SELECT id FROM adquisiciones.products WHERE company_id=v_company LIMIT 2) products;
    IF v_product_1 IS NULL OR v_product_2 IS NULL THEN RAISE EXCEPTION 'QA requires two products'; END IF;
    SELECT count(*) INTO v_bsale_rows FROM integraciones.bsale_stock_current WHERE company_id=v_company;
    SELECT count(*) INTO v_campaign_rows FROM inventarios.inventory_campaigns WHERE company_id=v_company;
    SELECT count(*) INTO v_recon_rows FROM inventarios.inventory_campaign_reconciliations WHERE company_id=v_company;

    INSERT INTO inventarios.inventory_campaigns
        (id,company_id,name,campaign_type,status,planned_at,started_at,approved_at,site_scope,product_scope,approved_by,created_at,created_by,updated_at,updated_by)
    VALUES (v_campaign,v_company,'QA read contract '||v_campaign,'GENERAL','APPROVED',now(),now(),now(),'ALL_INTERNAL','ALL',v_admin,now(),v_admin,now(),v_admin);
    INSERT INTO inventarios.sessions
        (id,company_id,session_number,name,inventory_type,status,warehouse_id,bsale_office_id,scope_mode,responsible_user_id,campaign_id,prepared_at,started_at,reviewed_at,approved_at,approved_by,created_at,created_by,updated_at,updated_by)
    VALUES (v_session,v_company,992000,'QA read contract session','GENERAL','APPROVED',v_warehouse,1,'GENERAL',v_admin,v_campaign,now(),now(),now(),now(),v_admin,now(),v_admin,now(),v_admin);
    INSERT INTO inventarios.operational_snapshots (id,company_id,session_id,completion_status,captured_at,captured_by,created_at,created_by)
    VALUES (v_snapshot,v_company,v_session,'PENDING',now(),v_admin,now(),v_admin);
    INSERT INTO logistica.locations (id,company_id,warehouse_id,code,name,created_by)
    VALUES (v_location,v_company,v_warehouse,'QA-READ-CONTRACT','QA read contract',v_admin);
    INSERT INTO inventarios.snapshot_locations (id,company_id,snapshot_id,location_id,warehouse_id,code,is_active,created_by)
    VALUES (v_snapshot_location,v_company,v_snapshot,v_location,v_warehouse,'QA-READ-CONTRACT',true,v_admin);
    INSERT INTO inventarios.snapshot_products (id,company_id,snapshot_id,product_id,bsale_variant_id,sku,name,created_by)
    VALUES (v_snapshot_product_1,v_company,v_snapshot,v_product_1,990000001,'QA-READ-001','QA Read Applied',v_admin),
           (v_snapshot_product_2,v_company,v_snapshot,v_product_2,990000002,'QA-READ-002','QA Read Pending',v_admin);
    SET LOCAL session_replication_role=replica;
    INSERT INTO inventarios.official_versions
        (id,company_id,session_id,snapshot_id,version_number,task_count,contribution_count,normal_contribution_count,recount_contribution_count,item_count,approved_at,approved_by,created_at,created_by)
    VALUES (v_version,v_company,v_session,v_snapshot,1,1,2,2,0,2,now(),v_admin,now(),v_admin);
    INSERT INTO inventarios.official_version_items
        (id,company_id,official_version_id,session_id,snapshot_id,snapshot_product_id,bsale_variant_id,available_quantity,damaged_quantity,expired_quantity,blocked_quantity,other_unavailable_quantity,physical_quantity,contribution_count,normal_contribution_count,recount_contribution_count,contribution_manifest,location_resolution_status,created_at,created_by)
    VALUES (v_official_item_1,v_company,v_version,v_session,v_snapshot,v_snapshot_product_1,990000001,3,0,0,0,0,3,1,1,0,'[]','RESOLVED',now(),v_admin),
           (v_official_item_2,v_company,v_version,v_session,v_snapshot,v_snapshot_product_2,990000002,4,0,0,0,0,4,1,1,0,'[]','RESOLVED',now(),v_admin);
    INSERT INTO inventarios.official_version_location_items
        (id,company_id,official_version_id,session_id,snapshot_id,snapshot_product_id,snapshot_location_id,theoretical_quantity,available_quantity,damaged_quantity,expired_quantity,blocked_quantity,other_unavailable_quantity,physical_quantity,valuation_status,created_by)
    VALUES (v_line_1,v_company,v_version,v_session,v_snapshot,v_snapshot_product_1,v_snapshot_location,3,3,0,0,0,0,3,'NOT_APPLICABLE',v_admin),
           (v_line_2,v_company,v_version,v_session,v_snapshot,v_snapshot_product_2,v_snapshot_location,4,4,0,0,0,0,4,'NOT_APPLICABLE',v_admin);
    SET LOCAL session_replication_role=origin;
    INSERT INTO inventarios.inventory_campaign_reconciliations
        (id,company_id,campaign_id,status,latest_bsale_sync_run_id,latest_bsale_synced_at,last_refreshed_at)
    VALUES (v_reconciliation,v_company,v_campaign,'READY',NULL,NULL,now());
    INSERT INTO inventarios.inventory_campaign_reconciliation_sources
        (company_id,reconciliation_id,session_id,official_version_id,snapshot_id,warehouse_id,bsale_office_id,source_status)
    VALUES (v_company,v_reconciliation,v_session,v_version,v_snapshot,v_warehouse,1,'INCLUDED');
    INSERT INTO inventarios.inventory_campaign_reconciliation_items
        (id,company_id,reconciliation_id,bsale_variant_id,bsale_office_id,physical_quantity,bsale_quantity,difference_quantity,reconciliation_status,logistics_applicability_status)
    VALUES (v_item_1,v_company,v_reconciliation,990000001,1,3,3,0,'APPLIED','READY'),
           (v_item_2,v_company,v_reconciliation,990000002,1,4,4,0,'READY','READY');
    INSERT INTO inventarios.inventory_campaign_reconciliation_lines
        (id,company_id,reconciliation_item_id,session_id,official_version_id,official_version_item_id,official_version_location_item_id,snapshot_id,snapshot_product_id,snapshot_location_id,warehouse_id,logistics_location_id,physical_quantity,available_quantity,damaged_quantity,expired_quantity,blocked_quantity,other_unavailable_quantity,line_status)
    VALUES (v_line_1,v_company,v_item_1,v_session,v_version,v_official_item_1,v_line_1,v_snapshot,v_snapshot_product_1,v_snapshot_location,v_warehouse,v_location,3,3,0,0,0,0,'READY'),
           (v_line_2,v_company,v_item_2,v_session,v_version,v_official_item_2,v_line_2,v_snapshot,v_snapshot_product_2,v_snapshot_location,v_warehouse,v_location,4,4,0,0,0,0,'READY');
    INSERT INTO inventarios.inventory_campaign_logistics_applications
        (id,company_id,campaign_id,reconciliation_id,idempotency_key,status,attempted_by,attempted_at,applied_at)
    VALUES (v_application,v_company,v_campaign,v_reconciliation,gen_random_uuid(),'APPLIED',v_admin,now(),now());
    INSERT INTO inventarios.inventory_campaign_logistics_application_items
        (id,company_id,application_id,reconciliation_item_id,reconciliation_line_id,session_id,official_version_id,official_version_location_item_id,product_id,warehouse_id,logistics_location_id,previous_balance,target_balance,delta,result,stock_adjustment_id,stock_adjustment_item_id,kardex_movement_id,applied_by)
    VALUES (v_application_item,v_company,v_application,v_item_1,v_line_1,v_session,v_version,v_line_1,v_product_1,v_warehouse,v_location,1,3,2,'APPLIED',gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),v_admin);

    PERFORM set_config('request.jwt.claims',json_build_object('sub',v_admin::text)::text,true);
    SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.bsale_variant_id), '[]'::jsonb) INTO v_list
    FROM inventarios.list_inventory_campaign_stock_reconciliation_items(v_company,v_campaign) x;
    IF jsonb_array_length(v_list) <> 2
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_list) x WHERE x->>'sku'='QA-READ-001' AND x->>'product_name'='QA Read Applied' AND x->>'logistics_application_status'='APPLIED')
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_list) x WHERE x->>'sku'='QA-READ-002' AND x->>'product_name'='QA Read Pending' AND x->>'logistics_application_status'='NOT_APPLIED') THEN
        RAISE EXCEPTION 'list read contract FAILED: %',v_list;
    END IF;
    INSERT INTO qa_campaign_read_results VALUES ('list_contract',v_list);

    SELECT inventarios.get_inventory_campaign_stock_reconciliation_item_detail(v_company,v_campaign,v_item_1) INTO v_applied_detail;
    IF (v_applied_detail->'item'->>'logistics_application_status') <> 'APPLIED'
       OR (v_applied_detail->'lines'->0->>'session_name') <> 'QA read contract session'
       OR (v_applied_detail->'lines'->0->>'warehouse_name') IS NULL
       OR (v_applied_detail->'lines'->0->>'logistics_location_code') <> 'QA-READ-CONTRACT'
       OR (v_applied_detail->'lines'->0->>'previous_balance')::numeric <> 1
       OR (v_applied_detail->'lines'->0->>'target_quantity')::numeric <> 3
       OR (v_applied_detail->'lines'->0->>'delta')::numeric <> 2
       OR (v_applied_detail->'lines'->0->>'application_result') <> 'APPLIED'
       OR (v_applied_detail->'lines'->0->>'adjustment_id') IS NULL
       OR (v_applied_detail->'lines'->0->>'adjustment_item_id') IS NULL
       OR (v_applied_detail->'lines'->0->>'kardex_movement_id') IS NULL THEN
        RAISE EXCEPTION 'applied detail contract FAILED: %',v_applied_detail;
    END IF;
    INSERT INTO qa_campaign_read_results VALUES ('applied_detail_contract',jsonb_build_object('trace_complete',true));

    SELECT inventarios.get_inventory_campaign_stock_reconciliation_item_detail(v_company,v_campaign,v_item_2) INTO v_pending_detail;
    IF (v_pending_detail->'item'->>'logistics_application_status') <> 'NOT_APPLIED'
       OR (v_pending_detail->'lines'->0->>'target_quantity')::numeric <> 4
       OR (v_pending_detail->'lines'->0->>'previous_balance') IS NOT NULL
       OR (v_pending_detail->'lines'->0->>'delta') IS NOT NULL
       OR (v_pending_detail->'lines'->0->>'application_result') IS NOT NULL
       OR (v_pending_detail->'lines'->0->>'adjustment_id') IS NOT NULL THEN
        RAISE EXCEPTION 'pending detail contract FAILED: %',v_pending_detail;
    END IF;
    INSERT INTO qa_campaign_read_results VALUES ('pending_detail_contract',jsonb_build_object('trace_fields_null',true));

    SELECT count(*) INTO v_scope_count
    FROM inventarios.list_inventory_campaign_stock_reconciliation_items(v_company,gen_random_uuid());
    IF v_scope_count <> 0 THEN
        RAISE EXCEPTION 'campaign scope FAILED';
    END IF;
    SELECT count(*) INTO v_bsale_rows_after FROM integraciones.bsale_stock_current WHERE company_id=v_company;
    IF v_bsale_rows_after <> v_bsale_rows THEN
        RAISE EXCEPTION 'read contract wrote Bsale';
    END IF;
END;
$$;

SELECT scenario,result FROM qa_campaign_read_results ORDER BY scenario;
ROLLBACK;
