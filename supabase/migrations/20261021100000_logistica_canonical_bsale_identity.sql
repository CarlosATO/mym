-- Identidad lógica de Notas de Venta Bsale.
-- bsale_nv_id conserva la evidencia física con la que nació una tarjeta;
-- current_bsale_nv_id apunta a la última versión del mismo documento lógico.

BEGIN;

ALTER TABLE logistica.sales_order_preparation_cards
  ADD COLUMN IF NOT EXISTS canonical_bsale_token text,
  ADD COLUMN IF NOT EXISTS current_bsale_nv_id bigint;

-- Resolver único de versiones físicas. Los documentos sin token quedan fuera y
-- sólo pueden ser tratados por el fallback inequívoco del backfill/reconcile.
CREATE OR REPLACE VIEW integraciones.vw_bsale_sales_order_documents_canonical AS
WITH ranked AS (
  SELECT d.*,
         d.raw_json ->> 'token' AS canonical_bsale_token,
         row_number() OVER (
           PARTITION BY d.company_id, d.document_type_id, d.raw_json ->> 'token'
           ORDER BY d.generation_date DESC NULLS LAST, d.bsale_id DESC
         ) AS version_rank
  FROM integraciones.bsale_documents d
  WHERE d.document_type_id = 23
    AND NULLIF(btrim(d.raw_json ->> 'token'), '') IS NOT NULL
)
SELECT company_id, document_type_id, canonical_bsale_token, number AS folio,
       bsale_id AS current_bsale_id, generation_date, state, client_id, office_id,
       raw_json
FROM ranked
WHERE version_rank = 1;

ALTER VIEW integraciones.vw_bsale_sales_order_documents_canonical SET (security_invoker = true);
GRANT SELECT ON integraciones.vw_bsale_sales_order_documents_canonical TO authenticated, service_role;

-- Backfill: el token siempre nace del documento físico de la tarjeta. El
-- fallback por folio sólo se aplica cuando devuelve una única identidad.
UPDATE logistica.sales_order_preparation_cards c
SET canonical_bsale_token = NULLIF(btrim(d.raw_json ->> 'token'), ''),
    current_bsale_nv_id = d.bsale_id
FROM integraciones.bsale_documents d
WHERE d.company_id = c.company_id
  AND d.bsale_id = c.bsale_nv_id
  AND d.document_type_id = 23;

UPDATE logistica.sales_order_preparation_cards c
SET canonical_bsale_token = f.canonical_bsale_token,
    current_bsale_nv_id = f.current_bsale_id
FROM (
  SELECT c2.id, canon.canonical_bsale_token, canon.current_bsale_id
  FROM logistica.sales_order_preparation_cards c2
  JOIN integraciones.bsale_documents original
    ON original.company_id = c2.company_id
   AND original.bsale_id = c2.bsale_nv_id
   AND original.document_type_id = 23
  JOIN (
    SELECT company_id, number, count(*) AS physical_count
    FROM integraciones.bsale_documents
    WHERE document_type_id = 23
    GROUP BY company_id, number
  ) unique_folio
    ON unique_folio.company_id = original.company_id
   AND unique_folio.number = original.number
   AND unique_folio.physical_count = 1
  JOIN integraciones.vw_bsale_sales_order_documents_canonical canon
    ON canon.company_id = original.company_id
   AND canon.folio = original.number
  WHERE c2.canonical_bsale_token IS NULL
) f
WHERE c.id = f.id;

UPDATE logistica.sales_order_preparation_cards c
SET current_bsale_nv_id = canon.current_bsale_id
FROM integraciones.vw_bsale_sales_order_documents_canonical canon
WHERE c.canonical_bsale_token = canon.canonical_bsale_token
  AND c.company_id = canon.company_id
  AND c.current_bsale_nv_id IS DISTINCT FROM canon.current_bsale_id;

CREATE INDEX IF NOT EXISTS sales_order_preparation_cards_current_nv_idx
  ON logistica.sales_order_preparation_cards(company_id, current_bsale_nv_id);

COMMENT ON COLUMN logistica.sales_order_preparation_cards.bsale_nv_id IS
  'Version física histórica con la que nació la tarjeta; no se reescribe por revisiones Bsale.';
COMMENT ON COLUMN logistica.sales_order_preparation_cards.current_bsale_nv_id IS
  'Versión física vigente resuelta por company + document_type=23 + token + generation_date/bsale_id.';
