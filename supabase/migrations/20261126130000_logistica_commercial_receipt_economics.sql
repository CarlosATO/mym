-- COMPRAS 07D.1. All changes, including inventory and receipt totals, are
-- performed by the existing receipt transaction. No production data is changed.
BEGIN;

ALTER TABLE logistica.purchase_receipts
  ADD COLUMN IF NOT EXISTS idempotency_request_fingerprint jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS purchase_receipts_company_idempotency_uq
  ON logistica.purchase_receipts (company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE logistica.purchase_receipt_items
  ADD COLUMN commercial_confirmed_snapshot_id uuid REFERENCES adquisiciones.purchase_order_snapshots(id),
  ADD COLUMN commercial_confirmed_item jsonb,
  ADD COLUMN commercial_gross_before_discount numeric(14,4),
  ADD COLUMN commercial_discount_amount numeric(14,4),
  ADD COLUMN commercial_qty_before numeric(14,4),
  ADD COLUMN commercial_qty_after numeric(14,4);

-- This capability is private and scoped to one transaction, backend and order.
CREATE TABLE logistica.commercial_receipt_capabilities (
  transaction_id bigint NOT NULL, backend_pid integer NOT NULL, po_id uuid NOT NULL,
  PRIMARY KEY (transaction_id, backend_pid)
);
ALTER TABLE logistica.commercial_receipt_capabilities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistica.commercial_receipt_capabilities FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION adquisiciones.guard_commercial_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, adquisiciones, logistica AS $$
DECLARE v_po_id uuid; v_managed boolean;
BEGIN
  IF TG_TABLE_NAME='purchase_receipts' THEN v_po_id:=NEW.purchase_order_id;
  ELSE SELECT po_id INTO v_po_id FROM adquisiciones.purchase_order_items WHERE id=NEW.purchase_order_item_id; END IF;
  SELECT p.commercial_draft_revision>0 OR EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items i WHERE i.po_id=p.id AND i.company_id=p.company_id AND i.purchase_unit_factor_snapshot IS NOT NULL)
    INTO v_managed FROM adquisiciones.purchase_orders p WHERE p.id=v_po_id FOR UPDATE;
  IF v_managed AND NOT EXISTS (SELECT 1 FROM logistica.commercial_receipt_capabilities c WHERE c.transaction_id=txid_current() AND c.backend_pid=pg_backend_pid() AND c.po_id=v_po_id) THEN
    RAISE EXCEPTION 'La recepción comercial requiere integración adicional' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION adquisiciones.guard_commercial_receipt() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION adquisiciones.guard_commercial_po_item() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, adquisiciones, logistica AS $$
DECLARE v_status text;
BEGIN
  IF NEW.purchase_unit_factor_snapshot IS NOT NULL OR NEW.commercial_unit_price_snapshot IS NOT NULL THEN
    SELECT status INTO v_status FROM adquisiciones.purchase_orders WHERE id=NEW.po_id AND company_id=NEW.company_id FOR UPDATE;
    IF v_status IS DISTINCT FROM 'BORRADOR' AND NOT (v_status='ENVIADA_PROVEEDOR' AND EXISTS (
      SELECT 1 FROM adquisiciones.commercial_draft_write_capabilities WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid()
    )) AND NOT (TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['quantity_received','quantity_pending','updated_at','updated_by'])=(to_jsonb(OLD)-ARRAY['quantity_received','quantity_pending','updated_at','updated_by']) AND EXISTS (
      SELECT 1 FROM logistica.commercial_receipt_capabilities WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid() AND po_id=NEW.po_id
    )) THEN RAISE EXCEPTION 'La configuración comercial requiere una operación controlada' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION adquisiciones.guard_commercial_po_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, adquisiciones, logistica AS $$
BEGIN
  IF (OLD.commercial_draft_revision>0 OR EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items i WHERE i.po_id=NEW.id AND i.company_id=NEW.company_id AND (i.purchase_unit_factor_snapshot IS NOT NULL OR i.commercial_unit_price_snapshot IS NOT NULL))) AND NEW.status NOT IN ('BORRADOR','CANCELADA') THEN
    IF NOT (((OLD.status='BORRADOR' AND NEW.status='EMITIDA' OR OLD.status='EMITIDA' AND NEW.status='ENVIADA_PROVEEDOR' OR OLD.status='ENVIADA_PROVEEDOR' AND NEW.status='CONFIRMADA') AND EXISTS (SELECT 1 FROM adquisiciones.commercial_draft_write_capabilities WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid())) OR
      (OLD.status IN ('CONFIRMADA','RECEPCION_PARCIAL') AND NEW.status IN ('RECEPCION_PARCIAL','RECEPCION_TOTAL') AND EXISTS (SELECT 1 FROM logistica.commercial_receipt_capabilities WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid() AND po_id=NEW.id))) THEN
      RAISE EXCEPTION 'La transición comercial requiere integración adicional' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Per-component cumulative rounding makes every partition telescope exactly to
