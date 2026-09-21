-- Mermas: align operational catalog varchar columns with the RPC text contract.

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
SET search_path = pg_catalog, public, auth, core, portal, adquisiciones, mermas
AS $$
DECLARE
  v_markup numeric;
BEGIN
  IF p_company_id IS NULL OR p_user_id IS NULL
     OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.internal_sale.create') THEN
    RAISE EXCEPTION 'No autorizado para cargar el catálogo de venta interna';
  END IF;
  IF p_today_plus_five IS NULL THEN
    RAISE EXCEPTION 'Fecha de elegibilidad inválida';
  END IF;

  SELECT worker_markup_percent INTO v_markup
  FROM mermas.internal_sale_settings
  WHERE company_id = p_company_id;
  IF v_markup IS NULL OR v_markup < 0 THEN
    RAISE EXCEPTION 'La configuración de venta a trabajadores está incompleta';
  END IF;

  RETURN QUERY
  SELECT
    product.bsale_variant_id,
    product.sku::text,
    product.description::text,
    cost.average_cost,
    cost.average_cost * 1.19,
    v_markup,
    sum(stock.available),
    round(cost.average_cost * 1.19 * (1 + v_markup / 100)),
    min(stock.expiration_date)
  FROM mermas.stock_current stock
  JOIN adquisiciones.products product
    ON product.company_id = stock.company_id
   AND product.bsale_variant_id = stock.variant_id
   AND product.is_active = true
   AND product.status = 'ACTIVE'
   AND coalesce(product.bsale_variant_state, 0) = 0
  CROSS JOIN LATERAL (
    SELECT mermas.resolve_internal_sale_cost(p_company_id, stock.variant_id) AS average_cost
  ) cost
  WHERE stock.company_id = p_company_id
    AND stock.expiration_date >= p_today_plus_five
    AND stock.available > 0
    AND cost.average_cost > 0
  GROUP BY product.bsale_variant_id, product.sku, product.description, cost.average_cost
  ORDER BY product.description, product.sku;
END;
$$;

REVOKE ALL ON FUNCTION mermas.get_internal_sale_catalog(uuid, uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.get_internal_sale_catalog(uuid, uuid, date) TO service_role;