COMMENT ON COLUMN logistica.sales_order_preparation_cards.canonical_bsale_token IS
  'Identidad técnica estable del documento lógico Bsale.';

-- La vista operativa y sus candidatos sólo exponen la versión vigente. Las
-- tablas de snapshots permanecen ligadas a bsale_nv_id histórico.
CREATE OR REPLACE VIEW integraciones.vw_bsale_sales_orders_for_preparation AS
SELECT
  d.company_id, d.bsale_id AS nv_bsale_id, d.number AS nv_folio,
  d.emission_date AS nv_emission_date, d.generation_date AS nv_generation_date,
  d.client_id, c.company AS client_name, c.code AS client_rut,
  d.raw_json->>'city' AS city_raw, d.raw_json->>'municipality' AS municipality_raw,
  d.raw_json->>'address' AS address_raw,
  CAST(d.raw_json->'user'->>'id' AS int) AS seller_bsale_id, s.name AS seller_name,
  d.total_amount,
  (SELECT count(*) FROM integraciones.bsale_document_details x WHERE x.company_id=d.company_id AND x.bsale_document_id=d.bsale_id) AS products_count,
  (SELECT sum(x.quantity) FROM integraciones.bsale_document_details x WHERE x.company_id=d.company_id AND x.bsale_document_id=d.bsale_id) AS total_quantity,
  invoice_link.invoice_bsale_id, invoice.number::text AS invoice_folio,
  invoice.emission_date AS invoice_emission_date, (invoice_link.invoice_bsale_id IS NOT NULL) AS is_invoiced,
  d.client_id AS client_bsale_id, d.raw_json->>'city' AS nv_city_raw, d.raw_json->>'municipality' AS nv_municipality_raw,
  c.city AS client_city_raw, c.commune AS client_municipality_raw,
  COALESCE(NULLIF(trim(c.commune), ''), NULLIF(trim(d.raw_json->>'municipality'), ''), NULLIF(trim(c.city), ''), NULLIF(trim(d.raw_json->>'city'), ''), 'SIN COMUNA') AS route_location_raw,
  CASE WHEN NULLIF(trim(c.commune), '') IS NOT NULL THEN 'CLIENT_MUNICIPALITY' WHEN NULLIF(trim(d.raw_json->>'municipality'), '') IS NOT NULL THEN 'NV_MUNICIPALITY' WHEN NULLIF(trim(c.city), '') IS NOT NULL THEN 'CLIENT_CITY' WHEN NULLIF(trim(d.raw_json->>'city'), '') IS NOT NULL THEN 'NV_CITY' ELSE 'UNKNOWN' END AS route_location_source,
  d.net_amount, d.tax_amount, d.total_amount AS gross_amount
FROM integraciones.vw_bsale_sales_order_documents_canonical canon
JOIN integraciones.bsale_documents d ON d.company_id=canon.company_id AND d.bsale_id=canon.current_bsale_id
LEFT JOIN integraciones.bsale_clients c ON c.company_id=d.company_id AND c.bsale_client_id=d.client_id
LEFT JOIN integraciones.bsale_sellers s ON s.company_id=d.company_id AND s.bsale_id=CAST(d.raw_json->'user'->>'id' AS int)
LEFT JOIN LATERAL (
  SELECT link.invoice_bsale_id FROM integraciones.bsale_invoice_sales_order_links link
  JOIN integraciones.bsale_documents inv ON inv.company_id=link.company_id AND inv.bsale_id=link.invoice_bsale_id AND inv.document_type_id=5
  WHERE link.company_id=d.company_id AND link.sales_order_bsale_id=d.bsale_id
  ORDER BY inv.generation_date DESC NULLS LAST, link.invoice_bsale_id DESC LIMIT 1
) invoice_link ON true
LEFT JOIN integraciones.bsale_documents invoice ON invoice.company_id=d.company_id AND invoice.bsale_id=invoice_link.invoice_bsale_id
WHERE d.state IN (0, 8888);

ALTER VIEW integraciones.vw_bsale_sales_orders_for_preparation SET (security_invoker = true);

