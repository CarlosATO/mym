-- Only the controlled confirmation may extend the existing commercial transitions.
CREATE OR REPLACE FUNCTION adquisiciones.guard_commercial_po_status()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog, adquisiciones AS $$
BEGIN
  IF (OLD.commercial_draft_revision>0 OR EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items i WHERE i.po_id=NEW.id AND i.company_id=NEW.company_id AND (i.purchase_unit_factor_snapshot IS NOT NULL OR i.commercial_unit_price_snapshot IS NOT NULL))) AND NEW.status NOT IN ('BORRADOR','CANCELADA') THEN
    IF NOT ((OLD.status='BORRADOR' AND NEW.status='EMITIDA' OR OLD.status='EMITIDA' AND NEW.status='ENVIADA_PROVEEDOR' OR OLD.status='ENVIADA_PROVEEDOR' AND NEW.status='CONFIRMADA') AND EXISTS (SELECT 1 FROM adquisiciones.commercial_draft_write_capabilities WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid())) THEN
      RAISE EXCEPTION 'La transición comercial requiere integración adicional' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Enrich the traditional capture at insertion time; neither snapshot is updated.
CREATE OR REPLACE FUNCTION adquisiciones.enrich_commercial_original_sent()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, adquisiciones AS $$
DECLARE v_items jsonb; v_count integer;
BEGIN
  IF NEW.snapshot_type NOT IN ('ORIGINAL_SENT','CONFIRMED') OR NOT EXISTS (SELECT 1 FROM adquisiciones.purchase_orders p WHERE p.id=NEW.po_id AND p.company_id=NEW.company_id AND p.commercial_draft_revision>0) OR NOT EXISTS (SELECT 1 FROM adquisiciones.commercial_draft_write_capabilities WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid()) THEN RETURN NEW; END IF;
  SELECT count(*), COALESCE(jsonb_agg(e.item || jsonb_build_object(
    'purchase_unit_snapshot',i.purchase_unit_snapshot,
    'purchase_unit_factor_snapshot',i.purchase_unit_factor_snapshot,
    'product_supplier_mapping_id',i.product_supplier_mapping_id,
    'historical_product_supplier_mapping_id',COALESCE(i.historical_product_supplier_mapping_id,i.product_supplier_mapping_id),
    'discount_unit_amount',i.discount_unit_amount,
    'commercial_quantity',CASE WHEN i.purchase_unit_factor_snapshot IS NOT NULL THEN i.quantity/i.purchase_unit_factor_snapshot ELSE NULL END,
    'commercial_unit_price_snapshot',i.commercial_unit_price_snapshot,
    'commercial_gross_amount_snapshot',i.commercial_gross_amount_snapshot
  ) ORDER BY e.ordinality),'[]'::jsonb) INTO v_count,v_items
  FROM jsonb_array_elements(NEW.items_snapshot) WITH ORDINALITY AS e(item,ordinality)
  JOIN adquisiciones.purchase_order_items i ON i.id=(e.item->>'item_id')::uuid AND i.po_id=NEW.po_id AND i.company_id=NEW.company_id;
  IF v_count<>jsonb_array_length(NEW.items_snapshot) THEN RAISE EXCEPTION 'No se pudieron capturar todas las líneas comerciales'; END IF;
  NEW.items_snapshot:=v_items;
  RETURN NEW;
END $$;

-- Receipt integration is intentionally closed, including direct writes and races
-- with confirmation. Lock the same order row used by the confirmation RPC.
CREATE FUNCTION adquisiciones.guard_commercial_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, adquisiciones AS $$
DECLARE v_po_id uuid; v_managed boolean;
BEGIN
  IF TG_TABLE_NAME='purchase_receipts' THEN v_po_id:=NEW.purchase_order_id;
  ELSE SELECT po_id INTO v_po_id FROM adquisiciones.purchase_order_items WHERE id=NEW.purchase_order_item_id; END IF;
  SELECT p.commercial_draft_revision>0 OR EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items i WHERE i.po_id=p.id AND i.company_id=p.company_id AND i.purchase_unit_factor_snapshot IS NOT NULL)
    INTO v_managed FROM adquisiciones.purchase_orders p WHERE p.id=v_po_id FOR UPDATE;
  IF v_managed THEN RAISE EXCEPTION 'La recepción comercial requiere integración adicional' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION adquisiciones.guard_commercial_receipt() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_guard_commercial_receipt BEFORE INSERT OR UPDATE OF purchase_order_id ON logistica.purchase_receipts FOR EACH ROW EXECUTE FUNCTION adquisiciones.guard_commercial_receipt();
