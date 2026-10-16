-- Bloque 4B-3B: lifecycle reversible controlado por cobertura Bsale.
--
-- Extiende logistica.reconcile_bodega_preparation_cards(uuid) para:
--   1. CERRAR una tarjeta abierta como COVERED_BSALE cuando su NV queda
--      completamente cubierta por documentos Bsale operativos tipo 1/5/7
--      (coverage_status='COMPLETA' en logistica.vw_sales_order_preparation_pending)
--      y NO corresponde un cierre definitivo.
--   2. PROMOVER una tarjeta cerrada COVERED_BSALE al cierre definitivo
--      (INVOICED / CANCELLED_BSALE / NON_OPERATIONAL_BSALE) si luego aparece una
--      condicion terminal, conservando el closed_at original y el mismo card_id/status.
--   3. REABRIR automaticamente una tarjeta cerrada COVERED_BSALE cuando la NV vuelve
--      a tener cantidad pendiente (is_pending=true), conservando card_id y status.
--
-- COVERED_BSALE es REVERSIBLE. INVOICED / CANCELLED_BSALE / NON_OPERATIONAL_BSALE
-- siguen siendo DEFINITIVOS e irreversibles.
--
-- NO se modifica:
--   * la CREACION de tarjetas (vista canonica + ventana de 30 dias);
--   * la logica de bsale_invoice_sales_order_links (Factura -> INVOICED);
--   * la vista canonica logistica.vw_sales_order_preparation_pending;
--   * integraciones.vw_bsale_sales_orders_for_preparation;
--   * logistica.vw_sales_order_preparation_board;
--   * las RPCs de exclusion administratica.
--
-- La ventana de 30 dias solo gobierna CREACION/DESCUBRIMIENTO. Cierre y reapertura
-- por cobertura NO dependen de la ventana (aplican a tarjetas de cualquier antiguedad).
-- Las exclusiones administrativas son ortogonales: cierre/reapertura NO dependen de
-- la existencia de una exclusion activa.

-- ============================================================================
-- 1. Extender closure_reason con COVERED_BSALE (unico valor nuevo).
-- ============================================================================
ALTER TABLE logistica.sales_order_preparation_cards
  DROP CONSTRAINT IF EXISTS sales_order_preparation_cards_closure_reason_check;

ALTER TABLE logistica.sales_order_preparation_cards
  ADD CONSTRAINT sales_order_preparation_cards_closure_reason_check
  CHECK (closure_reason IS NULL OR closure_reason IN (
    'INVOICED', 'CANCELLED_BSALE', 'NON_OPERATIONAL_BSALE', 'COVERED_BSALE'
  ));

