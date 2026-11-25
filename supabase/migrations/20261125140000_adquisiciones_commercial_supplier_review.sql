-- Historical identity survives removal of the relational supplier mapping.
ALTER TABLE adquisiciones.purchase_order_items ADD COLUMN historical_product_supplier_mapping_id uuid;
COMMENT ON COLUMN adquisiciones.purchase_order_items.historical_product_supplier_mapping_id IS 'Identidad histórica capturada; no es una referencia relacional ni implica que el mapeo siga existiendo.';

-- Capture identity during the FK's nested ON DELETE SET NULL operation only.
CREATE FUNCTION adquisiciones.capture_deleted_po_mapping_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, adquisiciones AS $$
BEGIN
  IF pg_trigger_depth()>1 AND OLD.product_supplier_mapping_id IS NOT NULL AND NEW.product_supplier_mapping_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM adquisiciones.product_supplier_mappings WHERE id=OLD.product_supplier_mapping_id) THEN
    NEW.historical_product_supplier_mapping_id:=COALESCE(OLD.historical_product_supplier_mapping_id,OLD.product_supplier_mapping_id);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION adquisiciones.capture_deleted_po_mapping_identity() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_capture_deleted_po_mapping_identity BEFORE UPDATE OF product_supplier_mapping_id ON adquisiciones.purchase_order_items FOR EACH ROW EXECUTE FUNCTION adquisiciones.capture_deleted_po_mapping_identity();

CREATE OR REPLACE FUNCTION adquisiciones.guard_managed_commercial_draft()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, adquisiciones AS $$
DECLARE v_managed boolean;
BEGIN
  IF TG_TABLE_NAME='purchase_orders' THEN
    v_managed:=OLD.commercial_draft_revision>0 OR EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items i WHERE i.po_id=OLD.id AND i.company_id=OLD.company_id AND i.purchase_unit_factor_snapshot IS NOT NULL);
    IF TG_OP='UPDATE' AND NEW.status='CANCELADA' AND (to_jsonb(NEW)-ARRAY['status','cancel_reason','cancelled_at','cancelled_by','updated_at','updated_by'])=(to_jsonb(OLD)-ARRAY['status','cancel_reason','cancelled_at','cancelled_by','updated_at','updated_by']) THEN RETURN NEW; END IF;
  ELSE
    PERFORM 1 FROM adquisiciones.purchase_orders p WHERE
      (p.id=CASE WHEN TG_OP='INSERT' THEN NEW.po_id ELSE OLD.po_id END AND p.company_id=CASE WHEN TG_OP='INSERT' THEN NEW.company_id ELSE OLD.company_id END)
      OR (TG_OP='UPDATE' AND p.id=NEW.po_id AND p.company_id=NEW.company_id) ORDER BY p.id FOR UPDATE;
    SELECT EXISTS (SELECT 1 FROM adquisiciones.purchase_orders p WHERE
      ((p.id=CASE WHEN TG_OP='INSERT' THEN NEW.po_id ELSE OLD.po_id END AND p.company_id=CASE WHEN TG_OP='INSERT' THEN NEW.company_id ELSE OLD.company_id END)
       OR (TG_OP='UPDATE' AND p.id=NEW.po_id AND p.company_id=NEW.company_id))
      AND (p.commercial_draft_revision>0 OR EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items i WHERE i.po_id=p.id AND i.company_id=p.company_id AND i.purchase_unit_factor_snapshot IS NOT NULL))) INTO v_managed;
    IF TG_OP <> 'DELETE' AND NEW.purchase_unit_factor_snapshot IS NOT NULL THEN v_managed:=true; END IF;
    IF TG_OP='UPDATE' AND pg_trigger_depth()>1 AND OLD.product_supplier_mapping_id IS NOT NULL AND NEW.product_supplier_mapping_id IS NULL
       AND NEW.historical_product_supplier_mapping_id IS NOT DISTINCT FROM COALESCE(OLD.historical_product_supplier_mapping_id,OLD.product_supplier_mapping_id)
       -- Stored generated values are not available in NEW during BEFORE triggers.
       -- Their source columns remain in the comparison.
       AND (to_jsonb(NEW)-ARRAY['product_supplier_mapping_id','historical_product_supplier_mapping_id','quantity_pending'])=(to_jsonb(OLD)-ARRAY['product_supplier_mapping_id','historical_product_supplier_mapping_id','quantity_pending'])
       AND NOT EXISTS (SELECT 1 FROM adquisiciones.product_supplier_mappings WHERE id=OLD.product_supplier_mapping_id) THEN RETURN NEW; END IF;
  END IF;
  IF v_managed AND NOT EXISTS (SELECT 1 FROM adquisiciones.commercial_draft_write_capabilities WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid()) THEN RAISE EXCEPTION 'El borrador comercial requiere control de revisión' USING ERRCODE='23514'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

