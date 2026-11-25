-- Only the controlled transition below can emit a managed commercial draft.
-- Subsequent workflow transitions remain blocked pending downstream integration.
CREATE OR REPLACE FUNCTION adquisiciones.guard_commercial_po_status()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, adquisiciones AS $$
BEGIN
  IF (OLD.commercial_draft_revision > 0 OR EXISTS (
    SELECT 1 FROM adquisiciones.purchase_order_items i WHERE i.po_id=NEW.id AND i.company_id=NEW.company_id
      AND (i.purchase_unit_factor_snapshot IS NOT NULL OR i.commercial_unit_price_snapshot IS NOT NULL)
  )) AND NEW.status NOT IN ('BORRADOR','CANCELADA') THEN
    IF NOT (OLD.status='BORRADOR' AND NEW.status='EMITIDA' AND EXISTS (
      SELECT 1 FROM adquisiciones.commercial_draft_write_capabilities
      WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid()
    )) THEN
      RAISE EXCEPTION 'La transición comercial requiere integración adicional' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION adquisiciones.emit_commercial_purchase_draft(
  p_po_id uuid, p_expected_revision bigint, p_user_id uuid, p_company_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, core, portal AS $$
DECLARE v_po adquisiciones.purchase_orders%ROWTYPE; v_net numeric; v_discount numeric; v_tax numeric; v_total numeric;
BEGIN
  IF p_po_id IS NULL OR p_expected_revision IS NULL OR p_user_id IS NULL OR p_company_id IS NULL OR
     NOT (COALESCE(core.has_company_access(p_user_id,p_company_id),false) OR COALESCE(portal.user_has_permission(p_user_id,'system.admin'),false)) OR
     NOT (COALESCE(core.has_permission_for_company(p_user_id,p_company_id,'adquisiciones.po.update'),false) OR COALESCE(portal.user_has_permission(p_user_id,'system.admin'),false)) THEN
    RAISE EXCEPTION 'Sin acceso para emitir la orden';
  END IF;
  SELECT * INTO v_po FROM adquisiciones.purchase_orders WHERE id=p_po_id AND company_id=p_company_id FOR UPDATE;
  IF NOT FOUND OR v_po.source_type IS DISTINCT FROM 'MANUAL' OR v_po.commercial_draft_revision < 1 THEN RAISE EXCEPTION 'Borrador comercial no encontrado'; END IF;
  IF v_po.commercial_draft_revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'El borrador cambió en otra sesión; vuelva a cargarlo'; END IF;
  IF v_po.status='EMITIDA' THEN RETURN jsonb_build_object('success',true,'po_id',v_po.id,'status','EMITIDA','correlative',v_po.correlative); END IF;
  IF v_po.status IS DISTINCT FROM 'BORRADOR' OR v_po.receipt_status IS DISTINCT FROM 'PENDIENTE' THEN RAISE EXCEPTION 'Solo se puede emitir un borrador sin recepciones'; END IF;
  IF v_po.supplier_id IS NULL OR v_po.warehouse_id IS NULL THEN RAISE EXCEPTION 'Selecciona un proveedor y una bodega de destino'; END IF;
  IF NOT EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items WHERE po_id=v_po.id AND company_id=p_company_id AND is_active=true) THEN RAISE EXCEPTION 'La orden requiere líneas'; END IF;
  IF EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items i WHERE i.po_id=v_po.id AND i.company_id=p_company_id AND i.is_active=true AND (
    i.product_description IS NULL OR btrim(i.product_description)='' OR i.quantity IS NULL OR i.quantity<=0 OR i.unit_price IS NULL OR i.unit_price<=0 OR
    i.discount_percent IS NULL OR i.discount_percent<0 OR i.discount_percent>100 OR i.discount_unit_amount IS NULL OR i.discount_unit_amount<0 OR i.discount_unit_amount>i.unit_price OR (i.discount_percent>0 AND i.discount_unit_amount>0) OR
    i.tax_rate IS NULL OR i.tax_rate<0 OR i.tax_rate>100 OR COALESCE(i.quantity_received,0)>0 OR
    (i.item_type='PRODUCT' AND (i.product_id IS NULL OR (i.purchase_unit_factor_snapshot IS NOT NULL AND (i.commercial_unit_price_snapshot IS NULL OR i.commercial_unit_price_snapshot<=0 OR (i.purchase_unit_factor_snapshot>1 AND mod(i.quantity,i.purchase_unit_factor_snapshot)<>0))))) OR
    (i.item_type='SERVICE' AND i.product_id IS NOT NULL) OR i.item_type NOT IN ('PRODUCT','SERVICE') OR
    i.commercial_gross_amount_snapshot IS NULL OR i.discount_amount IS NULL OR i.tax_amount IS NULL OR i.line_total IS NULL OR
    i.discount_amount>i.commercial_gross_amount_snapshot OR i.line_total<>i.commercial_gross_amount_snapshot-i.discount_amount+i.tax_amount
  )) THEN RAISE EXCEPTION 'Revisa las cantidades, precios y demás datos de las líneas antes de emitir'; END IF;
  SELECT sum(i.commercial_gross_amount_snapshot-i.discount_amount),sum(i.discount_amount),sum(i.tax_amount),sum(i.line_total)
    INTO v_net,v_discount,v_tax,v_total FROM adquisiciones.purchase_order_items i WHERE i.po_id=v_po.id AND i.company_id=p_company_id AND i.is_active=true;
  IF v_po.net_total IS DISTINCT FROM v_net OR v_po.discount_total IS DISTINCT FROM v_discount OR v_po.tax_total IS DISTINCT FROM v_tax OR v_po.grand_total IS DISTINCT FROM v_total OR COALESCE(v_po.exempt_total,0)<>0 THEN RAISE EXCEPTION 'Los totales del borrador no coinciden con sus líneas'; END IF;
  INSERT INTO adquisiciones.commercial_draft_write_capabilities(transaction_id,backend_pid) VALUES (txid_current(),pg_backend_pid());
  UPDATE adquisiciones.purchase_orders SET status='EMITIDA',updated_by=p_user_id,updated_at=clock_timestamp() WHERE id=v_po.id AND company_id=p_company_id;
  INSERT INTO adquisiciones.purchase_order_status_history(company_id,po_id,from_status,to_status,changed_by) VALUES (p_company_id,v_po.id,'BORRADOR','EMITIDA',p_user_id);
  DELETE FROM adquisiciones.commercial_draft_write_capabilities WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid();
  RETURN jsonb_build_object('success',true,'po_id',v_po.id,'status','EMITIDA','correlative',v_po.correlative);
END $$;
REVOKE ALL ON FUNCTION adquisiciones.emit_commercial_purchase_draft(uuid,bigint,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.emit_commercial_purchase_draft(uuid,bigint,uuid,uuid) TO service_role;
