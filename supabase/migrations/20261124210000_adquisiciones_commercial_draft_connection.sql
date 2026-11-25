-- Idempotent requests and optimistic concurrency for manual commercial drafts.
ALTER TABLE adquisiciones.purchase_orders ADD COLUMN commercial_draft_revision bigint NOT NULL DEFAULT 0;
CREATE TABLE adquisiciones.commercial_draft_requests (
  company_id uuid NOT NULL, user_id uuid NOT NULL, request_id uuid NOT NULL,
  payload jsonb NOT NULL, po_id uuid NOT NULL, result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (company_id,user_id,request_id)
);
ALTER TABLE adquisiciones.commercial_draft_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON adquisiciones.commercial_draft_requests FROM PUBLIC, anon, authenticated, service_role;

-- Private transaction capability: legacy writers cannot edit managed drafts.
CREATE TABLE adquisiciones.commercial_draft_write_capabilities (
  transaction_id bigint NOT NULL, backend_pid integer NOT NULL,
  PRIMARY KEY(transaction_id,backend_pid)
);
ALTER TABLE adquisiciones.commercial_draft_write_capabilities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON adquisiciones.commercial_draft_write_capabilities FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION adquisiciones.guard_managed_commercial_draft()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, adquisiciones AS $$
DECLARE v_managed boolean;
BEGIN
  IF TG_TABLE_NAME='purchase_orders' THEN
    v_managed := OLD.commercial_draft_revision>0 OR EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items i WHERE i.po_id=OLD.id AND i.company_id=OLD.company_id AND i.purchase_unit_factor_snapshot IS NOT NULL);
    IF TG_OP='UPDATE' AND NEW.status='CANCELADA' AND (to_jsonb(NEW)-ARRAY['status','cancel_reason','cancelled_at','cancelled_by','updated_at','updated_by']) = (to_jsonb(OLD)-ARRAY['status','cancel_reason','cancelled_at','cancelled_by','updated_at','updated_by']) THEN RETURN NEW; END IF;
  ELSE
    -- Serialize legacy writes with the wrapper's header lock, including moves
    -- between orders; recheck in a separate statement after any lock wait.
    PERFORM 1 FROM adquisiciones.purchase_orders p WHERE
      (p.id=CASE WHEN TG_OP='INSERT' THEN NEW.po_id ELSE OLD.po_id END AND p.company_id=CASE WHEN TG_OP='INSERT' THEN NEW.company_id ELSE OLD.company_id END)
      OR (TG_OP='UPDATE' AND p.id=NEW.po_id AND p.company_id=NEW.company_id)
      ORDER BY p.id FOR UPDATE;
    SELECT EXISTS (SELECT 1 FROM adquisiciones.purchase_orders p WHERE
      ((p.id=CASE WHEN TG_OP='INSERT' THEN NEW.po_id ELSE OLD.po_id END AND p.company_id=CASE WHEN TG_OP='INSERT' THEN NEW.company_id ELSE OLD.company_id END)
       OR (TG_OP='UPDATE' AND p.id=NEW.po_id AND p.company_id=NEW.company_id))
      AND (p.commercial_draft_revision>0 OR EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items i WHERE i.po_id=p.id AND i.company_id=p.company_id AND i.purchase_unit_factor_snapshot IS NOT NULL))) INTO v_managed;
    IF TG_OP <> 'DELETE' AND NEW.purchase_unit_factor_snapshot IS NOT NULL THEN v_managed := true; END IF;
  END IF;
  IF v_managed AND NOT EXISTS (SELECT 1 FROM adquisiciones.commercial_draft_write_capabilities WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid()) THEN
    RAISE EXCEPTION 'El borrador comercial requiere control de revisión' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_guard_managed_commercial_po BEFORE UPDATE OR DELETE ON adquisiciones.purchase_orders FOR EACH ROW EXECUTE FUNCTION adquisiciones.guard_managed_commercial_draft();
CREATE TRIGGER trg_guard_managed_commercial_item BEFORE INSERT OR UPDATE OR DELETE ON adquisiciones.purchase_order_items FOR EACH ROW EXECUTE FUNCTION adquisiciones.guard_managed_commercial_draft();