CREATE OR REPLACE VIEW logistica.vw_sales_order_preparation_board AS
SELECT c.id AS card_id, c.company_id, c.status, c.priority, c.assigned_user_id,
  c.route_date, c.normalized_city, nv.nv_bsale_id, nv.nv_folio, nv.nv_emission_date,
  nv.nv_generation_date, nv.client_name, nv.city_raw, nv.municipality_raw, nv.address_raw,
  nv.seller_bsale_id, nv.seller_name, nv.total_quantity, nv.total_amount, nv.invoice_folio,
   nv.is_invoiced, c.created_at, c.updated_at, nv.net_amount, nv.tax_amount, nv.gross_amount,
   c.locked_by_user_id, c.locked_at
FROM logistica.sales_order_preparation_cards c
JOIN integraciones.vw_bsale_sales_orders_for_preparation nv
  ON c.company_id=nv.company_id AND c.current_bsale_nv_id=nv.nv_bsale_id
WHERE c.closed_at IS NULL AND c.status IN ('PENDING_ROUTE_PREP','IN_PREPARATION','IN_AUDIT','AUDITED')
  AND nv.is_invoiced=false;

ALTER VIEW logistica.vw_sales_order_preparation_board SET (security_invoker = true);

-- Actualiza la referencia vigente sin tocar snapshots ni historial. Se obtiene
-- la definición instalada para conservar el lifecycle de Bodega anterior.
DO $migration$
DECLARE v_definition text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_definition
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='logistica' AND p.proname='reconcile_bodega_preparation_cards'
    AND pg_get_function_identity_arguments(p.oid)='p_company_id uuid';
  IF v_definition IS NULL THEN RAISE EXCEPTION 'No existe reconcile_bodega_preparation_cards(uuid).'; END IF;
  v_definition := replace(v_definition,
    E'BEGIN\n',
    $body$BEGIN
  UPDATE logistica.sales_order_preparation_cards c
     SET current_bsale_nv_id = canon.current_bsale_id,
         updated_at = now()
    FROM integraciones.vw_bsale_sales_order_documents_canonical canon
   WHERE c.company_id = p_company_id
     AND c.canonical_bsale_token = canon.canonical_bsale_token
     AND c.current_bsale_nv_id IS DISTINCT FROM canon.current_bsale_id;
$body$);
  v_definition := replace(v_definition, 'c.bsale_nv_id', 'COALESCE(c.current_bsale_nv_id, c.bsale_nv_id)');
  v_definition := replace(v_definition,
    'company_id, bsale_nv_id, bsale_nv_folio, raw_city',
    'company_id, bsale_nv_id, current_bsale_nv_id, canonical_bsale_token, bsale_nv_folio, raw_city');
  v_definition := replace(v_definition,
    'candidate.company_id, candidate.nv_bsale_id, candidate.nv_folio::text,',
    $replacement$candidate.company_id, candidate.nv_bsale_id, candidate.nv_bsale_id,
      NULLIF(btrim((SELECT d.raw_json->>'token' FROM integraciones.bsale_documents d
        WHERE d.company_id=candidate.company_id AND d.bsale_id=candidate.nv_bsale_id)), ''),
      candidate.nv_folio::text,$replacement$);
  EXECUTE v_definition;
END $migration$;

