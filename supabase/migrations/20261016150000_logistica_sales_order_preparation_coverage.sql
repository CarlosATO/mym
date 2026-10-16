-- Bloque 4B-2: fuente canonica SQL de cobertura de Notas de Venta (NV) y nueva
-- regla de CREACION de tarjetas de Preparacion/Bodega.
--
-- Objetivo: que `logistica.reconcile_bodega_preparation_cards` cree tarjetas NUEVAS
-- unicamente para NV realmente pendientes (con cantidad pendiente despues de la
-- cobertura por documentos 1/5/7), dentro de la ventana validada de 30 dias y sin
-- exclusion administrativa activa.
--
-- Esta migracion NO cambia el CIERRE de tarjetas existentes:
--   * Factura (document_type_id=5 via bsale_invoice_sales_order_links) -> INVOICED
--   * NV state=1   -> CANCELLED_BSALE
--   * NV state=8888 -> NON_OPERATIONAL_BSALE
-- Tampoco cierra todavia por Boleta (1) ni Guia (7) ni por coverage_status=COMPLETA.
-- Ese comportamiento sera un bloque posterior independiente.
--
-- Esta migracion NO modifica el board (logistica.vw_sales_order_preparation_board)
-- ni la vista legacy (integraciones.vw_bsale_sales_orders_for_preparation).

-- ============================================================================
-- 1. Fuente canonica de cobertura por NV.
--
-- Responsabilidad acotada: SOLO cobertura cuantitativa por detalle.
-- NO aplica:
--   * ventana temporal de 30 dias (responsabilidad de reconcile);
--   * exclusiones administrativas (responsabilidad de reconcile / board).
-- Por eso puede responder tambien por NV antiguas y reutilizarse despues para
-- revisar/cerrar tarjetas existentes.
--
-- Universo: documentos padre type=23 (Nota de Venta) con state=0.
-- Cobertura: por cada DETALLE original de la NV se suman las cantidades de
-- detalles hijos (misma company_id) cuyo related_detail_bsale_id apunta al detalle
-- original y cuyo documento padre es type IN (1=Boleta, 5=Factura, 7=Guia) con
-- state=0. La suma se TOPA por detalle (LEAST) a la cantidad original, de modo que
-- el doble conteo por varios documentos que referencian el mismo detalle nunca
-- produce covered_qty > original_qty. El tope es POR DETALLE, no global.
--
-- Documentos hijos anulados (state<>0) NO cubren.
-- Notas de credito (type=2) NO se consideran y NO se restan (riesgo documentado:
-- la evidencia actual no demuestra que una NC deba reconstruir la reserva de una NV
-- y la regla validada contra Bsale no las uso).
--
-- NV SIN detalles sincronizados: NO aparece en la vista (inner join a detalles). No
-- se le inventa remaining_qty; simplemente no es candidata a crear tarjeta nueva.
--
-- Clasificacion:
--   COMPLETA   : remaining_qty = 0
--   SIN_CIERRE : covered_qty = 0 (y remaining_qty > 0)
--   PARCIAL    : covered_qty > 0 AND remaining_qty > 0
--   is_pending : remaining_qty > 0
-- Nota: una NV con detalles y original_qty=0 cae en COMPLETA (no pendiente); es un
-- caso degenerado y no se convierte en remaining artificial.
-- ============================================================================
CREATE OR REPLACE VIEW logistica.vw_sales_order_preparation_pending AS
WITH nv_detail_coverage AS (
    SELECT
        nv.company_id,
        nv.bsale_id::bigint AS nv_bsale_id,
        nv.number AS nv_folio,
        nv.emission_date,
        nv.generation_date,
        nv.raw_json->>'city' AS raw_city,
        nv.raw_json->>'municipality' AS raw_municipality,
        GREATEST(COALESCE(d.quantity, 0), 0) AS original_qty_detail,
        LEAST(
            GREATEST(COALESCE(d.quantity, 0), 0),
            COALESCE(cover.covered_qty, 0)
        ) AS covered_qty_detail
    FROM integraciones.bsale_documents nv
    JOIN integraciones.bsale_document_details d
      ON d.company_id = nv.company_id
     AND d.bsale_document_id = nv.bsale_id
    LEFT JOIN LATERAL (
        SELECT SUM(GREATEST(COALESCE(child.quantity, 0), 0)) AS covered_qty
        FROM integraciones.bsale_document_details child
        JOIN integraciones.bsale_documents child_doc
          ON child_doc.company_id = child.company_id
         AND child_doc.bsale_id = child.bsale_document_id
        WHERE child.company_id = nv.company_id
          AND child.related_detail_bsale_id = d.bsale_id
          AND child_doc.document_type_id IN (1, 5, 7)
          AND child_doc.state = 0
    ) cover ON true
    WHERE nv.document_type_id = 23
      AND nv.state = 0
)
SELECT
    company_id,
    nv_bsale_id,
    nv_folio,
    emission_date,
    generation_date,
    raw_city,
    raw_municipality,
    SUM(original_qty_detail)::numeric AS original_qty,
    SUM(covered_qty_detail)::numeric AS covered_qty,
    SUM(GREATEST(original_qty_detail - covered_qty_detail, 0))::numeric AS remaining_qty,
    CASE
        WHEN SUM(GREATEST(original_qty_detail - covered_qty_detail, 0)) = 0 THEN 'COMPLETA'
        WHEN SUM(covered_qty_detail) = 0 THEN 'SIN_CIERRE'
        ELSE 'PARCIAL'
    END AS coverage_status,
    (SUM(GREATEST(original_qty_detail - covered_qty_detail, 0)) > 0) AS is_pending
