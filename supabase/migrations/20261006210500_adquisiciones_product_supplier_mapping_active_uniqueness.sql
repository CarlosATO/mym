ALTER TABLE adquisiciones.product_supplier_mappings
    DROP CONSTRAINT IF EXISTS product_supplier_mappings_company_id_supplier_id_sku_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_psm_company_supplier_sku_active
    ON adquisiciones.product_supplier_mappings(company_id, supplier_id, sku)
    WHERE is_active = true;

CREATE OR REPLACE FUNCTION adquisiciones.validate_product_supplier_mapping_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones
AS $$
DECLARE
    v_product adquisiciones.products%ROWTYPE;
BEGIN
    -- Allow retiring legacy rows before repairing their product identity.
    IF TG_OP = 'UPDATE'
       AND NEW.is_active = false
       AND OLD.company_id IS NOT DISTINCT FROM NEW.company_id
       AND OLD.sku IS NOT DISTINCT FROM NEW.sku
       AND OLD.product_id IS NOT DISTINCT FROM NEW.product_id
       AND OLD.bsale_variant_id IS NOT DISTINCT FROM NEW.bsale_variant_id THEN
        RETURN NEW;
    END IF;

    IF NEW.product_id IS NULL THEN
        RAISE EXCEPTION 'product_supplier_mapping.product_id es obligatorio para company_id=% y sku=%', NEW.company_id, NEW.sku
            USING ERRCODE = '23514';
    END IF;

    SELECT * INTO v_product
    FROM adquisiciones.products
    WHERE id = NEW.product_id;

    IF NOT FOUND
       OR v_product.company_id IS DISTINCT FROM NEW.company_id
       OR v_product.sku IS DISTINCT FROM NEW.sku
       OR v_product.bsale_variant_id IS DISTINCT FROM NEW.bsale_variant_id THEN
        RAISE EXCEPTION 'Mapping de proveedor inconsistente: product_id %, company_id %, sku %, bsale_variant_id %',
            NEW.product_id, NEW.company_id, NEW.sku, NEW.bsale_variant_id
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;
