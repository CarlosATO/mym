-- Consolidate the eligible worker-sale catalog into one read-only RPC.

CREATE OR REPLACE FUNCTION mermas.get_internal_sale_catalog(
  p_company_id uuid,
  p_user_id uuid,
  p_today_plus_five date
) RETURNS TABLE (
  bsale_variant_id integer,
  sku text,
  product_name text,
  average_cost numeric,
  cost_with_vat numeric,
  default_markup_percent numeric,
  eligible_stock numeric,
  worker_unit_price numeric,
  next_eligible_expiration date
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, integraciones, mermas
AS $$
DECLARE
  v_markup numeric;
BEGIN
  IF p_company_id IS NULL OR p_user_id IS NULL
     OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(
       p_user_id,
       p_company_id,
       'logistica.mermas.internal_sale.create'
     ) THEN
    RAISE EXCEPTION 'No autorizado para cargar el catálogo de venta interna';
  END IF;

  IF p_today_plus_five IS NULL THEN
    RAISE EXCEPTION 'Fecha de elegibilidad inválida';
  END IF;

  SELECT worker_markup_percent
  INTO v_markup
  FROM mermas.internal_sale_settings
  WHERE company_id = p_company_id;

  IF v_markup IS NULL OR v_markup < 0 THEN
    RAISE EXCEPTION 'La configuración de venta a trabajadores está incompleta';
  END IF;

  RETURN QUERY
  SELECT
    variant.bsale_id,
    COALESCE(variant.code, variant.bsale_id::text),
    COALESCE(product.name, 'Producto Bsale'),
    cost.average_cost,
    cost.average_cost * 1.19,
    v_markup,
    SUM(stock.available),
    ROUND(cost.average_cost * 1.19 * (1 + v_markup / 100)),
    MIN(stock.expiration_date)
  FROM mermas.stock_current stock
  JOIN integraciones.bsale_variants variant
    ON variant.company_id = stock.company_id
   AND variant.bsale_id = stock.variant_id
   AND variant.state = 0
  JOIN integraciones.bsale_variant_costs cost
    ON cost.company_id = stock.company_id
   AND cost.variant_id = stock.variant_id
  JOIN integraciones.bsale_products product
    ON product.company_id = variant.company_id
   AND product.bsale_id = variant.bsale_product_id
  WHERE stock.company_id = p_company_id
    AND stock.expiration_date >= p_today_plus_five
    AND stock.available > 0
    AND cost.average_cost > 0
  GROUP BY
    variant.bsale_id,
    variant.code,
    product.name,
    cost.average_cost
  ORDER BY product.name, variant.code;
END;
$$;

REVOKE ALL ON FUNCTION mermas.get_internal_sale_catalog(uuid, uuid, date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.get_internal_sale_catalog(uuid, uuid, date)
  TO service_role;
