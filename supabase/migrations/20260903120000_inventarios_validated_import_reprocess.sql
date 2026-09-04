-- Forward contract for repairing a VALIDATED campaign import without changing
-- its source file or writing import rows outside the official validator.

CREATE OR REPLACE FUNCTION inventarios.validate_campaign_stock_import(
    p_company_id uuid,
    p_import_id uuid,
    p_file_sha256 char(64),
    p_file_issues jsonb,
    p_rows jsonb,
    p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_import_status text;
    v_import_campaign_id uuid;
    v_import_theoretical_scope text;
    v_import_consumed_campaign_id uuid;
    v_import_cutoff_at timestamptz;
    v_import_storage_path text;
    v_existing_import_id uuid;
    v_existing_status text;
BEGIN
    IF p_file_sha256 IS NOT NULL AND p_file_sha256 !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.imports.manage');
    SELECT si.status, si.campaign_id, si.theoretical_scope, si.consumed_campaign_id,
           si.cutoff_at, si.storage_path
      INTO v_import_status, v_import_campaign_id, v_import_theoretical_scope,
           v_import_consumed_campaign_id, v_import_cutoff_at, v_import_storage_path
    FROM inventarios.stock_imports si
    JOIN inventarios.inventory_campaigns ic
      ON ic.company_id = si.company_id AND ic.id = si.campaign_id
    WHERE si.company_id = p_company_id AND si.id = p_import_id
    FOR UPDATE OF si;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion no existe.','retryable',false)::text;
    END IF;
    IF v_import_consumed_campaign_id IS NOT NULL OR v_import_status = 'CONSUMED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_CONSUMED',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion ya fue consumida.','retryable',false)::text;
    END IF;

    -- A validated import may only be replayed against the same immutable file.
    IF v_import_status = 'VALIDATED' THEN
        IF p_file_sha256 IS NULL OR p_file_sha256 IS DISTINCT FROM
           (SELECT si.file_sha256 FROM inventarios.stock_imports si
            WHERE si.company_id = p_company_id AND si.id = p_import_id) THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_INVALID_STATE',
                DETAIL=pg_catalog.jsonb_build_object('message','La importacion validada solo admite reprocesar el archivo original.','retryable',false)::text;
        END IF;
        UPDATE inventarios.stock_imports
           SET status = 'DRAFT', updated_at = pg_catalog.now(), updated_by = v_actor_id
         WHERE company_id = p_company_id AND id = p_import_id;
    ELSIF v_import_status IN ('REJECTED', 'DRAFT') THEN
        IF v_import_status = 'REJECTED' AND p_file_sha256 IS NOT NULL AND p_file_sha256 =
           (SELECT si.file_sha256 FROM inventarios.stock_imports si
            WHERE si.company_id = p_company_id AND si.id = p_import_id) THEN
            RETURN pg_catalog.jsonb_build_object('operation','inventarios.validate_campaign_stock_import',
                'entity_id',p_import_id,'state',v_import_status,'replayed',true,
                'data',pg_catalog.jsonb_build_object('import_id',p_import_id,'campaign_id',v_import_campaign_id,
                    'theoretical_scope',v_import_theoretical_scope,'status',v_import_status,
                    'storage_path_to_remove',NULL::text));
        END IF;
    ELSE
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion no admite validacion en su estado actual.','retryable',false,'status',v_import_status)::text;
    END IF;

    IF p_file_sha256 IS NOT NULL THEN
        SELECT si.id, si.status INTO v_existing_import_id, v_existing_status
        FROM inventarios.stock_imports si
        WHERE si.company_id = p_company_id AND si.campaign_id = v_import_campaign_id
          AND si.theoretical_scope = v_import_theoretical_scope AND si.cutoff_at = v_import_cutoff_at
          AND si.file_sha256 = p_file_sha256 AND si.status <> 'CONSUMED' AND si.id <> p_import_id
        ORDER BY si.created_at LIMIT 1;
        IF v_existing_import_id IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_DUPLICATE_IMPORT',
                DETAIL=pg_catalog.jsonb_build_object('message','Ya existe otra importacion con el mismo archivo.','retryable',false,'import_id',v_existing_import_id)::text;
        END IF;
        UPDATE inventarios.stock_imports
           SET file_sha256 = p_file_sha256,
               metadata = COALESCE(metadata, '{}'::jsonb) || pg_catalog.jsonb_build_object('file_sha256',p_file_sha256,'sealed_at',pg_catalog.now()),
               updated_at = pg_catalog.now(), updated_by = v_actor_id
         WHERE company_id = p_company_id AND id = p_import_id;
    END IF;

    RETURN inventarios.validate_campaign_stock_import(p_company_id, p_import_id, p_file_issues, p_rows, p_idempotency_key);
END;
$$;

CREATE OR REPLACE FUNCTION inventarios.materialize_campaign_global_stock(
    p_company_id uuid,
    p_campaign_id uuid,
    p_import_id uuid,
    p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_operation jsonb;
    v_operation_id uuid;
    v_campaign_status text;
    v_import_campaign_id uuid;
    v_import_status text;
    v_scope text;
    v_consumed uuid;
    v_snapshot_id uuid;
    v_snapshot_status text;
    v_accepted bigint;
    v_products bigint;
    v_stocks bigint;
    v_now timestamptz := pg_catalog.now();
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_import_id IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD';
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.imports.manage');
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id, 'inventarios.materialize_campaign_global_stock', p_idempotency_key,
        inventarios.compute_request_hash(pg_catalog.jsonb_build_object('company_id',p_company_id,'campaign_id',p_campaign_id,'import_id',p_import_id)));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT ic.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id FOR UPDATE;
    IF v_campaign_status IS NULL OR v_campaign_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La campana ya esta preparada o no existe.','retryable',false)::text;
    END IF;
    SELECT si.campaign_id, si.status, si.theoretical_scope, si.consumed_campaign_id
      INTO v_import_campaign_id, v_import_status, v_scope, v_consumed
    FROM inventarios.stock_imports si
    WHERE si.company_id = p_company_id AND si.id = p_import_id FOR UPDATE;
    IF v_import_campaign_id IS DISTINCT FROM p_campaign_id OR v_import_status <> 'VALIDATED' OR v_consumed IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion no esta disponible para materializacion.','retryable',false)::text;
    END IF;
    IF v_scope <> 'TOTAL_CAMPAIGN' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','Solo se admite materializacion TOTAL_CAMPAIGN.','retryable',false)::text;
    END IF;
    IF EXISTS (SELECT 1 FROM inventarios.sessions s WHERE s.company_id=p_company_id AND s.campaign_id=p_campaign_id)
       OR EXISTS (SELECT 1 FROM inventarios.inventory_campaign_snapshots cs WHERE cs.company_id=p_company_id AND cs.campaign_id=p_campaign_id AND cs.completion_status='COMPLETED')
       OR EXISTS (SELECT 1 FROM inventarios.operational_snapshots os JOIN inventarios.sessions s ON s.company_id=os.company_id AND s.id=os.session_id WHERE s.company_id=p_company_id AND s.campaign_id=p_campaign_id) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_ALREADY_PREPARED',
            DETAIL=pg_catalog.jsonb_build_object('message','La campana ya tiene sesiones o snapshots operativos.','retryable',false)::text;
    END IF;

    SELECT count(*) INTO v_accepted
    FROM inventarios.stock_import_rows r
    WHERE r.company_id=p_company_id AND r.import_id=p_import_id
      AND r.row_status IN ('VALID','WARNING') AND r.product_id IS NOT NULL
      AND r.bsale_variant_id IS NOT NULL AND r.sku IS NOT NULL AND pg_catalog.btrim(r.sku) <> ''
      AND r.theoretical_quantity IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM inventarios.stock_import_row_issues i WHERE i.company_id=r.company_id AND i.import_id=r.import_id AND i.row_id=r.id AND i.issue_level='ERROR')
      AND NOT EXISTS (SELECT 1 FROM inventarios.stock_import_row_issues i WHERE i.company_id=r.company_id AND i.import_id=r.import_id AND i.row_id=r.id AND i.issue_code <> 'ZERO_COST');
    IF v_accepted = 0 THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_NOT_MATERIALIZABLE'; END IF;

    INSERT INTO inventarios.inventory_campaign_snapshots(company_id,campaign_id,stock_import_id,theoretical_scope,completion_status,captured_at,captured_by,created_at,created_by)
    VALUES (p_company_id,p_campaign_id,p_import_id,'TOTAL_CAMPAIGN','COMPLETED',v_now,v_actor_id,v_now,v_actor_id)
    RETURNING id INTO v_snapshot_id;
    INSERT INTO inventarios.inventory_campaign_snapshot_products(company_id,campaign_snapshot_id,product_id,bsale_variant_id,sku,barcode,name,is_active,created_at,created_by)
    SELECT r.company_id,v_snapshot_id,r.product_id,r.bsale_variant_id,r.sku,NULLIF(pg_catalog.btrim(p.barcode),''),COALESCE(NULLIF(pg_catalog.btrim(p.description),''),r.sku),true,v_now,v_actor_id
    FROM inventarios.stock_import_rows r JOIN adquisiciones.products p ON p.id=r.product_id
    WHERE r.company_id=p_company_id AND r.import_id=p_import_id AND r.row_status IN ('VALID','WARNING')
      AND r.product_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM inventarios.stock_import_row_issues i WHERE i.company_id=r.company_id AND i.import_id=r.import_id AND i.row_id=r.id AND (i.issue_level='ERROR' OR i.issue_code <> 'ZERO_COST'));
    INSERT INTO inventarios.inventory_campaign_theoretical_stocks(company_id,campaign_snapshot_id,snapshot_product_id,scope_level,theoretical_quantity,unit_cost,source_import_id,created_at,created_by)
    SELECT r.company_id,v_snapshot_id,csp.id,'TOTAL_CAMPAIGN',r.theoretical_quantity,r.unit_cost,r.import_id,v_now,v_actor_id
    FROM inventarios.stock_import_rows r JOIN inventarios.inventory_campaign_snapshot_products csp ON csp.company_id=r.company_id AND csp.campaign_snapshot_id=v_snapshot_id AND csp.bsale_variant_id=r.bsale_variant_id
    WHERE r.company_id=p_company_id AND r.import_id=p_import_id AND r.row_status IN ('VALID','WARNING')
      AND NOT EXISTS (SELECT 1 FROM inventarios.stock_import_row_issues i WHERE i.company_id=r.company_id AND i.import_id=r.import_id AND i.row_id=r.id AND (i.issue_level='ERROR' OR i.issue_code <> 'ZERO_COST'));
    SELECT count(*) INTO v_products FROM inventarios.inventory_campaign_snapshot_products WHERE company_id=p_company_id AND campaign_snapshot_id=v_snapshot_id;
    SELECT count(*) INTO v_stocks FROM inventarios.inventory_campaign_theoretical_stocks WHERE company_id=p_company_id AND campaign_snapshot_id=v_snapshot_id;
    IF v_products <> v_accepted OR v_stocks <> v_accepted THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_MATERIALIZATION_COUNT_MISMATCH'; END IF;
    RETURN inventarios.complete_idempotent_operation(p_company_id,v_operation_id,p_import_id,pg_catalog.jsonb_build_object('operation','inventarios.materialize_campaign_global_stock','entity_id',p_import_id,'state','COMPLETED','replayed',false,'data',pg_catalog.jsonb_build_object('campaign_id',p_campaign_id,'import_id',p_import_id,'products',v_products,'stocks',v_stocks,'snapshot_id',v_snapshot_id)));
END;
$$;
