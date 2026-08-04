-- Migration: 20260803190300_inventarios_prepare_import_session.sql
-- Description: Fase 4I.3B. Preparacion EXCEL_IMPORT: snapshot congelado,
--              consumo de importacion y DRAFT->PREPARED.
-- Author: Assistant

-- PREPARE INVENTORY SESSION FROM IMPORT (EXCEL_IMPORT)
CREATE OR REPLACE FUNCTION inventarios.prepare_inventory_session_from_import(
    p_company_id uuid,
    p_session_id uuid,
    p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_operation jsonb; v_operation_id uuid;
    v_occurred_at timestamptz;
    v_session_status text;
    v_session_site_id uuid;
    v_session_campaign_id uuid;
    v_session_product_scope text;
    v_session_location_scope text;
    v_import_id uuid;
    v_import_status text;
    v_import_site_id uuid;
    v_import_consumed_session_id uuid;
    v_import_modality text;
    v_import_cutoff timestamptz;
    v_import_sha char(64);
    v_import_storage_path text;
    v_import_filename text;
    v_import_currency text;
    v_import_template_version text;
    v_site_type text;
    v_site_warehouse_id uuid;
    v_warehouse_id uuid;
    v_snapshot_id uuid;
    v_snapshot_status text;
    v_scope_location_count bigint;
    v_product_count bigint;
    v_theoretical_count bigint;
    v_cost_count bigint;
    v_hash text;
    v_outside_product boolean;
    v_outside_location boolean;
    v_response jsonb;
    v_payload jsonb;BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.configure');
    v_occurred_at := pg_catalog.now();

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.prepare_inventory_session_from_import'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_session_id::text));

    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.prepare_from_import','company_id',p_company_id,
        'session_id',p_session_id);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.session.prepare_from_import',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    -- ==================================================
    -- BLOQUEAR SESION E IMPORTACION (FOR UPDATE)
    -- ==================================================
    SELECT s.status, s.inventory_site_id, s.campaign_id, s.stock_import_id
    INTO v_session_status, v_session_site_id, v_session_campaign_id, v_import_id
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.id = p_session_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no existe.','retryable',false)::text;
    END IF;
    IF v_session_status = 'PREPARED' OR v_session_status = 'COUNTING'
       OR v_session_status = 'UNDER_REVIEW' OR v_session_status = 'APPROVED'
       OR v_session_status = 'EXPORTED' OR v_session_status = 'RECONCILED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_ALREADY_PREPARED',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada ya fue preparada o esta en una etapa posterior.','retryable',false)::text;
    END IF;
    IF v_session_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no permite esta operacion en su estado actual.','retryable',false,'status',v_session_status)::text;
    END IF;
    IF v_import_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_SCOPE_MISMATCH',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no tiene una importacion asociada.','retryable',false)::text;
    END IF;

    SELECT si.status, si.inventory_site_id, si.consumed_session_id, si.modality,
           si.cutoff_at, si.file_sha256, si.storage_path, si.original_filename,
           si.currency, si.template_version
    INTO v_import_status, v_import_site_id, v_import_consumed_session_id, v_import_modality,
         v_import_cutoff, v_import_sha, v_import_storage_path, v_import_filename,
         v_import_currency, v_import_template_version
    FROM inventarios.stock_imports si
    WHERE si.company_id = p_company_id AND si.id = v_import_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion asociada no existe.','retryable',false)::text;
    END IF;
    IF v_import_status <> 'VALIDATED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_NOT_VALIDATED',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion no esta VALIDATED.','retryable',false,'status',v_import_status)::text;
    END IF;
    IF v_import_site_id IS DISTINCT FROM v_session_site_id THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_SITE_MISMATCH',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion no pertenece a la unidad de la jornada.','retryable',false)::text;
    END IF;
    IF v_import_consumed_session_id IS NOT NULL AND v_import_consumed_session_id <> p_session_id THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_ALREADY_ASSIGNED',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion ya esta asociada a otra jornada.','retryable',false)::text;
    END IF;

    SELECT is2.site_type, is2.warehouse_id INTO v_site_type, v_site_warehouse_id
    FROM inventarios.inventory_sites is2
    WHERE is2.company_id = p_company_id AND is2.id = v_session_site_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La unidad inventariable no existe.','retryable',false)::text;
    END IF;
    IF v_site_type = 'INTERNAL_WAREHOUSE' AND v_site_warehouse_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La bodega interna no tiene bodega asociada.','retryable',false)::text;
    END IF;
    IF v_site_type = 'INTERNAL_WAREHOUSE' THEN
        v_warehouse_id := v_site_warehouse_id;
    ELSE
        v_warehouse_id := NULL;
    END IF;

    -- La sesion debe pertenecer al campaign_site correspondiente
    IF v_session_campaign_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM inventarios.inventory_campaign_sites ics
        WHERE ics.company_id = p_company_id AND ics.campaign_id = v_session_campaign_id
          AND ics.inventory_site_id = v_session_site_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_SCOPE_MISMATCH',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no pertenece a la unidad de la campana.','retryable',false)::text;
    END IF;

    -- Alcance de productos: SELECTED o ALL de la campana
    SELECT ic.product_scope INTO v_session_product_scope
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = v_session_campaign_id;
    IF v_session_product_scope IS NULL THEN v_session_product_scope := 'ALL'; END IF;
    SELECT ics.location_scope INTO v_session_location_scope
    FROM inventarios.inventory_campaign_sites ics
    WHERE ics.company_id = p_company_id AND ics.campaign_id = v_session_campaign_id
      AND ics.inventory_site_id = v_session_site_id;
    IF v_session_location_scope IS NULL THEN v_session_location_scope := 'ALL'; END IF;

    -- ==================================================
    -- VALIDACION DEL ALCANCE DEL ARCHIVO
    --   SELECTED: una fila del Excel fuera del alcance bloquea.
    --   POR_UBICACION: una fila con ubicacion fuera del alcance bloquea.
    -- ==================================================
    IF v_session_product_scope = 'SELECTED' THEN
        SELECT EXISTS (
            SELECT 1 FROM inventarios.stock_import_rows r
            WHERE r.company_id = p_company_id AND r.import_id = v_import_id
              AND r.row_status IN ('VALID', 'WARNING')
              AND NOT EXISTS (
                  SELECT 1 FROM inventarios.session_product_scopes sps
                  WHERE sps.company_id = p_company_id AND sps.session_id = p_session_id
                    AND sps.inclusion_type = 'INCLUDED'
                    AND sps.product_id = r.product_id
              )
        ) INTO v_outside_product;
        IF v_outside_product THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_OUTSIDE_PRODUCT_SCOPE',
                DETAIL=pg_catalog.jsonb_build_object('message','El archivo contiene productos fuera del alcance de la jornada.','retryable',false)::text;
        END IF;
    END IF;

    IF v_import_modality = 'POR_UBICACION' AND v_session_location_scope = 'SELECTED' THEN
        SELECT EXISTS (
            SELECT 1 FROM inventarios.stock_import_rows r
            WHERE r.company_id = p_company_id AND r.import_id = v_import_id
              AND r.row_status IN ('VALID', 'WARNING')
              AND NOT EXISTS (
                  SELECT 1 FROM inventarios.session_location_scopes slc
                  WHERE slc.company_id = p_company_id AND slc.session_id = p_session_id
                    AND slc.inclusion_type = 'INCLUDED'
                    AND slc.inventory_site_location_id = r.inventory_site_location_id
              )
        ) INTO v_outside_location;
        IF v_outside_location THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_OUTSIDE_LOCATION_SCOPE',
                DETAIL=pg_catalog.jsonb_build_object('message','El archivo contiene ubicaciones fuera del alcance de la jornada.','retryable',false)::text;
        END IF;
    END IF;

    -- ==================================================
    -- SNAPSHOT: ubicaciones, productos, stock teorico y costos
    -- ==================================================
    SELECT os.id, os.completion_status INTO v_snapshot_id, v_snapshot_status
    FROM inventarios.operational_snapshots os
    WHERE os.company_id = p_company_id AND os.session_id = p_session_id
    FOR UPDATE OF os;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SNAPSHOT_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no tiene snapshot pendiente.','retryable',false)::text;
    END IF;
    IF v_snapshot_status <> 'PENDING' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SNAPSHOT_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','El snapshot no esta en estado pendiente.','retryable',false,'status',v_snapshot_status)::text;
    END IF;

    -- Reemplazo controlado de contenido previo del snapshot
    DELETE FROM inventarios.snapshot_unit_costs WHERE company_id = p_company_id AND snapshot_id = v_snapshot_id;
    DELETE FROM inventarios.snapshot_theoretical_stocks WHERE company_id = p_company_id AND snapshot_id = v_snapshot_id;
    DELETE FROM inventarios.snapshot_stocks WHERE company_id = p_company_id AND snapshot_id = v_snapshot_id;
    DELETE FROM inventarios.snapshot_products WHERE company_id = p_company_id AND snapshot_id = v_snapshot_id;
    DELETE FROM inventarios.snapshot_locations WHERE company_id = p_company_id AND snapshot_id = v_snapshot_id;

    -- 7. Ubicaciones congeladas desde inventory_site_locations (fuente canonica)
    INSERT INTO inventarios.snapshot_locations (
        company_id, snapshot_id, inventory_site_location_id, source_logistics_location_id,
        location_id, warehouse_id, code, name, aisle, rack, level, position, is_active,
        created_at, created_by
    )
    SELECT slc.company_id, v_snapshot_id, isl.id, isl.source_logistics_location_id,
           isl.source_logistics_location_id, v_warehouse_id, isl.code, isl.name,
           isl.aisle, isl.rack, isl.level, isl.position, isl.is_active,
           v_occurred_at, v_actor_id
    FROM inventarios.session_location_scopes slc
    JOIN inventarios.inventory_site_locations isl
      ON isl.company_id = slc.company_id AND isl.id = slc.inventory_site_location_id
    WHERE slc.company_id = p_company_id AND slc.session_id = p_session_id
      AND slc.inclusion_type = 'INCLUDED'
    ON CONFLICT (company_id, snapshot_id, inventory_site_location_id) WHERE inventory_site_location_id IS NOT NULL DO NOTHING;

    SELECT pg_catalog.count(*) INTO v_scope_location_count
    FROM inventarios.session_location_scopes slc
    WHERE slc.company_id = p_company_id AND slc.session_id = p_session_id
      AND slc.inclusion_type = 'INCLUDED';
    IF v_scope_location_count < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SNAPSHOT_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no tiene ubicaciones en su alcance.','retryable',false,'scope_location_count',v_scope_location_count)::text;
    END IF;

    -- 8. Productos congelados.
    --    SELECTED: exactamente los INCLUDED de session_product_scopes.
    --    ALL: catalogo interno activo (global + empresa) + productos del
    --         archivo que correspondan al catalogo.
    IF v_session_product_scope = 'SELECTED' THEN
        INSERT INTO inventarios.snapshot_products (
            company_id, snapshot_id, product_id, bsale_variant_id, sku, barcode, name, product_metadata, created_at, created_by
        )
        SELECT sps.company_id, v_snapshot_id, sps.product_id, p.bsale_variant_id,
               p.sku, p.barcode, coalesce(pg_catalog.btrim(p.description), p.sku),
               pg_catalog.jsonb_build_object('entered_name', NULL::text),
               v_occurred_at, v_actor_id
        FROM inventarios.session_product_scopes sps
        JOIN adquisiciones.products p ON p.id = sps.product_id
        WHERE sps.company_id = p_company_id AND sps.session_id = p_session_id
          AND sps.inclusion_type = 'INCLUDED'
        ON CONFLICT (company_id, snapshot_id, product_id) WHERE product_id IS NOT NULL DO NOTHING;
    ELSE
        INSERT INTO inventarios.snapshot_products (
            company_id, snapshot_id, product_id, bsale_variant_id, sku, barcode, name, product_metadata, created_at, created_by
        )
        SELECT p.company_id, v_snapshot_id, p.id, p.bsale_variant_id,
               p.sku, p.barcode, coalesce(pg_catalog.btrim(p.description), p.sku),
               pg_catalog.jsonb_build_object('entered_name', NULL::text),
               v_occurred_at, v_actor_id
        FROM adquisiciones.products p
        WHERE (p.company_id = p_company_id OR p.company_id IS NULL)
          AND p.is_active = true
        ON CONFLICT (company_id, snapshot_id, product_id) WHERE product_id IS NOT NULL DO NOTHING;

        -- Productos validos del archivo que correspondan al catalogo interno
        INSERT INTO inventarios.snapshot_products (
            company_id, snapshot_id, product_id, bsale_variant_id, sku, barcode, name, product_metadata, created_at, created_by
        )
        SELECT r.company_id, v_snapshot_id, r.product_id, p.bsale_variant_id,
               p.sku, p.barcode, coalesce(pg_catalog.btrim(p.description), p.sku),
               pg_catalog.jsonb_build_object('entered_name', r.entered_name),
               v_occurred_at, v_actor_id
        FROM inventarios.stock_import_rows r
        JOIN adquisiciones.products p ON p.id = r.product_id
        WHERE r.company_id = p_company_id AND r.import_id = v_import_id
          AND r.row_status IN ('VALID', 'WARNING')
          AND r.product_id IS NOT NULL
        ON CONFLICT (company_id, snapshot_id, product_id) WHERE product_id IS NOT NULL DO NOTHING;
    END IF;

    SELECT pg_catalog.count(*) INTO v_product_count
    FROM inventarios.snapshot_products sp
    WHERE sp.company_id = p_company_id AND sp.snapshot_id = v_snapshot_id;
    IF v_product_count < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SNAPSHOT_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','El snapshot no pudo construirse con productos.','retryable',false,'product_count',v_product_count)::text;
    END IF;

    -- 9. Stock teorico.
    --    GENERAL: scope_level=WAREHOUSE, un total por producto (0 si ausente).
    --    POR_UBICACION: scope_level=LOCATION por producto+ubicacion; las
    --    combinaciones ausentes se interpretan como 0 (no se materializan).
    IF v_import_modality = 'GENERAL' THEN
        INSERT INTO inventarios.snapshot_theoretical_stocks (
            company_id, snapshot_id, snapshot_product_id, scope_level, snapshot_location_id,
            theoretical_quantity, created_at, created_by
        )
        SELECT sp.company_id, v_snapshot_id, sp.id, 'WAREHOUSE', NULL,
               coalesce(
                   (SELECT pg_catalog.sum(r.theoretical_quantity)
                    FROM inventarios.stock_import_rows r
                    WHERE r.company_id = p_company_id AND r.import_id = v_import_id
                      AND r.product_id = sp.product_id AND r.row_status IN ('VALID','WARNING')),
                   0
               ),
               v_occurred_at, v_actor_id
        FROM inventarios.snapshot_products sp
        WHERE sp.company_id = p_company_id AND sp.snapshot_id = v_snapshot_id
        ON CONFLICT (company_id, snapshot_id, snapshot_product_id)
            WHERE scope_level = 'WAREHOUSE' DO NOTHING;
    ELSE
        INSERT INTO inventarios.snapshot_theoretical_stocks (
            company_id, snapshot_id, snapshot_product_id, scope_level, snapshot_location_id,
            theoretical_quantity, created_at, created_by
        )
        SELECT r.company_id, v_snapshot_id, sp.id, 'LOCATION', sl.id,
               r.theoretical_quantity, v_occurred_at, v_actor_id
        FROM inventarios.stock_import_rows r
        JOIN inventarios.snapshot_products sp
          ON sp.company_id = r.company_id AND sp.snapshot_id = v_snapshot_id AND sp.product_id = r.product_id
        JOIN inventarios.snapshot_locations sl
          ON sl.company_id = r.company_id AND sl.snapshot_id = v_snapshot_id
         AND sl.inventory_site_location_id = r.inventory_site_location_id
        WHERE r.company_id = p_company_id AND r.import_id = v_import_id
          AND r.row_status IN ('VALID', 'WARNING')
          AND r.product_id IS NOT NULL AND r.inventory_site_location_id IS NOT NULL
          AND r.theoretical_quantity IS NOT NULL
        ON CONFLICT (company_id, snapshot_id, snapshot_product_id, snapshot_location_id)
            WHERE scope_level = 'LOCATION' DO NOTHING;
    END IF;

    -- 10. Costos congelados (un costo por producto; ausente = valorizacion incompleta)
    INSERT INTO inventarios.snapshot_unit_costs (
        company_id, snapshot_id, snapshot_product_id, unit_cost, currency, source,
        captured_at, has_cost, valuation_status, created_at, created_by
    )
    SELECT sp.company_id, v_snapshot_id, sp.id,
           coalesce(
               (SELECT r.unit_cost FROM inventarios.stock_import_rows r
                WHERE r.company_id = p_company_id AND r.import_id = v_import_id
                  AND r.product_id = sp.product_id AND r.row_status IN ('VALID','WARNING')
                ORDER BY r.row_index LIMIT 1),
               NULL
           ),
           'CLP', 'EXCEL_IMPORT', v_occurred_at,
           coalesce(
               (SELECT (r.unit_cost > 0) FROM inventarios.stock_import_rows r
                WHERE r.company_id = p_company_id AND r.import_id = v_import_id
                  AND r.product_id = sp.product_id AND r.row_status IN ('VALID','WARNING')
                ORDER BY r.row_index LIMIT 1),
               false
           ),
           CASE
               WHEN coalesce(
                   (SELECT (r.unit_cost > 0) FROM inventarios.stock_import_rows r
                    WHERE r.company_id = p_company_id AND r.import_id = v_import_id
                      AND r.product_id = sp.product_id AND r.row_status IN ('VALID','WARNING')
                    ORDER BY r.row_index LIMIT 1),
                   false
               ) THEN 'COMPLETE'
               ELSE 'INCOMPLETE_NO_COST'
           END,
           v_occurred_at, v_actor_id
    FROM inventarios.snapshot_products sp
    WHERE sp.company_id = p_company_id AND sp.snapshot_id = v_snapshot_id
    ON CONFLICT (company_id, snapshot_id, snapshot_product_id) DO NOTHING;

    SELECT pg_catalog.count(*) INTO v_theoretical_count
    FROM inventarios.snapshot_theoretical_stocks st
    WHERE st.company_id = p_company_id AND st.snapshot_id = v_snapshot_id;

    SELECT pg_catalog.count(*) INTO v_cost_count
    FROM inventarios.snapshot_unit_costs uc
    WHERE uc.company_id = p_company_id AND uc.snapshot_id = v_snapshot_id;

    -- ==================================================
    -- HASH DETERMINISTA (productos, ubicaciones, stocks, costos, importacion)
    -- ==================================================
    SELECT pg_catalog.encode(
        extensions.digest(
            pg_catalog.convert_to(
                pg_catalog.string_agg(t.line, E'\n' ORDER BY t.line),
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    )
    INTO v_hash
    FROM (
        SELECT 'P:' || sp.product_id::text || '|' || coalesce(sp.sku,'') AS line
        FROM inventarios.snapshot_products sp
        WHERE sp.company_id = p_company_id AND sp.snapshot_id = v_snapshot_id
        UNION ALL
        SELECT 'L:' || sl.inventory_site_location_id::text || '|' || coalesce(sl.code,'')
        FROM inventarios.snapshot_locations sl
        WHERE sl.company_id = p_company_id AND sl.snapshot_id = v_snapshot_id
        UNION ALL
        SELECT 'S:' || sp.product_id::text || '|' || coalesce(sl.inventory_site_location_id::text,'') || '|' || st.theoretical_quantity::text
        FROM inventarios.snapshot_theoretical_stocks st
        JOIN inventarios.snapshot_products sp ON sp.company_id = st.company_id AND sp.snapshot_id = st.snapshot_id AND sp.id = st.snapshot_product_id
        LEFT JOIN inventarios.snapshot_locations sl ON sl.company_id = st.company_id AND sl.snapshot_id = st.snapshot_id AND sl.id = st.snapshot_location_id
        WHERE st.company_id = p_company_id AND st.snapshot_id = v_snapshot_id
        UNION ALL
        SELECT 'C:' || sp.product_id::text || '|' || coalesce(uc.unit_cost::text,'')
        FROM inventarios.snapshot_unit_costs uc
        JOIN inventarios.snapshot_products sp ON sp.company_id = uc.company_id AND sp.snapshot_id = uc.snapshot_id AND sp.id = uc.snapshot_product_id
        WHERE uc.company_id = p_company_id AND uc.snapshot_id = v_snapshot_id
        UNION ALL
        SELECT 'I:' || v_import_id::text || '|' || v_import_cutoff::text || '|' || coalesce(v_import_sha,'')
    ) AS t;

    -- ==================================================
    -- FINALIZAR SNAPSHOT, CONSUMIR IMPORTACION Y TRANSICIONAR
    -- ==================================================
    UPDATE inventarios.operational_snapshots AS os
    SET completion_status = 'COMPLETED',
        content_hash = v_hash,
        captured_at = v_occurred_at,
        captured_by = v_actor_id,
        stock_source = 'EXCEL_IMPORT',
        stock_import_id = v_import_id,
        inventory_site_id = v_session_site_id,
        warehouse_id = v_warehouse_id,
        cutoff_at = v_import_cutoff,
        modality = v_import_modality,
        currency = v_import_currency,
        file_sha256 = v_import_sha,
        template_version = v_import_template_version
    WHERE os.company_id = p_company_id AND os.id = v_snapshot_id;

    UPDATE inventarios.sessions AS s
    SET status = 'PREPARED',
        prepared_at = v_occurred_at,
        warehouse_id = v_warehouse_id,
        inventory_site_id = v_session_site_id,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE s.company_id = p_company_id AND s.id = p_session_id
      AND s.status = 'DRAFT';
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
            DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;

    -- La importacion solo pasa a CONSUMED despues de todo lo anterior
    UPDATE inventarios.stock_imports AS si
    SET status = 'CONSUMED',
        consumed_session_id = p_session_id,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE si.company_id = p_company_id AND si.id = v_import_id
      AND si.status = 'VALIDATED';
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
            DETAIL=pg_catalog.jsonb_build_object('message','No se pudo consumir la importacion.','retryable',true)::text;
    END IF;

    -- Auditoria
    INSERT INTO portal.audit_logs (
        schema_name, module_code, table_name, record_id, action,
        old_data, new_data, performed_by, event_type, severity
    ) VALUES (
        'inventarios', 'inventarios', 'sessions', p_session_id, 'PREPARE_IMPORT',
        pg_catalog.jsonb_build_object('status', 'DRAFT'),
        pg_catalog.jsonb_build_object('status', 'PREPARED', 'snapshot_id', v_snapshot_id,
            'stock_import_id', v_import_id, 'content_hash', v_hash),
        v_actor_id, 'inventory_session_prepared_from_import', 'INFO'
    );

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.prepare_from_import','entity_id',p_session_id,
        'state','PREPARED','version',NULL::integer,'cycle_number',NULL::integer,
        'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object('session_id',p_session_id,
            'snapshot_id',v_snapshot_id,'completion_status','COMPLETED',
            'content_hash',v_hash,'prepared_at',v_occurred_at,
            'stock_import_id',v_import_id,'stock_import_status','CONSUMED',
            'product_count',v_product_count,'theoretical_count',v_theoretical_count,
            'cost_count',v_cost_count,'scope_location_count',v_scope_location_count));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_session_id, v_response);
END;
$$;