-- the confirmed net, discount and tax. Gross before discount is their sum.
CREATE FUNCTION logistica.commercial_receipt_amount(p_total numeric, p_before numeric, p_after numeric, p_quantity numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT round(p_total*p_after/p_quantity,2)-round(p_total*p_before/p_quantity,2)
$$;
REVOKE ALL ON FUNCTION logistica.commercial_receipt_amount(numeric,numeric,numeric,numeric) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION logistica.apply_commercial_receipt_economics() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, adquisiciones, logistica AS $$
DECLARE v_po uuid; v_snapshot uuid; v_item jsonb; v_count integer; v_qty numeric; v_before numeric; v_after numeric; v_net numeric; v_discount numeric; v_tax numeric;
BEGIN
  SELECT p.id INTO v_po FROM adquisiciones.purchase_orders p JOIN adquisiciones.purchase_order_items i ON i.po_id=p.id AND i.company_id=p.company_id
    WHERE i.id=NEW.purchase_order_item_id AND i.company_id=NEW.company_id AND (p.commercial_draft_revision>0 OR EXISTS
      (SELECT 1 FROM adquisiciones.purchase_order_items ci WHERE ci.po_id=p.id AND ci.company_id=p.company_id AND (ci.purchase_unit_factor_snapshot IS NOT NULL OR ci.commercial_unit_price_snapshot IS NOT NULL)));
  IF v_po IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM logistica.commercial_receipt_capabilities WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid() AND po_id=v_po) THEN RAISE EXCEPTION 'Recepción comercial no autorizada'; END IF;
  SELECT count(*), (array_agg(s.id))[1], (array_agg(e.value))[1] INTO v_count,v_snapshot,v_item
    FROM adquisiciones.purchase_order_snapshots s CROSS JOIN LATERAL jsonb_array_elements(s.items_snapshot) e
    WHERE s.po_id=v_po AND s.company_id=NEW.company_id AND s.snapshot_type='CONFIRMED' AND e.value->>'item_id'=NEW.purchase_order_item_id::text;
  IF v_count<>1 THEN RAISE EXCEPTION 'Falta la línea comercial confirmada'; END IF;
  v_qty:=(v_item->>'quantity')::numeric;
  IF v_qty IS NULL OR v_qty<=0 OR v_qty IS DISTINCT FROM NEW.quantity_ordered OR v_item->>'commercial_gross_amount_snapshot' IS NULL OR v_item->>'discount_amount' IS NULL OR v_item->>'tax_amount' IS NULL OR v_item->>'line_total' IS NULL THEN RAISE EXCEPTION 'Snapshot comercial confirmado inválido'; END IF;
  SELECT coalesce(sum(i.quantity_received),0) INTO v_before FROM logistica.purchase_receipt_items i JOIN logistica.purchase_receipts r ON r.id=i.receipt_id
    WHERE i.company_id=NEW.company_id AND i.purchase_order_item_id=NEW.purchase_order_item_id AND r.status='COMPLETED' AND i.condition IN ('CONFORME','DANADO');
  v_after:=v_before+CASE WHEN NEW.condition IN ('CONFORME','DANADO') THEN NEW.quantity_received ELSE 0 END;
  IF v_before<0 OR v_after>v_qty OR v_after<v_before THEN RAISE EXCEPTION 'Cantidad comercial fuera de rango'; END IF;
  v_net:=logistica.commercial_receipt_amount((v_item->>'commercial_gross_amount_snapshot')::numeric-(v_item->>'discount_amount')::numeric,v_before,v_after,v_qty);
  v_discount:=logistica.commercial_receipt_amount((v_item->>'discount_amount')::numeric,v_before,v_after,v_qty);
  v_tax:=logistica.commercial_receipt_amount((v_item->>'tax_amount')::numeric,v_before,v_after,v_qty);
  IF (v_item->>'line_total')::numeric IS DISTINCT FROM (v_item->>'commercial_gross_amount_snapshot')::numeric-(v_item->>'discount_amount')::numeric+(v_item->>'tax_amount')::numeric OR v_net<0 OR v_discount<0 OR v_tax<0 THEN RAISE EXCEPTION 'Importes confirmados inválidos'; END IF;
  NEW.commercial_confirmed_snapshot_id:=v_snapshot; NEW.commercial_confirmed_item:=v_item;
  NEW.commercial_gross_before_discount:=v_net+v_discount; NEW.commercial_discount_amount:=v_discount;
  NEW.commercial_qty_before:=v_before; NEW.commercial_qty_after:=v_after;
  NEW.net_amount:=v_net; NEW.tax_amount:=v_tax; NEW.gross_amount:=v_net+v_tax;
  NEW.unit_cost:=CASE WHEN NEW.quantity_received>0 THEN v_net/NEW.quantity_received ELSE 0 END;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION logistica.apply_commercial_receipt_economics() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_commercial_receipt_economics BEFORE INSERT ON logistica.purchase_receipt_items FOR EACH ROW EXECUTE FUNCTION logistica.apply_commercial_receipt_economics();

-- Canonical request fingerprint for idempotency verification across retries.
CREATE FUNCTION logistica.purchase_receipt_request_fingerprint(
  p_purchase_order_id uuid,
  p_receiving_type text,
  p_effective_warehouse_id uuid,
  p_notes text,
  p_document_type text,
  p_document_number text,
  p_document_date date,
  p_items jsonb,
  p_attachment jsonb
) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE
  v_items jsonb;
  v_attachment jsonb := NULL;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object(
      'valid_items', false,
      'purchase_order_id', p_purchase_order_id,
      'raw_items', coalesce(p_items, 'null'::jsonb)
    );
  END IF;

  IF p_attachment IS NOT NULL AND jsonb_typeof(p_attachment) NOT IN ('object', 'null') THEN
    RETURN jsonb_build_object(
      'valid_items', false,
      'purchase_order_id', p_purchase_order_id,
      'invalid_attachment', true
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_items) AS e(val)
    WHERE jsonb_typeof(e.val) <> 'object'
       OR coalesce(nullif(btrim(e.val->>'purchase_order_item_id'), ''), nullif(btrim(e.val->>'id'), '')) IS NULL
  ) THEN
    RETURN jsonb_build_object(
      'valid_items', false,
      'purchase_order_id', p_purchase_order_id,
      'invalid_item_element', true
    );
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'item_id', coalesce(nullif(btrim(e.val->>'purchase_order_item_id'), ''), nullif(btrim(e.val->>'id'), ''))::uuid,
      'condition', coalesce(nullif(btrim(e.val->>'condition'), ''), 'CONFORME'),
      'quantity_received', trim_scale(coalesce(nullif(btrim(e.val->>'quantity_received'), '')::numeric, nullif(btrim(e.val->>'quantity'), '')::numeric, 0)),
      'quantity_rejected', trim_scale(coalesce(nullif(btrim(e.val->>'quantity_rejected'), '')::numeric, 0)),
      'quantity_missing', trim_scale(coalesce(nullif(btrim(e.val->>'quantity_missing'), '')::numeric, 0)),
      'location_id', nullif(btrim(e.val->>'location_id'), '')::uuid,
      'lot_number', nullif(e.val->>'lot_number', ''),
      'expiration_date', nullif(btrim(e.val->>'expiration_date'), '')::date,
      'rejection_reason', nullif(btrim(e.val->>'rejection_reason'), ''),
      'difference_reason', nullif(btrim(e.val->>'difference_reason'), ''),
      'notes', nullif(btrim(e.val->>'notes'), '')
    ) ORDER BY e.ord
  )
  INTO v_items
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS e(val, ord);

  IF p_attachment IS NOT NULL AND jsonb_typeof(p_attachment) = 'object' THEN
    v_attachment := jsonb_build_object(
      'document_type', coalesce(nullif(p_attachment->>'document_type', ''), nullif(btrim(p_document_type), '')),
      'storage_bucket', coalesce(nullif(p_attachment->>'storage_bucket', ''), 'recepciones'),
      'storage_path', nullif(p_attachment->>'storage_path', ''),
      'file_name', nullif(p_attachment->>'file_name', ''),
      'file_size', nullif(btrim(p_attachment->>'file_size'), '')::bigint,
      'mime_type', nullif(p_attachment->>'mime_type', ''),
      'notes', nullif(p_attachment->>'notes', ''),
      'file_url', nullif(p_attachment->>'file_url', '')
    );
  END IF;

  RETURN jsonb_build_object(
    'valid_items', true,
    'purchase_order_id', p_purchase_order_id,
    'receiving_type', nullif(btrim(p_receiving_type), ''),
    'warehouse_id', CASE WHEN p_receiving_type = 'WAREHOUSE' THEN p_effective_warehouse_id ELSE NULL END,
    'notes', nullif(btrim(p_notes), ''),
    'document_type', nullif(btrim(p_document_type), ''),
    'document_number', nullif(btrim(p_document_number), ''),
    'document_date', p_document_date,
    'items', v_items,
    'attachment', v_attachment
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'valid_items', false,
    'purchase_order_id', p_purchase_order_id,
    'invalid_payload', true
  );
