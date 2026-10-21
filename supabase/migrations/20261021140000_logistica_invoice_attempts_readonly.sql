-- Facturación V1: preparación, idempotencia y reconciliación read-only.
-- Este contrato no contiene ninguna operación de escritura contra Bsale.

BEGIN;

CREATE TABLE logistica.sales_order_invoice_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  card_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_cards(id),
  canonical_bsale_token text NOT NULL,
  historical_bsale_nv_id bigint NOT NULL,
  current_bsale_nv_id bigint NOT NULL,
  sales_id text NOT NULL,
  fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN (
    'PREPARED', 'LOCKED', 'UNKNOWN', 'CONFIRMED',
    'RECONCILIATION_REQUIRED', 'FAILED_RETRYABLE',
    'FAILED_TERMINAL', 'CANCELLED'
  )),
  payload_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  nv_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  detail_snapshots jsonb NOT NULL DEFAULT '[]'::jsonb,
  requested_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  submitted_at timestamptz,
  confirmed_at timestamptz,
  bsale_invoice_id bigint,
  bsale_invoice_number text,
  last_error text,
  last_reconciliation_at timestamptz,
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);

CREATE INDEX sales_order_invoice_attempts_card_idx
  ON logistica.sales_order_invoice_attempts(company_id, card_id, created_at DESC);
CREATE INDEX sales_order_invoice_attempts_token_idx
  ON logistica.sales_order_invoice_attempts(company_id, canonical_bsale_token);
CREATE INDEX sales_order_invoice_attempts_sales_id_idx
  ON logistica.sales_order_invoice_attempts(company_id, sales_id);
CREATE UNIQUE INDEX sales_order_invoice_attempts_active_key
  ON logistica.sales_order_invoice_attempts(company_id, canonical_bsale_token, fingerprint)
  WHERE status IN ('PREPARED', 'LOCKED', 'UNKNOWN', 'RECONCILIATION_REQUIRED', 'FAILED_RETRYABLE');

ALTER TABLE logistica.sales_order_invoice_attempts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON logistica.sales_order_invoice_attempts TO authenticated;
GRANT SELECT, INSERT, UPDATE ON logistica.sales_order_invoice_attempts TO service_role;
CREATE POLICY sales_order_invoice_attempts_select ON logistica.sales_order_invoice_attempts
  FOR SELECT TO authenticated USING (core.has_company_access(auth.uid(), company_id));
CREATE POLICY sales_order_invoice_attempts_write ON logistica.sales_order_invoice_attempts
  FOR INSERT TO authenticated WITH CHECK (core.has_company_access(auth.uid(), company_id) AND requested_by = auth.uid());
CREATE POLICY sales_order_invoice_attempts_update ON logistica.sales_order_invoice_attempts
  FOR UPDATE TO authenticated USING (core.has_company_access(auth.uid(), company_id))
  WITH CHECK (core.has_company_access(auth.uid(), company_id));
CREATE POLICY sales_order_invoice_attempts_service ON logistica.sales_order_invoice_attempts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE logistica.sales_order_invoice_attempts IS
  'Intentos de factura V1. Snapshot/fingerprint son inmutables; no emite documentos.';
COMMENT ON COLUMN logistica.sales_order_invoice_attempts.fingerprint IS
  'SHA-256 hex de snapshot facturable canónico: company, token, current NV, cliente, oficina, condición y líneas ordenadas por detail_id.';
COMMENT ON COLUMN logistica.sales_order_invoice_attempts.sales_id IS
  'PETGROUP:FACTURA:<company>:<fingerprint>; si excede 50 caracteres, PETGROUP:FACTURA:<sha256 hex de la cadena completa, 32 chars>.';

-- Contratos reservados para la etapa de emisión, deliberadamente no implementados aquí:
-- 1) Doble emisión: el lock/índice server-side prevalece sobre cualquier botón frontend.
-- 2) Confirmación explícita futura: "Está a punto de realizar una facturación real
--    para el cliente <CLIENTE> por un monto de <MONTO>. ¿Está seguro de continuar?"
--    con número de NV, cliente y monto; acciones "Cancelar" y "Emitir factura".
-- 3) CONFIRMED conserva la card y su historial para el flujo posterior de Guía de Ruta.
-- 4) UNKNOWN/RECONCILIATION_REQUIRED bloquean una nueva emisión hasta reconciliar.

