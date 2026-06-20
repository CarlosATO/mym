-- Migration to establish global product catalog, suppliers, and classifiers
-- 1. Alter tables to drop NOT NULL constraints on company_id
ALTER TABLE adquisiciones.products ALTER COLUMN company_id DROP NOT NULL;
ALTER TABLE adquisiciones.suppliers ALTER COLUMN company_id DROP NOT NULL;

-- 2. Migrate existing records to global catalog (company_id = NULL)
UPDATE adquisiciones.products SET company_id = NULL WHERE company_id IS NOT NULL;
UPDATE adquisiciones.suppliers SET company_id = NULL WHERE company_id IS NOT NULL;
UPDATE adquisiciones.product_classifiers SET company_id = NULL WHERE company_id IS NOT NULL;

-- 3. Drop old company-scoped indexes
DROP INDEX IF EXISTS adquisiciones.idx_products_sku_company;
DROP INDEX IF EXISTS adquisiciones.idx_products_barcode_company;
DROP INDEX IF EXISTS adquisiciones.idx_suppliers_rut_company;
DROP INDEX IF EXISTS adquisiciones.idx_suppliers_rut_normalized_company;

-- 4. Recreate global and private partial unique indexes
-- Global uniqueness constraints
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_sku_global ON adquisiciones.products (sku) WHERE company_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode_global ON adquisiciones.products (barcode) WHERE company_id IS NULL AND barcode IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_rut_normalized_global ON adquisiciones.suppliers (rut_normalized) WHERE company_id IS NULL AND rut_normalized IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_rut_global ON adquisiciones.suppliers (rut) WHERE company_id IS NULL AND rut IS NOT NULL;

-- Private uniqueness constraints (scoped by company for future private items)
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_sku_private ON adquisiciones.products (company_id, sku) WHERE company_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode_private ON adquisiciones.products (company_id, barcode) WHERE company_id IS NOT NULL AND barcode IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_rut_normalized_private ON adquisiciones.suppliers (company_id, rut_normalized) WHERE company_id IS NOT NULL AND rut_normalized IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_rut_private ON adquisiciones.suppliers (company_id, rut) WHERE company_id IS NOT NULL AND rut IS NOT NULL;

-- 5. Helper function for global catalog write access based on user role (SECURITY DEFINER to prevent RLS recursion)
CREATE OR REPLACE FUNCTION adquisiciones.has_global_catalog_write_access(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM portal.users u
        JOIN portal.roles r ON u.role_id = r.id
        WHERE u.id = p_user_id AND u.is_active = true AND r.is_active = true AND r.name IN ('SUPER_USUARIO', 'GERENCIA', 'BODEGA')
    );
END;
$$;

GRANT EXECUTE ON FUNCTION adquisiciones.has_global_catalog_write_access(uuid) TO authenticated, service_role;

-- 6. Recreate RLS policies with strict role checking for global catalog writes
-- 6.1 products policies
DROP POLICY IF EXISTS rls_products_select ON adquisiciones.products;
DROP POLICY IF EXISTS rls_products_insert ON adquisiciones.products;
DROP POLICY IF EXISTS rls_products_update ON adquisiciones.products;

CREATE POLICY rls_products_select ON adquisiciones.products
    FOR SELECT TO authenticated
    USING (
        portal.has_permission('system.admin') OR 
        (
            (portal.has_permission('adquisiciones.products.view') OR portal.has_permission('module.adquisiciones.view')) AND 
            (company_id IS NULL OR core.has_company_access(auth.uid(), company_id))
        )
    );

CREATE POLICY rls_products_insert ON adquisiciones.products
    FOR INSERT TO authenticated
    WITH CHECK (
        portal.has_permission('system.admin') OR 
        (
            portal.has_permission('adquisiciones.products.create') AND 
            adquisiciones.has_global_catalog_write_access(auth.uid()) AND 
            (company_id IS NULL OR core.has_company_access(auth.uid(), company_id))
        )
    );

CREATE POLICY rls_products_update ON adquisiciones.products
    FOR UPDATE TO authenticated
    USING (
        portal.has_permission('system.admin') OR 
        (
            portal.has_permission('adquisiciones.products.update') AND 
            adquisiciones.has_global_catalog_write_access(auth.uid()) AND 
            (company_id IS NULL OR core.has_company_access(auth.uid(), company_id))
        )
    )
    WITH CHECK (
        portal.has_permission('system.admin') OR 
        (
            portal.has_permission('adquisiciones.products.update') AND 
            adquisiciones.has_global_catalog_write_access(auth.uid()) AND 
            (company_id IS NULL OR core.has_company_access(auth.uid(), company_id))
        )
    );

