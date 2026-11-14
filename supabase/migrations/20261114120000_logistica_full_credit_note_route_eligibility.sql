-- Excluye únicamente anulaciones totales demostradas por el espejo Bsale.
-- No modifica tarjetas ni documentos. Se conserva la definición vigente de los
-- consumidores y se interrumpe la migración si su estructura ya cambió.
BEGIN;

CREATE FUNCTION logistica.invoice_fully_cancelled_by_credit_note(p_company_id uuid, p_invoice_id bigint)
RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM integraciones.bsale_documents invoice
    JOIN integraciones.bsale_document_references ref
      ON ref.company_id = invoice.company_id
     AND (ref.referenced_document_id = invoice.bsale_id
          OR (ref.referenced_document_id IS NULL
              AND btrim(ref.referenced_document_number) = invoice.number::text))
    JOIN integraciones.bsale_documents note
      ON note.company_id = ref.company_id AND note.bsale_id = ref.bsale_document_id
     AND note.document_type_id = 2 AND note.state = 0
     AND coalesce(note.raw_json->>'cancellationStatus', '0') = '0'
    WHERE invoice.company_id = p_company_id AND invoice.bsale_id = p_invoice_id
      AND invoice.document_type_id = 5 AND invoice.number IS NOT NULL
      AND invoice.total_amount > 0 AND note.total_amount = invoice.total_amount
      AND (ref.reference_code IS NULL OR btrim(ref.reference_code) = '1')
      AND (ref.referenced_document_type_id IS NULL OR ref.referenced_document_type_id IN (5, 33))
      AND (ref.referenced_document_type IS NULL OR btrim(ref.referenced_document_type) IN ('5', '33'))
      AND (ref.referenced_document_number IS NULL OR btrim(ref.referenced_document_number) = invoice.number::text)
      -- Un folio duplicado o varias referencias hacen incierta la asociación.
      AND 1 = (SELECT count(*) FROM integraciones.bsale_documents other
               WHERE other.company_id = invoice.company_id AND other.document_type_id = 5
                 AND other.number = invoice.number)
      AND 1 = (SELECT count(*) FROM integraciones.bsale_document_references other_ref
               WHERE other_ref.company_id = note.company_id AND other_ref.bsale_document_id = note.bsale_id)
      AND EXISTS (SELECT 1 FROM integraciones.bsale_document_details line
                  WHERE line.company_id = invoice.company_id AND line.bsale_document_id = invoice.bsale_id)
      AND NOT EXISTS (
        SELECT 1 FROM integraciones.bsale_document_details line
        WHERE line.company_id = invoice.company_id
          AND line.bsale_document_id IN (invoice.bsale_id, note.bsale_id)
          AND (line.variant_id IS NULL OR line.quantity IS NULL OR line.quantity <= 0
               OR line.net_amount IS NULL OR line.total_amount IS NULL)
      )
      -- Comparación multiconjunto: también detecta líneas repetidas o faltantes.
      AND NOT EXISTS (
        (SELECT variant_id, quantity, net_amount, total_amount, count(*)
         FROM integraciones.bsale_document_details
         WHERE company_id = invoice.company_id AND bsale_document_id = invoice.bsale_id
         GROUP BY variant_id, quantity, net_amount, total_amount
         EXCEPT
         SELECT variant_id, quantity, net_amount, total_amount, count(*)
         FROM integraciones.bsale_document_details
         WHERE company_id = note.company_id AND bsale_document_id = note.bsale_id
         GROUP BY variant_id, quantity, net_amount, total_amount)
        UNION ALL
        (SELECT variant_id, quantity, net_amount, total_amount, count(*)
         FROM integraciones.bsale_document_details
         WHERE company_id = note.company_id AND bsale_document_id = note.bsale_id
         GROUP BY variant_id, quantity, net_amount, total_amount
         EXCEPT
         SELECT variant_id, quantity, net_amount, total_amount, count(*)
         FROM integraciones.bsale_document_details
         WHERE company_id = invoice.company_id AND bsale_document_id = invoice.bsale_id
         GROUP BY variant_id, quantity, net_amount, total_amount)
      )
  );
$function$;

REVOKE ALL ON FUNCTION logistica.invoice_fully_cancelled_by_credit_note(uuid, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION logistica.invoice_fully_cancelled_by_credit_note(uuid, bigint) TO authenticated, service_role;

DO $migration$
DECLARE
  definition text;
  changed text;
  target regprocedure;
  marker text := 'AND coalesce(d.raw_json->>''cancellationStatus'', ''0'') = ''0''';
BEGIN
  -- La vista de 28 columnas se conserva, incluyendo sus opciones y grants.
  SELECT pg_get_viewdef('logistica.vw_sales_order_preparation_board'::regclass, true) INTO definition;
  changed := replace(definition, 'ORDER BY a.confirmed_at DESC NULLS LAST',
    'AND NOT logistica.invoice_fully_cancelled_by_credit_note(d.company_id, d.bsale_id) ORDER BY a.confirmed_at DESC NULLS LAST');
  IF changed = definition OR (length(definition) - length(replace(definition, 'ORDER BY a.confirmed_at DESC NULLS LAST', ''))) / length('ORDER BY a.confirmed_at DESC NULLS LAST') <> 1 THEN
    RAISE EXCEPTION 'La definición del tablero cambió; revisar antes de aplicar';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW logistica.vw_sales_order_preparation_board AS ' || changed;

  -- Ambos RPC se filtran por la misma regla. El escritor usa draft_rows y
  -- rechaza atómicamente si falta alguna factura solicitada.
  FOREACH target IN ARRAY ARRAY[
    'logistica.get_route_invoice_draft_rows(uuid,bigint[])'::regprocedure,
    'logistica.get_route_invoice_selection_candidates(uuid)'::regprocedure
  ] LOOP
    SELECT pg_get_functiondef(target) INTO definition;
    changed := replace(definition, marker, marker || E'\n      AND NOT logistica.invoice_fully_cancelled_by_credit_note(d.company_id, d.bsale_id)');
    IF changed = definition OR (length(definition) - length(replace(definition, marker, ''))) / length(marker) <> 1 THEN
      RAISE EXCEPTION 'La definición de % cambió; revisar antes de aplicar', target;
    END IF;
    EXECUTE changed;
  END LOOP;
END;
$migration$;

COMMIT;