END $$;
REVOKE ALL ON FUNCTION logistica.purchase_receipt_request_fingerprint(uuid,text,uuid,text,text,text,date,jsonb,jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- Verify legacy pre-migration receipts that lack idempotency_request_fingerprint.
-- Compares all relevant persisted header, line and attachment fields, failing
-- closed whenever incompatible or when equivalence cannot be demonstrated.
CREATE FUNCTION logistica.purchase_receipt_matches_legacy(
  p_existing jsonb,
  p_company_id uuid,
  p_fingerprint jsonb
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog, logistica AS $$
DECLARE
  v_receipt_id uuid;
  v_stored_count integer;
  v_stored_items jsonb;
  v_req_items jsonb;
  v_doc_count integer;
  v_stored_doc jsonb;
  v_req_doc jsonb;
BEGIN
  IF p_existing IS NULL
     OR p_company_id IS NULL
     OR p_fingerprint IS NULL
     OR coalesce((p_fingerprint->>'valid_items')::boolean, false) IS NOT TRUE THEN
    RETURN false;
  END IF;

  -- Fail closed if any persisted header attribute is absent from the existing record
  -- or if the receipt_documents relation is unavailable to prove attachment equivalence.
  IF NOT (
    p_existing ? 'id'
    AND p_existing ? 'purchase_order_id'
    AND p_existing ? 'status'
    AND p_existing ? 'receiving_type'
    AND p_existing ? 'warehouse_id'
    AND p_existing ? 'document_type'
    AND p_existing ? 'document_number'
    AND p_existing ? 'document_date'
    AND p_existing ? 'notes'
  ) OR to_regclass('logistica.receipt_documents') IS NULL THEN
    RETURN false;
  END IF;

  v_receipt_id := (p_existing->>'id')::uuid;
  IF v_receipt_id IS NULL OR p_existing->>'status' IS DISTINCT FROM 'COMPLETED' THEN
    RETURN false;
  END IF;

  IF (p_existing->>'purchase_order_id')::uuid IS DISTINCT FROM (p_fingerprint->>'purchase_order_id')::uuid
     OR nullif(btrim(p_existing->>'receiving_type'), '') IS NULL
     OR nullif(btrim(p_existing->>'receiving_type'), '') IS DISTINCT FROM (p_fingerprint->>'receiving_type')
     OR (p_existing->>'warehouse_id')::uuid IS DISTINCT FROM (p_fingerprint->>'warehouse_id')::uuid
     OR nullif(btrim(p_existing->>'document_type'), '') IS NULL
     OR nullif(btrim(p_existing->>'document_type'), '') IS DISTINCT FROM (p_fingerprint->>'document_type')
     OR nullif(btrim(p_existing->>'document_number'), '') IS NULL
     OR nullif(btrim(p_existing->>'document_number'), '') IS DISTINCT FROM (p_fingerprint->>'document_number')
     OR (p_existing->>'document_date')::date IS DISTINCT FROM (p_fingerprint->>'document_date')::date
     OR nullif(btrim(p_existing->>'notes'), '') IS DISTINCT FROM (p_fingerprint->>'notes') THEN
    RETURN false;
  END IF;

  -- Compare every persisted line field: quantities (received, rejected, missing),
  -- condition, location, lot, expiration, reasons and notes.
  SELECT count(*), coalesce(jsonb_agg(s.item_obj ORDER BY s.item_obj::text), '[]'::jsonb)
  INTO v_stored_count, v_stored_items
  FROM (
    SELECT jsonb_build_object(
      'item_id', i.purchase_order_item_id,
      'condition', i.condition,
      'quantity_received', trim_scale(coalesce(i.quantity_received, 0)),
      'quantity_rejected', trim_scale(coalesce(i.quantity_rejected, 0)),
      'quantity_missing', trim_scale(coalesce(i.quantity_missing, 0)),
      'location_id', i.location_id,
      'lot_number', nullif(i.lot_number, ''),
      'expiration_date', i.expiration_date,
      'rejection_reason', nullif(btrim(i.rejection_reason), ''),
      'difference_reason', nullif(btrim(i.difference_reason), ''),
      'notes', nullif(btrim(i.notes), '')
    ) AS item_obj
    FROM logistica.purchase_receipt_items i
    WHERE i.receipt_id = v_receipt_id AND i.company_id = p_company_id
  ) s;

  IF v_stored_count <= 0 OR v_stored_count <> jsonb_array_length(p_fingerprint->'items') THEN
    RETURN false;
  END IF;

  SELECT coalesce(jsonb_agg(r.item_obj ORDER BY r.item_obj::text), '[]'::jsonb)
  INTO v_req_items
  FROM (
    SELECT jsonb_build_object(
      'item_id', (e.val->>'item_id')::uuid,
      'condition', e.val->>'condition',
      'quantity_received', trim_scale((e.val->>'quantity_received')::numeric),
      'quantity_rejected', trim_scale((e.val->>'quantity_rejected')::numeric),
      'quantity_missing', trim_scale((e.val->>'quantity_missing')::numeric),
      'location_id', (e.val->>'location_id')::uuid,
      'lot_number', nullif(e.val->>'lot_number', ''),
      'expiration_date', (e.val->>'expiration_date')::date,
      'rejection_reason', nullif(btrim(e.val->>'rejection_reason'), ''),
      'difference_reason', nullif(btrim(e.val->>'difference_reason'), ''),
      'notes', nullif(btrim(e.val->>'notes'), '')
    ) AS item_obj
    FROM jsonb_array_elements(p_fingerprint->'items') AS e(val)
  ) r;

  IF v_stored_items IS DISTINCT FROM v_req_items THEN
    RETURN false;
  END IF;

  -- Compare persisted attachment metadata in logistica.receipt_documents.
  -- Creation inserts at most 1 document; >1 documents implies post-creation changes
  -- whose equivalence with a creation retry cannot be demonstrated.
  SELECT count(*), (array_agg(jsonb_build_object(
    'document_type', d.document_type,
    'document_number', nullif(btrim(d.document_number), ''),
    'document_date', d.document_date,
    'storage_bucket', d.storage_bucket,
    'storage_path', nullif(d.storage_path, ''),
    'file_name', nullif(d.file_name, ''),
    'file_size', d.file_size,
    'mime_type', nullif(d.mime_type, ''),
    'notes', nullif(d.notes, ''),
    'file_url', nullif(d.file_url, '')
  )))[1]
  INTO v_doc_count, v_stored_doc
  FROM logistica.receipt_documents d
  WHERE d.receipt_id = v_receipt_id AND d.company_id = p_company_id;

  IF p_fingerprint->'attachment' IS NULL OR jsonb_typeof(p_fingerprint->'attachment') = 'null' THEN
    IF v_doc_count <> 0 THEN
      RETURN false;
    END IF;
  ELSIF jsonb_typeof(p_fingerprint->'attachment') = 'object' THEN
    IF v_doc_count <> 1 THEN
      RETURN false;
    END IF;
    v_req_doc := jsonb_build_object(
      'document_type', p_fingerprint->'attachment'->>'document_type',
      'document_number', p_fingerprint->>'document_number',
      'document_date', (p_fingerprint->>'document_date')::date,
      'storage_bucket', p_fingerprint->'attachment'->>'storage_bucket',
      'storage_path', p_fingerprint->'attachment'->>'storage_path',
      'file_name', p_fingerprint->'attachment'->>'file_name',
      'file_size', (p_fingerprint->'attachment'->>'file_size')::bigint,
      'mime_type', p_fingerprint->'attachment'->>'mime_type',
      'notes', p_fingerprint->'attachment'->>'notes',
      'file_url', p_fingerprint->'attachment'->>'file_url'
    );
    IF v_stored_doc IS DISTINCT FROM v_req_doc THEN
      RETURN false;
    END IF;
  ELSE
    RETURN false;
  END IF;

  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END $$;
REVOKE ALL ON FUNCTION logistica.purchase_receipt_matches_legacy(jsonb,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- Retain the published wrapper and its validations. Neither the pre-commercial
-- wrapper nor pre_hotfix is callable directly by API roles.
ALTER FUNCTION logistica.create_purchase_receipt_db(uuid,uuid,text,uuid,text,text,text,date,jsonb,uuid,uuid,jsonb) RENAME TO create_purchase_receipt_db_before_commercial;
REVOKE ALL ON FUNCTION logistica.create_purchase_receipt_db_before_commercial(uuid,uuid,text,uuid,text,text,text,date,jsonb,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
DO $$ BEGIN
  IF to_regprocedure('logistica.create_purchase_receipt_db_pre_hotfix(uuid,uuid,text,uuid,text,text,text,date,jsonb,uuid,uuid,jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION logistica.create_purchase_receipt_db_pre_hotfix(uuid,uuid,text,uuid,text,text,text,date,jsonb,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
  END IF;
END $$;

CREATE FUNCTION logistica.create_purchase_receipt_db(p_company_id uuid,p_purchase_order_id uuid,p_receiving_type text,p_warehouse_id uuid,p_notes text,p_document_type text,p_document_number text,p_document_date date,p_items jsonb,p_user_id uuid,p_idempotency_key uuid,p_attachment jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public, auth, core, logistica, adquisiciones AS $$
DECLARE
  v_po adquisiciones.purchase_orders%ROWTYPE;
  v_existing logistica.purchase_receipts%ROWTYPE;
  v_existing_json jsonb;
  v_effective_warehouse uuid;
  v_fingerprint jsonb;
  v_managed boolean := false;
  v_result jsonb;
  v_receipt uuid;
BEGIN
  -- Do not grant a capability or expose idempotency state before session/company permission checks.
  IF auth.uid() IS NULL OR p_user_id IS NULL OR auth.uid()<>p_user_id OR p_company_id IS NULL OR NOT coalesce(core.has_company_access(p_user_id,p_company_id),false) OR NOT coalesce(core.has_permission_for_company(p_user_id,p_company_id,'logistica.receptions.create'),false) THEN
    RETURN jsonb_build_object('success',false,'error','No tiene permiso para registrar recepciones');
  END IF;
  IF p_idempotency_key IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','La clave de idempotencia es obligatoria');
  END IF;

  -- Serialize concurrent calls sharing (company_id, idempotency_key) across any PO before row locks.
  PERFORM pg_advisory_xact_lock(hashtext(p_company_id::text), hashtext(p_idempotency_key::text));

  SELECT * INTO v_existing
  FROM logistica.purchase_receipts
  WHERE company_id = p_company_id AND idempotency_key = p_idempotency_key;

  IF FOUND AND v_existing.purchase_order_id IS DISTINCT FROM p_purchase_order_id THEN
    RAISE EXCEPTION 'La clave de idempotencia ya pertenece a otra orden de compra' USING ERRCODE = '23505';
  END IF;

  SELECT * INTO v_po
  FROM adquisiciones.purchase_orders
  WHERE id = p_purchase_order_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    IF v_existing.id IS NOT NULL THEN
      RAISE EXCEPTION 'La clave de idempotencia ya pertenece a otra orden de compra' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('success',false,'error','Orden de Compra no encontrada');
  END IF;

  v_effective_warehouse := CASE
    WHEN p_receiving_type = 'WAREHOUSE' THEN coalesce(p_warehouse_id, (to_jsonb(v_po)->>'warehouse_id')::uuid)
    ELSE NULL
  END;

  v_fingerprint := logistica.purchase_receipt_request_fingerprint(
    p_purchase_order_id,
    p_receiving_type,
    v_effective_warehouse,
    p_notes,
    p_document_type,
    p_document_number,
    p_document_date,
    p_items,
    p_attachment
  );

  IF v_existing.id IS NOT NULL THEN
    v_existing_json := to_jsonb(v_existing);
    IF v_existing.idempotency_request_fingerprint IS NOT NULL THEN
      IF v_existing.idempotency_request_fingerprint IS DISTINCT FROM v_fingerprint THEN
        RAISE EXCEPTION 'La clave de idempotencia ya fue utilizada con parámetros incompatibles' USING ERRCODE = '23505';
      END IF;
    ELSIF NOT logistica.purchase_receipt_matches_legacy(v_existing_json, p_company_id, v_fingerprint) THEN
      RAISE EXCEPTION 'La clave de idempotencia ya fue utilizada con parámetros incompatibles' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'success', true,
      'receipt_id', v_existing.id,
      'receipt_number', v_existing_json->>'receipt_number',
      'idempotent', true
    );
  END IF;

  -- Lock PO lines in deterministic order under the PO lock to serialize concurrent partial receipts.
  PERFORM 1 FROM adquisiciones.purchase_order_items WHERE po_id = p_purchase_order_id AND company_id = p_company_id ORDER BY id FOR UPDATE;

  SELECT coalesce(v_po.commercial_draft_revision, 0) > 0 OR EXISTS (
    SELECT 1 FROM adquisiciones.purchase_order_items i
    WHERE i.po_id = v_po.id AND i.company_id = v_po.company_id
      AND (i.purchase_unit_factor_snapshot IS NOT NULL OR i.commercial_unit_price_snapshot IS NOT NULL)
  ) INTO v_managed;

  IF coalesce(v_managed, false) THEN
    IF NOT EXISTS (SELECT 1 FROM adquisiciones.purchase_order_snapshots WHERE po_id = p_purchase_order_id AND company_id = p_company_id AND snapshot_type = 'CONFIRMED') THEN
      RAISE EXCEPTION 'Falta el snapshot comercial confirmado';
    END IF;
    INSERT INTO logistica.commercial_receipt_capabilities VALUES(txid_current(), pg_backend_pid(), p_purchase_order_id);
    INSERT INTO adquisiciones.commercial_draft_write_capabilities VALUES(txid_current(), pg_backend_pid());
  END IF;

  v_result := logistica.create_purchase_receipt_db_before_commercial(
    p_company_id, p_purchase_order_id, p_receiving_type, p_warehouse_id, p_notes,
    p_document_type, p_document_number, p_document_date, p_items, p_user_id, p_idempotency_key, p_attachment
  );

  IF coalesce((v_result->>'success')::boolean, false) AND NOT coalesce((v_result->>'idempotent')::boolean, false) THEN
    v_receipt := (v_result->>'receipt_id')::uuid;
    UPDATE logistica.purchase_receipts
    SET idempotency_request_fingerprint = v_fingerprint
    WHERE id = v_receipt AND company_id = p_company_id;

    IF coalesce(v_managed, false) THEN
      UPDATE logistica.purchase_receipts r SET receipt_total_net=x.net,receipt_total_tax=x.tax,receipt_total_gross=x.gross FROM
        (SELECT coalesce(sum(net_amount),0) net,coalesce(sum(tax_amount),0) tax,coalesce(sum(gross_amount),0) gross FROM logistica.purchase_receipt_items WHERE receipt_id=v_receipt AND company_id=p_company_id) x WHERE r.id=v_receipt AND r.company_id=p_company_id;
      UPDATE logistica.kardex_movements k SET unit_cost=i.unit_cost,total_cost=i.net_amount FROM logistica.purchase_receipt_items i
        WHERE k.source_type='PURCHASE_RECEIPT' AND k.source_id=v_receipt AND k.source_line_id=i.id AND k.company_id=p_company_id AND i.company_id=p_company_id;
    END IF;
  END IF;

  IF coalesce(v_managed, false) THEN
    DELETE FROM adquisiciones.commercial_draft_write_capabilities WHERE transaction_id = txid_current() AND backend_pid = pg_backend_pid();
    DELETE FROM logistica.commercial_receipt_capabilities WHERE transaction_id = txid_current() AND backend_pid = pg_backend_pid();
  END IF;

  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION logistica.create_purchase_receipt_db(uuid,uuid,text,uuid,text,text,text,date,jsonb,uuid,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION logistica.create_purchase_receipt_db(uuid,uuid,text,uuid,text,text,text,date,jsonb,uuid,uuid,jsonb) TO authenticated, service_role;

-- Explicit classification of receipt item cost origin:
--   POSITIVE_COST
--   LEGITIMATE_BONUS (100% supplier discount on positive-priced item)
--   COMMERCIAL_CUMULATIVE_ROUNDING_ZERO (partial commercial receipt rounding to 0.00 against CONFIRMED snapshot)
--   INVALID (zero/negative/inconsistent cost or invalid quantity)
CREATE FUNCTION logistica.classify_purchase_receipt_item_cost(p_receipt_item_id uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog, adquisiciones, logistica AS $$
DECLARE
  v_ri logistica.purchase_receipt_items%ROWTYPE;
  v_poi adquisiciones.purchase_order_items%ROWTYPE;
  v_po adquisiciones.purchase_orders%ROWTYPE;
  v_poi_json jsonb;
  v_is_commercial boolean;
  v_snap_count integer;
  v_snap_item jsonb;
  v_qty numeric;
  v_gross numeric;
  v_disc numeric;
  v_tax numeric;
  v_line_total numeric;
  v_confirmed_net numeric;
  v_expected_net numeric;
  v_expected_disc numeric;
  v_expected_tax numeric;
  v_prior_qty numeric;
  v_total_qty numeric;
BEGIN
  SELECT * INTO v_ri FROM logistica.purchase_receipt_items WHERE id = p_receipt_item_id;
  IF NOT FOUND THEN RETURN 'INVALID'; END IF;

  IF v_ri.condition NOT IN ('CONFORME', 'DANADO')
     OR v_ri.quantity_received IS NULL OR v_ri.quantity_received <= 0
     OR v_ri.net_amount IS NULL OR v_ri.net_amount < 0 THEN
    RETURN 'INVALID';
  END IF;

  SELECT * INTO v_poi
  FROM adquisiciones.purchase_order_items
  WHERE id = v_ri.purchase_order_item_id AND company_id = v_ri.company_id;
  IF NOT FOUND THEN RETURN 'INVALID'; END IF;

  SELECT * INTO v_po
  FROM adquisiciones.purchase_orders
  WHERE id = v_poi.po_id AND company_id = v_ri.company_id;
  IF NOT FOUND THEN RETURN 'INVALID'; END IF;

  v_is_commercial := coalesce(v_po.commercial_draft_revision, 0) > 0
    OR v_poi.purchase_unit_factor_snapshot IS NOT NULL
    OR v_poi.commercial_unit_price_snapshot IS NOT NULL
    OR v_ri.commercial_confirmed_snapshot_id IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM adquisiciones.purchase_order_items ci
      WHERE ci.po_id = v_po.id AND ci.company_id = v_po.company_id
        AND (ci.purchase_unit_factor_snapshot IS NOT NULL OR ci.commercial_unit_price_snapshot IS NOT NULL)
    );

  IF v_is_commercial THEN
    IF v_ri.commercial_confirmed_snapshot_id IS NULL
       OR v_ri.commercial_confirmed_item IS NULL
       OR v_ri.commercial_qty_before IS NULL
       OR v_ri.commercial_qty_after IS NULL THEN
      RETURN 'INVALID';
    END IF;

    SELECT count(*), (array_agg(e.value))[1]
    INTO v_snap_count, v_snap_item
    FROM adquisiciones.purchase_order_snapshots s
    CROSS JOIN LATERAL jsonb_array_elements(s.items_snapshot) e
    WHERE s.id = v_ri.commercial_confirmed_snapshot_id
      AND s.po_id = v_po.id
      AND s.company_id = v_ri.company_id
      AND s.snapshot_type = 'CONFIRMED'
      AND e.value->>'item_id' = v_poi.id::text;

    IF v_snap_count <> 1 OR v_snap_item IS DISTINCT FROM v_ri.commercial_confirmed_item THEN
      RETURN 'INVALID';
    END IF;

    v_qty := (v_snap_item->>'quantity')::numeric;
    v_gross := (v_snap_item->>'commercial_gross_amount_snapshot')::numeric;
    v_disc := (v_snap_item->>'discount_amount')::numeric;
    v_tax := (v_snap_item->>'tax_amount')::numeric;
    v_line_total := (v_snap_item->>'line_total')::numeric;
    v_confirmed_net := v_gross - v_disc;

    IF v_qty IS NULL OR v_qty <= 0 OR v_qty IS DISTINCT FROM v_ri.quantity_ordered
       OR v_gross IS NULL OR v_gross <= 0
       OR (v_snap_item->>'commercial_unit_price_snapshot' IS NOT NULL AND (v_snap_item->>'commercial_unit_price_snapshot')::numeric <= 0)
       OR (v_snap_item->>'commercial_unit_price_snapshot' IS NULL AND v_snap_item->>'unit_price' IS NOT NULL AND (v_snap_item->>'unit_price')::numeric <= 0)
       OR v_disc IS NULL OR v_disc < 0 OR v_disc > v_gross
       OR v_tax IS NULL OR v_tax < 0
       OR v_line_total IS DISTINCT FROM (v_confirmed_net + v_tax) THEN
      RETURN 'INVALID';
    END IF;

    IF v_ri.commercial_qty_before < 0
       OR v_ri.commercial_qty_after <> v_ri.commercial_qty_before + v_ri.quantity_received
       OR v_ri.commercial_qty_after > v_qty THEN
      RETURN 'INVALID';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM logistica.purchase_receipt_items o_ri
      JOIN logistica.purchase_receipts o_r ON o_r.id = o_ri.receipt_id
      WHERE o_ri.company_id = v_ri.company_id
        AND o_ri.purchase_order_item_id = v_ri.purchase_order_item_id
        AND o_r.status = 'COMPLETED'
        AND o_ri.condition IN ('CONFORME', 'DANADO')
        AND o_ri.id <> v_ri.id
        AND (
          o_ri.commercial_qty_before IS NULL
          OR o_ri.commercial_qty_after IS NULL
          OR (o_ri.commercial_qty_before < v_ri.commercial_qty_after AND v_ri.commercial_qty_before < o_ri.commercial_qty_after)
        )
    ) THEN
      RETURN 'INVALID';
    END IF;

    SELECT
      coalesce(sum(CASE WHEN o_ri.commercial_qty_after <= v_ri.commercial_qty_before THEN o_ri.quantity_received ELSE 0 END), 0),
      coalesce(sum(o_ri.quantity_received), 0)
    INTO v_prior_qty, v_total_qty
    FROM logistica.purchase_receipt_items o_ri
    JOIN logistica.purchase_receipts o_r ON o_r.id = o_ri.receipt_id
    WHERE o_ri.company_id = v_ri.company_id
      AND o_ri.purchase_order_item_id = v_ri.purchase_order_item_id
      AND o_r.status = 'COMPLETED'
      AND o_ri.condition IN ('CONFORME', 'DANADO');

    IF v_prior_qty IS DISTINCT FROM v_ri.commercial_qty_before OR v_total_qty > v_qty THEN
      RETURN 'INVALID';
    END IF;

    v_expected_net := logistica.commercial_receipt_amount(v_confirmed_net, v_ri.commercial_qty_before, v_ri.commercial_qty_after, v_qty);
    v_expected_disc := logistica.commercial_receipt_amount(v_disc, v_ri.commercial_qty_before, v_ri.commercial_qty_after, v_qty);
    v_expected_tax := logistica.commercial_receipt_amount(v_tax, v_ri.commercial_qty_before, v_ri.commercial_qty_after, v_qty);

    IF v_ri.net_amount IS DISTINCT FROM v_expected_net
       OR v_ri.commercial_discount_amount IS DISTINCT FROM v_expected_disc
       OR v_ri.tax_amount IS DISTINCT FROM v_expected_tax
       OR v_ri.commercial_gross_before_discount IS DISTINCT FROM (v_expected_net + v_expected_disc)
       OR v_ri.gross_amount IS DISTINCT FROM (v_expected_net + v_expected_tax) THEN
      RETURN 'INVALID';
    END IF;

    IF v_ri.net_amount > 0 THEN
      RETURN 'POSITIVE_COST';
    END IF;

    IF v_confirmed_net = 0 THEN
      RETURN 'LEGITIMATE_BONUS';
    END IF;

    IF v_ri.quantity_received < v_qty THEN
      RETURN 'COMMERCIAL_CUMULATIVE_ROUNDING_ZERO';
    END IF;

    RETURN 'INVALID';
  END IF;

  IF v_ri.net_amount > 0 THEN
    RETURN 'POSITIVE_COST';
  END IF;

  v_poi_json := to_jsonb(v_poi);
  IF coalesce((v_poi_json->>'unit_price')::numeric, 0) > 0 AND (
    coalesce((v_poi_json->>'discount_percent')::numeric, 0) = 100
    OR coalesce((v_poi_json->>'discount_unit_amount')::numeric, 0) >= (v_poi_json->>'unit_price')::numeric
    OR coalesce((v_poi_json->>'discount_amount')::numeric, 0) >= ((v_poi_json->>'unit_price')::numeric * v_poi.quantity)
  ) THEN
    RETURN 'LEGITIMATE_BONUS';
  END IF;

  RETURN 'INVALID';
END $$;
REVOKE ALL ON FUNCTION logistica.classify_purchase_receipt_item_cost(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION integraciones.prepare_bsale_purchase_receipt_operation(
  p_purchase_receipt_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, logistica, adquisiciones, integraciones
AS $$
DECLARE
  r logistica.purchase_receipts%ROWTYPE;
  s integraciones.bsale_purchase_receipt_settings%ROWTYPE;
  o integraciones.bsale_purchase_receipt_operations%ROWTYPE;
  v_doc text;
  v_number bigint;
  v_note text;
  v_correlative text;
  v_details jsonb := '[]'::jsonb;
  v_service numeric := 0;
  v_service_count integer := 0;
  v_service_rounding_zero boolean := false;
  v_requires_reconciliation boolean := false;
  v_line record;
  x record;
BEGIN
  SELECT * INTO r
  FROM logistica.purchase_receipts
  WHERE id = p_purchase_receipt_id
  FOR SHARE;

  IF NOT FOUND
     OR NOT core.has_company_access(p_user_id, r.company_id)
     OR NOT core.has_permission_for_company(p_user_id, r.company_id, 'logistica.receptions.create') THEN
    RAISE EXCEPTION 'Recepción no encontrada o no autorizada';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('bsale_receipt_op'), hashtext(r.id::text));

  SELECT * INTO o
  FROM integraciones.bsale_purchase_receipt_operations
  WHERE purchase_receipt_id = r.id;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'operation_id', o.id,
      'status', o.status,
      'reception_id', o.bsale_reception_id,
      'error', o.error_message,
      'payload', o.payload_snapshot
    );
  END IF;

  SELECT * INTO s
  FROM integraciones.bsale_purchase_receipt_settings
  WHERE company_id = r.company_id;

  IF NOT FOUND THEN
    INSERT INTO integraciones.bsale_purchase_receipt_operations(
      company_id, purchase_receipt_id, correlation_code, office_id, status, error_message, created_by
    ) VALUES (
      r.company_id, r.id, r.receipt_number, NULL, 'FAILED', 'La empresa no tiene configuración de Recepciones BSale', p_user_id
    ) RETURNING * INTO o;

    RETURN jsonb_build_object('operation_id', o.id, 'status', o.status, 'reception_id', NULL, 'error', o.error_message, 'payload', o.payload_snapshot);
  END IF;

  IF NOT s.enabled THEN
    INSERT INTO integraciones.bsale_purchase_receipt_operations(
      company_id, purchase_receipt_id, correlation_code, office_id, status, error_message, created_by
    ) VALUES (
      r.company_id, r.id, r.receipt_number, s.office_id, 'FAILED', 'La integración de Recepciones BSale está deshabilitada', p_user_id
    ) RETURNING * INTO o;

    RETURN jsonb_build_object('operation_id', o.id, 'status', o.status, 'reception_id', NULL, 'error', o.error_message, 'payload', o.payload_snapshot);
  END IF;

  IF r.document_type = 'FA' THEN
    v_doc := 'FACTURA';
  ELSIF r.document_type = 'GD' THEN
    v_doc := 'GUÍA';
  ELSE
    INSERT INTO integraciones.bsale_purchase_receipt_operations(
      company_id, purchase_receipt_id, correlation_code, office_id, status, error_message, created_by
    ) VALUES (
      r.company_id, r.id, r.receipt_number, s.office_id, 'FAILED', 'Documento no soportado por BSale', p_user_id
    ) RETURNING * INTO o;

    RETURN jsonb_build_object('operation_id', o.id, 'status', o.status, 'reception_id', NULL, 'error', o.error_message, 'payload', o.payload_snapshot);
  END IF;

  BEGIN
    v_number := btrim(r.document_number)::bigint;
  EXCEPTION WHEN invalid_text_representation THEN
    INSERT INTO integraciones.bsale_purchase_receipt_operations(
      company_id, purchase_receipt_id, correlation_code, office_id, status, error_message, created_by
    ) VALUES (
      r.company_id, r.id, r.receipt_number, s.office_id, 'FAILED', 'El número de documento debe ser numérico para BSale', p_user_id
    ) RETURNING * INTO o;

    RETURN jsonb_build_object('operation_id', o.id, 'status', o.status, 'reception_id', NULL, 'error', o.error_message, 'payload', o.payload_snapshot);
  END;

  IF v_number <= 0 THEN
    INSERT INTO integraciones.bsale_purchase_receipt_operations(
      company_id, purchase_receipt_id, correlation_code, office_id, status, error_message, created_by
    ) VALUES (
      r.company_id, r.id, r.receipt_number, s.office_id, 'FAILED', 'El número de documento debe ser positivo para BSale', p_user_id
    ) RETURNING * INTO o;

    RETURN jsonb_build_object('operation_id', o.id, 'status', o.status, 'reception_id', NULL, 'error', o.error_message, 'payload', o.payload_snapshot);
  END IF;

  SELECT coalesce(to_jsonb(po)->>'correlative', po.id::text)
  INTO v_correlative
  FROM adquisiciones.purchase_orders po
  WHERE po.id = r.purchase_order_id;

  v_note := coalesce(r.receipt_number, r.id::text) || ' | ' || coalesce(v_correlative, r.purchase_order_id::text);
  IF r.notes IS NOT NULL AND char_length(v_note) < 100 THEN
    v_note := v_note || ' | ' || left(r.notes, greatest(0, 100 - char_length(v_note) - 3));
  END IF;

  INSERT INTO integraciones.bsale_purchase_receipt_operations(
    company_id, purchase_receipt_id, correlation_code, office_id, status, created_by
  ) VALUES (
    r.company_id, r.id, left(v_note, 100), s.office_id, 'PREPARED', p_user_id
  ) RETURNING * INTO o;

  -- Validate every physical stock-controlling PRODUCT line individually so
  -- invalid zero-cost lines cannot be masked by grouping under the same variant.
  FOR v_line IN SELECT
      i.id AS receipt_item_id,
      p.bsale_variant_id AS variant_id,
      logistica.classify_purchase_receipt_item_cost(i.id) AS cost_origin
    FROM logistica.purchase_receipt_items i
    JOIN adquisiciones.purchase_order_items poi ON poi.id = i.purchase_order_item_id
    JOIN adquisiciones.products p ON p.id = i.product_id
    LEFT JOIN integraciones.bsale_products bp
      ON bp.company_id = p.company_id AND bp.bsale_id = p.bsale_product_id
    LEFT JOIN integraciones.bsale_variants bv
      ON bv.company_id = p.company_id AND bv.bsale_id = p.bsale_variant_id
    LEFT JOIN integraciones.bsale_products bp_var
      ON bp_var.company_id = p.company_id AND bp_var.bsale_id = bv.bsale_product_id
    WHERE i.receipt_id = r.id
      AND poi.item_type = 'PRODUCT'
      AND i.condition IN ('CONFORME', 'DANADO')
      AND coalesce(bp.stock_control, bp_var.stock_control, true) = true
  LOOP
    IF v_line.variant_id IS NULL THEN
      RAISE EXCEPTION 'Una línea PRODUCT no tiene bsale_variant_id';
    END IF;
    IF v_line.cost_origin = 'INVALID' THEN
      RAISE EXCEPTION 'Línea PRODUCT sin cantidad o costo neto válido';
    END IF;
  END LOOP;

  -- Group physical stock-controlling products by variant while keeping bonus and
  -- commercial cumulative rounding zero strictly distinct.
  FOR x IN SELECT
      p.bsale_variant_id AS variant_id,
      sum(i.quantity_received) AS quantity,
      sum(i.net_amount) AS net_amount,
      bool_and(logistica.classify_purchase_receipt_item_cost(i.id) = 'LEGITIMATE_BONUS') AS is_legitimate_bonus,
      bool_and(logistica.classify_purchase_receipt_item_cost(i.id) IN ('LEGITIMATE_BONUS', 'COMMERCIAL_CUMULATIVE_ROUNDING_ZERO')) AS is_valid_zero_cost,
      bool_or(logistica.classify_purchase_receipt_item_cost(i.id) = 'COMMERCIAL_CUMULATIVE_ROUNDING_ZERO') AS has_commercial_rounding_zero
    FROM logistica.purchase_receipt_items i
    JOIN adquisiciones.purchase_order_items poi ON poi.id = i.purchase_order_item_id
    JOIN adquisiciones.products p ON p.id = i.product_id
    LEFT JOIN integraciones.bsale_products bp
      ON bp.company_id = p.company_id AND bp.bsale_id = p.bsale_product_id
    LEFT JOIN integraciones.bsale_variants bv
      ON bv.company_id = p.company_id AND bv.bsale_id = p.bsale_variant_id
    LEFT JOIN integraciones.bsale_products bp_var
      ON bp_var.company_id = p.company_id AND bp_var.bsale_id = bv.bsale_product_id
    WHERE i.receipt_id = r.id
      AND poi.item_type = 'PRODUCT'
      AND i.condition IN ('CONFORME', 'DANADO')
      AND coalesce(bp.stock_control, bp_var.stock_control, true) = true
    GROUP BY p.bsale_variant_id
  LOOP
    IF x.variant_id IS NULL THEN
      RAISE EXCEPTION 'Una línea PRODUCT no tiene bsale_variant_id';
    END IF;

    IF x.quantity <= 0 OR x.net_amount < 0 OR (x.net_amount = 0 AND NOT coalesce(x.is_valid_zero_cost, false)) THEN
      RAISE EXCEPTION 'Línea PRODUCT sin cantidad o costo neto válido';
    END IF;

    IF x.net_amount = 0 AND NOT coalesce(x.is_legitimate_bonus, false) AND coalesce(x.has_commercial_rounding_zero, false) THEN
      v_requires_reconciliation := true;
    END IF;

    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'quantity', x.quantity,
      'variantId', x.variant_id,
      'cost', CASE WHEN x.quantity > 0 THEN x.net_amount / x.quantity ELSE 0 END
    ));
  END LOOP;

  -- Only explicit SERVICE lines are aggregated into the service variant; non-stock freight is excluded from BSale stock receptions
  FOR v_line IN SELECT
      i.id AS receipt_item_id,
      i.net_amount,
      logistica.classify_purchase_receipt_item_cost(i.id) AS cost_origin
    FROM logistica.purchase_receipt_items i
    JOIN adquisiciones.purchase_order_items poi ON poi.id = i.purchase_order_item_id
    WHERE i.receipt_id = r.id
      AND poi.item_type = 'SERVICE'
      AND i.condition IN ('CONFORME', 'DANADO')
  LOOP
    v_service_count := v_service_count + 1;
    v_service := v_service + coalesce(v_line.net_amount, 0);
    IF v_line.cost_origin = 'COMMERCIAL_CUMULATIVE_ROUNDING_ZERO' THEN
      v_service_rounding_zero := true;
    ELSIF v_line.cost_origin = 'INVALID' AND v_line.net_amount < 0 THEN
      RAISE EXCEPTION 'Línea SERVICE sin cantidad o costo neto válido';
    END IF;
  END LOOP;

  IF v_service > 0 THEN
    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'quantity', 1,
      'variantId', s.service_variant_id,
      'cost', v_service
    ));
  ELSIF v_service_count > 0 AND v_service = 0 AND v_service_rounding_zero THEN
    v_requires_reconciliation := true;
    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'quantity', 1,
      'variantId', s.service_variant_id,
      'cost', 0
    ));
  END IF;

  IF jsonb_array_length(v_details) = 0 THEN
    RAISE EXCEPTION 'La recepción no tiene líneas aceptadas para BSale';
  END IF;

  UPDATE integraciones.bsale_purchase_receipt_operations
  SET payload_snapshot = jsonb_build_object(
        'document', v_doc,
        'officeId', s.office_id,
        'documentNumber', v_number,
        'note', left(v_note, 100),
        'details', v_details
      ),
      correlation_code = left(v_note, 100),
      status = CASE WHEN v_requires_reconciliation THEN 'RECONCILIATION_REQUIRED' ELSE 'PREPARED' END,
      error_message = CASE
        WHEN v_requires_reconciliation THEN
          'Costo neto cero legítimo por distribución económica acumulada; compatibilidad BSale pendiente de conciliación explícita.'
        ELSE NULL
      END
  WHERE id = o.id
  RETURNING * INTO o;

  RETURN jsonb_build_object(
    'operation_id', o.id,
    'status', o.status,
    'reception_id', o.bsale_reception_id,
    'error', o.error_message,
    'payload', o.payload_snapshot
  );
