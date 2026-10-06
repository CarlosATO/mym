CREATE OR REPLACE FUNCTION adquisiciones.validate_product_supplier_mapping_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones
AS $$
DECLARE
    v_product adquisiciones.products%ROWTYPE;
BEGIN
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

DROP TRIGGER IF EXISTS trg_product_supplier_mapping_integrity
    ON adquisiciones.product_supplier_mappings;

CREATE TRIGGER trg_product_supplier_mapping_integrity
BEFORE INSERT OR UPDATE ON adquisiciones.product_supplier_mappings
FOR EACH ROW
EXECUTE FUNCTION adquisiciones.validate_product_supplier_mapping_integrity();

COMMENT ON FUNCTION adquisiciones.validate_product_supplier_mapping_integrity() IS
    'Impide mappings de proveedor cuyo producto no coincide por empresa, SKU y variante Bsale.';
