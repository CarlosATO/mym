-- Bodega V2: excluir estados legacy no operativos del tablero activo.

CREATE OR REPLACE VIEW logistica.vw_sales_order_preparation_board AS
SELECT
    c.id AS card_id,
    c.company_id,
    c.status,
    c.priority,
    c.assigned_user_id,
    c.route_date,
    c.normalized_city,
    nv.nv_bsale_id,
    nv.nv_folio,
    nv.nv_emission_date,
    nv.nv_generation_date,
    nv.client_name,
    nv.city_raw,
    nv.municipality_raw,
    nv.address_raw,
    nv.seller_bsale_id,
    nv.seller_name,
    nv.total_quantity,
    nv.total_amount,
    nv.invoice_folio,
    nv.is_invoiced,
    c.created_at,
    c.updated_at,
    nv.net_amount,
    nv.tax_amount,
    nv.gross_amount
FROM logistica.sales_order_preparation_cards c
JOIN integraciones.vw_bsale_sales_orders_for_preparation nv
  ON c.company_id = nv.company_id
 AND c.bsale_nv_id = nv.nv_bsale_id
WHERE c.closed_at IS NULL
  AND c.status IN ('PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT')
  AND nv.is_invoiced = false;

ALTER VIEW logistica.vw_sales_order_preparation_board SET (security_invoker = true);