-- 6.2 suppliers policies
DROP POLICY IF EXISTS rls_suppliers_select ON adquisiciones.suppliers;
DROP POLICY IF EXISTS rls_suppliers_insert ON adquisiciones.suppliers;
DROP POLICY IF EXISTS rls_suppliers_update ON adquisiciones.suppliers;

CREATE POLICY rls_suppliers_select ON adquisiciones.suppliers
    FOR SELECT TO authenticated
    USING (
        portal.has_permission('system.admin') OR 
        (
            portal.has_permission('adquisiciones.suppliers.view') AND 
            (company_id IS NULL OR core.has_company_access(auth.uid(), company_id))
        )
    );

CREATE POLICY rls_suppliers_insert ON adquisiciones.suppliers
    FOR INSERT TO authenticated
    WITH CHECK (
        portal.has_permission('system.admin') OR 
        (
            portal.has_permission('adquisiciones.suppliers.create') AND 
            adquisiciones.has_global_catalog_write_access(auth.uid()) AND 
            (company_id IS NULL OR core.has_company_access(auth.uid(), company_id))
        )
    );

CREATE POLICY rls_suppliers_update ON adquisiciones.suppliers
    FOR UPDATE TO authenticated
    USING (
        portal.has_permission('system.admin') OR 
        (
            portal.has_permission('adquisiciones.suppliers.update') AND 
            adquisiciones.has_global_catalog_write_access(auth.uid()) AND 
            (company_id IS NULL OR core.has_company_access(auth.uid(), company_id))
        )
    )
    WITH CHECK (
        portal.has_permission('system.admin') OR 
        (
            portal.has_permission('adquisiciones.suppliers.update') AND 
            adquisiciones.has_global_catalog_write_access(auth.uid()) AND 
            (company_id IS NULL OR core.has_company_access(auth.uid(), company_id))
        )
    );

-- 6.3 product_classifiers policies
DROP POLICY IF EXISTS rls_classifiers_select ON adquisiciones.product_classifiers;
DROP POLICY IF EXISTS rls_classifiers_insert ON adquisiciones.product_classifiers;
DROP POLICY IF EXISTS rls_classifiers_update ON adquisiciones.product_classifiers;

CREATE POLICY rls_classifiers_select ON adquisiciones.product_classifiers
    FOR SELECT TO authenticated
    USING (
        company_id IS NULL OR 
        portal.has_permission('system.admin') OR 
        core.has_company_access(auth.uid(), company_id)
    );

CREATE POLICY rls_classifiers_insert ON adquisiciones.product_classifiers
    FOR INSERT TO authenticated
    WITH CHECK (
        portal.has_permission('system.admin') OR 
        (
            (portal.has_permission('adquisiciones.products.create') OR portal.has_permission('adquisiciones.products.update')) AND 
            adquisiciones.has_global_catalog_write_access(auth.uid()) AND 
            (company_id IS NULL OR core.has_company_access(auth.uid(), company_id))
        )
    );

CREATE POLICY rls_classifiers_update ON adquisiciones.product_classifiers
    FOR UPDATE TO authenticated
    USING (
        portal.has_permission('system.admin') OR 
        (
            portal.has_permission('adquisiciones.products.update') AND 
            adquisiciones.has_global_catalog_write_access(auth.uid()) AND 
            (company_id IS NULL OR core.has_company_access(auth.uid(), company_id))
        )
    )
    WITH CHECK (
        portal.has_permission('system.admin') OR 
        (
            portal.has_permission('adquisiciones.products.update') AND 
            adquisiciones.has_global_catalog_write_access(auth.uid()) AND 
            (company_id IS NULL OR core.has_company_access(auth.uid(), company_id))
        )
    );