END;
$$;

REVOKE ALL ON FUNCTION integraciones.prepare_bsale_purchase_receipt_operation(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION integraciones.prepare_bsale_purchase_receipt_operation(uuid, uuid) TO service_role;

-- Controlled confirmation exclusively for RECONCILIATION_REQUIRED operations
-- after verified remote Bsale reconciliation (finish_bsale_purchase_receipt_operation
-- remains strictly SENDING-only, and claim remains strictly PREPARED-only).
CREATE OR REPLACE FUNCTION integraciones.confirm_reconciled_bsale_purchase_receipt_operation(
  p_operation_id uuid,
  p_company_id uuid,
  p_user_id uuid,
  p_reception_id bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, logistica, integraciones
AS $$
DECLARE
  o integraciones.bsale_purchase_receipt_operations%ROWTYPE;
  r logistica.purchase_receipts%ROWTYPE;
BEGIN
  IF p_operation_id IS NULL OR p_company_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'Operación no encontrada o no autorizada';
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Operación no encontrada o no autorizada';
  END IF;

  SELECT * INTO o
  FROM integraciones.bsale_purchase_receipt_operations
  WHERE id = p_operation_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND
     OR NOT coalesce(core.has_company_access(p_user_id, o.company_id), false)
     OR NOT coalesce(core.has_permission_for_company(p_user_id, o.company_id, 'logistica.receptions.create'), false) THEN
    RAISE EXCEPTION 'Operación no encontrada o no autorizada';
  END IF;

  IF p_reception_id IS NULL OR p_reception_id <= 0 THEN
    RAISE EXCEPTION 'ID de recepción BSale inválido para confirmación';
  END IF;

  IF o.status = 'CONFIRMED' THEN
    IF o.bsale_reception_id IS DISTINCT FROM p_reception_id THEN
      RAISE EXCEPTION 'La operación ya está confirmada con otra recepción BSale' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'operation_id', o.id,
      'status', o.status,
      'reception_id', o.bsale_reception_id,
      'error', o.error_message,
      'payload', o.payload_snapshot
    );
  END IF;

  IF o.status <> 'RECONCILIATION_REQUIRED' THEN
    RAISE EXCEPTION 'Solo se puede confirmar por conciliación una operación en estado RECONCILIATION_REQUIRED';
  END IF;

  IF o.bsale_reception_id IS NOT NULL AND o.bsale_reception_id <> p_reception_id THEN
    RAISE EXCEPTION 'El ID de recepción BSale no coincide con el registrado en la operación' USING ERRCODE = '23505';
  END IF;

  SELECT * INTO r
  FROM logistica.purchase_receipts
  WHERE id = o.purchase_receipt_id AND company_id = o.company_id;

  IF NOT FOUND OR r.status <> 'COMPLETED' THEN
    RAISE EXCEPTION 'La recepción local asociada no es válida para confirmar';
  END IF;

  IF NOT integraciones.purchase_receipt_payload_is_valid(o.payload_snapshot) THEN
    RAISE EXCEPTION 'El payload BSale de la operación es inválido';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('bsale_remote_rec'), hashtext(o.company_id::text || ':' || p_reception_id::text));

  IF EXISTS (
    SELECT 1
    FROM integraciones.bsale_purchase_receipt_operations other
    WHERE other.company_id = o.company_id
      AND other.bsale_reception_id = p_reception_id
      AND other.id <> o.id
  ) THEN
    RAISE EXCEPTION 'La recepción BSale ya se encuentra vinculada a otra operación de la empresa' USING ERRCODE = '23505';
  END IF;

  UPDATE integraciones.bsale_purchase_receipt_operations
  SET status = 'CONFIRMED',
      bsale_reception_id = p_reception_id,
      error_message = NULL,
      confirmed_at = coalesce(confirmed_at, now())
  WHERE id = o.id AND status = 'RECONCILIATION_REQUIRED'
  RETURNING * INTO o;

  RETURN jsonb_build_object(
    'operation_id', o.id,
    'status', o.status,
    'reception_id', o.bsale_reception_id,
    'error', o.error_message,
    'payload', o.payload_snapshot
  );
END;
$$;

REVOKE ALL ON FUNCTION integraciones.confirm_reconciled_bsale_purchase_receipt_operation(uuid, uuid, uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION integraciones.confirm_reconciled_bsale_purchase_receipt_operation(uuid, uuid, uuid, bigint) TO service_role;

COMMIT;
