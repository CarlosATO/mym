-- Migration: 20260805185000_inventarios_campaign_import_coverage_fix.sql
-- Description: Hotfix de cobertura selectiva para validate_campaign_stock_import.
--              Restaura los ciclos de cobertura con record explicito sin perder
--              entered_description ni las mejoras posteriores.
-- Author: Assistant

CREATE OR REPLACE FUNCTION inventarios.validate_campaign_stock_import(
    p_company_id uuid,
    p_import_id uuid,
    p_file_issues jsonb,
    p_rows jsonb,
    p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid; v_operation jsonb; v_operation_id uuid; v_payload jsonb; v_now timestamptz := pg_catalog.now();
    v_import_status text; v_import_campaign_id uuid; v_import_theoretical_scope text; v_import_consumed_campaign_id uuid; v_campaign_product_scope text;
    v_row jsonb; v_issue jsonb; v_row_index integer; v_row_id uuid; v_total_rows integer := 0; v_valid_rows integer := 0; v_warning_rows integer := 0; v_error_rows integer := 0; v_issue_warning_count integer := 0; v_issue_error_count integer := 0;
    v_has_error boolean; v_has_warning boolean; v_sku text; v_sku_norm text; v_barcode text; v_entered_name text; v_entered_description text; v_site_code text; v_site_norm text; v_location_code text; v_location_norm text; v_quantity_text text; v_cost_text text; v_quantity numeric; v_cost numeric;
    v_product_id uuid; v_product_count integer; v_product_bsale_variant_id integer; v_site_id uuid; v_site_active boolean; v_site_enabled boolean; v_site_count integer; v_location_id uuid; v_location_active boolean; v_location_count integer; v_campaign_site_id uuid; v_campaign_site_location_scope text; v_seen_combos jsonb := '{}'::jsonb; v_key text; v_final_status text;
    v_file_issue_level text; v_file_issue_code text; v_file_issue_field text; v_file_issue_message text; v_file_issue_metadata jsonb; v_file_issue_row_index integer; v_row_issues jsonb; v_coverage record;
BEGIN
    IF p_company_id IS NULL OR p_import_id IS NULL OR p_idempotency_key IS NULL OR p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' OR COALESCE(p_file_issues, '[]'::jsonb) IS NULL OR pg_catalog.jsonb_typeof(COALESCE(p_file_issues, '[]'::jsonb)) <> 'array' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.imports.manage');
    v_payload := pg_catalog.jsonb_build_object('operation','inventarios.validate_campaign_stock_import','company_id',p_company_id,'import_id',p_import_id,'file_issues',COALESCE(p_file_issues,'[]'::jsonb),'rows',p_rows,'idempotency_key',p_idempotency_key);
    v_operation := inventarios.begin_idempotent_operation(p_company_id, 'inventarios.validate_campaign_stock_import', p_idempotency_key, inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT si.status, si.campaign_id, si.theoretical_scope, si.consumed_campaign_id, ic.product_scope
    INTO v_import_status, v_import_campaign_id, v_import_theoretical_scope, v_import_consumed_campaign_id, v_campaign_product_scope
    FROM inventarios.stock_imports si
    JOIN inventarios.inventory_campaigns ic ON ic.company_id = si.company_id AND ic.id = si.campaign_id
    WHERE si.company_id = p_company_id AND si.id = p_import_id
    FOR UPDATE OF si;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=pg_catalog.jsonb_build_object('message','La importacion no existe.','retryable',false)::text;
    END IF;
    IF v_import_campaign_id IS NULL OR v_import_theoretical_scope IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_INVALID_STATE', DETAIL=pg_catalog.jsonb_build_object('message','La importacion no pertenece a una campana valida.','retryable',false)::text;
    END IF;
    IF v_import_consumed_campaign_id IS NOT NULL OR v_import_status = 'CONSUMED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_CONSUMED', DETAIL=pg_catalog.jsonb_build_object('message','La importacion ya fue consumida.','retryable',false)::text;
    END IF;
    IF v_import_status NOT IN ('DRAFT', 'REJECTED') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_INVALID_STATE', DETAIL=pg_catalog.jsonb_build_object('message','La importacion no admite validacion en su estado actual.','retryable',false,'status',v_import_status)::text;
    END IF;

    DELETE FROM inventarios.stock_import_row_issues WHERE company_id = p_company_id AND import_id = p_import_id;
    DELETE FROM inventarios.stock_import_rows WHERE company_id = p_company_id AND import_id = p_import_id;

    FOR v_issue IN SELECT value FROM pg_catalog.jsonb_array_elements(COALESCE(p_file_issues, '[]'::jsonb)) LOOP
        IF pg_catalog.jsonb_typeof(v_issue) <> 'object' THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
        END IF;
        v_file_issue_level := CASE WHEN pg_catalog.upper(pg_catalog.btrim(COALESCE(v_issue->>'level', 'WARNING'))) = 'ERROR' THEN 'ERROR' ELSE 'WARNING' END;
        v_file_issue_code := COALESCE(NULLIF(pg_catalog.btrim(v_issue->>'code'), ''), 'FILE_ISSUE');
        v_file_issue_field := NULLIF(pg_catalog.btrim(COALESCE(v_issue->>'field', '')), '');
        v_file_issue_message := COALESCE(NULLIF(pg_catalog.btrim(COALESCE(v_issue->>'message', '')), ''), 'La solicitud no tiene el formato requerido.');
        v_file_issue_metadata := CASE WHEN pg_catalog.jsonb_typeof(v_issue->'metadata') = 'object' THEN v_issue->'metadata' ELSE '{}'::jsonb END;
        v_file_issue_row_index := NULL;
        IF NULLIF(pg_catalog.btrim(COALESCE(v_issue->>'row_index', v_issue->>'row_number', '')), '') IS NOT NULL AND COALESCE(v_issue->>'row_index', v_issue->>'row_number', '') ~ '^[0-9]+$' THEN v_file_issue_row_index := (COALESCE(v_issue->>'row_index', v_issue->>'row_number'))::integer; END IF;
        INSERT INTO inventarios.stock_import_row_issues(company_id, import_id, row_id, row_index, issue_level, issue_code, field, safe_message, metadata)
        VALUES (p_company_id, p_import_id, NULL, v_file_issue_row_index, v_file_issue_level, v_file_issue_code, v_file_issue_field, v_file_issue_message, v_file_issue_metadata);
        IF v_file_issue_level = 'ERROR' THEN v_issue_error_count := v_issue_error_count + 1; ELSE v_issue_warning_count := v_issue_warning_count + 1; END IF;
    END LOOP;

    FOR v_row IN SELECT value FROM pg_catalog.jsonb_array_elements(p_rows) LOOP
        IF pg_catalog.jsonb_typeof(v_row) <> 'object' THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
        END IF;

        v_row_index := COALESCE(NULLIF(pg_catalog.btrim(COALESCE(v_row->>'row_index', v_row->>'row_number', '')), '')::integer, 0);
        IF v_row_index <= 0 THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
        END IF;

        v_sku := pg_catalog.btrim(COALESCE(v_row->>'sku', '')); v_barcode := pg_catalog.btrim(COALESCE(v_row->>'barcode', '')); v_entered_name := pg_catalog.btrim(COALESCE(v_row->>'entered_name', '')); v_entered_description := pg_catalog.btrim(COALESCE(v_row->>'entered_description', v_row->>'enteredDescription', '')); v_site_code := pg_catalog.btrim(COALESCE(v_row->>'entered_site_code', v_row->>'site_code', '')); v_location_code := pg_catalog.btrim(COALESCE(v_row->>'entered_location_code', v_row->>'location_code', '')); v_quantity_text := pg_catalog.btrim(COALESCE(v_row->>'quantity', '')); v_cost_text := pg_catalog.btrim(COALESCE(v_row->>'cost', v_row->>'unit_cost', ''));
        v_row_issues := '[]'::jsonb; v_has_error := false; v_has_warning := false; v_quantity := NULL; v_cost := NULL; v_key := NULL; v_product_id := NULL; v_product_bsale_variant_id := NULL; v_site_id := NULL; v_site_active := false; v_site_enabled := false; v_location_id := NULL; v_location_active := false; v_campaign_site_id := NULL; v_campaign_site_location_scope := NULL;

        IF v_sku = '' AND v_site_code = '' AND v_location_code = '' AND v_quantity_text = '' AND v_cost_text = '' AND v_entered_description = '' THEN CONTINUE; END IF;

        IF v_sku = '' THEN
            v_has_error := true; v_row_issues := v_row_issues || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('severity','ERROR','code','UNKNOWN_PRODUCT','field','sku','message','El SKU no existe en el catalogo de la empresa.','metadata',pg_catalog.jsonb_build_object('row_index', v_row_index)));
            v_issue_error_count := v_issue_error_count + 1;
        ELSE
            v_sku_norm := pg_catalog.upper(pg_catalog.btrim(v_sku));
            SELECT count(*) INTO v_product_count FROM adquisiciones.products p WHERE (p.company_id = p_company_id OR p.company_id IS NULL) AND pg_catalog.upper(pg_catalog.btrim(p.sku)) = v_sku_norm;
            IF v_product_count = 1 THEN
                SELECT p.id, p.bsale_variant_id INTO v_product_id, v_product_bsale_variant_id FROM adquisiciones.products p WHERE (p.company_id = p_company_id OR p.company_id IS NULL) AND pg_catalog.upper(pg_catalog.btrim(p.sku)) = v_sku_norm LIMIT 1;
                IF v_campaign_product_scope = 'SELECTED' AND NOT EXISTS (SELECT 1 FROM inventarios.inventory_campaign_products icp WHERE icp.company_id = p_company_id AND icp.campaign_id = v_import_campaign_id AND icp.product_id = v_product_id) THEN
                    v_has_error := true; v_row_issues := v_row_issues || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('severity','ERROR','code','PRODUCT_OUT_OF_SCOPE','field','sku','message','El producto no esta incluido en la campana.','metadata',pg_catalog.jsonb_build_object('row_index', v_row_index, 'product_id', v_product_id, 'product_scope', v_campaign_product_scope))); v_issue_error_count := v_issue_error_count + 1; v_product_id := NULL;
                END IF;
            ELSIF v_product_count > 1 THEN
                v_has_error := true; v_row_issues := v_row_issues || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('severity','ERROR','code','AMBIGUOUS_PRODUCT','field','sku','message','El SKU coincide con mas de un producto.','metadata',pg_catalog.jsonb_build_object('row_index', v_row_index, 'sku', v_sku_norm))); v_issue_error_count := v_issue_error_count + 1;
            ELSE
                v_has_error := true; v_row_issues := v_row_issues || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('severity','ERROR','code','UNKNOWN_PRODUCT','field','sku','message','El SKU no existe en el catalogo de la empresa.','metadata',pg_catalog.jsonb_build_object('row_index', v_row_index, 'sku', v_sku_norm))); v_issue_error_count := v_issue_error_count + 1;
            END IF;
        END IF;

        IF v_quantity_text = '' THEN
            v_has_error := true; v_row_issues := v_row_issues || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('severity','ERROR','code','MISSING_QUANTITY','field','quantity','message','La cantidad teorica es obligatoria.','metadata',pg_catalog.jsonb_build_object('row_index', v_row_index))); v_issue_error_count := v_issue_error_count + 1;
        ELSE
            BEGIN
                v_quantity := v_quantity_text::numeric;
                IF v_quantity < 0 OR pg_catalog.scale(v_quantity) > 3 THEN
                    v_has_error := true; v_row_issues := v_row_issues || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('severity','ERROR','code',CASE WHEN v_quantity < 0 THEN 'NEGATIVE_QUANTITY' ELSE 'QUANTITY_SCALE_EXCEEDED' END,'field','quantity','message',CASE WHEN v_quantity < 0 THEN 'La cantidad no puede ser negativa.' ELSE 'La cantidad no puede tener mas de 3 decimales.' END,'metadata',pg_catalog.jsonb_build_object('row_index', v_row_index))); v_issue_error_count := v_issue_error_count + 1;
                END IF;
            EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
                v_has_error := true; v_row_issues := v_row_issues || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('severity','ERROR','code','INVALID_QUANTITY','field','quantity','message','La cantidad no es un valor numerico valido.','metadata',pg_catalog.jsonb_build_object('row_index', v_row_index))); v_issue_error_count := v_issue_error_count + 1;
            END;
        END IF;

        IF v_cost_text = '' THEN
            v_has_warning := true; v_row_issues := v_row_issues || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('severity','WARNING','code','MISSING_COST','field','cost','message','El costo unitario no fue informado.','metadata',pg_catalog.jsonb_build_object('row_index', v_row_index))); v_issue_warning_count := v_issue_warning_count + 1;
        ELSE
            BEGIN
                v_cost := v_cost_text::numeric;
                IF v_cost < 0 OR pg_catalog.scale(v_cost) > 2 THEN
                    v_has_error := true; v_row_issues := v_row_issues || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('severity','ERROR','code','INVALID_COST','field','cost','message',CASE WHEN v_cost < 0 THEN 'El costo unitario no puede ser negativo.' ELSE 'El costo unitario no puede tener mas de 2 decimales.' END,'metadata',pg_catalog.jsonb_build_object('row_index', v_row_index))); v_issue_error_count := v_issue_error_count + 1;
                ELSIF v_cost = 0 THEN
                    v_has_warning := true; v_row_issues := v_row_issues || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('severity','WARNING','code','ZERO_COST','field','cost','message','El costo unitario es cero.','metadata',pg_catalog.jsonb_build_object('row_index', v_row_index))); v_issue_warning_count := v_issue_warning_count + 1;
                END IF;
            EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
                v_has_error := true; v_row_issues := v_row_issues || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('severity','ERROR','code','INVALID_COST','field','cost','message','El costo unitario no es un valor numerico valido.','metadata',pg_catalog.jsonb_build_object('row_index', v_row_index))); v_issue_error_count := v_issue_error_count + 1;
            END;
        END IF;

        IF v_import_theoretical_scope = 'TOTAL_CAMPAIGN' THEN
            IF v_site_code <> '' THEN v_has_error := true; v_row_issues := v_row_issues || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('severity','ERROR','code','SITE_OUT_OF_CAMPAIGN','field','entered_site_code','message','La importacion TOTAL_CAMPAIGN no admite unidad.','metadata',pg_catalog.jsonb_build_object('row_index', v_row_index, 'scope', v_import_theoretical_scope))); v_issue_error_count := v_issue_error_count + 1; END IF;
            IF v_location_code <> '' THEN v_has_error := true; v_row_issues := v_row_issues || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('severity','ERROR','code','LOCATION_OUT_OF_CAMPAIGN','field','entered_location_code','message','La importacion TOTAL_CAMPAIGN no admite ubicacion.','metadata',pg_catalog.jsonb_build_object('row_index', v_row_index, 'scope', v_import_theoretical_scope))); v_issue_error_count := v_issue_error_count + 1; END IF;
        ELSE
            IF v_site_code = '' THEN
                v_has_error := true; v_row_issues := v_row_issues || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('severity','ERROR','code','UNKNOWN_SITE','field','entered_site_code','message','La unidad es obligatoria.','metadata',pg_catalog.jsonb_build_object('row_index', v_row_index, 'scope', v_import_theoretical_scope))); v_issue_error_count := v_issue_error_count + 1;
            ELSE
                v_site_norm := pg_catalog.upper(pg_catalog.btrim(v_site_code));
                SELECT count(*) INTO v_site_count FROM inventarios.inventory_sites s WHERE s.company_id = p_company_id AND pg_catalog.upper(pg_catalog.btrim(s.code)) = v_site_norm;
                IF v_site_count = 1 THEN
                    SELECT s.id, s.is_active, s.inventory_enabled INTO v_site_id, v_site_active, v_site_enabled FROM inventarios.inventory_sites s WHERE s.company_id = p_company_id AND pg_catalog.upper(pg_catalog.btrim(s.code)) = v_site_norm LIMIT 1;
                    IF NOT v_site_active OR NOT v_site_enabled THEN
                        v_has_error := true; v_row_issues := v_row_issues || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('severity','ERROR','code','UNKNOWN_SITE','field','entered_site_code','message','La unidad no existe o no esta habilitada.','metadata',pg_catalog.jsonb_build_object('row_index', v_row_index, 'site_code', v_site_norm))); v_issue_error_count := v_issue_error_count + 1; v_site_id := NULL;
                    ELSIF NOT EXISTS (SELECT 1 FROM inventarios.inventory_campaign_sites ics WHERE ics.company_id = p_company_id AND ics.campaign_id = v_import_campaign_id AND ics.inventory_site_id = v_site_id) THEN
                        v_has_error := true; v_row_issues := v_row_issues || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('severity','ERROR','code','SITE_OUT_OF_CAMPAIGN','field','entered_site_code','message','La unidad no pertenece a la campana.','metadata',pg_catalog.jsonb_build_object('row_index', v_row_index, 'site_code', v_site_norm, 'campaign_id', v_import_campaign_id))); v_issue_error_count := v_issue_error_count + 1; v_site_id := NULL;
                    END IF;
                ELSIF v_site_count > 1 THEN
                    v_has_error := true; v_row_issues := v_row_issues || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('severity','ERROR','code','AMBIGUOUS_SITE','field','entered_site_code','message','La unidad coincide con mas de un registro.','metadata',pg_catalog.jsonb_build_object('row_index', v_row_index, 'site_code', v_site_norm))); v_issue_error_count := v_issue_error_count + 1;
                ELSIF EXISTS (SELECT 1 FROM inventarios.inventory_sites s2 WHERE s2.company_id <> p_company_id AND pg_catalog.upper(pg_catalog.btrim(s2.code)) = v_site_norm) THEN
                    v_has_error := true; v_row_issues := v_row_issues || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('severity','ERROR','code','SITE_COMPANY_MISMATCH','field','entered_site_code','message','La unidad pertenece a otra empresa.','metadata',pg_catalog.jsonb_build_object('row_index', v_row_index, 'site_code', v_site_norm))); v_issue_error_count := v_issue_error_count + 1;
                ELSE
                    v_has_error := true; v_row_issues := v_row_issues || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('severity','ERROR','code','UNKNOWN_SITE','field','entered_site_code','message','La unidad no existe o no esta habilitada.','metadata',pg_catalog.jsonb_build_object('row_index', v_row_index, 'site_code', v_site_norm))); v_issue_error_count := v_issue_error_count + 1;
                END IF;

                IF v_site_id IS NOT NULL AND v_import_theoretical_scope = 'BY_SITE' AND v_location_code <> '' THEN
                    v_has_error := true; v_row_issues := v_row_issues || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('severity','ERROR','code','LOCATION_OUT_OF_CAMPAIGN','field','entered_location_code','message','La importacion BY_SITE no admite ubicacion.','metadata',pg_catalog.jsonb_build_object('row_index', v_row_index, 'scope', v_import_theoretical_scope))); v_issue_error_count := v_issue_error_count + 1;
                END IF;

                IF v_import_theoretical_scope = 'BY_LOCATION' THEN
                    IF v_location_code = '' THEN
                        v_has_error := true; v_row_issues := v_row_issues || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('severity','ERROR','code','UNKNOWN_LOCATION','field','entered_location_code','message','La ubicacion es obligatoria.','metadata',pg_catalog.jsonb_build_object('row_index', v_row_index, 'site_code', v_site_norm))); v_issue_error_count := v_issue_error_count + 1;
                    ELSIF v_site_id IS NOT NULL THEN
                        v_location_norm := pg_catalog.upper(pg_catalog.btrim(v_location_code));
                        SELECT count(*) INTO v_location_count FROM inventarios.inventory_site_locations l WHERE l.company_id = p_company_id AND l.inventory_site_id = v_site_id AND pg_catalog.upper(pg_catalog.btrim(l.code)) = v_location_norm;
                        IF v_location_count = 1 THEN
                            SELECT l.id, l.is_active INTO v_location_id, v_location_active FROM inventarios.inventory_site_locations l WHERE l.company_id = p_company_id AND l.inventory_site_id = v_site_id AND pg_catalog.upper(pg_catalog.btrim(l.code)) = v_location_norm LIMIT 1;
                            IF NOT v_location_active THEN
                                v_has_error := true; v_row_issues := v_row_issues || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('severity','ERROR','code','UNKNOWN_LOCATION','field','entered_location_code','message','La ubicacion no existe o no esta habilitada.','metadata',pg_catalog.jsonb_build_object('row_index', v_row_index, 'location_code', v_location_norm))); v_issue_error_count := v_issue_error_count + 1; v_location_id := NULL;
                            ELSE
                                SELECT ics.id, ics.location_scope INTO v_campaign_site_id, v_campaign_site_location_scope FROM inventarios.inventory_campaign_sites ics WHERE ics.company_id = p_company_id AND ics.campaign_id = v_import_campaign_id AND ics.inventory_site_id = v_site_id LIMIT 1;
                                IF NOT FOUND THEN
                                    v_has_error := true; v_row_issues := v_row_issues || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('severity','ERROR','code','SITE_OUT_OF_CAMPAIGN','field','entered_site_code','message','La unidad no pertenece a la campana.','metadata',pg_catalog.jsonb_build_object('row_index', v_row_index, 'site_code', v_site_norm, 'campaign_id', v_import_campaign_id))); v_issue_error_count := v_issue_error_count + 1; v_location_id := NULL;
                                ELSIF v_campaign_site_location_scope = 'SELECTED' AND NOT EXISTS (SELECT 1 FROM inventarios.inventory_campaign_site_locations icl WHERE icl.company_id = p_company_id AND icl.campaign_site_id = v_campaign_site_id AND icl.inventory_site_location_id = v_location_id) THEN
                                    v_has_error := true; v_row_issues := v_row_issues || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('severity','ERROR','code','LOCATION_OUT_OF_CAMPAIGN','field','entered_location_code','message','La ubicacion no pertenece al alcance congelado de la campana.','metadata',pg_catalog.jsonb_build_object('row_index', v_row_index, 'location_code', v_location_norm, 'campaign_site_id', v_campaign_site_id, 'location_scope', v_campaign_site_location_scope))); v_issue_error_count := v_issue_error_count + 1; v_location_id := NULL;
                                END IF;
                            END IF;
                        ELSIF v_location_count > 1 THEN
                            v_has_error := true; v_row_issues := v_row_issues || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('severity','ERROR','code','AMBIGUOUS_LOCATION','field','entered_location_code','message','La ubicacion coincide con mas de un registro.','metadata',pg_catalog.jsonb_build_object('row_index', v_row_index, 'location_code', v_location_norm, 'inventory_site_id', v_site_id))); v_issue_error_count := v_issue_error_count + 1;
                        ELSIF EXISTS (SELECT 1 FROM inventarios.inventory_site_locations l2 WHERE l2.company_id = p_company_id AND l2.inventory_site_id <> v_site_id AND pg_catalog.upper(pg_catalog.btrim(l2.code)) = v_location_norm) THEN
                            v_has_error := true; v_row_issues := v_row_issues || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('severity','ERROR','code','LOCATION_SITE_MISMATCH','field','entered_location_code','message','La ubicacion pertenece a otra unidad.','metadata',pg_catalog.jsonb_build_object('row_index', v_row_index, 'location_code', v_location_norm, 'inventory_site_id', v_site_id))); v_issue_error_count := v_issue_error_count + 1;
                        ELSE
                            v_has_error := true; v_row_issues := v_row_issues || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('severity','ERROR','code','UNKNOWN_LOCATION','field','entered_location_code','message','La ubicacion no existe en la unidad seleccionada.','metadata',pg_catalog.jsonb_build_object('row_index', v_row_index, 'location_code', v_location_norm, 'inventory_site_id', v_site_id))); v_issue_error_count := v_issue_error_count + 1;
                        END IF;
                    END IF;
                END IF;
            END IF;
        END IF;

        IF NOT v_has_error AND v_product_id IS NOT NULL THEN
            v_key := CASE WHEN v_import_theoretical_scope = 'TOTAL_CAMPAIGN' THEN v_product_id::text WHEN v_import_theoretical_scope = 'BY_SITE' THEN v_product_id::text || '|' || v_site_id::text ELSE v_product_id::text || '|' || v_site_id::text || '|' || v_location_id::text END;
            IF v_seen_combos ? v_key THEN
                v_has_error := true; v_row_issues := v_row_issues || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('severity','ERROR','code','DUPLICATE_LOGICAL_ROW','field','sku','message','La combinacion logica de la fila esta duplicada.','metadata',pg_catalog.jsonb_build_object('row_index', v_row_index, 'combo_key', v_key, 'scope', v_import_theoretical_scope))); v_issue_error_count := v_issue_error_count + 1;
            ELSE
                v_seen_combos := v_seen_combos || pg_catalog.jsonb_build_object(v_key, true);
            END IF;
        END IF;

        INSERT INTO inventarios.stock_import_rows(
            company_id, import_id, row_index, sku, barcode, entered_name, entered_description, product_id, bsale_variant_id, inventory_site_id, inventory_site_location_id, location_id, theoretical_quantity, unit_cost, row_status, entered_site_code, resolved_inventory_site_id, entered_location_code, created_at, created_by
        ) VALUES (
            p_company_id, p_import_id, v_row_index, v_sku, NULLIF(v_barcode, ''), NULLIF(v_entered_name, ''), NULLIF(v_entered_description, ''), v_product_id, v_product_bsale_variant_id, v_site_id, v_location_id, NULL, v_quantity, v_cost, CASE WHEN v_has_error THEN 'ERROR' WHEN v_has_warning THEN 'WARNING' ELSE 'VALID' END, NULLIF(v_site_code, ''), v_site_id, NULLIF(v_location_code, ''), v_now, v_actor_id
        ) RETURNING id INTO v_row_id;

        FOR v_issue IN SELECT value FROM pg_catalog.jsonb_array_elements(v_row_issues) LOOP
            INSERT INTO inventarios.stock_import_row_issues(company_id, import_id, row_id, row_index, issue_level, issue_code, field, safe_message, metadata)
            VALUES (p_company_id, p_import_id, v_row_id, v_row_index, v_issue->>'severity', v_issue->>'code', NULLIF(v_issue->>'field', ''), v_issue->>'message', COALESCE(v_issue->'metadata', '{}'::jsonb));
        END LOOP;

        v_total_rows := v_total_rows + 1;
        IF v_has_error THEN v_error_rows := v_error_rows + 1; ELSIF v_has_warning THEN v_warning_rows := v_warning_rows + 1; ELSE v_valid_rows := v_valid_rows + 1; END IF;
    END LOOP;

    -- Cobertura selectiva: solo los productos seleccionados deben aparecer al menos una vez.
    IF v_campaign_product_scope = 'SELECTED' THEN
        IF v_import_theoretical_scope = 'TOTAL_CAMPAIGN' THEN
            FOR v_coverage IN
                SELECT cp.product_id, cp.sku
                FROM inventarios.inventory_campaign_products cp
                WHERE cp.company_id = p_company_id
                  AND cp.campaign_id = v_import_campaign_id
                  AND NOT EXISTS (
                      SELECT 1
                      FROM inventarios.stock_import_rows r
                      WHERE r.company_id = p_company_id
                        AND r.import_id = p_import_id
                        AND r.row_status <> 'ERROR'
                        AND r.product_id = cp.product_id
                  )
            LOOP
                v_issue_error_count := v_issue_error_count + 1;
                INSERT INTO inventarios.stock_import_row_issues(company_id, import_id, row_id, row_index, issue_level, issue_code, field, safe_message, metadata)
                VALUES (
                    p_company_id,
                    p_import_id,
                    NULL,
                    NULL,
                    'ERROR',
                    'MISSING_SELECTED_PRODUCT_COVERAGE',
                    'product_id',
                    'El producto seleccionado no aparece una vez en el archivo.',
                    pg_catalog.jsonb_build_object('product_id', v_coverage.product_id, 'sku', v_coverage.sku, 'scope', v_import_theoretical_scope)
                );
            END LOOP;
        ELSIF v_import_theoretical_scope = 'BY_SITE' THEN
            FOR v_coverage IN
                SELECT cp.product_id, cp.sku, ics.inventory_site_id, s.code AS site_code
                FROM inventarios.inventory_campaign_products cp
                JOIN inventarios.inventory_campaign_sites ics ON ics.company_id = cp.company_id AND ics.campaign_id = cp.campaign_id
                JOIN inventarios.inventory_sites s ON s.company_id = ics.company_id AND s.id = ics.inventory_site_id
                WHERE cp.company_id = p_company_id
                  AND cp.campaign_id = v_import_campaign_id
                  AND NOT EXISTS (
                      SELECT 1
                      FROM inventarios.stock_import_rows r
                      WHERE r.company_id = p_company_id
                        AND r.import_id = p_import_id
                        AND r.row_status <> 'ERROR'
                        AND r.product_id = cp.product_id
                        AND r.resolved_inventory_site_id = ics.inventory_site_id
                  )
            LOOP
                v_issue_error_count := v_issue_error_count + 1;
                INSERT INTO inventarios.stock_import_row_issues(company_id, import_id, row_id, row_index, issue_level, issue_code, field, safe_message, metadata)
                VALUES (
                    p_company_id,
                    p_import_id,
                    NULL,
                    NULL,
                    'ERROR',
                    'MISSING_SELECTED_PRODUCT_COVERAGE',
                    'resolved_inventory_site_id',
                    'El producto seleccionado no aparece una vez en cada unidad de la campana.',
                    pg_catalog.jsonb_build_object('product_id', v_coverage.product_id, 'sku', v_coverage.sku, 'inventory_site_id', v_coverage.inventory_site_id, 'site_code', v_coverage.site_code, 'scope', v_import_theoretical_scope)
                );
            END LOOP;
        ELSE
            FOR v_coverage IN
                SELECT cp.product_id, cp.sku, ics.inventory_site_id, s.code AS site_code, loc.id AS inventory_site_location_id, loc.code AS location_code
                FROM inventarios.inventory_campaign_products cp
                JOIN inventarios.inventory_campaign_sites ics ON ics.company_id = cp.company_id AND ics.campaign_id = cp.campaign_id
                JOIN inventarios.inventory_sites s ON s.company_id = ics.company_id AND s.id = ics.inventory_site_id
                JOIN inventarios.inventory_site_locations loc ON loc.company_id = ics.company_id AND loc.inventory_site_id = ics.inventory_site_id
                LEFT JOIN inventarios.inventory_campaign_site_locations icl ON icl.company_id = ics.company_id AND icl.campaign_site_id = ics.id AND icl.inventory_site_location_id = loc.id
                WHERE cp.company_id = p_company_id
                  AND cp.campaign_id = v_import_campaign_id
                  AND ((ics.location_scope = 'ALL' AND loc.is_active = true) OR (ics.location_scope = 'SELECTED' AND icl.inventory_site_location_id IS NOT NULL))
                  AND NOT EXISTS (
                      SELECT 1
                      FROM inventarios.stock_import_rows r
                      WHERE r.company_id = p_company_id
                        AND r.import_id = p_import_id
                        AND r.row_status <> 'ERROR'
                        AND r.product_id = cp.product_id
                        AND r.resolved_inventory_site_id = ics.inventory_site_id
                        AND r.inventory_site_location_id = loc.id
                  )
            LOOP
                v_issue_error_count := v_issue_error_count + 1;
                INSERT INTO inventarios.stock_import_row_issues(company_id, import_id, row_id, row_index, issue_level, issue_code, field, safe_message, metadata)
                VALUES (
                    p_company_id,
                    p_import_id,
                    NULL,
                    NULL,
                    'ERROR',
                    'MISSING_SELECTED_PRODUCT_COVERAGE',
                    'inventory_site_location_id',
                    'El producto seleccionado no aparece una vez en cada ubicacion congelada de la campana.',
                    pg_catalog.jsonb_build_object('product_id', v_coverage.product_id, 'sku', v_coverage.sku, 'inventory_site_id', v_coverage.inventory_site_id, 'site_code', v_coverage.site_code, 'inventory_site_location_id', v_coverage.inventory_site_location_id, 'location_code', v_coverage.location_code, 'scope', v_import_theoretical_scope)
                );
            END LOOP;
        END IF;
    END IF;

    v_final_status := CASE WHEN v_error_rows = 0 AND v_issue_error_count = 0 THEN 'VALIDATED' ELSE 'REJECTED' END;
    UPDATE inventarios.stock_imports SET row_count = v_total_rows, error_count = v_error_rows, warning_count = v_warning_rows, file_issues = COALESCE(p_file_issues, '[]'::jsonb), validated_at = v_now, validated_by = v_actor_id, updated_at = v_now, updated_by = v_actor_id, status = v_final_status WHERE company_id = p_company_id AND id = p_import_id;

    RETURN inventarios.complete_idempotent_operation(
        p_company_id,
        v_operation_id,
        p_import_id,
        pg_catalog.jsonb_build_object('operation','inventarios.validate_campaign_stock_import','entity_id',p_import_id,'state',v_final_status,'version',NULL::integer,'cycle_number',NULL::integer,'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,'occurred_at',v_now,'data',pg_catalog.jsonb_build_object('import_id',p_import_id,'campaign_id',v_import_campaign_id,'theoretical_scope',v_import_theoretical_scope,'status',v_final_status,'row_count',v_total_rows,'valid_rows',v_valid_rows,'warning_rows',v_warning_rows,'error_rows',v_error_rows,'issue_warning_count',v_issue_warning_count,'issue_error_count',v_issue_error_count))
    );
END;
$$;

ALTER FUNCTION inventarios.validate_campaign_stock_import(uuid, uuid, jsonb, jsonb, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.validate_campaign_stock_import(uuid, uuid, jsonb, jsonb, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.validate_campaign_stock_import(uuid, uuid, jsonb, jsonb, uuid) TO authenticated;
