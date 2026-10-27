-- Optimización aislada del read model del Kanban de Preparación.
--
-- La vista conserva el contrato de 28 columnas y separa los dos universos que
-- tienen reglas distintas:
--   * estados operativos: no requieren buscar intentos de factura;
--   * INVOICED_READY_FOR_ROUTE: requiere factura confirmada y no incluida en
--     una Guía de Ruta activa.
--
-- No modifica tablas, estados, sincronización Bsale, RLS ni permisos. El
-- rollback exacto está preparado en:
-- supabase/rollback/20261026120000_logistica_optimize_sales_order_preparation_board.sql

BEGIN;

CREATE OR REPLACE VIEW logistica.vw_sales_order_preparation_board AS
WITH candidate_cards AS (
  SELECT
    c.id,
    c.company_id,
    c.status,
    c.priority,
    c.assigned_user_id,
    c.route_date,
    c.normalized_city,
    c.bsale_nv_id,
    c.current_bsale_nv_id,
    c.created_at,
    c.updated_at,
    c.locked_by_user_id,
    c.locked_at,
    c.closed_at,
    c.canonical_bsale_token
  FROM logistica.sales_order_preparation_cards c
  WHERE (
    c.closed_at IS NULL
    AND c.status IN ('PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT', 'AUDITED')
  )
  OR c.status = 'INVOICED_READY_FOR_ROUTE'
),
-- La vista Bsale y la resolución canónica se expanden una sola vez. Esta
-- materialización contiene únicamente las tarjetas candidatas ya unidas a su
-- NV vigente y excluidas; no materializa el universo completo de documentos.
candidate_bsale AS MATERIALIZED (
  SELECT
    c.id AS card_id, c.company_id, c.status, c.priority, c.assigned_user_id,
    c.route_date, c.normalized_city, nv.nv_bsale_id, nv.nv_folio,
    nv.nv_emission_date, nv.nv_generation_date, nv.client_name, nv.city_raw,
    nv.municipality_raw, nv.address_raw, nv.seller_bsale_id, nv.seller_name,
    nv.total_quantity, nv.total_amount, nv.net_amount, nv.tax_amount,
    nv.gross_amount, c.created_at, c.updated_at, nv.is_invoiced,
    c.locked_by_user_id, c.locked_at, nv.invoice_folio AS historical_invoice_folio,
    c.bsale_nv_id, c.current_bsale_nv_id, c.canonical_bsale_token
  FROM candidate_cards c
  JOIN integraciones.vw_bsale_sales_orders_for_preparation nv
    ON c.company_id = nv.company_id
   AND COALESCE(c.current_bsale_nv_id, c.bsale_nv_id) = nv.nv_bsale_id
  WHERE NOT EXISTS (
    SELECT 1
    FROM logistica.sales_order_preparation_exclusions e
    WHERE e.company_id = c.company_id
      AND e.active = true
      AND (
        e.bsale_nv_id = c.bsale_nv_id
        OR e.bsale_nv_id = c.current_bsale_nv_id
        OR (
          c.canonical_bsale_token IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM integraciones.bsale_documents excluded_nv
            WHERE excluded_nv.company_id = e.company_id
              AND excluded_nv.bsale_id = e.bsale_nv_id
              AND excluded_nv.document_type_id = 23
              AND NULLIF(btrim(excluded_nv.raw_json ->> 'token'), '') = c.canonical_bsale_token
          )
        )
      )
  )
),
operational_board AS (
  SELECT *
  FROM candidate_bsale
  WHERE status IN ('PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT', 'AUDITED')
    AND is_invoiced = false
),
invoiced_board AS (
  SELECT
    c.card_id, c.company_id, c.status, c.priority, c.assigned_user_id,
    c.route_date, c.normalized_city, c.nv_bsale_id, c.nv_folio,
    c.nv_emission_date, c.nv_generation_date, c.client_name, c.city_raw,
    c.municipality_raw, c.address_raw, c.seller_bsale_id, c.seller_name,
    c.total_quantity, c.total_amount, c.net_amount, c.tax_amount,
    c.gross_amount, c.created_at, c.updated_at, c.is_invoiced,
    c.locked_by_user_id, c.locked_at, c.historical_invoice_folio,
    eligible.invoice_bsale_id AS read_model_invoice_bsale_id,
    eligible.invoice_folio AS read_model_invoice_folio
  FROM candidate_bsale c
  LEFT JOIN LATERAL (
    SELECT a.bsale_invoice_id AS invoice_bsale_id,
           d.number::text AS invoice_folio
    FROM logistica.sales_order_invoice_attempts a
    JOIN integraciones.bsale_documents d
      ON d.company_id = a.company_id
     AND d.bsale_id = a.bsale_invoice_id
     AND d.document_type_id = 5
     AND d.state = 0
     AND COALESCE(d.raw_json->>'cancellationStatus', '0') = '0'
    WHERE a.company_id = c.company_id
      AND a.card_id = c.card_id
      AND a.status = 'CONFIRMED'
      AND a.bsale_invoice_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM logistica.route_guide_items rgi
        JOIN logistica.route_guides rg
          ON rg.id = rgi.route_guide_id
         AND rg.company_id = rgi.company_id
         AND rg.status IN ('DRAFT', 'DISPATCHED')
        WHERE rgi.company_id = a.company_id
          AND rgi.validation_status = 'VALID'
          AND (
            rgi.invoice_bsale_id = a.bsale_invoice_id
            OR (
              rgi.invoice_bsale_id IS NULL
              AND rgi.invoice_number = d.number::text
            )
          )
      )
    ORDER BY a.confirmed_at DESC NULLS LAST, a.created_at DESC
    LIMIT 1
  ) eligible ON true
  WHERE c.status = 'INVOICED_READY_FOR_ROUTE'
    AND eligible.invoice_bsale_id IS NOT NULL
)
SELECT
  card_id, company_id, status, priority, assigned_user_id, route_date,
  normalized_city, nv_bsale_id, nv_folio, nv_emission_date,
  nv_generation_date, client_name, city_raw, municipality_raw, address_raw,
  seller_bsale_id, seller_name, total_quantity, total_amount,
  historical_invoice_folio AS invoice_folio, is_invoiced, created_at, updated_at,
  net_amount, tax_amount, gross_amount, locked_by_user_id, locked_at
FROM operational_board
UNION ALL
SELECT
  card_id, company_id, status, priority, assigned_user_id, route_date,
  normalized_city, nv_bsale_id, nv_folio, nv_emission_date,
  nv_generation_date, client_name, city_raw, municipality_raw, address_raw,
  seller_bsale_id, seller_name, total_quantity, total_amount,
  read_model_invoice_folio AS invoice_folio,
  read_model_invoice_bsale_id IS NOT NULL AS is_invoiced,
  created_at, updated_at, net_amount, tax_amount, gross_amount,
  locked_by_user_id, locked_at
FROM invoiced_board;

ALTER VIEW logistica.vw_sales_order_preparation_board SET (security_invoker = true);

COMMIT;
