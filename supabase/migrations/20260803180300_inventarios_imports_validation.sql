-- Migration: 20260803180300_inventarios_imports_validation.sql
-- Description: Fase 4I.3A. Núcleo de validacion y persistencia de filas de
--              importacion de stock/costo: _process_stock_import_rows,
--              validate_stock_import y revalidate_stock_import.
--              Valida productos, ubicaciones, cantidades, costos, duplicados
--              y consistencia de costo por SKU, persistiendo filas y multiples
--              issues por fila de forma transaccional.
-- Author: Assistant

-- ============================================================
-- CORE DE VALIDACION
--   p_file_issues: jsonb array de {level, code, message} a nivel archivo.
--   p_rows: jsonb array de filas parseadas en servidor:
--           {row_index, sku, barcode, entered_name, location_code,
--            quantity, cost, formula_fields[]}
--   p_mode: 'VALIDATE' | 'REVALIDATE'
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios._process_stock_import_rows(
    p_company_id uuid,
    p_import_id uuid,
    p_file_sha256 char(64),
    p_file_issues jsonb,
    p_rows jsonb,
    p_mode text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_occurred_at timestamptz;
    v_mode text;
    v_import_status text;
    v_site_type text;
    v_warehouse_id uuid;
    v_site_id uuid;
    v_modality text;
    v_cutoff timestamptz;
    v_current_storage_path text;
    v_rows_total int;
    v_existing_id uuid;
    v_existing_status text;
    v_row jsonb;
    v_row_index int;
    v_sku text;
    v_barcode text;
    v_entered_name text;
    v_loc_code text;
    v_qty_text text;
    v_cost_text text;
    v_formula text[];
    v_has_error boolean;
    v_has_warning boolean;
    v_product_id uuid;
    v_product_barcode text;
    v_bsale_variant_id int;
    v_product_cnt bigint;
    v_loc_id uuid;
    v_loc_active boolean;
    v_src_logistics_loc uuid;
    v_qty numeric;
    v_cost numeric;
    v_key text;
    v_row_status text;
    v_error_count int := 0;
    v_warning_count int := 0;
    v_row_count int := 0;
    v_file_error boolean;
    v_final_status text;
    v_response jsonb;
    v_cost_map jsonb := '{}'::jsonb;
    v_seen_map jsonb := '{}'::jsonb;
    v_issues_agg jsonb := '[]'::jsonb;
    v_issue jsonb;
BEGIN
    IF p_company_id IS NULL OR p_import_id IS NULL OR p_rows IS NULL
       OR pg_catalog.jsonb_typeof(p_rows) <> 'array' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_mode := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_mode, 'VALIDATE')));
    IF v_mode NOT IN ('VALIDATE', 'REVALIDATE') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.imports.manage');
    v_occurred_at := pg_catalog.now();

    SELECT si.status, si.inventory_site_id, si.modality, si.cutoff_at, si.storage_path
    INTO v_import_status, v_site_id, v_modality, v_cutoff, v_current_storage_path
    FROM inventarios.stock_imports si
    WHERE si.company_id = p_company_id AND si.id = p_import_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion no existe.','retryable',false)::text;
    END IF;

    IF v_import_status = 'CONSUMED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_CONSUMED',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion ya fue consumida.','retryable',false)::text;
    END IF;

    IF v_mode = 'VALIDATE' AND v_import_status NOT IN ('DRAFT', 'REJECTED') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion no admite validacion en su estado actual.','retryable',false)::text;
    END IF;

    SELECT site_type, warehouse_id INTO v_site_type, v_warehouse_id
    FROM inventarios.inventory_sites
    WHERE company_id = p_company_id AND id = v_site_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La unidad inventariable no existe.','retryable',false)::text;
    END IF;
    IF v_site_type = 'INTERNAL_WAREHOUSE' AND v_warehouse_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La bodega interna no tiene bodega asociada.','retryable',false)::text;
    END IF;
    IF v_site_type <> 'INTERNAL_WAREHOUSE' THEN
        v_warehouse_id := NULL;
    END IF;

    -- ========================================================
    -- IDEMPOTENCIA: mismo archivo + sitio + modalidad + corte
    -- devuelve la importacion existente (no crea duplicado).
    -- CONSUMED no se reutiliza.
    -- ========================================================
    IF p_file_sha256 IS NOT NULL THEN
        SELECT si.id, si.status INTO v_existing_id, v_existing_status
        FROM inventarios.stock_imports si
        WHERE si.company_id = p_company_id
          AND si.inventory_site_id = v_site_id
          AND si.modality = v_modality
          AND si.cutoff_at = v_cutoff
          AND si.file_sha256 = p_file_sha256
          AND si.status <> 'CONSUMED'
          AND si.id <> p_import_id
        ORDER BY si.created_at
        LIMIT 1;

        IF v_existing_id IS NOT NULL THEN
            DELETE FROM inventarios.stock_imports
            WHERE company_id = p_company_id AND id = p_import_id;
            RETURN pg_catalog.jsonb_build_object(
                'replayed', true,
                'import_id', v_existing_id,
                'status', v_existing_status,
                'storage_path_to_remove', v_current_storage_path,
                'occurred_at', v_occurred_at
            );
        END IF;
    END IF;

    -- Reemplazo controlado de filas/issues anteriores
    DELETE FROM inventarios.stock_import_rows
    WHERE company_id = p_company_id AND import_id = p_import_id;

    v_rows_total := pg_catalog.jsonb_array_length(p_rows);
    IF v_rows_total > 200000 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','El archivo excede la cantidad maxima de filas.','retryable',false)::text;
    END IF;

    -- ========================================================
    -- CICLO DE VALIDACION POR FILA
    -- ========================================================
    FOR v_row IN SELECT value FROM pg_catalog.jsonb_array_elements(p_rows) LOOP
        v_has_error := false;
        v_has_warning := false;
        v_product_id := NULL;
        v_product_barcode := NULL;
        v_bsale_variant_id := NULL;
        v_loc_id := NULL;
        v_loc_active := false;
        v_src_logistics_loc := NULL;
        v_qty := NULL;
        v_cost := NULL;
        v_row_status := 'VALID';

        v_row_index := COALESCE((v_row->>'row_index')::int, 0);
        v_sku := pg_catalog.btrim(COALESCE(v_row->>'sku', ''));
        v_barcode := pg_catalog.btrim(COALESCE(v_row->>'barcode', ''));
        v_entered_name := pg_catalog.btrim(COALESCE(v_row->>'entered_name', ''));
        v_loc_code := pg_catalog.btrim(COALESCE(v_row->>'location_code', ''));
        v_qty_text := pg_catalog.btrim(COALESCE(v_row->>'quantity', ''));
        v_cost_text := pg_catalog.btrim(COALESCE(v_row->>'cost', ''));
        v_formula := '{}'::text[];
        SELECT COALESCE(
            ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_row->'formula_fields', '[]'::jsonb))),
            '{}'::text[]
        ) INTO v_formula;

        -- Ignora filas completamente vacias
        IF v_sku = '' AND v_barcode = '' AND v_entered_name = '' AND v_loc_code = ''
           AND v_qty_text = '' AND v_cost_text = '' AND pg_catalog.cardinality(v_formula) = 0 THEN
            CONTINUE;
        END IF;

        -- ==================================================
        -- PRODUCTO: resolucion por SKU en la misma empresa
        -- ==================================================
        IF v_sku <> '' THEN
            SELECT count(*) INTO v_product_cnt
            FROM adquisiciones.products p
            WHERE (p.company_id = p_company_id OR p.company_id IS NULL)
              AND p.sku = v_sku;
            IF v_product_cnt = 1 THEN
                SELECT p.id, p.barcode, p.bsale_variant_id INTO v_product_id, v_product_barcode, v_bsale_variant_id
                FROM adquisiciones.products p
                WHERE (p.company_id = p_company_id OR p.company_id IS NULL)
                  AND p.sku = v_sku
                LIMIT 1;
            ELSIF v_product_cnt > 1 THEN
                v_has_error := true;
                v_issues_agg := v_issues_agg || pg_catalog.jsonb_build_object(
                    'row_index', v_row_index, 'level', 'ERROR', 'code', 'AMBIGUOUS_PRODUCT',
                    'message', 'El SKU coincide con mas de un producto.')::jsonb;
            ELSE
                SELECT count(*) INTO v_product_cnt
                FROM adquisiciones.products p
                WHERE (p.company_id = p_company_id OR p.company_id IS NULL)
                  AND pg_catalog.upper(p.sku) = pg_catalog.upper(v_sku);
                IF v_product_cnt = 1 THEN
                    SELECT p.id, p.barcode, p.bsale_variant_id INTO v_product_id, v_product_barcode, v_bsale_variant_id
                    FROM adquisiciones.products p
                    WHERE (p.company_id = p_company_id OR p.company_id IS NULL)
                      AND pg_catalog.upper(p.sku) = pg_catalog.upper(v_sku)
                    LIMIT 1;
                ELSIF v_product_cnt > 1 THEN
                    v_has_error := true;
                    v_issues_agg := v_issues_agg || pg_catalog.jsonb_build_object(
                        'row_index', v_row_index, 'level', 'ERROR', 'code', 'AMBIGUOUS_PRODUCT',
                        'message', 'El SKU coincide con mas de un producto.')::jsonb;
                ELSE
                    v_has_error := true;
                    v_issues_agg := v_issues_agg || pg_catalog.jsonb_build_object(
                        'row_index', v_row_index, 'level', 'ERROR', 'code', 'UNKNOWN_PRODUCT',
                        'message', 'El SKU no existe en el catalogo de la empresa.')::jsonb;
                END IF;
            END IF;
        ELSE
            v_has_error := true;
            v_issues_agg := v_issues_agg || pg_catalog.jsonb_build_object(
                'row_index', v_row_index, 'level', 'ERROR', 'code', 'UNKNOWN_PRODUCT',
                'message', 'El SKU esta vacio o no existe en el catalogo de la empresa.')::jsonb;
        END IF;

        -- Barcode distinto al catalogo (WARNING)
        IF v_product_id IS NOT NULL AND v_barcode <> '' AND v_product_barcode IS NOT NULL
           AND pg_catalog.btrim(v_product_barcode) <> v_barcode THEN
            v_has_warning := true;
            v_issues_agg := v_issues_agg || pg_catalog.jsonb_build_object(
                'row_index', v_row_index, 'level', 'WARNING', 'code', 'BARCODE_MISMATCH',
                'message', 'El codigo de barras difiere del catalogo.')::jsonb;
        END IF;

        -- ==================================================
        -- UBICACION SEGUN MODALIDAD
        -- ==================================================
        IF v_modality = 'GENERAL' THEN
            IF v_loc_code <> '' THEN
                v_has_warning := true;
                v_issues_agg := v_issues_agg || pg_catalog.jsonb_build_object(
                    'row_index', v_row_index, 'level', 'WARNING', 'code', 'UNEXPECTED_LOCATION',
                    'message', 'La modalidad GENERAL no requiere ubicacion.')::jsonb;
            END IF;
        ELSE
            IF v_loc_code = '' THEN
                v_has_error := true;
                v_issues_agg := v_issues_agg || pg_catalog.jsonb_build_object(
                    'row_index', v_row_index, 'level', 'ERROR', 'code', 'MISSING_LOCATION',
                    'message', 'El codigo de ubicacion es obligatorio.')::jsonb;
            ELSE
                SELECT l.id, l.is_active, l.source_logistics_location_id
                INTO v_loc_id, v_loc_active, v_src_logistics_loc
                FROM inventarios.inventory_site_locations l
                WHERE l.company_id = p_company_id
                  AND l.inventory_site_id = v_site_id
                  AND pg_catalog.upper(l.code) = pg_catalog.upper(v_loc_code)
                LIMIT 1;
                IF NOT FOUND THEN
                    IF EXISTS (SELECT 1 FROM inventarios.inventory_site_locations l2
                               WHERE l2.company_id = p_company_id
                                 AND pg_catalog.upper(l2.code) = pg_catalog.upper(v_loc_code)
                                 AND l2.inventory_site_id <> v_site_id) THEN
                        v_has_error := true;
                        v_issues_agg := v_issues_agg || pg_catalog.jsonb_build_object(
                            'row_index', v_row_index, 'level', 'ERROR', 'code', 'LOCATION_NOT_IN_SITE',
                            'message', 'La ubicacion pertenece a otra unidad.')::jsonb;
                    ELSE
                        v_has_error := true;
                        v_issues_agg := v_issues_agg || pg_catalog.jsonb_build_object(
                            'row_index', v_row_index, 'level', 'ERROR', 'code', 'UNKNOWN_LOCATION',
                            'message', 'La ubicacion no existe en la unidad seleccionada.')::jsonb;
                    END IF;
                ELSIF NOT v_loc_active THEN
                    v_has_error := true;
                    v_issues_agg := v_issues_agg || pg_catalog.jsonb_build_object(
                        'row_index', v_row_index, 'level', 'ERROR', 'code', 'INACTIVE_LOCATION',
                        'message', 'La ubicacion esta inactiva.')::jsonb;
                END IF;
            END IF;
        END IF;

        -- ==================================================
        -- CANTIDAD
        -- ==================================================
        IF 'quantity' = ANY(v_formula) THEN
            v_has_error := true;
            v_issues_agg := v_issues_agg || pg_catalog.jsonb_build_object(
                'row_index', v_row_index, 'level', 'ERROR', 'code', 'FORMULA_NOT_ALLOWED',
                'message', 'La celda de cantidad contiene una formula no permitida.')::jsonb;
        ELSIF v_qty_text = '' THEN
            v_has_error := true;
            v_issues_agg := v_issues_agg || pg_catalog.jsonb_build_object(
                'row_index', v_row_index, 'level', 'ERROR', 'code', 'MISSING_QUANTITY',
                'message', 'La cantidad teorica es obligatoria.')::jsonb;
        ELSE
            BEGIN
                v_qty := v_qty_text::numeric;
                IF v_qty < 0 THEN
                    v_has_error := true;
                    v_qty := NULL;
                    v_issues_agg := v_issues_agg || pg_catalog.jsonb_build_object(
                        'row_index', v_row_index, 'level', 'ERROR', 'code', 'NEGATIVE_QUANTITY',
                        'message', 'La cantidad no puede ser negativa.')::jsonb;
                ELSIF pg_catalog.scale(v_qty) > 3 THEN
                    v_has_error := true;
                    v_qty := NULL;
                    v_issues_agg := v_issues_agg || pg_catalog.jsonb_build_object(
                        'row_index', v_row_index, 'level', 'ERROR', 'code', 'QUANTITY_SCALE_EXCEEDED',
                        'message', 'La cantidad no puede tener mas de 3 decimales.')::jsonb;
                END IF;
            EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
                v_has_error := true;
                v_qty := NULL;
                v_issues_agg := v_issues_agg || pg_catalog.jsonb_build_object(
                    'row_index', v_row_index, 'level', 'ERROR', 'code', 'INVALID_QUANTITY',
                    'message', 'La cantidad no es un valor numerico valido.')::jsonb;
            END;
        END IF;

        -- ==================================================
        -- COSTO
        -- ==================================================
        IF 'cost' = ANY(v_formula) THEN
            v_has_error := true;
            v_issues_agg := v_issues_agg || pg_catalog.jsonb_build_object(
                'row_index', v_row_index, 'level', 'ERROR', 'code', 'FORMULA_NOT_ALLOWED',
                'message', 'La celda de costo contiene una formula no permitida.')::jsonb;
        ELSIF v_cost_text = '' THEN
            v_has_warning := true;
            v_issues_agg := v_issues_agg || pg_catalog.jsonb_build_object(
                'row_index', v_row_index, 'level', 'WARNING', 'code', 'MISSING_COST',
                'message', 'El costo unitario no fue informado.')::jsonb;
        ELSE
            BEGIN
                v_cost := v_cost_text::numeric;
                IF v_cost < 0 THEN
                    v_has_error := true;
                    v_cost := NULL;
                    v_issues_agg := v_issues_agg || pg_catalog.jsonb_build_object(
                        'row_index', v_row_index, 'level', 'ERROR', 'code', 'INVALID_COST',
                        'message', 'El costo unitario no puede ser negativo.')::jsonb;
                ELSIF pg_catalog.scale(v_cost) > 2 THEN
                    v_has_error := true;
                    v_cost := NULL;
                    v_issues_agg := v_issues_agg || pg_catalog.jsonb_build_object(
                        'row_index', v_row_index, 'level', 'ERROR', 'code', 'INVALID_COST',
                        'message', 'El costo unitario no puede tener mas de 2 decimales.')::jsonb;
                ELSIF v_cost = 0 THEN
                    v_has_warning := true;
                    v_issues_agg := v_issues_agg || pg_catalog.jsonb_build_object(
                        'row_index', v_row_index, 'level', 'WARNING', 'code', 'ZERO_COST',
                        'message', 'El costo unitario es cero.')::jsonb;
                END IF;
            EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
                v_has_error := true;
                v_cost := NULL;
                v_issues_agg := v_issues_agg || pg_catalog.jsonb_build_object(
                    'row_index', v_row_index, 'level', 'ERROR', 'code', 'INVALID_COST',
                    'message', 'El costo unitario no es un valor numerico valido.')::jsonb;
            END;
        END IF;

        -- Consistencia de costo por SKU (POR_UBICACION)
        IF v_modality = 'POR_UBICACION' AND v_product_id IS NOT NULL AND v_cost IS NOT NULL THEN
            IF v_cost_map ? v_product_id::text
               AND (v_cost_map ->> v_product_id::text)::numeric IS DISTINCT FROM v_cost THEN
                v_has_error := true;
                v_issues_agg := v_issues_agg || pg_catalog.jsonb_build_object(
                    'row_index', v_row_index, 'level', 'ERROR', 'code', 'INCONSISTENT_UNIT_COST',
                    'message', 'El SKU mantiene costos distintos entre ubicaciones.')::jsonb;
            ELSE
                v_cost_map := v_cost_map || pg_catalog.jsonb_build_object(v_product_id::text, v_cost);
            END IF;
        END IF;

        -- ==================================================
        -- DUPLICADOS
        -- ==================================================
        IF v_modality = 'GENERAL' THEN
            v_key := 'sku:' || pg_catalog.upper(v_sku);
        ELSE
            v_key := 'sku:' || pg_catalog.upper(v_sku) || '|loc:' || pg_catalog.upper(COALESCE(v_loc_code, ''));
        END IF;
        IF v_seen_map ? v_key THEN
            v_has_error := true;
            v_issues_agg := v_issues_agg || pg_catalog.jsonb_build_object(
                'row_index', v_row_index, 'level', 'ERROR', 'code', 'DUPLICATE_SKU_LOCATION',
                'message', 'La combinacion de SKU y ubicacion esta duplicada.')::jsonb;
        ELSE
            v_seen_map := v_seen_map || pg_catalog.jsonb_build_object(v_key, true);
        END IF;

        -- Estado de fila: ERROR > WARNING > VALID
        IF v_has_error THEN
            v_row_status := 'ERROR';
        ELSIF v_has_warning THEN
            v_row_status := 'WARNING';
        ELSE
            v_row_status := 'VALID';
        END IF;

        v_row_count := v_row_count + 1;
        IF v_row_status = 'ERROR' THEN v_error_count := v_error_count + 1; END IF;
        IF v_row_status = 'WARNING' THEN v_warning_count := v_warning_count + 1; END IF;

        INSERT INTO inventarios.stock_import_rows (
            company_id, import_id, row_index, sku, barcode, product_id,
            bsale_variant_id, inventory_site_id, inventory_site_location_id,
            location_id, entered_name, theoretical_quantity, unit_cost,
            currency, row_status, created_at, created_by
        ) VALUES (
            p_company_id, p_import_id, v_row_index, v_sku, NULLIF(v_barcode, ''),
            v_product_id, v_bsale_variant_id, v_site_id, v_loc_id, v_src_logistics_loc,
            NULLIF(v_entered_name, ''), v_qty, v_cost, 'CLP', v_row_status, v_occurred_at, v_actor_id
        );
    END LOOP;

    -- ========================================================
    -- ISSUES DE FILA EN LOTE
    -- ========================================================
    IF pg_catalog.jsonb_array_length(v_issues_agg) > 0 THEN
        FOR v_issue IN SELECT value FROM pg_catalog.jsonb_array_elements(v_issues_agg) LOOP
            INSERT INTO inventarios.stock_import_row_issues (
                company_id, import_id, row_id, row_index, issue_level, issue_code, safe_message
            )
            SELECT p_company_id, p_import_id, r.id, (v_issue->>'row_index')::int,
                   v_issue->>'level', v_issue->>'code', v_issue->>'message'
            FROM inventarios.stock_import_rows r
            WHERE r.company_id = p_company_id AND r.import_id = p_import_id
              AND r.row_index = (v_issue->>'row_index')::int;
        END LOOP;
    END IF;

    -- ========================================================
    -- CABECERA
    -- ========================================================
    v_file_error := EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(COALESCE(p_file_issues, '[]'::jsonb)) i
        WHERE i->>'level' = 'ERROR'
    );
    IF v_error_count = 0 AND NOT v_file_error THEN
        v_final_status := 'VALIDATED';
    ELSE
        v_final_status := 'REJECTED';
    END IF;

    UPDATE inventarios.stock_imports
    SET row_count = v_row_count,
        error_count = v_error_count,
        warning_count = v_warning_count,
        validated_at = v_occurred_at,
        validated_by = v_actor_id,
        updated_at = v_occurred_at,
        updated_by = v_actor_id,
        file_sha256 = p_file_sha256,
        file_issues = COALESCE(p_file_issues, '[]'::jsonb),
        warehouse_id = COALESCE(v_warehouse_id, warehouse_id),
        status = v_final_status
    WHERE company_id = p_company_id AND id = p_import_id;

    v_response := pg_catalog.jsonb_build_object(
        'entity_id', p_import_id, 'state', v_final_status, 'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object(
            'import_id', p_import_id, 'status', v_final_status,
            'row_count', v_row_count, 'error_count', v_error_count,
            'warning_count', v_warning_count, 'file_sha256', p_file_sha256
        )
    );
    RETURN v_response;
END;
$$;