CREATE OR REPLACE FUNCTION logistica.invoice_attempt_prevalidate(
  p_company_id uuid, p_card_id uuid
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, logistica, integraciones AS $$
DECLARE
  c record; d record; line_count integer; open_count integer; consumed numeric; current_qty numeric; billable_lines integer := 0;
  blockers jsonb := '[]'::jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND (auth.uid() IS NULL OR NOT core.has_company_access(auth.uid(), p_company_id)
      OR NOT core.has_permission_for_company(auth.uid(), p_company_id, 'logistica.preparation.manage')) THEN
    RAISE EXCEPTION 'COMPANY_ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;
  SELECT card.*, canon.current_bsale_id AS resolved_current_bsale_nv_id,
         canon.canonical_bsale_token AS resolved_canonical_bsale_token INTO c
  FROM logistica.sales_order_preparation_cards card
  LEFT JOIN integraciones.vw_bsale_sales_order_documents_canonical canon
    ON canon.company_id = card.company_id AND canon.canonical_bsale_token = card.canonical_bsale_token
  WHERE card.id = p_card_id AND card.company_id = p_company_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ready', false, 'blockers', jsonb_build_array('CARD_NOT_FOUND')); END IF;
  IF c.status IS DISTINCT FROM 'AUDITED' THEN blockers := blockers || jsonb_build_array('STATUS_NOT_AUDITED'); END IF;
  IF c.closed_at IS NOT NULL THEN blockers := blockers || jsonb_build_array('READINESS_NOT_READY_TO_INVOICE'); END IF;
  IF c.canonical_bsale_token IS NULL THEN blockers := blockers || jsonb_build_array('CANONICAL_TOKEN_INVALID'); END IF;
  IF c.resolved_current_bsale_nv_id IS NULL THEN blockers := blockers || jsonb_build_array('CURRENT_BSALE_NV_ID_REQUIRED'); END IF;
  SELECT d.* INTO d FROM integraciones.bsale_documents d WHERE d.company_id=p_company_id AND d.bsale_id=c.resolved_current_bsale_nv_id;
  IF NOT FOUND THEN blockers := blockers || jsonb_build_array('CURRENT_DOCUMENT_NOT_FOUND');
  ELSE
    IF d.document_type_id IS DISTINCT FROM 23 THEN blockers := blockers || jsonb_build_array('DOCUMENT_TYPE_NOT_SALES_ORDER'); END IF;
    IF d.state IS DISTINCT FROM 0 THEN blockers := blockers || jsonb_build_array('BSALE_STATE_NOT_ACTIVE'); END IF;
    IF d.client_id IS NULL OR NOT EXISTS (SELECT 1 FROM integraciones.bsale_clients x WHERE x.company_id=p_company_id AND x.bsale_client_id=d.client_id) THEN blockers := blockers || jsonb_build_array('CLIENT_INVALID'); END IF;
    IF d.office_id IS NULL THEN blockers := blockers || jsonb_build_array('OFFICE_INVALID'); END IF;
    IF d.raw_json->'saleCondition'->>'id' IS NULL THEN blockers := blockers || jsonb_build_array('NOT_READY_CONTRACT'); END IF;
  END IF;
  SELECT count(*) INTO open_count FROM logistica.sales_order_preparation_incidents i WHERE i.company_id=p_company_id AND i.card_id=p_card_id AND i.status='OPEN';
  IF open_count > 0 THEN blockers := blockers || jsonb_build_array('OPEN_COMMERCIAL_INCIDENTS'); END IF;
  SELECT count(*) INTO line_count FROM integraciones.bsale_document_details x WHERE x.company_id=p_company_id AND x.bsale_document_id=c.resolved_current_bsale_nv_id;
  IF line_count=0 THEN blockers := blockers || jsonb_build_array('DETAILS_MISSING'); END IF;
  FOR d IN SELECT x.* FROM integraciones.bsale_document_details x WHERE x.company_id=p_company_id AND x.bsale_document_id=c.resolved_current_bsale_nv_id LOOP
    SELECT coalesce(sum(invdet.quantity),0) INTO consumed
    FROM integraciones.bsale_invoice_sales_order_links l
    JOIN integraciones.bsale_document_details invdet ON invdet.company_id=l.company_id AND invdet.bsale_id=l.invoice_detail_bsale_id
    JOIN integraciones.bsale_documents inv ON inv.company_id=l.company_id AND inv.bsale_id=l.invoice_bsale_id AND inv.document_type_id=5
    WHERE l.company_id=p_company_id AND l.sales_order_bsale_id=c.resolved_current_bsale_nv_id AND l.sales_order_detail_bsale_id=d.bsale_id AND inv.state=0;
    current_qty := coalesce(d.quantity,0);
    IF current_qty <= 0 THEN blockers := blockers || jsonb_build_array('INVALID_QUANTITY:'||d.bsale_id); END IF;
    IF consumed > current_qty THEN blockers := blockers || jsonb_build_array('OVERCONSUMED:'||d.bsale_id); END IF;
    IF current_qty > consumed THEN billable_lines := billable_lines + 1; END IF;
  END LOOP;
  IF line_count > 0 AND billable_lines = 0 THEN blockers := blockers || jsonb_build_array('ZERO_BILLABLE_SALDO'); END IF;
  RETURN jsonb_build_object('ready', jsonb_array_length(blockers)=0, 'card_id', p_card_id, 'current_bsale_nv_id', c.resolved_current_bsale_nv_id, 'historical_bsale_nv_id', c.bsale_nv_id, 'blockers', blockers);
END; $$;

CREATE OR REPLACE FUNCTION logistica.prepare_sales_order_invoice_attempt(
  p_company_id uuid, p_card_id uuid
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, logistica, integraciones AS $$
DECLARE
  c record; d record; v_validation jsonb; v_nv jsonb; v_lines jsonb; v_payload jsonb; v_fp text; v_sales_id text; v_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND (auth.uid() IS NULL OR NOT core.has_company_access(auth.uid(), p_company_id)
      OR NOT core.has_permission_for_company(auth.uid(), p_company_id, 'logistica.preparation.manage')) THEN RAISE EXCEPTION 'COMPANY_ACCESS_DENIED' USING ERRCODE='42501'; END IF;
  SELECT * INTO c FROM logistica.sales_order_preparation_cards WHERE id=p_card_id AND company_id=p_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CARD_NOT_FOUND'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text||':card:'||p_card_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text||':token:'||coalesce(c.canonical_bsale_token,''), 0));
  SELECT current_bsale_id, canonical_bsale_token INTO c.current_bsale_nv_id, c.canonical_bsale_token
  FROM integraciones.vw_bsale_sales_order_documents_canonical
  WHERE company_id=p_company_id AND canonical_bsale_token=c.canonical_bsale_token;
  v_validation := logistica.invoice_attempt_prevalidate(p_company_id,p_card_id);
  IF coalesce((v_validation->>'ready')::boolean,false) IS NOT TRUE THEN RETURN jsonb_build_object('ok',false,'validation',v_validation); END IF;
  SELECT jsonb_build_object('company_id',p_company_id,'card_id',c.id,'canonical_bsale_token',c.canonical_bsale_token,'historical_bsale_nv_id',c.bsale_nv_id,'current_bsale_nv_id',d.bsale_id,'folio',d.number,'state',d.state,'document_type_id',d.document_type_id,'client_id',d.client_id,'office_id',d.office_id,'sale_condition_id',d.raw_json->'saleCondition'->>'id','price_list',d.raw_json->'priceList','generation_date',d.generation_date,'totals',jsonb_build_object('net',d.net_amount,'tax',d.tax_amount,'exempt',d.exempt_amount,'total',d.total_amount)) INTO v_nv
  FROM integraciones.bsale_documents d WHERE d.company_id=p_company_id AND d.bsale_id=c.current_bsale_nv_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('detail_id',x.bsale_id,'variant_id',x.variant_id,'sku',x.variant_code,'quantity',x.quantity,'billable_quantity',x.quantity-coalesce(consumed.qty,0),'net_unit_value',x.net_unit_value,'net_amount',x.net_amount,'net_discount',x.net_discount,'tax_amount',x.tax_amount,'total_amount',x.total_amount) ORDER BY x.bsale_id),'[]'::jsonb) INTO v_lines
  FROM integraciones.bsale_document_details x LEFT JOIN LATERAL (SELECT coalesce(sum(idet.quantity),0) qty FROM integraciones.bsale_invoice_sales_order_links l JOIN integraciones.bsale_document_details idet ON idet.company_id=l.company_id AND idet.bsale_id=l.invoice_detail_bsale_id JOIN integraciones.bsale_documents inv ON inv.company_id=l.company_id AND inv.bsale_id=l.invoice_bsale_id AND inv.document_type_id=5 AND inv.state=0 WHERE l.company_id=p_company_id AND l.sales_order_bsale_id=c.current_bsale_nv_id AND l.sales_order_detail_bsale_id=x.bsale_id) consumed ON true
  WHERE x.company_id=p_company_id AND x.bsale_document_id=c.current_bsale_nv_id;
  v_payload := jsonb_build_object('document_type_id',5,'details',v_lines,'source_current_bsale_nv_id',c.current_bsale_nv_id);
  v_fp := pg_catalog.encode(extensions.digest(convert_to((v_nv || jsonb_build_object('details',v_lines))::text,'UTF8'),'sha256'),'hex');
  v_sales_id := 'PETGROUP:FACTURA:'||p_company_id::text||':'||v_fp;
  IF length(v_sales_id)>50 THEN v_sales_id := 'PETGROUP:FACTURA:'||substr(pg_catalog.encode(extensions.digest(convert_to(v_sales_id,'UTF8'),'sha256'),'hex'),1,32); END IF;
  IF EXISTS (SELECT 1 FROM logistica.sales_order_invoice_attempts x
             WHERE x.company_id=p_company_id AND x.canonical_bsale_token=c.canonical_bsale_token
               AND x.status IN ('PREPARED','LOCKED','UNKNOWN','RECONCILIATION_REQUIRED','FAILED_RETRYABLE')
               AND x.fingerprint IS DISTINCT FROM v_fp) THEN
    RETURN jsonb_build_object('ok',false,'validation',jsonb_build_object('ready',false,'blockers',jsonb_build_array('ACTIVE_INCOMPATIBLE_ATTEMPT')));
  END IF;
  INSERT INTO logistica.sales_order_invoice_attempts(company_id,card_id,canonical_bsale_token,historical_bsale_nv_id,current_bsale_nv_id,sales_id,fingerprint,status,payload_snapshot,nv_snapshot,detail_snapshots,requested_by,started_at)
  VALUES(p_company_id,p_card_id,c.canonical_bsale_token,c.bsale_nv_id,c.current_bsale_nv_id,v_sales_id,v_fp,'PREPARED',v_payload,v_nv,v_lines,auth.uid(),now())
  ON CONFLICT (company_id,canonical_bsale_token,fingerprint) WHERE status IN ('PREPARED','LOCKED','UNKNOWN','RECONCILIATION_REQUIRED','FAILED_RETRYABLE') DO UPDATE SET updated_at=now()
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok',true,'attempt_id',v_id,'sales_id',v_sales_id,'fingerprint',v_fp,'snapshot',v_nv,'details',v_lines);
END; $$;

