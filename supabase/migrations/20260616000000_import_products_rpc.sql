-- Migración para crear la función RPC de importación masiva de productos de catálogo
CREATE OR REPLACE FUNCTION adquisiciones.import_products_bulk(
    p_products jsonb,
    p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_product jsonb;
    v_sku varchar;
    v_barcode varchar;
    v_internal_code varchar;
    v_description varchar;
    v_brand varchar;
    v_category varchar;
    v_subcategory varchar;
    v_product_type varchar;
    v_unit_of_measure varchar;
    v_weight_unit varchar;
    v_package_unit varchar;
    v_purchase_unit varchar;
    v_sales_unit varchar;
    
    v_created_count integer := 0;
    v_omitted_sku_count integer := 0;
    v_omitted_barcode_count integer := 0;
    v_omitted_duplicate_name_count integer := 0;
    v_created_classifiers_count integer := 0;
    
    v_errors jsonb := '[]'::jsonb;
    v_row_idx integer := 0;
    
    -- Helper variables for normalization
    v_norm_sku varchar;
    v_norm_barcode varchar;
    v_norm_desc varchar;
    v_norm_brand varchar;
    v_norm_unit varchar;
    
    -- For checking classifier exists or inserting it
    v_classifier_types text[] := ARRAY['BRAND', 'CATEGORY', 'SUBCATEGORY', 'PRODUCT_TYPE', 'WEIGHT_UNIT', 'MEASURE_UNIT', 'PACKAGE_UNIT', 'PURCHASE_UNIT', 'SALES_UNIT'];
    v_classifier_vals text[];
    v_classifier_type text;
    v_classifier_val text;
    v_norm_cval text;
    i integer;
BEGIN
    -- Loop through products
    FOR v_product IN SELECT * FROM jsonb_array_elements(p_products) LOOP
        v_row_idx := v_row_idx + 1;
        
        -- Extract values
        v_sku := trim(both ' ' from (v_product->>'sku'));
        v_barcode := trim(both ' ' from (v_product->>'codigo_barra'));
        v_internal_code := trim(both ' ' from (v_product->>'codigo_interno'));
        v_description := trim(both ' ' from (v_product->>'descripcion'));
        v_brand := trim(both ' ' from (v_product->>'marca'));
        v_category := trim(both ' ' from (v_product->>'categoria'));
        v_subcategory := trim(both ' ' from (v_product->>'subcategoria'));
        v_product_type := trim(both ' ' from (v_product->>'tipo_producto'));
        v_unit_of_measure := trim(both ' ' from (v_product->>'unidad_medida'));
        v_weight_unit := trim(both ' ' from (v_product->>'unidad_peso'));
        v_package_unit := trim(both ' ' from (v_product->>'unidad_empaque'));
        v_purchase_unit := trim(both ' ' from (v_product->>'unidad_compra'));
        v_sales_unit := trim(both ' ' from (v_product->>'unidad_venta'));
        
        -- Basic validations
        IF v_sku IS NULL OR v_sku = '' THEN
            v_errors := jsonb_insert(v_errors, '{0}', jsonb_build_object('row', v_row_idx, 'message', 'SKU obligatorio'), true);
            CONTINUE;
        END IF;
        
        IF v_description IS NULL OR v_description = '' THEN
            v_errors := jsonb_insert(v_errors, '{0}', jsonb_build_object('row', v_row_idx, 'message', 'Descripción obligatoria'), true);
            CONTINUE;
        END IF;
        
        -- Normalizations
        -- Normalize SKU: uppercase and replace multiple spaces
        v_norm_sku := upper(regexp_replace(v_sku, '\s+', ' ', 'g'));
        v_norm_desc := upper(regexp_replace(v_description, '\s+', ' ', 'g'));
        
        -- Check duplicate by SKU (or internal_code if matches)
        IF EXISTS (
            SELECT 1 FROM adquisiciones.products 
            WHERE upper(sku) = v_norm_sku 
               OR (v_internal_code IS NOT NULL AND v_internal_code != '' AND upper(internal_code) = upper(v_internal_code))
        ) THEN
            v_omitted_sku_count := v_omitted_sku_count + 1;
            CONTINUE;
        END IF;
        
        -- Check duplicate by barcode if not empty
        IF v_barcode IS NOT NULL AND v_barcode != '' THEN
            v_norm_barcode := upper(regexp_replace(v_barcode, '\s+', ' ', 'g'));
            IF EXISTS (SELECT 1 FROM adquisiciones.products WHERE upper(barcode) = v_norm_barcode) THEN
                v_omitted_barcode_count := v_omitted_barcode_count + 1;
                CONTINUE;
            END IF;
        ELSE
            v_norm_barcode := NULL;
        END IF;
        
        -- Check duplicate by normalized description + brand + unit
        v_norm_brand := COALESCE(upper(regexp_replace(v_brand, '\s+', ' ', 'g')), 'SIN MARCA');
        v_norm_unit := COALESCE(upper(regexp_replace(v_unit_of_measure, '\s+', ' ', 'g')), 'UNIDAD');
        
        IF EXISTS (
            SELECT 1 FROM adquisiciones.products
            WHERE upper(description) = v_norm_desc
              AND COALESCE(upper(brand), 'SIN MARCA') = v_norm_brand
              AND COALESCE(upper(unit_of_measure), 'UNIDAD') = v_norm_unit
        ) THEN
            v_omitted_duplicate_name_count := v_omitted_duplicate_name_count + 1;
            CONTINUE;
        END IF;
        
        -- Auto-seed/verify classifiers
        v_classifier_vals := ARRAY[
            v_brand, v_category, v_subcategory, v_product_type, 
            v_weight_unit, v_unit_of_measure, v_package_unit, 
            v_purchase_unit, v_sales_unit
        ];
        
        FOR i IN 1..9 LOOP
            v_classifier_type := v_classifier_types[i];
            v_classifier_val := trim(both ' ' from v_classifier_vals[i]);
            
            -- Fallbacks if empty
            IF v_classifier_val IS NULL OR v_classifier_val = '' THEN
                v_classifier_val := CASE
                    WHEN v_classifier_type = 'BRAND' THEN 'SIN MARCA'
                    WHEN v_classifier_type = 'CATEGORY' THEN 'SIN CATEGORIA'
                    WHEN v_classifier_type = 'SUBCATEGORY' THEN 'SIN SUBCATEGORIA'
                    WHEN v_classifier_type = 'PRODUCT_TYPE' THEN 'SIN TIPO'
                    WHEN v_classifier_type = 'WEIGHT_UNIT' THEN 'UNIDAD'
                    WHEN v_classifier_type = 'MEASURE_UNIT' THEN 'UNIDAD'
                    WHEN v_classifier_type = 'PACKAGE_UNIT' THEN 'CAJA'
                    WHEN v_classifier_type = 'PURCHASE_UNIT' THEN 'UNIDAD'
                    WHEN v_classifier_type = 'SALES_UNIT' THEN 'UNIDAD'
                    ELSE 'UNIDAD'
                END;
            END IF;
            
            -- Normalize classifier value
            v_norm_cval := upper(regexp_replace(v_classifier_val, '\s+', ' ', 'g'));
            
            -- Check if exists. If not, insert it!
            IF NOT EXISTS (
                SELECT 1 FROM adquisiciones.product_classifiers 
                WHERE classifier_type = v_classifier_type 
                  AND normalized_name = v_norm_cval
            ) THEN
                INSERT INTO adquisiciones.product_classifiers (classifier_type, name, normalized_name, created_by)
                VALUES (v_classifier_type, v_classifier_val, v_norm_cval, p_user_id);
                
                v_created_classifiers_count := v_created_classifiers_count + 1;
            END IF;
            
            -- Update local variable for insertion in products table
            CASE i
                WHEN 1 THEN v_brand := v_classifier_val;
                WHEN 2 THEN v_category := v_classifier_val;
                WHEN 3 THEN v_subcategory := v_classifier_val;
                WHEN 4 THEN v_product_type := v_classifier_val;
                WHEN 5 THEN v_weight_unit := v_classifier_val;
                WHEN 6 THEN v_unit_of_measure := v_classifier_val;
                WHEN 7 THEN v_package_unit := v_classifier_val;
                WHEN 8 THEN v_purchase_unit := v_classifier_val;
                WHEN 9 THEN v_sales_unit := v_classifier_val;
            END CASE;
        END LOOP;
        
        -- Insert product
        BEGIN
            INSERT INTO adquisiciones.products (
                sku, barcode, internal_code, description, short_description,
                brand, category, subcategory, product_type, species, presentation,
                unit_of_measure, net_weight, weight_unit, package_quantity, package_unit,
                purchase_unit, sales_unit, min_stock, max_stock, reorder_point,
                tax_rate, is_perishable, requires_lot, requires_expiration, notes,
                created_by, updated_by, status, is_active
            )
            VALUES (
                v_norm_sku,
                v_norm_barcode,
                CASE WHEN v_internal_code = '' THEN NULL ELSE upper(v_internal_code) END,
                v_norm_desc,
                CASE WHEN (v_product->>'descripcion_corta') IS NOT NULL AND trim(both ' ' from (v_product->>'descripcion_corta')) != '' THEN upper(trim(both ' ' from (v_product->>'descripcion_corta'))) ELSE NULL END,
                upper(v_brand),
                upper(v_category),
                upper(v_subcategory),
                upper(v_product_type),
                CASE WHEN (v_product->>'especie') IS NOT NULL AND trim(both ' ' from (v_product->>'especie')) != '' THEN upper(trim(both ' ' from (v_product->>'especie'))) ELSE NULL END,
                CASE WHEN (v_product->>'presentacion') IS NOT NULL AND trim(both ' ' from (v_product->>'presentacion')) != '' THEN upper(trim(both ' ' from (v_product->>'presentacion'))) ELSE NULL END,
                upper(v_unit_of_measure),
                COALESCE((v_product->>'peso_neto')::numeric, 0),
                upper(v_weight_unit),
                COALESCE((v_product->>'cantidad_empaque')::numeric, 0),
                upper(v_package_unit),
                upper(v_purchase_unit),
                upper(v_sales_unit),
                COALESCE((v_product->>'stock_minimo')::numeric, 0),
                COALESCE((v_product->>'stock_maximo')::numeric, 0),
                COALESCE((v_product->>'punto_reposicion')::numeric, 0),
                COALESCE((v_product->>'iva_porcentaje')::numeric, 19),
                COALESCE((v_product->>'perecible') IN ('SI', 'si', 'Si', 'TRUE', 'true', '1', 'YES', 'yes', 'Yes'), false),
                COALESCE((v_product->>'requiere_lote') IN ('SI', 'si', 'Si', 'TRUE', 'true', '1', 'YES', 'yes', 'Yes'), false),
                COALESCE((v_product->>'requiere_vencimiento') IN ('SI', 'si', 'Si', 'TRUE', 'true', '1', 'YES', 'yes', 'Yes'), false),
                CASE WHEN (v_product->>'observacion') IS NOT NULL AND trim(both ' ' from (v_product->>'observacion')) != '' THEN upper(trim(both ' ' from (v_product->>'observacion'))) ELSE NULL END,
                p_user_id,
                p_user_id,
                'ACTIVE',
                true
            );
            
            v_created_count := v_created_count + 1;
        EXCEPTION WHEN OTHERS THEN
            v_errors := v_errors || jsonb_build_array(jsonb_build_object('row', v_row_idx, 'message', SQLERRM));
        END;
    END LOOP;
    
    RETURN jsonb_build_object(
        'created', v_created_count,
        'omitted_sku', v_omitted_sku_count,
        'omitted_barcode', v_omitted_barcode_count,
        'omitted_duplicate_name', v_omitted_duplicate_name_count,
        'created_classifiers', v_created_classifiers_count,
        'errors', v_errors
    );
END;
$$;
