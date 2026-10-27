-- Rollback for 20261026180000_logistica_invoice_condition_fallback.sql.
-- Restores the invoice functions as defined by the preceding ambiguity fix.

BEGIN;

CREATE OR REPLACE FUNCTION logistica.invoice_attempt_prevalidate(
  p_company_id uuid, p_card_id uuid
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, logistica, integraciones AS $$
DECLARE
  card_row record; doc_row record; line_row record;
  line_count integer; open_count integer; consumed numeric; current_qty numeric; billable_lines integer := 0;
  blockers jsonb := '[]'::jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND (auth.uid() IS NULL OR NOT core.has_company_access(auth.uid(), p_company_id)
      OR NOT core.has_permission_for_company(auth.uid(), p_company_id, 'logistica.preparation.manage')) THEN
    RAISE EXCEPTION 'COMPANY_ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;
  SELECT card.*, canon.current_bsale_id AS resolved_current_bsale_nv_id,
         canon.canonical_bsale_token AS resolved_canonical_bsale_token INTO card_row
  FROM logistica.sales_order_preparation_cards card
  LEFT JOIN integraciones.vw_bsale_sales_order_documents_canonical canon
    ON canon.company_id = card.company_id AND canon.canonical_bsale_token = card.canonical_bsale_token
  WHERE card.id = p_card_id AND card.company_id = p_company_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ready', false, 'blockers', jsonb_build_array('CARD_NOT_FOUND')); END IF;
  IF card_row.status IS DISTINCT FROM 'AUDITED' THEN blockers := blockers || jsonb_build_array('STATUS_NOT_AUDITED'); END IF;
  IF card_row.closed_at IS NOT NULL THEN blockers := blockers || jsonb_build_array('READINESS_NOT_READY_TO_INVOICE'); END IF;
  IF card_row.canonical_bsale_token IS NULL THEN blockers := blockers || jsonb_build_array('CANONICAL_TOKEN_INVALID'); END IF;
  IF card_row.resolved_current_bsale_nv_id IS NULL THEN blockers := blockers || jsonb_build_array('CURRENT_BSALE_NV_ID_REQUIRED'); END IF;
  SELECT doc.* INTO doc_row
  FROM integraciones.bsale_documents doc
  WHERE doc.company_id=p_company_id AND doc.bsale_id=card_row.resolved_current_bsale_nv_id;
  IF NOT FOUND THEN blockers := blockers || jsonb_build_array('CURRENT_DOCUMENT_NOT_FOUND');
  ELSE
    IF doc_row.document_type_id IS DISTINCT FROM 23 THEN blockers := blockers || jsonb_build_array('DOCUMENT_TYPE_NOT_SALES_ORDER'); END IF;
    IF doc_row.state IS DISTINCT FROM 0 THEN blockers := blockers || jsonb_build_array('BSALE_STATE_NOT_ACTIVE'); END IF;
    IF doc_row.client_id IS NULL OR NOT EXISTS (SELECT 1 FROM integraciones.bsale_clients x WHERE x.company_id=p_company_id AND x.bsale_client_id=doc_row.client_id) THEN blockers := blockers || jsonb_build_array('CLIENT_INVALID'); END IF;
    IF doc_row.office_id IS NULL THEN blockers := blockers || jsonb_build_array('OFFICE_INVALID'); END IF;
    IF doc_row.raw_json->'saleCondition'->>'id' IS NULL THEN blockers := blockers || jsonb_build_array('NOT_READY_CONTRACT'); END IF;
  END IF;
  SELECT count(*) INTO open_count FROM logistica.sales_order_preparation_incidents i WHERE i.company_id=p_company_id AND i.card_id=p_card_id AND i.status='OPEN';
  IF open_count > 0 THEN blockers := blockers || jsonb_build_array('OPEN_COMMERCIAL_INCIDENTS'); END IF;
  SELECT count(*) INTO line_count FROM integraciones.bsale_document_details x WHERE x.company_id=p_company_id AND x.bsale_document_id=card_row.resolved_current_bsale_nv_id;
  IF line_count=0 THEN blockers := blockers || jsonb_build_array('DETAILS_MISSING'); END IF;
  FOR line_row IN SELECT x.* FROM integraciones.bsale_document_details x WHERE x.company_id=p_company_id AND x.bsale_document_id=card_row.resolved_current_bsale_nv_id LOOP
    SELECT coalesce(sum(invdet.quantity),0) INTO consumed
    FROM integraciones.bsale_invoice_sales_order_links l
    JOIN integraciones.bsale_document_details invdet ON invdet.company_id=l.company_id AND invdet.bsale_id=l.invoice_detail_bsale_id
    JOIN integraciones.bsale_documents inv ON inv.company_id=l.company_id AND inv.bsale_id=l.invoice_bsale_id AND inv.document_type_id=5
    WHERE l.company_id=p_company_id AND l.sales_order_bsale_id=card_row.resolved_current_bsale_nv_id AND l.sales_order_detail_bsale_id=line_row.bsale_id AND inv.state=0;
    current_qty := coalesce(line_row.quantity,0);
    IF current_qty <= 0 THEN blockers := blockers || jsonb_build_array('INVALID_QUANTITY:'||line_row.bsale_id); END IF;
    IF consumed > current_qty THEN blockers := blockers || jsonb_build_array('OVERCONSUMED:'||line_row.bsale_id); END IF;
    IF current_qty > consumed THEN billable_lines := billable_lines + 1; END IF;
  END LOOP;
  IF line_count > 0 AND billable_lines = 0 THEN blockers := blockers || jsonb_build_array('ZERO_BILLABLE_SALDO'); END IF;
  RETURN jsonb_build_object('ready', jsonb_array_length(blockers)=0, 'card_id', p_card_id, 'current_bsale_nv_id', card_row.resolved_current_bsale_nv_id, 'historical_bsale_nv_id', card_row.bsale_nv_id, 'blockers', blockers);
END; $$;

CREATE OR REPLACE FUNCTION logistica.prepare_sales_order_invoice_attempt(
  p_company_id uuid, p_card_id uuid
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, logistica, integraciones AS $$
DECLARE
  card_row record; v_validation jsonb; v_nv jsonb; v_lines jsonb; v_payload jsonb; v_fp text; v_sales_id text; v_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND (auth.uid() IS NULL OR NOT core.has_company_access(auth.uid(), p_company_id)
      OR NOT core.has_permission_for_company(auth.uid(), p_company_id, 'logistica.preparation.manage')) THEN RAISE EXCEPTION 'COMPANY_ACCESS_DENIED' USING ERRCODE='42501'; END IF;
  SELECT * INTO card_row FROM logistica.sales_order_preparation_cards WHERE id=p_card_id AND company_id=p_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CARD_NOT_FOUND'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text||':card:'||p_card_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text||':token:'||coalesce(card_row.canonical_bsale_token,''), 0));
  SELECT current_bsale_id, canonical_bsale_token INTO card_row.current_bsale_nv_id, card_row.canonical_bsale_token
  FROM integraciones.vw_bsale_sales_order_documents_canonical
  WHERE company_id=p_company_id AND canonical_bsale_token=card_row.canonical_bsale_token;
  v_validation := logistica.invoice_attempt_prevalidate(p_company_id,p_card_id);
  IF coalesce((v_validation->>'ready')::boolean,false) IS NOT TRUE THEN RETURN jsonb_build_object('ok',false,'validation',v_validation); END IF;
  SELECT jsonb_build_object('company_id',p_company_id,'card_id',card_row.id,'canonical_bsale_token',card_row.canonical_bsale_token,'historical_bsale_nv_id',card_row.bsale_nv_id,'current_bsale_nv_id',doc.bsale_id,'folio',doc.number,'state',doc.state,'document_type_id',doc.document_type_id,'client_id',doc.client_id,'office_id',doc.office_id,'sale_condition_id',doc.raw_json->'saleCondition'->>'id','price_list',doc.raw_json->'priceList','generation_date',doc.generation_date,'totals',jsonb_build_object('net',doc.net_amount,'tax',doc.tax_amount,'exempt',doc.exempt_amount,'total',doc.total_amount)) INTO v_nv
  FROM integraciones.bsale_documents doc WHERE doc.company_id=p_company_id AND doc.bsale_id=card_row.current_bsale_nv_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('detail_id',x.bsale_id,'variant_id',x.variant_id,'sku',x.variant_code,'quantity',x.quantity,'billable_quantity',x.quantity-coalesce(consumed.qty,0),'net_unit_value',x.net_unit_value,'net_amount',x.net_amount,'net_discount',x.net_discount,'tax_amount',x.tax_amount,'total_amount',x.total_amount) ORDER BY x.bsale_id),'[]'::jsonb) INTO v_lines
  FROM integraciones.bsale_document_details x LEFT JOIN LATERAL (SELECT coalesce(sum(idet.quantity),0) qty FROM integraciones.bsale_invoice_sales_order_links l JOIN integraciones.bsale_document_details idet ON idet.company_id=l.company_id AND idet.bsale_id=l.invoice_detail_bsale_id JOIN integraciones.bsale_documents inv ON inv.company_id=l.company_id AND inv.bsale_id=l.invoice_bsale_id AND inv.document_type_id=5 AND inv.state=0 WHERE l.company_id=p_company_id AND l.sales_order_bsale_id=card_row.current_bsale_nv_id AND l.sales_order_detail_bsale_id=x.bsale_id) consumed ON true
  WHERE x.company_id=p_company_id AND x.bsale_document_id=card_row.current_bsale_nv_id;
  v_payload := jsonb_build_object('document_type_id',5,'details',v_lines,'source_current_bsale_nv_id',card_row.current_bsale_nv_id);
  v_fp := pg_catalog.encode(extensions.digest(convert_to((v_nv || jsonb_build_object('details',v_lines))::text,'UTF8'),'sha256'),'hex');
  v_sales_id := 'PETGROUP:FACTURA:'||p_company_id::text||':'||v_fp;
  IF length(v_sales_id)>50 THEN v_sales_id := 'PETGROUP:FACTURA:'||substr(pg_catalog.encode(extensions.digest(convert_to(v_sales_id,'UTF8'),'sha256'),'hex'),1,32); END IF;
  IF EXISTS (SELECT 1 FROM logistica.sales_order_invoice_attempts x WHERE x.company_id=p_company_id AND x.canonical_bsale_token=card_row.canonical_bsale_token AND x.status IN ('PREPARED','LOCKED','UNKNOWN','RECONCILIATION_REQUIRED','FAILED_RETRYABLE') AND x.fingerprint IS DISTINCT FROM v_fp) THEN
    RETURN jsonb_build_object('ok',false,'validation',jsonb_build_object('ready',false,'blockers',jsonb_build_array('ACTIVE_INCOMPATIBLE_ATTEMPT')));
  END IF;
  INSERT INTO logistica.sales_order_invoice_attempts(company_id,card_id,canonical_bsale_token,historical_bsale_nv_id,current_bsale_nv_id,sales_id,fingerprint,status,payload_snapshot,nv_snapshot,detail_snapshots,requested_by,started_at)
  VALUES(p_company_id,p_card_id,card_row.canonical_bsale_token,card_row.bsale_nv_id,card_row.current_bsale_nv_id,v_sales_id,v_fp,'PREPARED',v_payload,v_nv,v_lines,auth.uid(),now())
  ON CONFLICT (company_id,canonical_bsale_token,fingerprint) WHERE status IN ('PREPARED','LOCKED','UNKNOWN','RECONCILIATION_REQUIRED','FAILED_RETRYABLE') DO UPDATE SET updated_at=now()
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok',true,'attempt_id',v_id,'sales_id',v_sales_id,'fingerprint',v_fp,'snapshot',v_nv,'details',v_lines);
END; $$;

COMMIT;