CREATE OR REPLACE FUNCTION logistica.reconcile_sales_order_invoice_attempt(p_attempt_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, logistica, integraciones AS $$
DECLARE a record; inv record; matches integer; good boolean;
BEGIN
  SELECT * INTO a FROM logistica.sales_order_invoice_attempts WHERE id=p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ATTEMPT_NOT_FOUND'; END IF;
  IF auth.role() IS DISTINCT FROM 'service_role' AND (auth.uid() IS NULL OR NOT core.has_company_access(auth.uid(), a.company_id)
      OR NOT core.has_permission_for_company(auth.uid(), a.company_id, 'module.logistica.view')) THEN RAISE EXCEPTION 'COMPANY_ACCESS_DENIED' USING ERRCODE='42501'; END IF;
  SELECT count(*) INTO matches FROM integraciones.bsale_documents WHERE company_id=a.company_id AND document_type_id=5 AND state=0 AND raw_json->>'salesId'=a.sales_id;
  IF matches=0 THEN UPDATE logistica.sales_order_invoice_attempts SET status='UNKNOWN',last_reconciliation_at=now(),updated_at=now() WHERE id=a.id; RETURN jsonb_build_object('status','UNKNOWN','reason','NO_DOCUMENT_IN_MIRROR'); END IF;
  IF matches<>1 THEN UPDATE logistica.sales_order_invoice_attempts SET status='RECONCILIATION_REQUIRED',last_error='AMBIGUOUS_SALES_ID_MATCH',last_reconciliation_at=now(),updated_at=now() WHERE id=a.id; RETURN jsonb_build_object('status','RECONCILIATION_REQUIRED','matches',matches); END IF;
  SELECT * INTO inv FROM integraciones.bsale_documents WHERE company_id=a.company_id AND document_type_id=5 AND state=0 AND raw_json->>'salesId'=a.sales_id LIMIT 1;
  good := EXISTS (SELECT 1 FROM integraciones.bsale_document_details x WHERE x.company_id=a.company_id AND x.bsale_document_id=inv.bsale_id)
    AND NOT EXISTS (SELECT 1 FROM integraciones.bsale_document_details x
                    WHERE x.company_id=a.company_id AND x.bsale_document_id=inv.bsale_id
                      AND (x.related_detail_bsale_id IS NULL OR NOT EXISTS (
                        SELECT 1 FROM jsonb_array_elements(a.detail_snapshots) s
                        WHERE (s->>'detail_id')::bigint=x.related_detail_bsale_id
                      ) OR coalesce(x.quantity,0)<=0))
    AND NOT EXISTS (
      SELECT 1
      FROM integraciones.bsale_document_details x
      JOIN LATERAL (SELECT coalesce(max((y->>'quantity')::numeric),0) AS current_quantity
                    FROM jsonb_array_elements(a.detail_snapshots) y
                    WHERE (y->>'detail_id')::bigint=x.related_detail_bsale_id) current_line ON true
      WHERE x.company_id=a.company_id AND x.bsale_document_id=inv.bsale_id
      GROUP BY x.related_detail_bsale_id, current_line.current_quantity
      HAVING sum(x.quantity) > current_line.current_quantity
    );
  IF NOT good THEN UPDATE logistica.sales_order_invoice_attempts SET status='RECONCILIATION_REQUIRED',last_error='RELATED_DETAIL_ID_NOT_PROVABLE',last_reconciliation_at=now(),updated_at=now() WHERE id=a.id; RETURN jsonb_build_object('status','RECONCILIATION_REQUIRED','reason','RELATED_DETAIL_ID_NOT_PROVABLE'); END IF;
  UPDATE logistica.sales_order_invoice_attempts SET status='CONFIRMED',bsale_invoice_id=inv.bsale_id,bsale_invoice_number=inv.number::text,confirmed_at=now(),last_reconciliation_at=now(),updated_at=now() WHERE id=a.id;
  INSERT INTO integraciones.bsale_invoice_sales_order_links(company_id,invoice_bsale_id,invoice_detail_bsale_id,sales_order_bsale_id,sales_order_detail_bsale_id)
  SELECT a.company_id,inv.bsale_id,x.bsale_id,a.current_bsale_nv_id,x.related_detail_bsale_id FROM integraciones.bsale_document_details x WHERE x.company_id=a.company_id AND x.bsale_document_id=inv.bsale_id AND x.related_detail_bsale_id IS NOT NULL ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('status','CONFIRMED','invoice_id',inv.bsale_id,'invoice_number',inv.number);
END; $$;

CREATE OR REPLACE FUNCTION logistica.get_sales_order_invoice_attempt(p_attempt_id uuid)
RETURNS SETOF logistica.sales_order_invoice_attempts LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public, auth, core, logistica AS $$
  SELECT * FROM logistica.sales_order_invoice_attempts
  WHERE id=p_attempt_id AND core.has_company_access(auth.uid(), company_id)
    AND core.has_permission_for_company(auth.uid(), company_id, 'module.logistica.view')
$$;

REVOKE ALL ON FUNCTION logistica.invoice_attempt_prevalidate(uuid,uuid), logistica.prepare_sales_order_invoice_attempt(uuid,uuid), logistica.reconcile_sales_order_invoice_attempt(uuid), logistica.get_sales_order_invoice_attempt(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION logistica.invoice_attempt_prevalidate(uuid,uuid), logistica.prepare_sales_order_invoice_attempt(uuid,uuid), logistica.reconcile_sales_order_invoice_attempt(uuid), logistica.get_sales_order_invoice_attempt(uuid) TO authenticated, service_role;

COMMIT;