-- Preserve both the current link and the identity captured by a prior FK deletion.
CREATE OR REPLACE FUNCTION adquisiciones.enrich_commercial_original_sent()
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
    'historical_product_supplier_mapping_id',COALESCE(i.historical_product_supplier_mapping_id,i.product_supplier_mapping_id),
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

CREATE TABLE adquisiciones.commercial_review_requests (
  company_id uuid NOT NULL, user_id uuid NOT NULL, request_id uuid NOT NULL,
  payload jsonb NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,user_id,request_id)
);
ALTER TABLE adquisiciones.commercial_review_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON adquisiciones.commercial_review_requests FROM PUBLIC, anon, authenticated, service_role;

-- The general guard remains in force: only a private transaction capability can
-- write commercial fields while a sent order is being reviewed.
CREATE OR REPLACE FUNCTION adquisiciones.guard_commercial_po_item()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog, adquisiciones AS $$
DECLARE v_status text;
BEGIN
  IF NEW.purchase_unit_factor_snapshot IS NOT NULL OR NEW.commercial_unit_price_snapshot IS NOT NULL THEN
    SELECT status INTO v_status FROM adquisiciones.purchase_orders WHERE id=NEW.po_id AND company_id=NEW.company_id FOR UPDATE;
    IF v_status IS DISTINCT FROM 'BORRADOR' AND NOT (v_status='ENVIADA_PROVEEDOR' AND EXISTS (
      SELECT 1 FROM adquisiciones.commercial_draft_write_capabilities WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid()
    )) THEN RAISE EXCEPTION 'La configuración comercial requiere una operación controlada' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION adquisiciones.get_commercial_supplier_review_state(p_po_id uuid,p_user_id uuid,p_company_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, adquisiciones, core, portal AS $$
DECLARE v_revision bigint; v_items jsonb;
BEGIN
  IF p_po_id IS NULL OR p_user_id IS NULL OR p_company_id IS NULL OR
    NOT (COALESCE(core.has_company_access(p_user_id,p_company_id),false) OR COALESCE(portal.user_has_permission(p_user_id,'system.admin'),false)) OR
    NOT (COALESCE(core.has_permission_for_company(p_user_id,p_company_id,'adquisiciones.po.view'),false) OR COALESCE(portal.user_has_permission(p_user_id,'system.admin'),false)) THEN RAISE EXCEPTION 'Sin acceso a la revisión'; END IF;
  SELECT commercial_draft_revision INTO v_revision FROM adquisiciones.purchase_orders WHERE id=p_po_id AND company_id=p_company_id AND status='ENVIADA_PROVEEDOR' AND commercial_draft_revision>0;
  IF NOT FOUND THEN RAISE EXCEPTION 'Orden comercial enviada no encontrada'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('item_id',i.id,'item_type',i.item_type,'product_id',i.product_id,'product_description',i.product_description,'unit',i.unit,'quantity',i.quantity,'unit_price',i.unit_price,'discount_percent',i.discount_percent,'discount_unit_amount',i.discount_unit_amount,'discount_amount',i.discount_amount,'tax_rate',i.tax_rate,'tax_amount',i.tax_amount,'line_total',i.line_total,'purchase_unit_snapshot',i.purchase_unit_snapshot,'purchase_unit_factor_snapshot',i.purchase_unit_factor_snapshot,'product_supplier_mapping_id',i.product_supplier_mapping_id,'historical_product_supplier_mapping_id',COALESCE(i.historical_product_supplier_mapping_id,i.product_supplier_mapping_id,(SELECT COALESCE(NULLIF(e.value->>'historical_product_supplier_mapping_id','')::uuid,NULLIF(e.value->>'product_supplier_mapping_id','')::uuid) FROM adquisiciones.purchase_order_snapshots s CROSS JOIN LATERAL jsonb_array_elements(s.items_snapshot) e WHERE s.po_id=p_po_id AND s.company_id=p_company_id AND s.snapshot_type='ORIGINAL_SENT' AND e.value->>'item_id'=i.id::text LIMIT 1)),'commercial_unit_price',i.commercial_unit_price_snapshot::text,'commercial_gross_amount',i.commercial_gross_amount_snapshot,'notes',i.notes) ORDER BY i.line_number),'[]'::jsonb) INTO v_items FROM adquisiciones.purchase_order_items i WHERE i.po_id=p_po_id AND i.company_id=p_company_id AND i.is_active=true;
  RETURN jsonb_build_object('revision',v_revision,'items',v_items);
