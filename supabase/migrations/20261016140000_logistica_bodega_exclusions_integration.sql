-- Bloque 3: integrar las exclusiones manuales de NV (logistica.sales_order_preparation_exclusions)
-- en el flujo de Preparacion/Bodega.
--
-- Alternativa 2: una exclusion activa OCULTA/BLOQUEA pero NO modifica el lifecycle de
-- logistica.sales_order_preparation_cards (no cambia status, closed_at ni closure_reason).
--
-- Cambios:
--   1. logistica.reconcile_bodega_preparation_cards: no crea tarjetas para NV con
--      exclusion activa (y no las cuenta como candidatas descubiertas).
--   2. logistica.vw_sales_order_preparation_board: oculta del Kanban las tarjetas cuya
--      NV tenga exclusion activa, sin tocar la fila de la tarjeta.
--
-- NO se modifica integraciones.vw_bsale_sales_orders_for_preparation: representa el
-- universo bruto de NV sincronizadas (document_type_id=23, state=0) y es consumida por
-- funciones de rutas y por authorize_sales_order_route_exception, que necesitan ver ese
-- universo; la semantica de exclusion se aplica explicitamente en reconcile y en el board.

-- ============================================================================
-- 1. reconcile_bodega_preparation_cards: bloquear creacion por exclusion activa
-- ============================================================================
CREATE OR REPLACE FUNCTION logistica.reconcile_bodega_preparation_cards(
  p_company_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = logistica, integraciones, public
AS $$
DECLARE
  v_relations_created integer := 0;
  v_created integer := 0;
  v_closed_invoiced integer := 0;
  v_closed_cancelled integer := 0;
  v_closed_non_operational integer := 0;
  v_movements_created integer := 0;
  v_discovered integer := 0;
  v_skipped_invoiced integer := 0;
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'p_company_id es obligatorio';
  END IF;

  WITH inserted AS (
    INSERT INTO integraciones.bsale_invoice_sales_order_links (
      company_id, invoice_bsale_id, invoice_detail_bsale_id,
      sales_order_bsale_id, sales_order_detail_bsale_id, relation_source
    )
    SELECT DISTINCT
      invoice_detail.company_id, invoice.bsale_id, invoice_detail.bsale_id,
      sales_order_detail.bsale_document_id, sales_order_detail.bsale_id,
      'DETAIL_RELATED_ID'
    FROM integraciones.bsale_document_details invoice_detail
    JOIN integraciones.bsale_documents invoice
      ON invoice.company_id = invoice_detail.company_id
     AND invoice.bsale_id = invoice_detail.bsale_document_id
     AND invoice.document_type_id = 5
    JOIN integraciones.bsale_document_details sales_order_detail
      ON sales_order_detail.company_id = invoice_detail.company_id
     AND sales_order_detail.bsale_id = invoice_detail.related_detail_bsale_id
    JOIN integraciones.bsale_documents sales_order
      ON sales_order.company_id = sales_order_detail.company_id
     AND sales_order.bsale_id = sales_order_detail.bsale_document_id
     AND sales_order.document_type_id = 23
    WHERE invoice_detail.company_id = p_company_id
      AND invoice_detail.related_detail_bsale_id IS NOT NULL
    ON CONFLICT (company_id, invoice_detail_bsale_id, sales_order_detail_bsale_id)
    DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_relations_created FROM inserted;

  SELECT count(*) INTO v_discovered
  FROM integraciones.bsale_documents nv
  WHERE nv.company_id = p_company_id
    AND nv.document_type_id = 23
    AND nv.state = 0
    AND NOT EXISTS (
      SELECT 1 FROM logistica.sales_order_preparation_cards c
      WHERE c.company_id = p_company_id AND c.bsale_nv_id = nv.bsale_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM logistica.sales_order_preparation_exclusions e
      WHERE e.company_id = nv.company_id
        AND e.bsale_nv_id = nv.bsale_id
        AND e.active = true
    );

  SELECT count(*) INTO v_skipped_invoiced
  FROM integraciones.bsale_documents nv
  WHERE nv.company_id = p_company_id
    AND nv.document_type_id = 23
    AND nv.state = 0
    AND EXISTS (
      SELECT 1
      FROM integraciones.bsale_invoice_sales_order_links link
      JOIN integraciones.bsale_documents invoice
        ON invoice.company_id = link.company_id
       AND invoice.bsale_id = link.invoice_bsale_id
       AND invoice.document_type_id = 5
      WHERE link.company_id = nv.company_id
        AND link.sales_order_bsale_id = nv.bsale_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM logistica.sales_order_preparation_cards c
      WHERE c.company_id = p_company_id AND c.bsale_nv_id = nv.bsale_id
    );

  WITH inserted AS (
    INSERT INTO logistica.sales_order_preparation_cards (
      company_id, bsale_nv_id, bsale_nv_folio, raw_city, raw_municipality,
      normalized_city, status
    )
    SELECT nv.company_id, nv.bsale_id, nv.number::text,
      nv.raw_json->>'city', nv.raw_json->>'municipality',
      logistica.normalize_city(nv.company_id, nv.raw_json->>'city'),
      'PENDING_ROUTE_PREP'
    FROM integraciones.bsale_documents nv
    WHERE nv.company_id = p_company_id
      AND nv.document_type_id = 23
      AND nv.state = 0
      AND NOT EXISTS (
        SELECT 1
        FROM integraciones.bsale_invoice_sales_order_links link
        JOIN integraciones.bsale_documents invoice
          ON invoice.company_id = link.company_id
         AND invoice.bsale_id = link.invoice_bsale_id
         AND invoice.document_type_id = 5
        WHERE link.company_id = nv.company_id
          AND link.sales_order_bsale_id = nv.bsale_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM logistica.sales_order_preparation_cards c
        WHERE c.company_id = p_company_id AND c.bsale_nv_id = nv.bsale_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM logistica.sales_order_preparation_exclusions e
        WHERE e.company_id = nv.company_id
          AND e.bsale_nv_id = nv.bsale_id
          AND e.active = true
      )
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_created FROM inserted;

  WITH candidates AS (
    SELECT c.id, c.company_id, c.status, nv.bsale_id AS bsale_document_id,
      nv.state AS bsale_state,
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM integraciones.bsale_invoice_sales_order_links link
          JOIN integraciones.bsale_documents invoice
            ON invoice.company_id = link.company_id
           AND invoice.bsale_id = link.invoice_bsale_id
           AND invoice.document_type_id = 5
          WHERE link.company_id = nv.company_id
            AND link.sales_order_bsale_id = nv.bsale_id
        ) THEN 'INVOICED'
        WHEN nv.state = 1 THEN 'CANCELLED_BSALE'
        WHEN nv.state = 8888 THEN 'NON_OPERATIONAL_BSALE'
      END AS closure_reason
    FROM logistica.sales_order_preparation_cards c
    JOIN integraciones.bsale_documents nv
      ON nv.company_id = c.company_id
     AND nv.bsale_id = c.bsale_nv_id
     AND nv.document_type_id = 23
    WHERE c.company_id = p_company_id
      AND c.closed_at IS NULL
      AND (
        nv.state IN (1, 8888)
        OR EXISTS (
          SELECT 1
          FROM integraciones.bsale_invoice_sales_order_links link
          JOIN integraciones.bsale_documents invoice
            ON invoice.company_id = link.company_id
           AND invoice.bsale_id = link.invoice_bsale_id
           AND invoice.document_type_id = 5
          WHERE link.company_id = nv.company_id
            AND link.sales_order_bsale_id = nv.bsale_id
        )
      )
  )
  INSERT INTO logistica.sales_order_preparation_movements (
    company_id, card_id, from_status, to_status, moved_by, movement_source,
    pin_validated, observation, metadata, automation_key
  )
  SELECT company_id, id, status, status, NULL, 'SYNC', false,
    'Cierre automático de Bodega',
    jsonb_build_object(
      'closure_reason', closure_reason,
      'bsale_state', bsale_state,
      'bsale_document_id', bsale_document_id,
      'relation_source', 'DETAIL_RELATED_ID'
    ),
    'BODEGA_CLOSURE:' || closure_reason
  FROM candidates
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_movements_created = ROW_COUNT;

  WITH updated AS (
    UPDATE logistica.sales_order_preparation_cards c
    SET closed_at = now(),
        closure_reason = CASE
          WHEN EXISTS (
            SELECT 1
            FROM integraciones.bsale_invoice_sales_order_links link
            JOIN integraciones.bsale_documents invoice
              ON invoice.company_id = link.company_id
             AND invoice.bsale_id = link.invoice_bsale_id
             AND invoice.document_type_id = 5
            WHERE link.company_id = nv.company_id
              AND link.sales_order_bsale_id = nv.bsale_id
          ) THEN 'INVOICED'
          WHEN nv.state = 1 THEN 'CANCELLED_BSALE'
          WHEN nv.state = 8888 THEN 'NON_OPERATIONAL_BSALE'
        END,
        updated_at = now()
    FROM integraciones.bsale_documents nv
    WHERE c.company_id = p_company_id
      AND c.closed_at IS NULL
      AND nv.company_id = c.company_id
      AND nv.bsale_id = c.bsale_nv_id
      AND nv.document_type_id = 23
      AND (
        nv.state IN (1, 8888)
        OR EXISTS (
          SELECT 1
          FROM integraciones.bsale_invoice_sales_order_links link
          JOIN integraciones.bsale_documents invoice
            ON invoice.company_id = link.company_id
           AND invoice.bsale_id = link.invoice_bsale_id
           AND invoice.document_type_id = 5
          WHERE link.company_id = nv.company_id
            AND link.sales_order_bsale_id = nv.bsale_id
        )
      )
    RETURNING c.closure_reason
  )
  SELECT count(*) FILTER (WHERE closure_reason = 'INVOICED'),
    count(*) FILTER (WHERE closure_reason = 'CANCELLED_BSALE'),
    count(*) FILTER (WHERE closure_reason = 'NON_OPERATIONAL_BSALE')
  INTO v_closed_invoiced, v_closed_cancelled, v_closed_non_operational
  FROM updated;

  RETURN jsonb_build_object(
    'relations_created', v_relations_created,
    'discovered', v_discovered,
    'skipped_invoiced', v_skipped_invoiced,
    'created', v_created,
    'closed_invoiced', v_closed_invoiced,
    'closed_cancelled', v_closed_cancelled,
    'closed_non_operational', v_closed_non_operational,
    'movements_created', v_movements_created
  );
END;
$$;

REVOKE ALL ON FUNCTION logistica.reconcile_bodega_preparation_cards(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION logistica.reconcile_bodega_preparation_cards(uuid) TO service_role;

-- ============================================================================
-- 2. Kanban: ocultar tarjetas cuya NV tenga exclusion activa (sin tocar la fila)
-- ============================================================================
CREATE OR REPLACE VIEW logistica.vw_sales_order_preparation_board AS
SELECT
    c.id AS card_id, c.company_id, c.status, c.priority, c.assigned_user_id,
    c.route_date, c.normalized_city, nv.nv_bsale_id, nv.nv_folio,
    nv.nv_emission_date, nv.nv_generation_date, nv.client_name, nv.city_raw,
    nv.municipality_raw, nv.address_raw, nv.seller_bsale_id, nv.seller_name,
    nv.total_quantity, nv.total_amount, nv.invoice_folio, nv.is_invoiced,
    c.created_at, c.updated_at, nv.net_amount, nv.tax_amount, nv.gross_amount
FROM logistica.sales_order_preparation_cards c
JOIN integraciones.vw_bsale_sales_orders_for_preparation nv
  ON c.company_id = nv.company_id AND c.bsale_nv_id = nv.nv_bsale_id
WHERE c.closed_at IS NULL
  AND c.status IN ('PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT')
  AND nv.is_invoiced = false
  AND NOT EXISTS (
    SELECT 1
    FROM logistica.sales_order_preparation_exclusions e
    WHERE e.company_id = c.company_id
      AND e.bsale_nv_id = c.bsale_nv_id
      AND e.active = true
  );

ALTER VIEW logistica.vw_sales_order_preparation_board SET (security_invoker = true);