-- ============================================================================
-- 2. reconcile_bodega_preparation_cards: crear (sin cambios) + lifecycle
--    reversible por cobertura.
--
-- Orden semantico:
--   1. descubrimiento/creacion (sin cambios);
--   2. cierres definitivos de tarjetas abiertas (sin cambios);
--   3. PROMOCION de COVERED_BSALE a definitivo;
--   4. CIERRE de tarjetas abiertas COMPLETA como COVERED_BSALE;
--   5. REAPERTURA de COVERED_BSALE que vuelven a estar pendientes;
--   6. movimientos SYNC por cada transicion;
--   7. misma forma JSON.
--
-- Idempotencia de movements: el indice unico real es
--   (company_id, card_id, automation_key) WHERE automation_key IS NOT NULL.
-- Se usa la MARCA TEMPORAL REAL de la transicion en la clave, de modo que:
--   * un rerun sin transicion nueva NO vuelve a tocar la tarjeta => no crea movimiento;
--   * un nuevo ciclo (close -> reopen -> close) produce una marca distinta => nuevo movimiento.
--     close: 'BODEGA_COVERED_CLOSE:<closed_at>'
--     reopen: 'BODEGA_COVERED_REOPEN:<now() de la reapertura>'
--     promocion: 'BODEGA_PROMOTION:<motivo definitivo>'
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
  v_promotions integer := 0;
  v_covered_closed integer := 0;
  v_covered_reopened integer := 0;
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
  -- exclusion administrativa activa. SIN CAMBIOS respecto a Bloque 4B-2.
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
  -- CIERRES DEFINITIVOS de tarjetas abiertas: SIN CAMBIOS respecto a Bloques
  -- previos. Precedencia interna vigente: INVOICED > state=1 > state=8888.
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

  -- --------------------------------------------------------------------------
  -- (3) PROMOCION: tarjeta cerrada COVERED_BSALE que adquiere una condicion
  --     definitiva -> cierre definitivo. Conserva closed_at original, card_id
  --     y status. Nunca vuelve a abrirse.
  -- --------------------------------------------------------------------------
  WITH promotable AS (
    SELECT c.id, c.company_id, c.status,
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
      END AS definitive_reason
    FROM logistica.sales_order_preparation_cards c
    JOIN integraciones.bsale_documents nv
      ON nv.company_id = c.company_id
     AND nv.bsale_id = c.bsale_nv_id
     AND nv.document_type_id = 23
    WHERE c.company_id = p_company_id
      AND c.closed_at IS NOT NULL
      AND c.closure_reason = 'COVERED_BSALE'
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
  ),
  promoted AS (
    UPDATE logistica.sales_order_preparation_cards c
    SET closure_reason = p.definitive_reason,
        updated_at = now()
    FROM promotable p
    WHERE c.id = p.id
      AND c.closure_reason = 'COVERED_BSALE'
    RETURNING c.id, c.company_id, c.status, p.definitive_reason
  ),
  promotion_mov AS (
    INSERT INTO logistica.sales_order_preparation_movements (
      company_id, card_id, from_status, to_status, moved_by, movement_source,
      pin_validated, observation, metadata, automation_key
    )
    SELECT company_id, id, status, status, NULL, 'SYNC', false,
      'Cierre Bodega promovido de COVERED_BSALE a ' || definitive_reason,
      jsonb_build_object(
        'closure_reason', definitive_reason,
        'previous_closure_reason', 'COVERED_BSALE',
        'transition', 'PROMOTION',
        'relation_source', 'DETAIL_RELATED_ID'
      ),
      'BODEGA_PROMOTION:' || definitive_reason
    FROM promoted
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_promotions FROM promotion_mov;

  v_movements_created := v_movements_created + v_promotions;

  -- --------------------------------------------------------------------------
  -- (4) CIERRE REVERSIBLE: tarjeta abierta, NV state=0, cobertura COMPLETA,
  --     sin condicion definitiva -> COVERED_BSALE.
  --     El status permanece intacto. No depende de exclusion ni de la ventana.
  -- --------------------------------------------------------------------------
  WITH closeable AS (
    SELECT c.id, c.company_id, c.status,
      cov.original_qty, cov.covered_qty, cov.remaining_qty
    FROM logistica.sales_order_preparation_cards c
    JOIN logistica.vw_sales_order_preparation_pending cov
      ON cov.company_id = c.company_id
     AND cov.nv_bsale_id = c.bsale_nv_id
    WHERE c.company_id = p_company_id
      AND c.closed_at IS NULL
      AND cov.coverage_status = 'COMPLETA'
      AND NOT EXISTS (
        SELECT 1
        FROM integraciones.bsale_invoice_sales_order_links link
        JOIN integraciones.bsale_documents invoice
          ON invoice.company_id = link.company_id
         AND invoice.bsale_id = link.invoice_bsale_id
         AND invoice.document_type_id = 5
        WHERE link.company_id = c.company_id
          AND link.sales_order_bsale_id = c.bsale_nv_id
      )
  ),
  closed AS (
    UPDATE logistica.sales_order_preparation_cards c
    SET closed_at = now(),
        closure_reason = 'COVERED_BSALE',
        updated_at = now()
    FROM closeable cl
    WHERE c.id = cl.id
    RETURNING c.id, c.company_id, c.status, c.closed_at,
      cl.original_qty, cl.covered_qty, cl.remaining_qty
  ),
  close_mov AS (
    INSERT INTO logistica.sales_order_preparation_movements (
      company_id, card_id, from_status, to_status, moved_by, movement_source,
      pin_validated, observation, metadata, automation_key
    )
    SELECT company_id, id, status, status, NULL, 'SYNC', false,
      'Cierre reversible automático: NV cubierta completamente por documentos Bsale (COVERED_BSALE)',
      jsonb_build_object(
        'closure_reason', 'COVERED_BSALE',
        'coverage_status', 'COMPLETA',
        'original_qty', original_qty,
        'covered_qty', covered_qty,
        'remaining_qty', remaining_qty,
        'transition', 'COVERED_CLOSE'
      ),
      'BODEGA_COVERED_CLOSE:' || to_char(closed_at, 'YYYYMMDDHH24MISSUS')
    FROM closed
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_covered_closed FROM close_mov;

  v_movements_created := v_movements_created + v_covered_closed;

  -- --------------------------------------------------------------------------
  -- (5) REAPERTURA: tarjeta cerrada COVERED_BSALE que vuelve a estar pendiente
  --     (evidencia POSITIVA: fila en la vista + is_pending=true, NV state=0).
  --     Sin condicion definitiva. Conserva card_id y status.
  --     Fail-safe: si la NV no aparece en la vista (p.ej. faltan detalles), NO reabre.
  -- --------------------------------------------------------------------------
  WITH reopenable AS (
    SELECT c.id, c.company_id, c.status, cov.remaining_qty
    FROM logistica.sales_order_preparation_cards c
    JOIN logistica.vw_sales_order_preparation_pending cov
      ON cov.company_id = c.company_id
     AND cov.nv_bsale_id = c.bsale_nv_id
    WHERE c.company_id = p_company_id
      AND c.closed_at IS NOT NULL
      AND c.closure_reason = 'COVERED_BSALE'
      AND cov.is_pending = true
      AND NOT EXISTS (
        SELECT 1
        FROM integraciones.bsale_invoice_sales_order_links link
        JOIN integraciones.bsale_documents invoice
          ON invoice.company_id = link.company_id
         AND invoice.bsale_id = link.invoice_bsale_id
         AND invoice.document_type_id = 5
        WHERE link.company_id = c.company_id
          AND link.sales_order_bsale_id = c.bsale_nv_id
      )
  ),
  reopened AS (
    UPDATE logistica.sales_order_preparation_cards c
    SET closed_at = NULL,
        closure_reason = NULL,
        updated_at = now()
    FROM reopenable r
    WHERE c.id = r.id
      AND c.closure_reason = 'COVERED_BSALE'
    RETURNING c.id, c.company_id, c.status, r.remaining_qty, now() AS transition_at
  ),
  reopen_mov AS (
    INSERT INTO logistica.sales_order_preparation_movements (
      company_id, card_id, from_status, to_status, moved_by, movement_source,
      pin_validated, observation, metadata, automation_key
    )
    SELECT company_id, id, status, status, NULL, 'SYNC', false,
      'Reapertura automática: NV volvió a tener cantidad pendiente en Bsale',
      jsonb_build_object(
        'closure_reason', NULL,
        'previous_closure_reason', 'COVERED_BSALE',
        'remaining_qty', remaining_qty,
        'transition', 'COVERED_REOPEN'
      ),
      'BODEGA_COVERED_REOPEN:' || to_char(transition_at, 'YYYYMMDDHH24MISSUS')
    FROM reopened
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_covered_reopened FROM reopen_mov;

  v_movements_created := v_movements_created + v_covered_reopened;

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
    'segun logistica.vw_sales_order_preparation_pending (is_pending=true) dentro de la ventana de 30 dias, '
    'cierra tarjetas abiertas por Factura (INVOICED), state=1 (CANCELLED_BSALE) o state=8888 (NON_OPERATIONAL_BSALE) '
    '(definitivos), y aplica el lifecycle REVERSIBLE por cobertura: cierra como COVERED_BSALE las tarjetas abiertas '
    'cuya NV queda COMPLETA por documentos 1/5/7, promueve COVERED_BSALE a cierre definitivo si aparece condicion '
    'terminal, y reabre COVERED_BSALE si la NV vuelve a quedar pendiente. Conserva card_id y status.';