END $$;
REVOKE ALL ON FUNCTION adquisiciones.get_commercial_supplier_review_state(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.get_commercial_supplier_review_state(uuid,uuid,uuid) TO service_role;

CREATE FUNCTION adquisiciones.save_commercial_supplier_review(p_po_id uuid,p_data jsonb,p_user_id uuid,p_company_id uuid,p_request_id uuid,p_expected_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, adquisiciones, integraciones, logistica, core, portal AS $$
DECLARE
  v_po adquisiciones.purchase_orders%ROWTYPE; v_old adquisiciones.purchase_order_items%ROWTYPE; v_product adquisiciones.products%ROWTYPE;
  v_item jsonb; v_original jsonb; v_payload jsonb; v_saved adquisiciones.commercial_review_requests%ROWTYPE;
  v_id uuid; v_product_id uuid; v_mapping uuid; v_historical uuid; v_unit text; v_factor integer; v_type text; v_desc text;
  v_qty numeric; v_price numeric; v_unit_price numeric; v_percent numeric; v_fixed numeric; v_rate numeric; v_base numeric; v_discount numeric; v_tax numeric;
  v_net numeric:=0; v_discounts numeric:=0; v_taxes numeric:=0; v_ids uuid[]:=ARRAY[]::uuid[]; v_n integer:=0; v_count integer;
  v_new boolean; v_restore boolean; v_has_product boolean:=false; v_has_service boolean:=false; v_result jsonb; v_revision bigint;
BEGIN
  IF p_po_id IS NULL OR p_user_id IS NULL OR p_company_id IS NULL OR p_request_id IS NULL OR p_expected_revision IS NULL OR
    NOT (COALESCE(core.has_company_access(p_user_id,p_company_id),false) OR COALESCE(portal.user_has_permission(p_user_id,'system.admin'),false)) OR
    NOT (COALESCE(core.has_permission_for_company(p_user_id,p_company_id,'adquisiciones.po.update'),false) OR COALESCE(portal.user_has_permission(p_user_id,'system.admin'),false)) THEN RAISE EXCEPTION 'Sin acceso para guardar la revisión'; END IF;
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' OR jsonb_typeof(p_data->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'items')=0 THEN RAISE EXCEPTION 'La revisión requiere líneas'; END IF;
  v_payload:=jsonb_build_object('po_id',p_po_id,'data',p_data,'revision',p_expected_revision);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text||':'||p_user_id::text||':'||p_request_id::text,0));
  SELECT * INTO v_saved FROM adquisiciones.commercial_review_requests WHERE company_id=p_company_id AND user_id=p_user_id AND request_id=p_request_id;
  IF FOUND THEN IF v_saved.payload IS DISTINCT FROM v_payload THEN RAISE EXCEPTION 'La clave de guardado ya se utilizó con otros datos'; END IF; RETURN v_saved.result; END IF;
  SELECT * INTO v_po FROM adquisiciones.purchase_orders WHERE id=p_po_id AND company_id=p_company_id FOR UPDATE;
  IF NOT FOUND OR v_po.commercial_draft_revision<1 OR v_po.status IS DISTINCT FROM 'ENVIADA_PROVEEDOR' THEN RAISE EXCEPTION 'Orden comercial enviada no encontrada'; END IF;
  IF v_po.commercial_draft_revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'La revisión cambió en otra sesión; vuelva a cargarla'; END IF;
  -- Lock both FK targets before inspecting receipts, so concurrent inserts
  -- cannot race the subsequent line deletions.
  PERFORM 1 FROM adquisiciones.purchase_order_items WHERE po_id=p_po_id AND company_id=p_company_id ORDER BY id FOR UPDATE;
  IF v_po.receipt_status IS DISTINCT FROM 'PENDIENTE' OR EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items WHERE po_id=p_po_id AND company_id=p_company_id AND COALESCE(quantity_received,0)>0)
    OR EXISTS (SELECT 1 FROM logistica.purchase_receipts WHERE purchase_order_id=p_po_id)
    OR EXISTS (SELECT 1 FROM logistica.purchase_receipt_items ri JOIN adquisiciones.purchase_order_items i ON i.id=ri.purchase_order_item_id WHERE i.po_id=p_po_id AND i.company_id=p_company_id) THEN RAISE EXCEPTION 'La orden tiene recepciones'; END IF;
  IF NOT EXISTS (SELECT 1 FROM adquisiciones.purchase_order_snapshots WHERE po_id=p_po_id AND company_id=p_company_id AND snapshot_type='ORIGINAL_SENT') THEN RAISE EXCEPTION 'Falta el snapshot original'; END IF;
  INSERT INTO adquisiciones.commercial_draft_write_capabilities(transaction_id,backend_pid) VALUES(txid_current(),pg_backend_pid());
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_data->'items') LOOP
    v_n:=v_n+1; v_id:=NULLIF(v_item->>'item_id','')::uuid; v_product_id:=NULLIF(v_item->>'product_id','')::uuid; v_type:=v_item->>'item_type'; v_new:=v_id IS NULL; v_restore:=false; v_original:=NULL;
    IF v_type IS NULL OR v_type NOT IN ('PRODUCT','SERVICE') THEN RAISE EXCEPTION 'Tipo inválido en línea %',v_n; END IF;
    IF NOT v_new THEN
      IF v_id=ANY(v_ids) THEN RAISE EXCEPTION 'Línea duplicada'; END IF;
      SELECT * INTO v_old FROM adquisiciones.purchase_order_items WHERE id=v_id AND po_id=p_po_id AND company_id=p_company_id FOR UPDATE;
      IF NOT FOUND THEN
        SELECT count(*),(array_agg(e.value))[1] INTO v_count,v_original FROM adquisiciones.purchase_order_snapshots s CROSS JOIN LATERAL jsonb_array_elements(s.items_snapshot) e WHERE s.po_id=p_po_id AND s.company_id=p_company_id AND s.snapshot_type='ORIGINAL_SENT' AND e.value->>'item_id'=v_id::text;
        IF v_count<>1 THEN RAISE EXCEPTION 'Línea restaurada no pertenece al snapshot original'; END IF;
        IF v_type IS DISTINCT FROM v_original->>'item_type' OR v_product_id IS DISTINCT FROM NULLIF(v_original->>'product_id','')::uuid THEN RAISE EXCEPTION 'Identidad de línea restaurada inválida'; END IF;
        v_restore:=true;
      ELSIF v_old.item_type IS DISTINCT FROM v_type OR v_old.product_id IS DISTINCT FROM v_product_id THEN RAISE EXCEPTION 'Identidad de línea existente inválida'; END IF;
    END IF;
    -- Restoration uses the immutable original, not client or current catalog values.
    IF v_restore THEN v_item:=v_original || jsonb_build_object('commercial_unit_price',v_original->>'commercial_unit_price_snapshot'); END IF;
    v_qty:=NULLIF(v_item->>'quantity','')::numeric; v_percent:=COALESCE(NULLIF(v_item->>'discount_percent','')::numeric,0); v_fixed:=COALESCE(NULLIF(v_item->>'discount_unit_amount','')::numeric,0); v_rate:=COALESCE(NULLIF(v_item->>'tax_rate','')::numeric,19);
    IF v_qty IS NULL OR v_qty::text IN ('NaN','Infinity','-Infinity') OR v_percent::text IN ('NaN','Infinity','-Infinity') OR v_fixed::text IN ('NaN','Infinity','-Infinity') OR v_rate::text IN ('NaN','Infinity','-Infinity') OR v_qty<=0 OR v_qty<>round(v_qty,4) OR v_qty>=10000000000 OR v_percent<0 OR v_percent>100 OR v_percent<>round(v_percent,2) OR v_fixed<0 OR v_fixed<>round(v_fixed,4) OR (v_percent>0 AND v_fixed>0) OR v_rate<0 OR v_rate>100 OR v_rate<>round(v_rate,2) THEN RAISE EXCEPTION 'Cantidad, descuento o IVA inválido en línea %',v_n; END IF;
    v_mapping:=NULL; v_historical:=NULL; v_unit:=NULL; v_factor:=NULL; v_price:=NULL;
    v_desc:=CASE WHEN v_restore THEN NULLIF(btrim(v_original->>'product_description'),'') WHEN NOT v_new THEN v_old.product_description ELSE NULLIF(btrim(v_item->>'product_description'),'') END;
    IF v_type='PRODUCT' THEN
      v_has_product:=true; IF v_product_id IS NULL THEN RAISE EXCEPTION 'Producto requerido'; END IF;
      IF v_restore THEN
        v_unit:=NULLIF(v_original->>'purchase_unit_snapshot',''); v_factor:=NULLIF(v_original->>'purchase_unit_factor_snapshot','')::integer;
        v_historical:=COALESCE(NULLIF(v_original->>'historical_product_supplier_mapping_id','')::uuid,NULLIF(v_original->>'product_supplier_mapping_id','')::uuid);
        SELECT id INTO v_mapping FROM adquisiciones.product_supplier_mappings WHERE id=NULLIF(v_original->>'product_supplier_mapping_id','')::uuid AND company_id=p_company_id AND product_id=v_product_id FOR SHARE;
      ELSIF NOT v_new THEN
        v_unit:=v_old.purchase_unit_snapshot; v_factor:=v_old.purchase_unit_factor_snapshot; v_mapping:=v_old.product_supplier_mapping_id;
        SELECT COALESCE(v_old.historical_product_supplier_mapping_id,v_old.product_supplier_mapping_id,NULLIF(e.value->>'historical_product_supplier_mapping_id','')::uuid,NULLIF(e.value->>'product_supplier_mapping_id','')::uuid) INTO v_historical FROM adquisiciones.purchase_order_snapshots s CROSS JOIN LATERAL jsonb_array_elements(s.items_snapshot) e WHERE s.po_id=p_po_id AND s.company_id=p_company_id AND s.snapshot_type='ORIGINAL_SENT' AND e.value->>'item_id'=v_id::text;
        v_historical:=COALESCE(v_historical,v_old.historical_product_supplier_mapping_id,v_old.product_supplier_mapping_id);
      ELSE
        SELECT * INTO v_product FROM adquisiciones.products WHERE id=v_product_id AND company_id=p_company_id AND is_active FOR SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Producto inválido'; END IF;
        v_desc:=NULLIF(btrim(v_product.description),'');
        IF EXISTS (SELECT 1 FROM adquisiciones.product_supplier_mappings m LEFT JOIN adquisiciones.suppliers s ON s.id=m.supplier_id AND s.company_id=p_company_id WHERE m.company_id=p_company_id AND m.product_id=v_product_id AND m.is_active AND s.id IS NULL) THEN RAISE EXCEPTION 'Proveedor de mapeo inválido'; END IF;
        IF v_product.source='BSALE' THEN
          IF v_product.bsale_brand_id IS NULL THEN RAISE EXCEPTION 'Marca Bsale no resoluble'; END IF;
          SELECT count(*) INTO v_count FROM integraciones.bsale_brand_supplier_links WHERE company_id=p_company_id AND bsale_brand_id=v_product.bsale_brand_id;
          IF v_count<>1 OR NOT EXISTS(SELECT 1 FROM integraciones.bsale_brand_supplier_links WHERE company_id=p_company_id AND bsale_brand_id=v_product.bsale_brand_id AND supplier_id=v_po.supplier_id) THEN RAISE EXCEPTION 'Proveedor de marca Bsale ambiguo o contradictorio'; END IF;
          SELECT count(*),(array_agg(m.id))[1],(array_agg(m.purchase_unit))[1],(array_agg(m.purchase_unit_factor))[1] INTO v_count,v_mapping,v_unit,v_factor FROM adquisiciones.product_supplier_mappings m WHERE m.company_id=p_company_id AND m.product_id=v_product_id AND m.is_active;
          IF EXISTS(SELECT 1 FROM adquisiciones.product_supplier_mappings m LEFT JOIN adquisiciones.suppliers s ON s.id=m.supplier_id AND s.company_id=p_company_id WHERE m.company_id=p_company_id AND m.product_id=v_product_id AND m.is_active AND (s.id IS NULL OR (s.supplier_kind='REAL' AND s.id<>v_po.supplier_id))) THEN RAISE EXCEPTION 'Mapeo contradictorio'; END IF;
        ELSE
          SELECT count(*),(array_agg(m.id))[1],(array_agg(m.purchase_unit))[1],(array_agg(m.purchase_unit_factor))[1] INTO v_count,v_mapping,v_unit,v_factor FROM adquisiciones.product_supplier_mappings m JOIN adquisiciones.suppliers s ON s.id=m.supplier_id AND s.company_id=p_company_id WHERE m.company_id=p_company_id AND m.product_id=v_product_id AND m.is_active AND (s.id=v_po.supplier_id OR (s.supplier_kind='BSALE_OPERATIVE' AND s.parent_supplier_id=v_po.supplier_id));
        END IF;
        IF v_count>1 THEN RAISE EXCEPTION 'Mapeo comercial ambiguo'; END IF;
        v_factor:=COALESCE(v_factor,1);
        IF v_factor<1 OR (NULLIF(btrim(v_unit),'') IS NULL AND v_factor<>1) THEN RAISE EXCEPTION 'Configuración comercial inválida'; END IF;
        IF NOT (v_item ? 'purchase_unit_snapshot' AND v_item ? 'purchase_unit_factor_snapshot' AND v_item ? 'product_supplier_mapping_id') OR NULLIF(btrim(v_item->>'purchase_unit_snapshot'),'') IS DISTINCT FROM NULLIF(btrim(v_unit),'') OR NULLIF(v_item->>'purchase_unit_factor_snapshot','')::integer IS DISTINCT FROM v_factor OR NULLIF(v_item->>'product_supplier_mapping_id','')::uuid IS DISTINCT FROM v_mapping THEN RAISE EXCEPTION 'La configuración comercial cambió; vuelva a seleccionar el producto'; END IF;
        v_historical:=v_mapping;
      END IF;
      IF v_factor IS NOT NULL THEN
        IF v_factor>1 AND mod(v_qty,v_factor)<>0 THEN RAISE EXCEPTION 'Debe ser múltiplo de %',v_factor; END IF;
        v_price:=NULLIF(v_item->>'commercial_unit_price','')::numeric;
        IF v_price IS NULL OR v_price::text IN ('NaN','Infinity','-Infinity') OR v_price<0 OR v_price<>round(v_price,4) OR v_price>=100000000000000 THEN RAISE EXCEPTION 'Precio comercial inválido'; END IF;
        v_unit_price:=round(v_price/v_factor,4); v_base:=v_qty*v_price/v_factor;
      ELSE v_unit_price:=NULLIF(v_item->>'unit_price','')::numeric; v_base:=v_qty*v_unit_price; END IF;
    ELSE
      v_has_service:=true; IF v_product_id IS NOT NULL THEN RAISE EXCEPTION 'Servicio con producto inválido'; END IF;
      v_unit_price:=NULLIF(v_item->>'unit_price','')::numeric; v_base:=v_qty*v_unit_price;
    END IF;
    IF v_desc IS NULL OR v_unit_price IS NULL OR v_unit_price::text IN ('NaN','Infinity','-Infinity') OR v_unit_price<0 OR v_unit_price<>round(v_unit_price,4) OR v_unit_price>=10000000000 OR v_fixed>v_unit_price THEN RAISE EXCEPTION 'Descripción, precio o descuento inválido en línea %',v_n; END IF;
    v_base:=round(v_base,2); v_discount:=round(CASE WHEN v_percent>0 THEN v_base*v_percent/100 ELSE v_qty*v_fixed END,2);
    IF v_discount>v_base THEN RAISE EXCEPTION 'Descuento supera el bruto'; END IF;
    v_tax:=round((v_base-v_discount)*v_rate/100,2); v_net:=v_net+v_base-v_discount; v_discounts:=v_discounts+v_discount; v_taxes:=v_taxes+v_tax;
    IF v_new OR v_restore THEN
      INSERT INTO adquisiciones.purchase_order_items(id,company_id,po_id,line_number,item_type,product_id,product_description,unit,quantity,unit_price,discount_percent,discount_unit_amount,discount_amount,tax_rate,tax_amount,line_total,warehouse_id,cost_center,required_date,notes,quantity_received,created_by,updated_by,purchase_unit_snapshot,purchase_unit_factor_snapshot,product_supplier_mapping_id,historical_product_supplier_mapping_id,commercial_unit_price_snapshot,commercial_gross_amount_snapshot)
      VALUES(COALESCE(v_id,gen_random_uuid()),p_company_id,p_po_id,v_n,v_type,v_product_id,v_desc,CASE WHEN v_restore THEN NULLIF(v_original->>'unit','') WHEN v_type='PRODUCT' THEN v_product.unit_of_measure ELSE NULLIF(v_item->>'unit','') END,v_qty,v_unit_price,v_percent,v_fixed,v_discount,v_rate,v_tax,v_base-v_discount+v_tax,CASE WHEN v_restore THEN NULLIF(v_original->>'warehouse_id','')::uuid ELSE v_po.warehouse_id END,CASE WHEN v_restore THEN NULLIF(v_original->>'cost_center','') ELSE NULL END,CASE WHEN v_restore THEN NULLIF(v_original->>'required_date','')::date ELSE v_po.required_date END,NULLIF(v_item->>'notes',''),0,p_user_id,p_user_id,v_unit,v_factor,v_mapping,v_historical,v_price,v_base) RETURNING id INTO v_id;
    ELSE
      UPDATE adquisiciones.purchase_order_items SET line_number=v_n,quantity=v_qty,unit_price=v_unit_price,discount_percent=v_percent,discount_unit_amount=v_fixed,discount_amount=v_discount,tax_rate=v_rate,tax_amount=v_tax,line_total=v_base-v_discount+v_tax,notes=CASE WHEN v_item ? 'notes' THEN NULLIF(v_item->>'notes','') ELSE v_old.notes END,historical_product_supplier_mapping_id=v_historical,commercial_unit_price_snapshot=v_price,commercial_gross_amount_snapshot=v_base,updated_by=p_user_id,updated_at=now() WHERE id=v_id AND po_id=p_po_id AND company_id=p_company_id;
    END IF;
    v_ids:=array_append(v_ids,v_id);
  END LOOP;
  DELETE FROM adquisiciones.purchase_order_items WHERE po_id=p_po_id AND company_id=p_company_id AND NOT(id=ANY(v_ids));
  UPDATE adquisiciones.purchase_orders SET po_type=CASE WHEN v_has_product AND v_has_service THEN 'MIXTA' WHEN v_has_service THEN 'SERVICIOS' ELSE 'PRODUCTOS' END,net_total=v_net,discount_total=v_discounts,tax_total=v_taxes,exempt_total=0,grand_total=v_net+v_taxes,commercial_draft_revision=commercial_draft_revision+1,updated_by=p_user_id,updated_at=now() WHERE id=p_po_id AND company_id=p_company_id RETURNING commercial_draft_revision INTO v_revision;
  v_result:=jsonb_build_object('success',true,'po_id',p_po_id,'status','ENVIADA_PROVEEDOR','revision',v_revision,'item_ids',to_jsonb(v_ids),'net_total',v_net,'discount_total',v_discounts,'tax_total',v_taxes,'grand_total',v_net+v_taxes);
  INSERT INTO adquisiciones.commercial_review_requests(company_id,user_id,request_id,payload,result) VALUES(p_company_id,p_user_id,p_request_id,v_payload,v_result);
  DELETE FROM adquisiciones.commercial_draft_write_capabilities WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid();
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION adquisiciones.save_commercial_supplier_review(uuid,jsonb,uuid,uuid,uuid,bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.save_commercial_supplier_review(uuid,jsonb,uuid,uuid,uuid,bigint) TO service_role;