CREATE TRIGGER trg_guard_commercial_receipt_item BEFORE INSERT OR UPDATE OF purchase_order_item_id ON logistica.purchase_receipt_items FOR EACH ROW EXECUTE FUNCTION adquisiciones.guard_commercial_receipt();

CREATE FUNCTION adquisiciones.confirm_commercial_purchase_order(p_po_id uuid,p_user_id uuid,p_company_id uuid,p_expected_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, adquisiciones, logistica, core, portal AS $$
DECLARE v_po adquisiciones.purchase_orders%ROWTYPE; v_result jsonb; v_net numeric; v_discount numeric; v_tax numeric; v_count integer;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM p_user_id THEN RAISE EXCEPTION 'El usuario de la sesión no coincide con p_user_id'; END IF;
  IF p_po_id IS NULL OR p_user_id IS NULL OR p_company_id IS NULL OR p_expected_revision IS NULL OR
    NOT (COALESCE(core.has_company_access(p_user_id,p_company_id),false) OR COALESCE(portal.user_has_permission(p_user_id,'system.admin'),false)) OR
    NOT (COALESCE(core.has_permission_for_company(p_user_id,p_company_id,'adquisiciones.po.update'),false) OR COALESCE(portal.user_has_permission(p_user_id,'system.admin'),false)) OR
    NOT (COALESCE(portal.user_has_permission(p_user_id,'adquisiciones.po.update'),false) OR COALESCE(portal.user_has_permission(p_user_id,'system.admin'),false)) THEN RAISE EXCEPTION 'Sin acceso para confirmar la orden'; END IF;
  SELECT * INTO v_po FROM adquisiciones.purchase_orders WHERE id=p_po_id AND company_id=p_company_id FOR UPDATE;
  IF NOT FOUND OR v_po.commercial_draft_revision<1 THEN RAISE EXCEPTION 'Orden comercial no encontrada'; END IF;
  IF v_po.commercial_draft_revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'La revisión cambió en otra sesión; vuelva a cargarla'; END IF;
  IF v_po.status='CONFIRMADA' THEN
    SELECT jsonb_build_object('success',true,'already_confirmed',true,'po_id',p_po_id,'status','CONFIRMADA','snapshot_id',id,'revision',p_expected_revision) INTO v_result FROM adquisiciones.purchase_order_snapshots WHERE po_id=p_po_id AND company_id=p_company_id AND snapshot_type='CONFIRMED';
    IF v_result IS NULL THEN RAISE EXCEPTION 'Falta el snapshot confirmado'; END IF;
    RETURN v_result;
  END IF;
  IF v_po.status IS DISTINCT FROM 'ENVIADA_PROVEEDOR' THEN RAISE EXCEPTION 'Solo se puede confirmar una orden enviada'; END IF;
  PERFORM 1 FROM adquisiciones.purchase_order_items WHERE po_id=p_po_id AND company_id=p_company_id ORDER BY id FOR UPDATE;
  IF v_po.receipt_status IS DISTINCT FROM 'PENDIENTE' OR EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items WHERE po_id=p_po_id AND company_id=p_company_id AND COALESCE(quantity_received,0)>0) OR EXISTS (SELECT 1 FROM logistica.purchase_receipts WHERE purchase_order_id=p_po_id) OR EXISTS (SELECT 1 FROM logistica.purchase_receipt_items ri JOIN adquisiciones.purchase_order_items i ON i.id=ri.purchase_order_item_id WHERE i.po_id=p_po_id AND i.company_id=p_company_id) THEN RAISE EXCEPTION 'La orden tiene recepciones'; END IF;
  IF NOT EXISTS (SELECT 1 FROM adquisiciones.purchase_order_snapshots WHERE po_id=p_po_id AND company_id=p_company_id AND snapshot_type='ORIGINAL_SENT') OR EXISTS (SELECT 1 FROM adquisiciones.purchase_order_snapshots WHERE po_id=p_po_id AND snapshot_type='CONFIRMED') THEN RAISE EXCEPTION 'Snapshots de la orden inválidos'; END IF;
  IF EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items WHERE po_id=p_po_id AND company_id=p_company_id AND is_active IS DISTINCT FROM true) THEN RAISE EXCEPTION 'La orden contiene líneas inactivas'; END IF;
  IF EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items i WHERE i.po_id=p_po_id AND i.company_id=p_company_id AND i.is_active AND (
    i.quantity IS NULL OR i.quantity::text IN ('NaN','Infinity','-Infinity') OR i.quantity<=0 OR i.unit_price IS NULL OR i.unit_price::text IN ('NaN','Infinity','-Infinity') OR i.unit_price<0 OR
    i.discount_percent IS NULL OR i.discount_percent::text IN ('NaN','Infinity','-Infinity') OR i.discount_percent<0 OR i.discount_percent>100 OR i.discount_unit_amount IS NULL OR i.discount_unit_amount::text IN ('NaN','Infinity','-Infinity') OR i.discount_unit_amount<0 OR i.discount_unit_amount>i.unit_price OR (i.discount_percent>0 AND i.discount_unit_amount>0) OR i.tax_rate IS NULL OR i.tax_rate::text IN ('NaN','Infinity','-Infinity') OR i.tax_rate<0 OR i.tax_rate>100 OR
    (i.item_type='PRODUCT' AND (i.product_id IS NULL OR i.purchase_unit_factor_snapshot IS NULL OR i.purchase_unit_factor_snapshot<1 OR (i.purchase_unit_factor_snapshot>1 AND (NULLIF(btrim(i.purchase_unit_snapshot),'') IS NULL OR mod(i.quantity,i.purchase_unit_factor_snapshot)<>0)) OR i.commercial_unit_price_snapshot IS NULL OR i.commercial_unit_price_snapshot::text IN ('NaN','Infinity','-Infinity') OR i.commercial_unit_price_snapshot<0 OR i.unit_price<>round(i.commercial_unit_price_snapshot/i.purchase_unit_factor_snapshot,4))) OR
    (i.item_type='SERVICE' AND (i.product_id IS NOT NULL OR i.purchase_unit_factor_snapshot IS NOT NULL OR i.commercial_unit_price_snapshot IS NOT NULL)) OR i.item_type NOT IN ('PRODUCT','SERVICE') OR NULLIF(btrim(i.product_description),'') IS NULL OR
    i.commercial_gross_amount_snapshot IS DISTINCT FROM round(CASE WHEN i.purchase_unit_factor_snapshot IS NOT NULL THEN i.quantity*i.commercial_unit_price_snapshot/i.purchase_unit_factor_snapshot ELSE i.quantity*i.unit_price END,2) OR
    i.discount_amount IS DISTINCT FROM round(CASE WHEN i.discount_percent>0 THEN i.commercial_gross_amount_snapshot*i.discount_percent/100 ELSE i.quantity*i.discount_unit_amount END,2) OR i.discount_amount>i.commercial_gross_amount_snapshot OR
    i.tax_amount IS DISTINCT FROM round((i.commercial_gross_amount_snapshot-i.discount_amount)*i.tax_rate/100,2) OR i.line_total IS DISTINCT FROM i.commercial_gross_amount_snapshot-i.discount_amount+i.tax_amount
  )) THEN RAISE EXCEPTION 'Datos comerciales o económicos inválidos'; END IF;
  SELECT count(*),COALESCE(sum(commercial_gross_amount_snapshot-discount_amount),0),COALESCE(sum(discount_amount),0),COALESCE(sum(tax_amount),0) INTO v_count,v_net,v_discount,v_tax FROM adquisiciones.purchase_order_items WHERE po_id=p_po_id AND company_id=p_company_id AND is_active;
  IF v_count=0 OR v_po.net_total IS DISTINCT FROM v_net OR v_po.discount_total IS DISTINCT FROM v_discount OR v_po.tax_total IS DISTINCT FROM v_tax OR v_po.exempt_total IS DISTINCT FROM 0::numeric OR v_po.grand_total IS DISTINCT FROM v_net+v_tax THEN RAISE EXCEPTION 'Totales comerciales inválidos'; END IF;
  INSERT INTO adquisiciones.commercial_draft_write_capabilities(transaction_id,backend_pid) VALUES(txid_current(),pg_backend_pid());
  v_result:=adquisiciones.confirm_purchase_order_supplier_review(p_po_id,p_user_id,p_company_id);
  IF COALESCE((v_result->>'success')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION '%',COALESCE(v_result->>'error','No se pudo confirmar la orden'); END IF;
  IF NOT EXISTS (SELECT 1 FROM adquisiciones.purchase_order_snapshots WHERE po_id=p_po_id AND company_id=p_company_id AND snapshot_type='CONFIRMED' AND id=(v_result->>'snapshot_id')::uuid) THEN RAISE EXCEPTION 'No se creó el snapshot confirmado'; END IF;
  DELETE FROM adquisiciones.commercial_draft_write_capabilities WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid();
  RETURN v_result || jsonb_build_object('revision',p_expected_revision);
END $$;
REVOKE ALL ON FUNCTION adquisiciones.confirm_commercial_purchase_order(uuid,uuid,uuid,bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.confirm_commercial_purchase_order(uuid,uuid,uuid,bigint) TO service_role;
