-- Resolve route-guide customer identity from the Bsale document, never from
-- the display name. The trigger covers future inserts and invoice edits.

CREATE OR REPLACE FUNCTION logistica.set_route_guide_item_customer_bsale_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, logistica, integraciones
AS $$
DECLARE
    v_match_count integer;
    v_client_id bigint;
BEGIN
    SELECT count(*)::integer, min(d.client_id)
    INTO v_match_count, v_client_id
    FROM integraciones.bsale_documents d
    WHERE d.company_id = NEW.company_id
      AND d.number::text = btrim(NEW.invoice_number)
      AND d.document_type_id = 5;

    IF v_match_count = 1
       AND EXISTS (
           SELECT 1
           FROM integraciones.bsale_clients c
           WHERE c.company_id = NEW.company_id
             AND c.bsale_client_id = v_client_id
       ) THEN
        NEW.customer_bsale_id := v_client_id;
    ELSE
        -- Do not retain a stale identity after an invoice/company edit.
        NEW.customer_bsale_id := NULL;
    END IF;

    RETURN NEW;
END;
$$;

ALTER FUNCTION logistica.set_route_guide_item_customer_bsale_id() OWNER TO postgres;

DROP TRIGGER IF EXISTS set_route_guide_item_customer_bsale_id
ON logistica.route_guide_items;

CREATE TRIGGER set_route_guide_item_customer_bsale_id
BEFORE INSERT OR UPDATE OF company_id, invoice_number
ON logistica.route_guide_items
FOR EACH ROW
EXECUTE FUNCTION logistica.set_route_guide_item_customer_bsale_id();

-- Backfill only the requested guides, only with one Bsale invoice, a valid
-- Bsale client, and matching document amount. GR-2026-000001 is excluded.
WITH source AS (
    SELECT gi.id AS guide_item_id, min(d.client_id) AS client_id
    FROM logistica.route_guide_items gi
    JOIN logistica.route_guides g ON g.id = gi.route_guide_id
    JOIN integraciones.bsale_documents d
      ON d.company_id = gi.company_id
     AND d.number::text = btrim(gi.invoice_number)
     AND d.document_type_id = 5
     AND d.total_amount = gi.amount
    JOIN integraciones.bsale_clients c
      ON c.company_id = d.company_id
     AND c.bsale_client_id = d.client_id
    WHERE g.guide_number IN (
    'GR-2026-000002', 'GR-2026-000003', 'GR-2026-000004',
    'GR-2026-000005', 'GR-2026-000006', 'GR-2026-000007',
    'GR-2026-000008', 'GR-2026-000009'
    )
      AND g.guide_number <> 'GR-2026-000001'
    GROUP BY gi.id
    HAVING count(*) = 1
)
UPDATE logistica.route_guide_items gi
SET customer_bsale_id = source.client_id
FROM source
WHERE gi.id = source.guide_item_id
  AND gi.customer_bsale_id IS NULL;

-- RR-2026-000002 is still untouched financially: synchronize identity only.
DO $$
DECLARE
    v_settlement_id uuid;
    v_guide_id uuid;
    v_item_count integer;
    v_updated integer;
BEGIN
    SELECT rs.id, rs.route_guide_id
    INTO v_settlement_id, v_guide_id
    FROM adquisiciones.route_settlements rs
    JOIN logistica.route_guides g ON g.id = rs.route_guide_id
    WHERE rs.settlement_number = 'RR-2026-000002'
      AND g.guide_number = 'GR-2026-000002';

    IF v_settlement_id IS NULL THEN
        RAISE EXCEPTION 'RR-2026-000002 no existe o no corresponde a GR-2026-000002.';
    END IF;

    IF EXISTS (SELECT 1 FROM adquisiciones.route_settlement_payments WHERE settlement_id = v_settlement_id)
       OR EXISTS (SELECT 1 FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND resolution_type IS NOT NULL) THEN
        RAISE EXCEPTION 'RR-2026-000002 ya contiene Payments o resoluciones.';
    END IF;

    SELECT count(*) INTO v_item_count
    FROM adquisiciones.route_settlement_items
    WHERE settlement_id = v_settlement_id;

    IF v_item_count <> 13 THEN
        RAISE EXCEPTION 'RR-2026-000002 debe contener 13 settlement_items; se encontraron %.', v_item_count;
    END IF;

    UPDATE adquisiciones.route_settlement_items si
    SET customer_bsale_id = gi.customer_bsale_id
    FROM logistica.route_guide_items gi
    WHERE si.settlement_id = v_settlement_id
      AND si.route_guide_item_id = gi.id
      AND gi.route_guide_id = v_guide_id
      AND gi.customer_bsale_id IS NOT NULL
      AND si.customer_bsale_id IS NULL;

    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND customer_bsale_id IS NULL) <> 0 THEN
        RAISE EXCEPTION 'RR-2026-000002 conserva settlement_items sin customer_bsale_id.';
    END IF;

    IF v_updated <> 13 THEN
        RAISE EXCEPTION 'Se actualizaron % settlement_items; se esperaban 13.', v_updated;
    END IF;
END;
$$;
