-- Forward-only repair for the administrative preparation exclusions regression.
-- This migration is intentionally isolated: it does not alter the already
-- applied migrations, permissions, card statuses, or route-guide read models.

BEGIN;

-- The exclusion follows the card's historical NV and its canonical current
-- revision. Revocation remains active=false and therefore preserves history.
CREATE OR REPLACE FUNCTION logistica.preparation_card_is_excluded(
  p_company_id uuid,
  p_card_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, logistica, integraciones
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM logistica.sales_order_preparation_cards c
    JOIN logistica.sales_order_preparation_exclusions e
      ON e.company_id = c.company_id
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
    WHERE c.company_id = p_company_id
      AND c.id = p_card_id
  );
$$;

REVOKE ALL ON FUNCTION logistica.preparation_card_is_excluded(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION logistica.preparation_card_is_excluded(uuid, uuid) TO service_role;

-- Restore the 28-column board contract from the latest read model, while
-- applying the exclusion predicate to both historical and canonical NV IDs.
CREATE OR REPLACE VIEW logistica.vw_sales_order_preparation_board AS
WITH board AS (
  SELECT
    c.id AS card_id, c.company_id, c.status, c.priority, c.assigned_user_id,
    c.route_date, c.normalized_city, nv.nv_bsale_id, nv.nv_folio,
    nv.nv_emission_date, nv.nv_generation_date, nv.client_name, nv.city_raw,
    nv.municipality_raw, nv.address_raw, nv.seller_bsale_id, nv.seller_name,
    nv.total_quantity, nv.total_amount, nv.net_amount, nv.tax_amount,
    nv.gross_amount, c.created_at, c.updated_at, nv.is_invoiced,
    c.locked_by_user_id, c.locked_at,
    nv.invoice_folio AS historical_invoice_folio,
    eligible.invoice_bsale_id AS read_model_invoice_bsale_id,
    eligible.invoice_folio AS read_model_invoice_folio,
    eligible.invoice_total_amount AS read_model_invoice_total_amount
  FROM logistica.sales_order_preparation_cards c
  JOIN integraciones.vw_bsale_sales_orders_for_preparation nv
    ON c.company_id = nv.company_id
   AND COALESCE(c.current_bsale_nv_id, c.bsale_nv_id) = nv.nv_bsale_id
  LEFT JOIN LATERAL (
    SELECT a.bsale_invoice_id AS invoice_bsale_id,
           d.number::text AS invoice_folio,
           d.total_amount AS invoice_total_amount
    FROM logistica.sales_order_invoice_attempts a
    JOIN integraciones.bsale_documents d
      ON d.company_id = a.company_id
     AND d.bsale_id = a.bsale_invoice_id
     AND d.document_type_id = 5
     AND d.state = 0
     AND COALESCE(d.raw_json->>'cancellationStatus', '0') = '0'
    WHERE a.company_id = c.company_id
      AND a.card_id = c.id
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
  WHERE (
    (
      c.closed_at IS NULL
      AND c.status IN ('PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT', 'AUDITED')
      AND nv.is_invoiced = false
    )
    OR (
      c.status = 'INVOICED_READY_FOR_ROUTE'
      AND eligible.invoice_bsale_id IS NOT NULL
    )
  )
  AND NOT EXISTS (
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
)
SELECT
  card_id, company_id, status, priority, assigned_user_id, route_date,
  normalized_city, nv_bsale_id, nv_folio, nv_emission_date,
  nv_generation_date, client_name, city_raw, municipality_raw, address_raw,
  seller_bsale_id, seller_name, total_quantity, total_amount,
  CASE WHEN status = 'INVOICED_READY_FOR_ROUTE'
       THEN read_model_invoice_folio ELSE historical_invoice_folio END AS invoice_folio,
  CASE WHEN status = 'INVOICED_READY_FOR_ROUTE'
       THEN read_model_invoice_bsale_id IS NOT NULL ELSE is_invoiced END AS is_invoiced,
  created_at, updated_at, net_amount, tax_amount, gross_amount,
  locked_by_user_id, locked_at
FROM board;

ALTER VIEW logistica.vw_sales_order_preparation_board SET (security_invoker = true);

-- Direct RPC calls must not prepare, audit, or finalize an excluded card.
CREATE OR REPLACE FUNCTION logistica.guard_excluded_preparation_card()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, logistica
AS $$
BEGIN
  IF logistica.preparation_card_is_excluded(NEW.company_id, NEW.card_id) THEN
    RAISE EXCEPTION 'La tarjeta está excluida administrativamente y no puede operar en Preparación.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION logistica.guard_excluded_card_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, logistica
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status
     AND NEW.status IN ('IN_PREPARATION', 'IN_AUDIT', 'AUDITED', 'INVOICED_READY_FOR_ROUTE')
     AND logistica.preparation_card_is_excluded(NEW.company_id, NEW.id) THEN
    RAISE EXCEPTION 'La tarjeta está excluida administrativamente y no puede avanzar en el flujo.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION logistica.guard_excluded_invoice_attempt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, logistica
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF logistica.preparation_card_is_excluded(NEW.company_id, NEW.card_id) THEN
      RAISE EXCEPTION 'La tarjeta está excluida administrativamente y no puede facturarse.';
    END IF;
  ELSIF TG_OP = 'UPDATE'
        AND OLD.status IS DISTINCT FROM NEW.status
        AND NEW.status = 'SUBMITTING'
        AND logistica.preparation_card_is_excluded(NEW.company_id, NEW.card_id) THEN
    RAISE EXCEPTION 'La tarjeta está excluida administrativamente y no puede facturarse.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_excluded_preparation_lines
  ON logistica.sales_order_preparation_lines;
CREATE TRIGGER trg_guard_excluded_preparation_lines
  BEFORE INSERT OR UPDATE ON logistica.sales_order_preparation_lines
  FOR EACH ROW EXECUTE FUNCTION logistica.guard_excluded_preparation_card();

DROP TRIGGER IF EXISTS trg_guard_excluded_audits
  ON logistica.sales_order_audits;
CREATE TRIGGER trg_guard_excluded_audits
  BEFORE INSERT OR UPDATE ON logistica.sales_order_audits
  FOR EACH ROW EXECUTE FUNCTION logistica.guard_excluded_preparation_card();

DROP TRIGGER IF EXISTS trg_guard_excluded_audit_lines
  ON logistica.sales_order_audit_lines;
CREATE TRIGGER trg_guard_excluded_audit_lines
  BEFORE INSERT OR UPDATE ON logistica.sales_order_audit_lines
  FOR EACH ROW EXECUTE FUNCTION logistica.guard_excluded_preparation_card();

DROP TRIGGER IF EXISTS trg_guard_excluded_card_status_change
  ON logistica.sales_order_preparation_cards;
CREATE TRIGGER trg_guard_excluded_card_status_change
  BEFORE UPDATE ON logistica.sales_order_preparation_cards
  FOR EACH ROW EXECUTE FUNCTION logistica.guard_excluded_card_status_change();

DROP TRIGGER IF EXISTS trg_guard_excluded_invoice_attempt
  ON logistica.sales_order_invoice_attempts;
CREATE TRIGGER trg_guard_excluded_invoice_attempt
  BEFORE INSERT OR UPDATE ON logistica.sales_order_invoice_attempts
  FOR EACH ROW EXECUTE FUNCTION logistica.guard_excluded_invoice_attempt();

COMMIT;