REVOKE ALL ON FUNCTION logistica.reconcile_bodega_preparation_cards(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION logistica.reconcile_bodega_preparation_cards(uuid) TO service_role;

-- Verificación contra la versión vigente. El detail_id histórico sólo se usa
-- si pertenece al documento vigente; variant_id y SKU resuelven revisiones.
CREATE OR REPLACE FUNCTION logistica.verify_open_preparation_incidents_v1(p_company_id uuid, p_bsale_nv_ids bigint[] DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, logistica, integraciones AS $function$
DECLARE v_verified int:=0; v_resolved int:=0; v_mismatched int:=0; v_not_found int:=0; v_cancelled int:=0;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND (auth.uid() IS NULL OR NOT core.has_company_access(auth.uid(), p_company_id)) THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='COMPANY_ACCESS_DENIED'; END IF;
  WITH scoped AS (
    SELECT i.*, c.canonical_bsale_token, COALESCE(c.current_bsale_nv_id, i.bsale_nv_id) AS current_id
    FROM logistica.sales_order_preparation_incidents i JOIN logistica.sales_order_preparation_cards c ON c.id=i.card_id AND c.company_id=i.company_id
    WHERE i.company_id=p_company_id AND i.status='OPEN' AND (p_bsale_nv_ids IS NULL OR i.bsale_nv_id=ANY(p_bsale_nv_ids) OR c.current_bsale_nv_id=ANY(p_bsale_nv_ids))
  ), observed AS (
    SELECT s.*, d.state, d.bsale_id AS resolved_id,
      exact.quantity AS exact_quantity, exact.bsale_id AS exact_detail_id,
       coalesce(matches.match_count,0) AS match_count, coalesce(matches.match_quantity,0) AS match_quantity,
       matches.match_detail_id
    FROM scoped s LEFT JOIN integraciones.bsale_documents d ON d.company_id=p_company_id AND d.bsale_id=s.current_id AND d.document_type_id=23
    LEFT JOIN LATERAL (SELECT det.bsale_id, det.quantity FROM integraciones.bsale_document_details det WHERE det.company_id=p_company_id AND det.bsale_document_id=s.current_id AND det.bsale_id=s.bsale_detail_id LIMIT 1) exact ON true
    LEFT JOIN LATERAL (SELECT count(*)::int AS match_count, coalesce(sum(det.quantity),0)::numeric AS match_quantity, max(det.bsale_id) AS match_detail_id FROM integraciones.bsale_document_details det WHERE exact.bsale_id IS NULL AND det.company_id=p_company_id AND det.bsale_document_id=s.current_id AND ((s.bsale_variant_id IS NOT NULL AND det.variant_id=s.bsale_variant_id) OR ((s.bsale_variant_id IS NULL OR NOT EXISTS (SELECT 1 FROM integraciones.bsale_document_details by_variant WHERE by_variant.company_id=p_company_id AND by_variant.bsale_document_id=s.current_id AND by_variant.variant_id=s.bsale_variant_id)) AND NULLIF(lower(btrim(det.variant_code)), '')=NULLIF(lower(btrim(s.sku)), '')))) matches ON true
  ), classified AS (
    SELECT o.*, CASE WHEN o.resolved_id IS NULL THEN 'NOT_FOUND' WHEN o.state IS DISTINCT FROM 0 THEN 'NV_CANCELLED' WHEN o.match_count>1 THEN 'MISMATCHED' WHEN o.required_bsale_action='REMOVE_LINE' THEN CASE WHEN o.match_count=0 OR (o.exact_detail_id IS NOT NULL AND o.exact_quantity<=0) OR (o.exact_detail_id IS NULL AND o.match_count=1 AND o.match_quantity<=0) THEN 'MATCHED' ELSE 'MISMATCHED' END WHEN o.exact_detail_id IS NOT NULL THEN CASE WHEN o.exact_quantity=o.expected_bsale_quantity THEN 'MATCHED' ELSE 'MISMATCHED' END WHEN o.match_count=1 AND o.match_quantity=o.expected_bsale_quantity THEN 'MATCHED' ELSE 'MISMATCHED' END AS result, CASE WHEN o.exact_detail_id IS NOT NULL THEN o.exact_quantity WHEN o.match_count=1 THEN o.match_quantity ELSE 0::numeric END AS observed_quantity
    FROM observed o
  ), updated AS (
    UPDATE logistica.sales_order_preparation_incidents i SET status=CASE WHEN x.result='MATCHED' THEN 'RESOLVED' ELSE 'OPEN' END, verification_status=CASE WHEN x.match_count>1 THEN 'ERROR' ELSE x.result END, last_verified_at=now(), bsale_observed_quantity=x.observed_quantity, bsale_observed_snapshot=jsonb_build_object('historical_nv_id',x.bsale_nv_id,'current_nv_id',x.current_id,'observed_detail_id',COALESCE(x.exact_detail_id, CASE WHEN x.match_count=1 THEN x.match_detail_id END),'matching_line_count',x.match_count,'verification_error',CASE WHEN x.match_count>1 THEN 'AMBIGUOUS' END,'verified_at',now()), updated_at=now() FROM classified x WHERE i.id=x.id RETURNING x.result
  ) SELECT count(*), count(*) FILTER (WHERE result='MATCHED'), count(*) FILTER (WHERE result='MISMATCHED'), count(*) FILTER (WHERE result='NOT_FOUND'), count(*) FILTER (WHERE result='NV_CANCELLED') INTO v_verified,v_resolved,v_mismatched,v_not_found,v_cancelled FROM updated;
  RETURN jsonb_build_object('verified',v_verified,'resolved',v_resolved,'open',v_mismatched+v_not_found+v_cancelled,'mismatched',v_mismatched,'not_found',v_not_found,'nv_cancelled',v_cancelled);
END; $function$;

-- Readiness usa current_bsale_nv_id y nunca una revisión histórica.
CREATE OR REPLACE VIEW logistica.vw_sales_order_route_readiness AS
WITH open_counts AS (SELECT card_id,count(*)::int AS open_count FROM logistica.sales_order_preparation_incidents WHERE status='OPEN' GROUP BY card_id)
SELECT c.id AS card_id,c.company_id,COALESCE(c.current_bsale_nv_id,c.bsale_nv_id) AS bsale_nv_id,c.bsale_nv_folio,
  (coalesce(oc.open_count,0)>0) AS has_open_commercial_incidents,coalesce(oc.open_count,0) AS open_commercial_incident_count,
  CASE WHEN d.bsale_id IS NULL OR d.state IS DISTINCT FROM 0 OR c.closed_at IS NOT NULL THEN 'BLOCKED' WHEN coalesce(oc.open_count,0)>0 THEN 'INCIDENTS' ELSE 'READY_TO_INVOICE' END AS route_readiness,
  d.state AS bsale_nv_state,(d.bsale_id IS NOT NULL) AS bsale_nv_found
FROM logistica.sales_order_preparation_cards c LEFT JOIN integraciones.bsale_documents d ON d.company_id=c.company_id AND d.bsale_id=COALESCE(c.current_bsale_nv_id,c.bsale_nv_id) AND d.document_type_id=23 LEFT JOIN open_counts oc ON oc.card_id=c.id WHERE c.status='AUDITED';

ALTER VIEW logistica.vw_sales_order_route_readiness SET (security_invoker=true);

-- Repair explícito y reversible de NV 5032. No se toca ningún snapshot.
UPDATE logistica.sales_order_preparation_cards
SET canonical_bsale_token='aa3dc0975673', current_bsale_nv_id=92513, updated_at=now()
WHERE id='76c48b76-d18b-49ea-b4e1-e0262571a90e'::uuid AND bsale_nv_id=92486;

UPDATE logistica.sales_order_preparation_cards
SET status='CANCELLED', closed_at=COALESCE(closed_at,now()), cancellation_reason='Duplicado técnico por revisión Bsale de NV 5032', updated_at=now()
WHERE id='57a31e66-69c5-498d-9284-2afeff09d957'::uuid AND bsale_nv_id=92513 AND status<>'CANCELLED';

INSERT INTO logistica.sales_order_preparation_movements(company_id,card_id,from_status,to_status,moved_by,movement_source,pin_validated,observation,metadata)
SELECT c.company_id,c.id,'PENDING_ROUTE_PREP','CANCELLED',NULL,'SYSTEM',false,'Duplicado técnico por revisión Bsale de NV 5032',jsonb_build_object('repair','canonical_bsale_identity','original_bsale_nv_id',92486,'current_bsale_nv_id',92513)
FROM logistica.sales_order_preparation_cards c
WHERE c.id='57a31e66-69c5-498d-9284-2afeff09d957'::uuid
  AND NOT EXISTS (SELECT 1 FROM logistica.sales_order_preparation_movements m WHERE m.card_id=c.id AND m.observation='Duplicado técnico por revisión Bsale de NV 5032');

-- Se crean después del repair para que la deduplicación histórica no bloquee
-- la instalación del contrato de una tarjeta operativa por identidad lógica.
CREATE UNIQUE INDEX IF NOT EXISTS sales_order_preparation_cards_active_token_key
  ON logistica.sales_order_preparation_cards(company_id, canonical_bsale_token)
  WHERE canonical_bsale_token IS NOT NULL AND closed_at IS NULL AND status <> 'CANCELLED';

CREATE UNIQUE INDEX IF NOT EXISTS sales_order_preparation_cards_active_legacy_folio_key
  ON logistica.sales_order_preparation_cards(company_id, bsale_nv_folio)
  WHERE canonical_bsale_token IS NULL AND bsale_nv_folio IS NOT NULL
    AND closed_at IS NULL AND status <> 'CANCELLED';

COMMIT;