-- 7. Refactor RPC Functions to support company_id IS NULL and global checks
-- 7.1 import_products_bulk
CREATE OR REPLACE FUNCTION adquisiciones.import_products_bulk(
    p_products jsonb,
    p_user_id uuid,
    p_company_id uuid
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
    
    v_norm_sku varchar;
    v_norm_barcode varchar;
    v_norm_desc varchar;
    v_norm_brand varchar;
    v_norm_unit varchar;
    
    v_classifier_types text[] := ARRAY['BRAND', 'CATEGORY', 'SUBCATEGORY', 'PRODUCT_TYPE', 'WEIGHT_UNIT', 'MEASURE_UNIT', 'PACKAGE_UNIT', 'PURCHASE_UNIT', 'SALES_UNIT'];
    v_classifier_vals text[];
    v_classifier_type text;
    v_classifier_val text;
    v_norm_cval text;
    i integer;
BEGIN
    FOR v_product IN SELECT * FROM jsonb_array_elements(p_products) LOOP
        v_row_idx := v_row_idx + 1;
        
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
        
        IF v_sku IS NULL OR v_sku = '' THEN
            v_errors := jsonb_insert(v_errors, '{0}', jsonb_build_object('row', v_row_idx, 'message', 'SKU obligatorio'), true);
            CONTINUE;
        END IF;
        
        IF v_description IS NULL OR v_description = '' THEN
            v_errors := jsonb_insert(v_errors, '{0}', jsonb_build_object('row', v_row_idx, 'message', 'Descripción obligatoria'), true);
            CONTINUE;
        END IF;
        
        v_norm_sku := upper(regexp_replace(v_sku, '\s+', ' ', 'g'));
        v_norm_desc := upper(regexp_replace(v_description, '\s+', ' ', 'g'));
        
        -- Check duplicate by SKU (either global or scoped by company)
        IF EXISTS (
            SELECT 1 FROM adquisiciones.products 
            WHERE (company_id IS NULL OR company_id = p_company_id) 
              AND (upper(sku) = v_norm_sku 
                 OR (v_internal_code IS NOT NULL AND v_internal_code != '' AND upper(internal_code) = upper(v_internal_code)))
        ) THEN
            v_omitted_sku_count := v_omitted_sku_count + 1;
            CONTINUE;
        END IF;
        
        -- Check duplicate by barcode (either global or scoped by company)
        IF v_barcode IS NOT NULL AND v_barcode != '' THEN
            v_norm_barcode := upper(regexp_replace(v_barcode, '\s+', ' ', 'g'));
            IF EXISTS (SELECT 1 FROM adquisiciones.products WHERE (company_id IS NULL OR company_id = p_company_id) AND upper(barcode) = v_norm_barcode) THEN
                v_omitted_barcode_count := v_omitted_barcode_count + 1;
                CONTINUE;
            END IF;
        ELSE
            v_norm_barcode := NULL;
        END IF;
        
        -- Check duplicate by description + brand + unit (either global or scoped by company)
        v_norm_brand := COALESCE(upper(regexp_replace(v_brand, '\s+', ' ', 'g')), 'SIN MARCA');
        v_norm_unit := COALESCE(upper(regexp_replace(v_unit_of_measure, '\s+', ' ', 'g')), 'UNIDAD');
        
        IF EXISTS (
            SELECT 1 FROM adquisiciones.products
            WHERE (company_id IS NULL OR company_id = p_company_id)
              AND upper(description) = v_norm_desc
              AND COALESCE(upper(brand), 'SIN MARCA') = v_norm_brand
              AND COALESCE(upper(unit_of_measure), 'UNIDAD') = v_norm_unit
        ) THEN
            v_omitted_duplicate_name_count := v_omitted_duplicate_name_count + 1;
            CONTINUE;
        END IF;
        
        -- Auto-seed/verify classifiers (scoped by company or global)
        v_classifier_vals := ARRAY[
            v_brand, v_category, v_subcategory, v_product_type, 
            v_weight_unit, v_unit_of_measure, v_package_unit, 
            v_purchase_unit, v_sales_unit
        ];
        
        FOR i IN 1..9 LOOP
            v_classifier_type := v_classifier_types[i];
            v_classifier_val := trim(both ' ' from v_classifier_vals[i]);
            
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
            
            v_norm_cval := upper(regexp_replace(v_classifier_val, '\s+', ' ', 'g'));
            
            -- Check if exists globally (company_id is null) or for this company
            IF NOT EXISTS (
                SELECT 1 FROM adquisiciones.product_classifiers 
                WHERE classifier_type = v_classifier_type 
                  AND normalized_name = v_norm_cval
                  AND (company_id IS NULL OR company_id = p_company_id)
            ) THEN
                -- Insert as global classifier (company_id = NULL) to keep classifiers shared
                INSERT INTO adquisiciones.product_classifiers (company_id, classifier_type, name, normalized_name, created_by)
                VALUES (NULL, v_classifier_type, v_classifier_val, v_norm_cval, p_user_id);
                
                v_created_classifiers_count := v_created_classifiers_count + 1;
            END IF;
            
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
        
        -- Insert product (company_id = NULL for global shared catalog)
        BEGIN
            INSERT INTO adquisiciones.products (
                company_id,
                sku, barcode, internal_code, description, short_description,
                brand, category, subcategory, product_type, species, presentation,
                unit_of_measure, net_weight, weight_unit, package_quantity, package_unit,
                purchase_unit, sales_unit, min_stock, max_stock, reorder_point,
                tax_rate, is_perishable, requires_lot, requires_expiration, notes,
                created_by, updated_by, status, is_active
            )
            VALUES (
                NULL,
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

-- 7.2 create_product_from_po
CREATE OR REPLACE FUNCTION adquisiciones.create_product_from_po(p_data jsonb, p_user_id uuid, p_company_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_sku varchar(50); v_product_id uuid;
BEGIN
    v_sku := upper(trim(p_data->>'sku'));
    IF v_sku IS NULL OR v_sku = '' THEN RETURN jsonb_build_object('success', false, 'error', 'SKU es obligatorio'); END IF;
    -- Check global duplicates or same company duplicates
    IF EXISTS (SELECT 1 FROM adquisiciones.products WHERE sku = v_sku AND (company_id IS NULL OR company_id = p_company_id)) THEN
        RETURN jsonb_build_object('success', false, 'error', 'El SKU "' || v_sku || '" ya existe en el catálogo maestro');
    END IF;
    -- Insert global product (company_id = NULL)
    INSERT INTO adquisiciones.products (company_id, sku, barcode, description, short_description, brand, category, subcategory, product_type, unit_of_measure, tax_rate, is_perishable, requires_lot, requires_expiration, notes, status, created_by)
    VALUES (NULL, v_sku, NULLIF(trim(COALESCE(p_data->>'barcode', '')),''), upper(trim(p_data->>'description')), upper(trim(COALESCE(p_data->>'short_description',''))), upper(trim(COALESCE(p_data->>'brand',''))), upper(trim(COALESCE(p_data->>'category',''))), upper(trim(COALESCE(p_data->>'subcategory',''))), upper(trim(COALESCE(p_data->>'product_type',''))), upper(trim(COALESCE(p_data->>'unit_of_measure',''))), COALESCE((p_data->>'tax_rate')::numeric, 19), COALESCE((p_data->>'is_perishable')::boolean, false), COALESCE((p_data->>'requires_lot')::boolean, false), COALESCE((p_data->>'requires_expiration')::boolean, false), p_data->>'notes', 'ACTIVE', p_user_id)
    RETURNING id INTO v_product_id;
    RETURN jsonb_build_object('success', true, 'product_id', v_product_id, 'sku', v_sku);
END;
$$;

-- 7.3 check_product_duplicates
CREATE OR REPLACE FUNCTION adquisiciones.check_product_duplicates(p_data jsonb, p_company_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_sku varchar(50) := upper(trim(p_data->>'sku'));
    v_barcode varchar(100) := trim(COALESCE(p_data->>'barcode', ''));
    v_brand varchar(120) := upper(trim(COALESCE(p_data->>'brand', '')));
    v_description varchar(250) := upper(trim(COALESCE(p_data->>'description', '')));
    v_unit varchar(50) := upper(trim(COALESCE(p_data->>'unit', '')));
    v_warnings jsonb := '[]'::jsonb;
    v_dup record;
BEGIN
    IF v_sku != '' THEN
        SELECT id, sku, description INTO v_dup FROM adquisiciones.products WHERE sku = v_sku AND (company_id IS NULL OR company_id = p_company_id) LIMIT 1;
        IF FOUND THEN v_warnings := v_warnings || jsonb_build_object('type', 'SKU', 'message', 'El SKU "' || v_sku || '" ya existe en el catálogo maestro', 'product_sku', v_dup.sku); END IF;
    END IF;
    IF v_barcode != '' THEN
        SELECT id, sku, barcode INTO v_dup FROM adquisiciones.products WHERE barcode = v_barcode AND (company_id IS NULL OR company_id = p_company_id) LIMIT 1;
        IF FOUND THEN v_warnings := v_warnings || jsonb_build_object('type', 'BARCODE', 'message', 'El código de barra "' || v_barcode || '" ya existe en el catálogo maestro', 'product_sku', v_dup.sku); END IF;
    END IF;
    RETURN jsonb_build_object('warnings', v_warnings);
END;
$$;

GRANT ALL ON ALL FUNCTIONS IN SCHEMA adquisiciones TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';
