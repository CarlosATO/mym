ALTER TABLE adquisiciones.products
  ADD COLUMN IF NOT EXISTS sales_unit_factor integer NOT NULL DEFAULT 1;

ALTER TABLE adquisiciones.products
  ADD CONSTRAINT products_sales_unit_factor_check CHECK (sales_unit_factor >= 1);

CREATE OR REPLACE FUNCTION adquisiciones.save_purchase_unit_configuration(
  p_company_id uuid, p_user_id uuid, p_product_ids uuid[], p_mapping_id uuid,
  p_purchase_unit text, p_purchase_factor integer, p_sales_factor integer
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, adquisiciones AS $$
DECLARE v_count integer;
BEGIN
  IF p_company_id IS NULL OR p_user_id IS NULL OR p_product_ids IS NULL OR
     cardinality(p_product_ids) < 1 OR cardinality(p_product_ids) > 500 OR
     (SELECT count(DISTINCT id) FROM unnest(p_product_ids) AS id) <> cardinality(p_product_ids) THEN
    RAISE EXCEPTION 'Productos inválidos';
  END IF;
  IF p_sales_factor IS NULL AND p_purchase_unit IS NULL AND p_purchase_factor IS NULL THEN
    RAISE EXCEPTION 'No hay cambios';
  END IF;
  IF p_sales_factor IS NOT NULL AND p_sales_factor < 1 THEN RAISE EXCEPTION 'Factor de venta inválido'; END IF;
  IF (p_purchase_unit IS NOT NULL AND p_purchase_unit NOT IN ('UNIDAD','BOLSA','DISPLAY','CAJA','PACK','SACHET')) OR
     (p_purchase_factor IS NOT NULL AND p_purchase_factor < 1) THEN RAISE EXCEPTION 'Configuración de compra inválida'; END IF;
  IF (p_purchase_unit IS NOT NULL OR p_purchase_factor IS NOT NULL) AND (p_mapping_id IS NULL OR cardinality(p_product_ids) <> 1) THEN
    RAISE EXCEPTION 'Mapeo de compra requerido';
  END IF;
  PERFORM id FROM adquisiciones.products WHERE company_id = p_company_id AND is_active AND id = ANY(p_product_ids) FOR UPDATE;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> cardinality(p_product_ids) THEN RAISE EXCEPTION 'Producto no encontrado'; END IF;
  IF p_purchase_unit IS NOT NULL OR p_purchase_factor IS NOT NULL THEN
    UPDATE adquisiciones.product_supplier_mappings SET
      purchase_unit = COALESCE(p_purchase_unit, purchase_unit),
      purchase_unit_factor = COALESCE(p_purchase_factor, purchase_unit_factor),
      updated_at = now(), updated_by = p_user_id
    WHERE id = p_mapping_id AND product_id = p_product_ids[1] AND company_id = p_company_id AND is_active;
    IF NOT FOUND THEN RAISE EXCEPTION 'Mapeo no encontrado'; END IF;
  END IF;
  IF p_sales_factor IS NOT NULL THEN
    UPDATE adquisiciones.products SET sales_unit_factor = p_sales_factor, updated_at = now(), updated_by = p_user_id
    WHERE company_id = p_company_id AND is_active AND id = ANY(p_product_ids);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.save_purchase_unit_configuration(uuid, uuid, uuid[], uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION adquisiciones.save_purchase_unit_configuration(uuid, uuid, uuid[], uuid, text, integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION adquisiciones.update_purchase_units_bulk(
  p_company_id uuid, p_user_id uuid, p_mapping_ids uuid[],
  p_purchase_unit text, p_purchase_factor integer
) RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, adquisiciones AS $$
DECLARE v_updated integer;
BEGIN
  IF p_company_id IS NULL OR p_user_id IS NULL OR p_mapping_ids IS NULL OR
     cardinality(p_mapping_ids) < 1 OR cardinality(p_mapping_ids) > 500 OR
     (SELECT count(DISTINCT id) FROM unnest(p_mapping_ids) AS id) <> cardinality(p_mapping_ids) THEN
    RAISE EXCEPTION 'Selección de mapeos inválida';
  END IF;
  IF p_purchase_unit IS NULL OR p_purchase_unit NOT IN ('UNIDAD', 'BOLSA', 'DISPLAY', 'CAJA', 'PACK', 'SACHET') OR
     p_purchase_factor IS NULL OR p_purchase_factor < 1 THEN
    RAISE EXCEPTION 'Configuración de compra inválida';
  END IF;

  UPDATE adquisiciones.product_supplier_mappings
  SET purchase_unit = p_purchase_unit, purchase_unit_factor = p_purchase_factor,
      updated_at = now(), updated_by = p_user_id
  WHERE company_id = p_company_id AND is_active AND id = ANY(p_mapping_ids);
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> cardinality(p_mapping_ids) THEN
    RAISE EXCEPTION 'No se actualizaron todos los mapeos activos solicitados';
  END IF;
  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.update_purchase_units_bulk(uuid, uuid, uuid[], text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION adquisiciones.update_purchase_units_bulk(uuid, uuid, uuid[], text, integer) TO service_role;
