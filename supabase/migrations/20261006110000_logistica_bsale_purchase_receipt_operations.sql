-- Durable PetGroup purchase-receipt -> BSale operations. Never touches mermas.*.
CREATE TABLE integraciones.bsale_purchase_receipt_settings (
  company_id uuid PRIMARY KEY REFERENCES core.companies(id) ON DELETE CASCADE,
  office_id integer CHECK (office_id IS NULL OR office_id > 0),
  service_variant_id integer NOT NULL CHECK (service_variant_id > 0),
  enabled boolean NOT NULL DEFAULT true,
  auto_sync_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO integraciones.bsale_purchase_receipt_settings(company_id, office_id, service_variant_id, enabled, auto_sync_enabled)
VALUES ('d1000000-0000-0000-0000-000000000001', 1, 4554, true, false)
ON CONFLICT (company_id) DO UPDATE SET office_id = EXCLUDED.office_id, service_variant_id = EXCLUDED.service_variant_id, enabled = EXCLUDED.enabled, auto_sync_enabled = EXCLUDED.auto_sync_enabled, updated_at = now();

CREATE TABLE integraciones.bsale_purchase_receipt_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
  purchase_receipt_id uuid NOT NULL REFERENCES logistica.purchase_receipts(id) ON DELETE RESTRICT,
  correlation_code text NOT NULL,
  status text NOT NULL DEFAULT 'PREPARED' CHECK (status IN ('PREPARED','SENDING','CONFIRMED','FAILED','RECONCILIATION_REQUIRED')),
  office_id integer CHECK (office_id IS NULL OR office_id > 0),
  payload_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  bsale_reception_id bigint,
  error_message text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_by uuid NOT NULL REFERENCES portal.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  sending_at timestamptz,
  last_attempt_at timestamptz,
  confirmed_at timestamptz,
  UNIQUE (purchase_receipt_id),
  UNIQUE (company_id, correlation_code)
);

CREATE INDEX bsale_purchase_receipt_operations_company_status_idx ON integraciones.bsale_purchase_receipt_operations(company_id, status, created_at DESC);
ALTER TABLE integraciones.bsale_purchase_receipt_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_purchase_receipt_operations ENABLE ROW LEVEL SECURITY;
CREATE POLICY bsale_purchase_receipt_settings_select ON integraciones.bsale_purchase_receipt_settings FOR SELECT TO authenticated USING (core.has_company_access(auth.uid(), company_id));
CREATE POLICY bsale_purchase_receipt_operations_select ON integraciones.bsale_purchase_receipt_operations FOR SELECT TO authenticated USING (core.has_company_access(auth.uid(), company_id) AND portal.has_permission('logistica.receptions.create'));
GRANT SELECT ON integraciones.bsale_purchase_receipt_settings, integraciones.bsale_purchase_receipt_operations TO authenticated, service_role;
GRANT ALL ON integraciones.bsale_purchase_receipt_settings, integraciones.bsale_purchase_receipt_operations TO service_role;

