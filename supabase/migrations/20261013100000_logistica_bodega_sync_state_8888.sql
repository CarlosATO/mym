-- Bodega: habilitar los triggers de sync y tratar state=8888 como no operativo.

ALTER TABLE integraciones.bsale_sync_runs
  ALTER COLUMN trigger TYPE varchar(40);

ALTER TABLE integraciones.bsale_sync_runs
  DROP CONSTRAINT IF EXISTS bsale_sync_runs_trigger_check;

ALTER TABLE integraciones.bsale_sync_runs
  ADD CONSTRAINT bsale_sync_runs_trigger_check
  CHECK (trigger IN (
    'INITIAL', 'CRON', 'NIGHTLY', 'MANUAL', 'SCHEDULED',
    'ROUTE_GUIDE_DIRECTED', 'WAREHOUSE_PREP', 'WAREHOUSE_INCREMENTAL',
    'WAREHOUSE_OPERATIONAL', 'WAREHOUSE_FULL'
  ));

ALTER TABLE logistica.sales_order_preparation_cards
  DROP CONSTRAINT IF EXISTS sales_order_preparation_cards_closure_reason_check;

ALTER TABLE logistica.sales_order_preparation_cards
  ADD CONSTRAINT sales_order_preparation_cards_closure_reason_check
  CHECK (closure_reason IS NULL OR closure_reason IN (
    'INVOICED', 'CANCELLED_BSALE', 'NON_OPERATIONAL_BSALE'
  ));

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

CREATE OR REPLACE VIEW integraciones.vw_bsale_sales_orders_for_preparation AS
SELECT
    nv.company_id, nv.bsale_id AS nv_bsale_id, nv.number AS nv_folio,
    nv.emission_date AS nv_emission_date, nv.generation_date AS nv_generation_date,
    nv.client_id, c.company AS client_name, c.code AS client_rut,
    nv.raw_json->>'city' AS city_raw, nv.raw_json->>'municipality' AS municipality_raw,
    nv.raw_json->>'address' AS address_raw,
    CAST(nv.raw_json->'user'->>'id' AS int) AS seller_bsale_id,
    s.name AS seller_name, nv.total_amount,
    (SELECT COUNT(d.id) FROM integraciones.bsale_document_details d
      WHERE d.company_id = nv.company_id AND d.bsale_document_id = nv.bsale_id) AS products_count,
    (SELECT SUM(d.quantity) FROM integraciones.bsale_document_details d
      WHERE d.company_id = nv.company_id AND d.bsale_document_id = nv.bsale_id) AS total_quantity,
    invoice_link.invoice_bsale_id, invoice.number::text AS invoice_folio,
    invoice.emission_date AS invoice_emission_date,
    (invoice_link.invoice_bsale_id IS NOT NULL) AS is_invoiced,
    nv.client_id AS client_bsale_id, nv.raw_json->>'city' AS nv_city_raw,
    nv.raw_json->>'municipality' AS nv_municipality_raw,
    c.city AS client_city_raw, c.commune AS client_municipality_raw,
    CASE
      WHEN c.commune IS NOT NULL AND trim(c.commune) <> '' THEN trim(c.commune)
      WHEN nv.raw_json->>'municipality' IS NOT NULL AND trim(nv.raw_json->>'municipality') <> '' THEN trim(nv.raw_json->>'municipality')
      WHEN c.city IS NOT NULL AND trim(c.city) <> '' THEN trim(c.city)
      WHEN nv.raw_json->>'city' IS NOT NULL AND trim(nv.raw_json->>'city') <> '' THEN trim(nv.raw_json->>'city')
      ELSE 'SIN COMUNA'
    END AS route_location_raw,
    CASE
      WHEN c.commune IS NOT NULL AND trim(c.commune) <> '' THEN 'CLIENT_MUNICIPALITY'
      WHEN nv.raw_json->>'municipality' IS NOT NULL AND trim(nv.raw_json->>'municipality') <> '' THEN 'NV_MUNICIPALITY'
      WHEN c.city IS NOT NULL AND trim(c.city) <> '' THEN 'CLIENT_CITY'
      WHEN nv.raw_json->>'city' IS NOT NULL AND trim(nv.raw_json->>'city') <> '' THEN 'NV_CITY'
      ELSE 'UNKNOWN'
    END AS route_location_source,
    nv.net_amount, nv.tax_amount, nv.total_amount AS gross_amount
FROM integraciones.bsale_documents nv
LEFT JOIN integraciones.bsale_clients c
  ON nv.company_id = c.company_id AND nv.client_id = c.bsale_client_id
LEFT JOIN integraciones.bsale_sellers s
  ON nv.company_id = s.company_id
 AND CAST(nv.raw_json->'user'->>'id' AS int) = s.bsale_id
LEFT JOIN LATERAL (
  SELECT link.invoice_bsale_id
  FROM integraciones.bsale_invoice_sales_order_links link
  JOIN integraciones.bsale_documents historical_invoice
    ON historical_invoice.company_id = link.company_id
   AND historical_invoice.bsale_id = link.invoice_bsale_id
   AND historical_invoice.document_type_id = 5
  WHERE link.company_id = nv.company_id
    AND link.sales_order_bsale_id = nv.bsale_id
  ORDER BY historical_invoice.generation_date DESC NULLS LAST, link.invoice_bsale_id DESC
  LIMIT 1
) invoice_link ON true
LEFT JOIN integraciones.bsale_documents invoice
  ON invoice.company_id = nv.company_id
 AND invoice.bsale_id = invoice_link.invoice_bsale_id
WHERE nv.document_type_id = 23 AND nv.state = 0;

ALTER VIEW integraciones.vw_bsale_sales_orders_for_preparation SET (security_invoker = true);

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
  AND nv.is_invoiced = false;

ALTER VIEW logistica.vw_sales_order_preparation_board SET (security_invoker = true);