FROM nv_detail_coverage
GROUP BY
    company_id,
    nv_bsale_id,
    nv_folio,
    emission_date,
    generation_date,
    raw_city,
    raw_municipality;

ALTER VIEW logistica.vw_sales_order_preparation_pending SET (security_invoker = true);

REVOKE ALL ON logistica.vw_sales_order_preparation_pending FROM PUBLIC, anon;
GRANT SELECT ON logistica.vw_sales_order_preparation_pending TO service_role;

COMMENT ON VIEW logistica.vw_sales_order_preparation_pending IS
    'Fuente canonica de COBERTURA cuantitativa por Nota de Venta (type=23, state=0). '
    'covered_qty suma detalles hijos 1/5/7 (state=0) topado POR DETALLE a la cantidad original; '
    'NO aplica ventana temporal ni exclusiones administrativas (responsabilidad de reconcile/board). '
    'NV sin detalles no aparece (no elegible). is_pending = remaining_qty > 0.';

-- ============================================================================
-- 2. reconcile_bodega_preparation_cards: crear tarjetas SOLO para NV realmente
--    pendientes segun la vista canonica, dentro de la ventana de 30 dias.
--
-- Se preserva integra la logica de:
--   * materializacion de bsale_invoice_sales_order_links;
--   * CIERRE de tarjetas existentes (INVOICED / CANCELLED_BSALE / NON_OPERATIONAL_BSALE);
--   * conteo diagnostico skipped_invoiced.
-- Solo cambian v_discovered y el INSERT ... SELECT de creacion para alinearse con
-- la vista canonica + ventana 30 dias (America/Santiago, ambos extremos inclusivos).
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
  v_business_date date := (now() AT TIME ZONE 'America/Santiago')::date;
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

  -- v_discovered: universo EXACTO de NV elegibles para CREAR tarjeta nueva.
  -- Debe coincidir con el INSERT de mas abajo.
  SELECT count(*) INTO v_discovered
  FROM logistica.vw_sales_order_preparation_pending candidate
  WHERE candidate.company_id = p_company_id
    AND candidate.is_pending = true
    AND candidate.emission_date >= v_business_date - 30
    AND candidate.emission_date <= v_business_date
    AND NOT EXISTS (
      SELECT 1 FROM logistica.sales_order_preparation_cards c
      WHERE c.company_id = p_company_id AND c.bsale_nv_id = candidate.nv_bsale_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM logistica.sales_order_preparation_exclusions e
      WHERE e.company_id = candidate.company_id
        AND e.bsale_nv_id = candidate.nv_bsale_id
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

  -- Creacion: SOLO NV realmente pendientes (is_pending), dentro de la ventana de
  -- 30 dias validada (ambos extremos inclusivos), sin tarjeta previa y sin
  -- exclusion administrativa activa.
  WITH inserted AS (
    INSERT INTO logistica.sales_order_preparation_cards (
      company_id, bsale_nv_id, bsale_nv_folio, raw_city, raw_municipality,
      normalized_city, status
    )
    SELECT candidate.company_id, candidate.nv_bsale_id, candidate.nv_folio::text,
      candidate.raw_city, candidate.raw_municipality,
      logistica.normalize_city(candidate.company_id, candidate.raw_city),
      'PENDING_ROUTE_PREP'
    FROM logistica.vw_sales_order_preparation_pending candidate
    WHERE candidate.company_id = p_company_id
      AND candidate.is_pending = true
      AND candidate.emission_date >= v_business_date - 30
      AND candidate.emission_date <= v_business_date
      AND NOT EXISTS (
        SELECT 1 FROM logistica.sales_order_preparation_cards c
        WHERE c.company_id = p_company_id AND c.bsale_nv_id = candidate.nv_bsale_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM logistica.sales_order_preparation_exclusions e
        WHERE e.company_id = candidate.company_id
          AND e.bsale_nv_id = candidate.nv_bsale_id
          AND e.active = true
      )
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_created FROM inserted;

  -- --------------------------------------------------------------------------
  -- CIERRE de tarjetas existentes: SIN CAMBIOS respecto a Bloque 3.
  -- NO cierra por Boleta (1), Guia (7) ni coverage_status=COMPLETA.
  -- --------------------------------------------------------------------------
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

COMMENT ON FUNCTION logistica.reconcile_bodega_preparation_cards(uuid) IS
    'Materializa enlaces NV->Factura (type=5), crea tarjetas NUEVAS solo para NV realmente pendientes '
    'segun logistica.vw_sales_order_preparation_pending (is_pending=true), dentro de la ventana de 30 dias '
    '(America/Santiago, extremos inclusivos) y sin exclusion administrativa activa, y cierra tarjetas existentes '
    'por Factura (INVOICED), state=1 (CANCELLED_BSALE) o state=8888 (NON_OPERATIONAL_BSALE). '
    'NO cierra por Boleta/Guia pendiente de un bloque posterior.';