CREATE OR REPLACE FUNCTION integraciones.prepare_bsale_purchase_receipt_operation(p_purchase_receipt_id uuid, p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, auth, core, portal, logistica, adquisiciones, integraciones AS $$
DECLARE r logistica.purchase_receipts%ROWTYPE; s integraciones.bsale_purchase_receipt_settings%ROWTYPE; o integraciones.bsale_purchase_receipt_operations%ROWTYPE;
  v_doc text; v_number bigint; v_note text; v_details jsonb := '[]'::jsonb; v_service numeric := 0; x record;
BEGIN
  SELECT * INTO r FROM logistica.purchase_receipts WHERE id = p_purchase_receipt_id FOR SHARE;
  IF NOT FOUND OR NOT core.has_company_access(p_user_id, r.company_id) OR NOT core.has_permission_for_company(p_user_id, r.company_id, 'logistica.receptions.create') THEN RAISE EXCEPTION 'Recepción no encontrada o no autorizada'; END IF;
  SELECT * INTO o FROM integraciones.bsale_purchase_receipt_operations WHERE purchase_receipt_id = r.id;
  IF FOUND THEN RETURN jsonb_build_object('operation_id', o.id, 'status', o.status, 'reception_id', o.bsale_reception_id, 'error', o.error_message, 'payload', o.payload_snapshot); END IF;
  SELECT * INTO s FROM integraciones.bsale_purchase_receipt_settings WHERE company_id = r.company_id;
  IF NOT FOUND THEN
    INSERT INTO integraciones.bsale_purchase_receipt_operations(company_id, purchase_receipt_id, correlation_code, office_id, status, error_message, created_by)
      VALUES (r.company_id, r.id, r.receipt_number, NULL, 'FAILED', 'La empresa no tiene configuración de Recepciones BSale', p_user_id) RETURNING * INTO o;
    RETURN jsonb_build_object('operation_id', o.id, 'status', o.status, 'reception_id', NULL, 'error', o.error_message, 'payload', o.payload_snapshot);
  END IF;
  IF NOT s.enabled THEN
    INSERT INTO integraciones.bsale_purchase_receipt_operations(company_id, purchase_receipt_id, correlation_code, office_id, status, error_message, created_by)
      VALUES (r.company_id, r.id, r.receipt_number, s.office_id, 'FAILED', 'La integración de Recepciones BSale está deshabilitada', p_user_id) RETURNING * INTO o;
    RETURN jsonb_build_object('operation_id', o.id, 'status', o.status, 'reception_id', NULL, 'error', o.error_message, 'payload', o.payload_snapshot);
  END IF;
  IF r.document_type = 'FA' THEN v_doc := 'FACTURA'; ELSIF r.document_type = 'GD' THEN v_doc := 'GUÍA'; ELSE
    INSERT INTO integraciones.bsale_purchase_receipt_operations(company_id, purchase_receipt_id, correlation_code, office_id, status, error_message, created_by) VALUES (r.company_id, r.id, r.receipt_number, s.office_id, 'FAILED', 'Documento no soportado por BSale', p_user_id) RETURNING * INTO o;
    RETURN jsonb_build_object('operation_id', o.id, 'status', o.status, 'reception_id', NULL, 'error', o.error_message, 'payload', o.payload_snapshot);
  END IF;
  BEGIN v_number := btrim(r.document_number)::bigint; EXCEPTION WHEN invalid_text_representation THEN
    INSERT INTO integraciones.bsale_purchase_receipt_operations(company_id, purchase_receipt_id, correlation_code, office_id, status, error_message, created_by) VALUES (r.company_id, r.id, r.receipt_number, s.office_id, 'FAILED', 'El número de documento debe ser numérico para BSale', p_user_id) RETURNING * INTO o;
    RETURN jsonb_build_object('operation_id', o.id, 'status', o.status, 'reception_id', NULL, 'error', o.error_message, 'payload', o.payload_snapshot);
  END;
  IF v_number <= 0 THEN
    INSERT INTO integraciones.bsale_purchase_receipt_operations(company_id, purchase_receipt_id, correlation_code, office_id, status, error_message, created_by) VALUES (r.company_id, r.id, r.receipt_number, s.office_id, 'FAILED', 'El número de documento debe ser positivo para BSale', p_user_id) RETURNING * INTO o;
    RETURN jsonb_build_object('operation_id', o.id, 'status', o.status, 'reception_id', NULL, 'error', o.error_message, 'payload', o.payload_snapshot);
  END IF;
  v_note := r.receipt_number || ' | ' || (SELECT po.correlative FROM adquisiciones.purchase_orders po WHERE po.id = r.purchase_order_id);
  IF r.notes IS NOT NULL AND char_length(v_note) < 100 THEN v_note := v_note || ' | ' || left(r.notes, greatest(0, 100 - char_length(v_note) - 3)); END IF;
  INSERT INTO integraciones.bsale_purchase_receipt_operations(company_id, purchase_receipt_id, correlation_code, office_id, created_by)
    VALUES (r.company_id, r.id, v_note, s.office_id, p_user_id) RETURNING * INTO o;
  FOR x IN SELECT p.bsale_variant_id variant_id, sum(i.quantity_received) quantity, sum(i.net_amount) net_amount
    FROM logistica.purchase_receipt_items i JOIN adquisiciones.purchase_order_items poi ON poi.id = i.purchase_order_item_id
    JOIN adquisiciones.products p ON p.id = i.product_id WHERE i.receipt_id = r.id AND poi.item_type = 'PRODUCT' AND i.condition IN ('CONFORME','DANADO')
    GROUP BY p.bsale_variant_id LOOP
    IF x.variant_id IS NULL THEN RAISE EXCEPTION 'Una línea PRODUCT no tiene bsale_variant_id'; END IF;
    IF x.quantity <= 0 OR x.net_amount <= 0 THEN RAISE EXCEPTION 'Línea PRODUCT sin cantidad o costo neto válido'; END IF;
    v_details := v_details || jsonb_build_array(jsonb_build_object('quantity', x.quantity, 'variantId', x.variant_id, 'cost', x.net_amount / x.quantity));
  END LOOP;
  SELECT coalesce(sum(i.net_amount), 0) INTO v_service FROM logistica.purchase_receipt_items i JOIN adquisiciones.purchase_order_items poi ON poi.id = i.purchase_order_item_id WHERE i.receipt_id = r.id AND poi.item_type = 'SERVICE' AND i.condition IN ('CONFORME','DANADO');
  IF v_service > 0 THEN v_details := v_details || jsonb_build_array(jsonb_build_object('quantity', 1, 'variantId', s.service_variant_id, 'cost', v_service)); END IF;
  IF jsonb_array_length(v_details) = 0 THEN RAISE EXCEPTION 'La recepción no tiene líneas aceptadas para BSale'; END IF;
  UPDATE integraciones.bsale_purchase_receipt_operations SET payload_snapshot = jsonb_build_object('document', v_doc, 'officeId', s.office_id, 'documentNumber', v_number, 'note', left(v_note, 100), 'details', v_details), correlation_code = left(v_note, 100) WHERE id = o.id RETURNING * INTO o;
  RETURN jsonb_build_object('operation_id', o.id, 'status', o.status, 'reception_id', o.bsale_reception_id, 'error', o.error_message, 'payload', o.payload_snapshot);
END $$;

CREATE OR REPLACE FUNCTION integraciones.claim_bsale_purchase_receipt_operation(p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, integraciones AS $$ DECLARE o integraciones.bsale_purchase_receipt_operations%ROWTYPE; BEGIN SELECT * INTO o FROM integraciones.bsale_purchase_receipt_operations WHERE id = p_operation_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Operación no encontrada'; END IF; IF o.status = 'PREPARED' THEN UPDATE integraciones.bsale_purchase_receipt_operations SET status='SENDING', attempt_count=attempt_count+1, sending_at=now(), last_attempt_at=now() WHERE id=o.id; RETURN jsonb_build_object('claimed',true,'status','SENDING'); END IF; RETURN jsonb_build_object('claimed',false,'status',o.status,'reception_id',o.bsale_reception_id,'error',o.error_message); END $$;
CREATE OR REPLACE FUNCTION integraciones.finish_bsale_purchase_receipt_operation(p_operation_id uuid, p_status text, p_reception_id bigint, p_error text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, integraciones AS $$ BEGIN IF p_status NOT IN ('CONFIRMED','FAILED','RECONCILIATION_REQUIRED') THEN RAISE EXCEPTION 'Estado inválido'; END IF; UPDATE integraciones.bsale_purchase_receipt_operations SET status=p_status, bsale_reception_id=p_reception_id, error_message=nullif(btrim(p_error),''), confirmed_at=CASE WHEN p_status='CONFIRMED' THEN now() ELSE confirmed_at END WHERE id=p_operation_id AND status='SENDING'; IF NOT FOUND THEN RAISE EXCEPTION 'La operación no está en SENDING'; END IF; RETURN (SELECT jsonb_build_object('operation_id',id,'status',status,'reception_id',bsale_reception_id,'error',error_message,'payload',payload_snapshot) FROM integraciones.bsale_purchase_receipt_operations WHERE id=p_operation_id); END $$;
REVOKE ALL ON FUNCTION integraciones.prepare_bsale_purchase_receipt_operation(uuid,uuid), integraciones.claim_bsale_purchase_receipt_operation(uuid), integraciones.finish_bsale_purchase_receipt_operation(uuid,text,bigint,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION integraciones.prepare_bsale_purchase_receipt_operation(uuid,uuid), integraciones.claim_bsale_purchase_receipt_operation(uuid), integraciones.finish_bsale_purchase_receipt_operation(uuid,text,bigint,text) TO service_role;

CREATE OR REPLACE FUNCTION integraciones.retry_failed_bsale_purchase_receipt_operation(p_operation_id uuid, p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, core, portal, integraciones AS $$
DECLARE o integraciones.bsale_purchase_receipt_operations%ROWTYPE;
BEGIN
  SELECT * INTO o FROM integraciones.bsale_purchase_receipt_operations WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND OR NOT core.has_company_access(p_user_id, o.company_id) OR NOT core.has_permission_for_company(p_user_id, o.company_id, 'logistica.receptions.create') THEN RAISE EXCEPTION 'Operación no encontrada o no autorizada'; END IF;
  IF o.status <> 'FAILED' THEN RETURN jsonb_build_object('status', o.status, 'operation_id', o.id, 'reception_id', o.bsale_reception_id, 'error', o.error_message, 'payload', o.payload_snapshot); END IF;
  UPDATE integraciones.bsale_purchase_receipt_operations SET status='PREPARED', error_message=NULL, bsale_reception_id=NULL WHERE id=o.id;
  RETURN jsonb_build_object('status','PREPARED','operation_id',o.id,'reception_id',NULL,'error',NULL,'payload',o.payload_snapshot);
END $$;
REVOKE ALL ON FUNCTION integraciones.retry_failed_bsale_purchase_receipt_operation(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION integraciones.retry_failed_bsale_purchase_receipt_operation(uuid,uuid) TO service_role;