CREATE FUNCTION adquisiciones.save_commercial_draft_request(
  p_po_id uuid, p_data jsonb, p_user_id uuid, p_company_id uuid,
  p_request_id uuid, p_expected_revision bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, core, portal AS $$
DECLARE v_saved adquisiciones.commercial_draft_requests%ROWTYPE; v_result jsonb; v_po_id uuid; v_revision bigint; v_lines jsonb; v_payload jsonb;
BEGIN
  IF p_request_id IS NULL OR p_user_id IS NULL OR p_company_id IS NULL OR
    NOT (COALESCE(core.has_company_access(p_user_id,p_company_id),false) OR COALESCE(portal.user_has_permission(p_user_id,'system.admin'),false)) OR
    NOT (COALESCE(core.has_permission_for_company(p_user_id,p_company_id,CASE WHEN p_po_id IS NULL THEN 'adquisiciones.po.create' ELSE 'adquisiciones.po.update' END),false) OR COALESCE(portal.user_has_permission(p_user_id,'system.admin'),false)) THEN RAISE EXCEPTION 'Sin acceso para guardar el borrador'; END IF;
  v_payload := jsonb_build_object('po_id',p_po_id,'data',p_data,'revision',p_expected_revision);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':' || p_user_id::text || ':' || p_request_id::text,0));
  SELECT * INTO v_saved FROM adquisiciones.commercial_draft_requests WHERE company_id=p_company_id AND user_id=p_user_id AND request_id=p_request_id;
  IF FOUND THEN
    IF v_saved.payload IS DISTINCT FROM v_payload THEN RAISE EXCEPTION 'La clave de guardado ya se utilizó con otros datos'; END IF;
    RETURN v_saved.result;
  END IF;
  IF p_po_id IS NOT NULL THEN
    SELECT commercial_draft_revision INTO v_revision FROM adquisiciones.purchase_orders WHERE id=p_po_id AND company_id=p_company_id FOR UPDATE;
    IF NOT FOUND OR p_expected_revision IS NULL OR v_revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'El borrador cambió en otra sesión; vuelva a cargarlo'; END IF;
  END IF;
  INSERT INTO adquisiciones.commercial_draft_write_capabilities(transaction_id,backend_pid) VALUES (txid_current(),pg_backend_pid());
  v_result := adquisiciones.save_commercial_purchase_draft(p_po_id,p_data,p_user_id,p_company_id);
  v_po_id := (v_result->>'po_id')::uuid;
  UPDATE adquisiciones.purchase_orders SET commercial_draft_revision=commercial_draft_revision+1 WHERE id=v_po_id AND company_id=p_company_id RETURNING commercial_draft_revision INTO v_revision;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',i.id,'purchase_unit_snapshot',i.purchase_unit_snapshot,'purchase_unit_factor_snapshot',i.purchase_unit_factor_snapshot,'product_supplier_mapping_id',i.product_supplier_mapping_id,'commercial_unit_price_snapshot',i.commercial_unit_price_snapshot::text) ORDER BY i.line_number),'[]'::jsonb) INTO v_lines FROM adquisiciones.purchase_order_items i WHERE i.po_id=v_po_id AND i.company_id=p_company_id;
  v_result := v_result || jsonb_build_object('revision',v_revision,'lines',v_lines);
  INSERT INTO adquisiciones.commercial_draft_requests(company_id,user_id,request_id,payload,po_id,result) VALUES (p_company_id,p_user_id,p_request_id,v_payload,v_po_id,v_result);
  DELETE FROM adquisiciones.commercial_draft_write_capabilities WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid();
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION adquisiciones.save_commercial_draft_request(uuid,jsonb,uuid,uuid,uuid,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION adquisiciones.save_commercial_draft_request(uuid,jsonb,uuid,uuid,uuid,bigint) TO service_role;

CREATE FUNCTION adquisiciones.get_commercial_draft_snapshots(p_po_id uuid,p_user_id uuid,p_company_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, adquisiciones, core, portal AS $$
DECLARE v_revision bigint; v_lines jsonb;
BEGIN
  IF NOT (COALESCE(core.has_company_access(p_user_id,p_company_id),false) OR COALESCE(portal.user_has_permission(p_user_id,'system.admin'),false)) OR
     NOT (COALESCE(core.has_permission_for_company(p_user_id,p_company_id,'adquisiciones.po.view'),false) OR COALESCE(portal.user_has_permission(p_user_id,'system.admin'),false)) THEN RAISE EXCEPTION 'Sin acceso al borrador'; END IF;
  SELECT commercial_draft_revision INTO v_revision FROM adquisiciones.purchase_orders WHERE id=p_po_id AND company_id=p_company_id AND status='BORRADOR' AND source_type='MANUAL';
  IF NOT FOUND THEN RAISE EXCEPTION 'Borrador manual no encontrado'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',i.id,'purchase_unit_snapshot',i.purchase_unit_snapshot,'purchase_unit_factor_snapshot',i.purchase_unit_factor_snapshot,'product_supplier_mapping_id',i.product_supplier_mapping_id,'commercial_unit_price_snapshot',i.commercial_unit_price_snapshot::text) ORDER BY i.line_number),'[]'::jsonb) INTO v_lines FROM adquisiciones.purchase_order_items i WHERE i.po_id=p_po_id AND i.company_id=p_company_id AND i.is_active=true;
  RETURN jsonb_build_object('revision',v_revision,'lines',v_lines);
END $$;
REVOKE ALL ON FUNCTION adquisiciones.get_commercial_draft_snapshots(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION adquisiciones.get_commercial_draft_snapshots(uuid,uuid,uuid) TO service_role;
