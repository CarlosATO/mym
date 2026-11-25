-- Preserve the existing status transition and immutable ORIGINAL_SENT schema.
CREATE OR REPLACE FUNCTION adquisiciones.guard_commercial_po_status()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, adquisiciones AS $$
BEGIN
  IF (OLD.commercial_draft_revision > 0 OR EXISTS (
    SELECT 1 FROM adquisiciones.purchase_order_items i WHERE i.po_id=NEW.id AND i.company_id=NEW.company_id
      AND (i.purchase_unit_factor_snapshot IS NOT NULL OR i.commercial_unit_price_snapshot IS NOT NULL)
  )) AND NEW.status NOT IN ('BORRADOR','CANCELADA') THEN
    IF NOT ((OLD.status='BORRADOR' AND NEW.status='EMITIDA' OR OLD.status='EMITIDA' AND NEW.status='ENVIADA_PROVEEDOR') AND EXISTS (
      SELECT 1 FROM adquisiciones.commercial_draft_write_capabilities
      WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid()
    )) THEN
      RAISE EXCEPTION 'La transición comercial requiere integración adicional' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Enrich only the snapshot created by the controlled commercial transition;
-- all existing fields and ordering from the traditional capture are retained.
CREATE FUNCTION adquisiciones.enrich_commercial_original_sent()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, adquisiciones AS $$
DECLARE v_items jsonb; v_count integer;
BEGIN
  IF NEW.snapshot_type <> 'ORIGINAL_SENT' OR NOT EXISTS (
    SELECT 1 FROM adquisiciones.purchase_orders p WHERE p.id=NEW.po_id AND p.company_id=NEW.company_id AND p.commercial_draft_revision>0
  ) OR NOT EXISTS (
    SELECT 1 FROM adquisiciones.commercial_draft_write_capabilities WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid()
  ) THEN RETURN NEW; END IF;
  SELECT count(*), COALESCE(jsonb_agg(e.item || jsonb_build_object(
    'purchase_unit_snapshot',i.purchase_unit_snapshot,
    'purchase_unit_factor_snapshot',i.purchase_unit_factor_snapshot,
    'product_supplier_mapping_id',i.product_supplier_mapping_id,
    'commercial_quantity',CASE WHEN i.purchase_unit_factor_snapshot IS NOT NULL THEN i.quantity/i.purchase_unit_factor_snapshot ELSE NULL END,
    'commercial_unit_price_snapshot',i.commercial_unit_price_snapshot,
    'commercial_gross_amount_snapshot',i.commercial_gross_amount_snapshot
  ) ORDER BY e.ordinality),'[]'::jsonb) INTO v_count,v_items
  FROM jsonb_array_elements(NEW.items_snapshot) WITH ORDINALITY AS e(item,ordinality)
  JOIN adquisiciones.purchase_order_items i ON i.id=(e.item->>'item_id')::uuid AND i.po_id=NEW.po_id AND i.company_id=NEW.company_id;
  IF v_count<>jsonb_array_length(NEW.items_snapshot) THEN RAISE EXCEPTION 'No se pudieron capturar todas las líneas comerciales'; END IF;
  NEW.items_snapshot := v_items;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION adquisiciones.enrich_commercial_original_sent() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_enrich_purchase_order_snapshot_commercial
  BEFORE INSERT ON adquisiciones.purchase_order_snapshots FOR EACH ROW EXECUTE FUNCTION adquisiciones.enrich_commercial_original_sent();

CREATE FUNCTION adquisiciones.send_commercial_purchase_order(p_po_id uuid,p_user_id uuid,p_company_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, adquisiciones, core, portal AS $$
DECLARE v_po adquisiciones.purchase_orders%ROWTYPE; v_result jsonb;
BEGIN
  IF p_po_id IS NULL OR p_user_id IS NULL OR p_company_id IS NULL OR
     NOT (COALESCE(core.has_company_access(p_user_id,p_company_id),false) OR COALESCE(portal.user_has_permission(p_user_id,'system.admin'),false)) OR
     NOT (COALESCE(core.has_permission_for_company(p_user_id,p_company_id,'adquisiciones.po.update'),false) OR COALESCE(portal.user_has_permission(p_user_id,'system.admin'),false)) THEN
    RAISE EXCEPTION 'Sin acceso para marcar la orden como enviada';
  END IF;
  SELECT * INTO v_po FROM adquisiciones.purchase_orders WHERE id=p_po_id AND company_id=p_company_id FOR UPDATE;
  IF NOT FOUND OR v_po.commercial_draft_revision<1 THEN RAISE EXCEPTION 'Orden comercial no encontrada'; END IF;
  IF v_po.status='ENVIADA_PROVEEDOR' THEN
    IF NOT EXISTS (SELECT 1 FROM adquisiciones.purchase_order_snapshots WHERE po_id=p_po_id AND company_id=p_company_id AND snapshot_type='ORIGINAL_SENT') THEN RAISE EXCEPTION 'Falta el snapshot original de la orden enviada'; END IF;
    RETURN jsonb_build_object('success',true,'po_id',p_po_id,'status','ENVIADA_PROVEEDOR');
  END IF;
  IF v_po.status IS DISTINCT FROM 'EMITIDA' THEN RAISE EXCEPTION 'Solo se puede enviar una orden emitida'; END IF;
  IF EXISTS (SELECT 1 FROM adquisiciones.purchase_order_snapshots WHERE po_id=p_po_id AND snapshot_type='ORIGINAL_SENT') THEN RAISE EXCEPTION 'La orden ya tiene un snapshot original'; END IF;
  INSERT INTO adquisiciones.commercial_draft_write_capabilities(transaction_id,backend_pid) VALUES (txid_current(),pg_backend_pid());
  v_result := adquisiciones.update_purchase_order_status(p_po_id,'ENVIADA_PROVEEDOR',NULL,p_user_id);
  IF COALESCE((v_result->>'success')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION '%',COALESCE(v_result->>'error','No se pudo marcar la orden como enviada'); END IF;
  IF NOT EXISTS (SELECT 1 FROM adquisiciones.purchase_order_snapshots WHERE po_id=p_po_id AND company_id=p_company_id AND snapshot_type='ORIGINAL_SENT') THEN RAISE EXCEPTION 'No se creó el snapshot original'; END IF;
  DELETE FROM adquisiciones.commercial_draft_write_capabilities WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid();
  RETURN jsonb_build_object('success',true,'po_id',p_po_id,'status','ENVIADA_PROVEEDOR');
END $$;
REVOKE ALL ON FUNCTION adquisiciones.send_commercial_purchase_order(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.send_commercial_purchase_order(uuid,uuid,uuid) TO service_role;
