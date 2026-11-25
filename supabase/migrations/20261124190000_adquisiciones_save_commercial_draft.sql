-- Atomic manual draft writer. New product configuration is resolved in this transaction;
-- existing lines retain their captured configuration even if the catalog changes.
ALTER TABLE adquisiciones.purchase_order_items
  ADD COLUMN commercial_gross_amount_snapshot numeric(14,2),
  ADD CONSTRAINT poi_commercial_gross_nonnegative CHECK (commercial_gross_amount_snapshot IS NULL OR commercial_gross_amount_snapshot >= 0);

COMMENT ON COLUMN adquisiciones.purchase_order_items.commercial_gross_amount_snapshot IS
  'Importe bruto capturado para borradores comerciales; NULL para líneas históricas no calculadas por esta operación.';

CREATE FUNCTION adquisiciones.save_commercial_purchase_draft(
  p_po_id uuid, p_data jsonb, p_user_id uuid, p_company_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, integraciones, core, portal AS $$
DECLARE
  v_po adquisiciones.purchase_orders%ROWTYPE;
  v_old adquisiciones.purchase_order_items%ROWTYPE;
  v_product adquisiciones.products%ROWTYPE;
  v_item jsonb; v_item_id uuid; v_product_id uuid; v_supplier_id uuid;
  v_mapping uuid; v_unit text; v_factor integer; v_price numeric; v_unit_price numeric;
  v_qty numeric; v_percent numeric; v_fixed numeric; v_tax_rate numeric;
  v_base numeric; v_discount numeric; v_tax numeric;
  v_net numeric := 0; v_discounts numeric := 0; v_taxes numeric := 0;
  v_ids uuid[] := ARRAY[]::uuid[]; v_index integer := 0; v_count integer;
  v_has_product boolean := false; v_has_service boolean := false;
  v_desc text; v_type text; v_is_new boolean; v_warehouse uuid; v_authorized uuid;
  v_line_warehouse uuid; v_line_unit text; v_cost_center text; v_required_date date;
BEGIN
  IF p_company_id IS NULL OR p_user_id IS NULL OR
     NOT (COALESCE(core.has_company_access(p_user_id, p_company_id),false) OR COALESCE(portal.user_has_permission(p_user_id, 'system.admin'),false)) OR
     NOT (COALESCE(core.has_permission_for_company(p_user_id, p_company_id, CASE WHEN p_po_id IS NULL THEN 'adquisiciones.po.create' ELSE 'adquisiciones.po.update' END),false) OR COALESCE(portal.user_has_permission(p_user_id, 'system.admin'),false)) THEN
    RAISE EXCEPTION 'Sin acceso para guardar el borrador';
  END IF;
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' OR jsonb_typeof(p_data->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'items') = 0 THEN
    RAISE EXCEPTION 'El borrador requiere líneas';
  END IF;
  IF COALESCE(p_data->>'source_type', 'MANUAL') <> 'MANUAL' OR COALESCE(p_data->>'status', 'BORRADOR') <> 'BORRADOR' THEN
    RAISE EXCEPTION 'Solo se permiten borradores manuales';
  END IF;
  v_supplier_id := NULLIF(p_data->>'supplier_id', '')::uuid;
  v_warehouse := NULLIF(p_data->>'warehouse_id','')::uuid;
  v_authorized := NULLIF(p_data->>'authorized_by','')::uuid;
  IF v_warehouse IS NOT NULL THEN
    PERFORM 1 FROM adquisiciones.warehouses WHERE id=v_warehouse AND company_id=p_company_id AND is_active AND status='ACTIVE' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Bodega de cabecera inválida o inactiva'; END IF;
  END IF;
  IF v_authorized IS NOT NULL THEN
    PERFORM 1 FROM adquisiciones.authorized_personnel WHERE id=v_authorized AND company_id=p_company_id AND is_active FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Autorizador inválido o inactivo'; END IF;
  END IF;
  PERFORM 1 FROM adquisiciones.suppliers WHERE id=v_supplier_id AND company_id=p_company_id AND supplier_kind='REAL' AND is_active AND status='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Proveedor real inválido'; END IF;
  IF p_po_id IS NULL THEN
    INSERT INTO adquisiciones.purchase_orders (company_id,correlative,issue_date,required_date,supplier_id,warehouse_id,po_type,currency,payment_terms,requested_by,authorized_by,notes,source_type,net_total,discount_total,tax_total,exempt_total,grand_total,status,receipt_status,invoice_status,created_by,updated_by)
    VALUES (p_company_id,adquisiciones.generate_po_correlative(p_company_id),COALESCE(NULLIF(p_data->>'issue_date','')::date,CURRENT_DATE),NULLIF(p_data->>'required_date','')::date,v_supplier_id,NULLIF(p_data->>'warehouse_id','')::uuid,'PRODUCTOS',COALESCE(NULLIF(p_data->>'currency',''),'CLP'),NULLIF(p_data->>'payment_terms',''),p_user_id,NULLIF(p_data->>'authorized_by','')::uuid,NULLIF(p_data->>'notes',''),'MANUAL',0,0,0,0,0,'BORRADOR','PENDIENTE','PENDIENTE',p_user_id,p_user_id) RETURNING * INTO v_po;
    INSERT INTO adquisiciones.purchase_order_status_history (company_id,po_id,from_status,to_status,changed_by) VALUES (p_company_id,v_po.id,NULL,'BORRADOR',p_user_id);
  ELSE
    SELECT * INTO v_po FROM adquisiciones.purchase_orders WHERE id=p_po_id AND company_id=p_company_id FOR UPDATE;
    IF NOT FOUND OR v_po.status IS DISTINCT FROM 'BORRADOR' OR v_po.source_type IS DISTINCT FROM 'MANUAL' THEN RAISE EXCEPTION 'Solo se puede editar un borrador manual'; END IF;
    IF v_po.supplier_id IS DISTINCT FROM v_supplier_id THEN RAISE EXCEPTION 'No se permite cambiar el proveedor de un borrador guardado'; END IF;
    IF v_po.receipt_status IS DISTINCT FROM 'PENDIENTE' OR EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items WHERE po_id=v_po.id AND COALESCE(quantity_received,0)>0) THEN RAISE EXCEPTION 'El borrador tiene recepciones'; END IF;
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_data->'items') LOOP
    v_index := v_index + 1; v_type := v_item->>'item_type';
    v_item_id := NULLIF(v_item->>'item_id','')::uuid;
    v_product_id := NULLIF(v_item->>'product_id','')::uuid;
    v_is_new := v_item_id IS NULL;
    IF v_type IS NULL OR v_type NOT IN ('PRODUCT','SERVICE') THEN RAISE EXCEPTION 'Tipo inválido en línea %',v_index; END IF;
    IF NOT v_is_new THEN
      IF v_item_id=ANY(v_ids) THEN RAISE EXCEPTION 'Línea duplicada'; END IF;
      SELECT * INTO v_old FROM adquisiciones.purchase_order_items WHERE id=v_item_id AND po_id=v_po.id AND company_id=p_company_id FOR UPDATE;
      IF NOT FOUND OR v_old.item_type IS DISTINCT FROM v_type OR v_old.product_id IS DISTINCT FROM v_product_id THEN RAISE EXCEPTION 'Línea existente inválida'; END IF;
    END IF;
    v_line_warehouse := CASE WHEN v_item ? 'warehouse_id' THEN NULLIF(v_item->>'warehouse_id','')::uuid WHEN v_is_new THEN v_warehouse ELSE v_old.warehouse_id END;
    v_line_unit := CASE WHEN v_item ? 'unit' THEN NULLIF(v_item->>'unit','') WHEN v_is_new THEN NULL ELSE v_old.unit END;
    v_cost_center := CASE WHEN v_item ? 'cost_center' THEN NULLIF(v_item->>'cost_center','') WHEN v_is_new THEN NULL ELSE v_old.cost_center END;
    v_required_date := CASE WHEN v_item ? 'required_date' THEN NULLIF(v_item->>'required_date','')::date WHEN v_is_new THEN NULL ELSE v_old.required_date END;
    IF v_line_warehouse IS NOT NULL THEN
      PERFORM 1 FROM adquisiciones.warehouses WHERE id=v_line_warehouse AND company_id=p_company_id AND is_active AND status='ACTIVE' FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Bodega de línea inválida o inactiva'; END IF;
    END IF;
    v_qty := NULLIF(v_item->>'quantity','')::numeric;
    v_percent := COALESCE(NULLIF(v_item->>'discount_percent','')::numeric,0);
    v_fixed := COALESCE(NULLIF(v_item->>'discount_unit_amount','')::numeric,0);
    v_tax_rate := COALESCE(NULLIF(v_item->>'tax_rate','')::numeric,19);
    IF v_qty IS NULL OR v_qty::text IN ('NaN','Infinity','-Infinity') OR v_percent::text IN ('NaN','Infinity','-Infinity') OR v_fixed::text IN ('NaN','Infinity','-Infinity') OR v_tax_rate::text IN ('NaN','Infinity','-Infinity') OR v_qty <= 0 OR v_qty <> round(v_qty,4) OR v_qty >= 10000000000 OR v_percent < 0 OR v_percent > 100 OR v_percent <> round(v_percent,2) OR v_fixed < 0 OR v_fixed <> round(v_fixed,4) OR (v_percent>0 AND v_fixed>0) OR v_tax_rate < 0 OR v_tax_rate > 100 OR v_tax_rate <> round(v_tax_rate,2) THEN RAISE EXCEPTION 'Cantidad, descuento o IVA inválido en línea %',v_index; END IF;
    v_mapping := NULL; v_unit := NULL; v_factor := NULL; v_price := NULL;
    v_desc := NULLIF(btrim(v_item->>'product_description'),'');
    IF v_type='PRODUCT' THEN
      v_has_product := true;
      IF v_product_id IS NULL THEN RAISE EXCEPTION 'Producto requerido'; END IF;
      IF v_is_new THEN
        SELECT * INTO v_product FROM adquisiciones.products WHERE id=v_product_id AND company_id=p_company_id AND is_active FOR SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Producto inválido'; END IF;
        IF EXISTS (SELECT 1 FROM adquisiciones.product_supplier_mappings m LEFT JOIN adquisiciones.suppliers s ON s.id=m.supplier_id AND s.company_id=p_company_id WHERE m.company_id=p_company_id AND m.product_id=v_product_id AND m.is_active AND s.id IS NULL) THEN RAISE EXCEPTION 'Proveedor de mapeo inválido'; END IF;
        IF v_product.source='BSALE' THEN
          IF v_product.bsale_brand_id IS NULL THEN RAISE EXCEPTION 'Marca Bsale no resoluble'; END IF;
          SELECT count(*) INTO v_count FROM integraciones.bsale_brand_supplier_links WHERE company_id=p_company_id AND bsale_brand_id=v_product.bsale_brand_id;
          IF v_count<>1 OR NOT EXISTS (SELECT 1 FROM integraciones.bsale_brand_supplier_links WHERE company_id=p_company_id AND bsale_brand_id=v_product.bsale_brand_id AND supplier_id=v_supplier_id) THEN RAISE EXCEPTION 'Proveedor de marca Bsale ambiguo o contradictorio'; END IF;
          SELECT count(*),(array_agg(m.id))[1],(array_agg(m.purchase_unit))[1],(array_agg(m.purchase_unit_factor))[1]
          INTO v_count,v_mapping,v_unit,v_factor FROM adquisiciones.product_supplier_mappings m WHERE m.company_id=p_company_id AND m.product_id=v_product_id AND m.is_active;
          IF EXISTS (SELECT 1 FROM adquisiciones.product_supplier_mappings m LEFT JOIN adquisiciones.suppliers s ON s.id=m.supplier_id AND s.company_id=p_company_id WHERE m.company_id=p_company_id AND m.product_id=v_product_id AND m.is_active AND (s.id IS NULL OR (s.supplier_kind='REAL' AND s.id<>v_supplier_id))) THEN RAISE EXCEPTION 'Mapeo contradictorio'; END IF;
          IF v_count>1 THEN RAISE EXCEPTION 'Mapeo comercial ambiguo'; END IF;
        ELSE
          SELECT count(*),(array_agg(m.id))[1],(array_agg(m.purchase_unit))[1],(array_agg(m.purchase_unit_factor))[1]
          INTO v_count,v_mapping,v_unit,v_factor FROM adquisiciones.product_supplier_mappings m JOIN adquisiciones.suppliers s ON s.id=m.supplier_id AND s.company_id=p_company_id WHERE m.company_id=p_company_id AND m.product_id=v_product_id AND m.is_active AND (s.id=v_supplier_id OR (s.supplier_kind='BSALE_OPERATIVE' AND s.parent_supplier_id=v_supplier_id));
          IF v_count>1 THEN RAISE EXCEPTION 'Mapeo comercial ambiguo'; END IF;
        END IF;
        v_factor := COALESCE(v_factor,1);
        IF v_factor<1 OR (NULLIF(btrim(v_unit),'') IS NULL AND v_factor<>1) THEN RAISE EXCEPTION 'Configuración comercial inválida'; END IF;
        IF NOT (v_item ? 'purchase_unit_snapshot' AND v_item ? 'purchase_unit_factor_snapshot' AND v_item ? 'product_supplier_mapping_id') OR
          NULLIF(btrim(v_item->>'purchase_unit_snapshot'),'') IS DISTINCT FROM NULLIF(btrim(v_unit),'') OR
          NULLIF(v_item->>'purchase_unit_factor_snapshot','')::integer IS DISTINCT FROM v_factor OR
          NULLIF(v_item->>'product_supplier_mapping_id','')::uuid IS DISTINCT FROM v_mapping THEN
          RAISE EXCEPTION 'La configuración comercial cambió; vuelva a seleccionar el producto';
        END IF;
      ELSE
        v_mapping := v_old.product_supplier_mapping_id; v_unit := v_old.purchase_unit_snapshot; v_factor := v_old.purchase_unit_factor_snapshot;
      END IF;
      IF v_factor IS NOT NULL THEN
        IF v_factor>1 AND mod(v_qty,v_factor)<>0 THEN RAISE EXCEPTION 'Debe ser múltiplo de %',v_factor; END IF;
        v_price := NULLIF(v_item->>'commercial_unit_price','')::numeric;
        IF v_price IS NULL OR v_price::text IN ('NaN','Infinity','-Infinity') OR v_price<0 OR v_price<>round(v_price,4) OR v_price>=100000000000000 THEN RAISE EXCEPTION 'Precio comercial inválido'; END IF;
        v_unit_price := round(v_price/v_factor,4);
        v_base := v_qty*v_price/v_factor;
      ELSE
        v_unit_price := NULLIF(v_item->>'unit_price','')::numeric;
        v_base := v_qty*v_unit_price;
      END IF;
    ELSE
      v_has_service := true;
      IF v_product_id IS NOT NULL THEN RAISE EXCEPTION 'Servicio con producto inválido'; END IF;
      v_unit_price := NULLIF(v_item->>'unit_price','')::numeric;
      v_base := v_qty*v_unit_price;
    END IF;
    IF v_desc IS NULL OR v_unit_price IS NULL OR v_unit_price::text IN ('NaN','Infinity','-Infinity') OR v_unit_price<0 OR v_unit_price<>round(v_unit_price,4) OR v_unit_price>=10000000000 OR v_fixed>v_unit_price THEN RAISE EXCEPTION 'Descripción, precio o descuento inválido en línea %',v_index; END IF;
    -- Commercial drafts reconcile at line level: gross, discount and tax are
    -- rounded to cents before deriving net, line total and header totals.
    v_base := round(v_base,2);
    v_discount := round(CASE WHEN v_percent>0 THEN v_base*v_percent/100 ELSE v_qty*v_fixed END,2);
    IF v_discount>v_base THEN RAISE EXCEPTION 'Descuento supera el bruto'; END IF;
    v_tax := round((v_base-v_discount)*v_tax_rate/100,2);
    v_net := v_net+v_base-v_discount; v_discounts := v_discounts+v_discount; v_taxes := v_taxes+v_tax;
    IF v_is_new THEN
      INSERT INTO adquisiciones.purchase_order_items (company_id,po_id,line_number,item_type,product_id,product_description,unit,quantity,unit_price,discount_percent,discount_unit_amount,discount_amount,tax_rate,tax_amount,line_total,warehouse_id,cost_center,required_date,notes,quantity_received,created_by,updated_by,purchase_unit_snapshot,purchase_unit_factor_snapshot,product_supplier_mapping_id,commercial_unit_price_snapshot,commercial_gross_amount_snapshot)
      VALUES (p_company_id,v_po.id,v_index,v_type,v_product_id,v_desc,v_line_unit,v_qty,v_unit_price,v_percent,v_fixed,v_discount,v_tax_rate,v_tax,v_base-v_discount+v_tax,v_line_warehouse,v_cost_center,v_required_date,NULLIF(v_item->>'notes',''),0,p_user_id,p_user_id,v_unit,v_factor,v_mapping,v_price,v_base) RETURNING id INTO v_item_id;
    ELSE
      UPDATE adquisiciones.purchase_order_items SET line_number=v_index,product_description=v_desc,unit=v_line_unit,warehouse_id=v_line_warehouse,cost_center=v_cost_center,required_date=v_required_date,quantity=v_qty,unit_price=v_unit_price,discount_percent=v_percent,discount_unit_amount=v_fixed,discount_amount=v_discount,tax_rate=v_tax_rate,tax_amount=v_tax,line_total=v_base-v_discount+v_tax,notes=NULLIF(v_item->>'notes',''),commercial_unit_price_snapshot=v_price,commercial_gross_amount_snapshot=v_base,updated_by=p_user_id,updated_at=now() WHERE id=v_item_id AND po_id=v_po.id AND company_id=p_company_id;
    END IF;
    v_ids := array_append(v_ids,v_item_id);
  END LOOP;
  DELETE FROM adquisiciones.purchase_order_items WHERE po_id=v_po.id AND company_id=p_company_id AND NOT (id=ANY(v_ids));
  UPDATE adquisiciones.purchase_orders SET issue_date=COALESCE(NULLIF(p_data->>'issue_date','')::date,issue_date),required_date=NULLIF(p_data->>'required_date','')::date,warehouse_id=NULLIF(p_data->>'warehouse_id','')::uuid,currency=COALESCE(NULLIF(p_data->>'currency',''),'CLP'),payment_terms=NULLIF(p_data->>'payment_terms',''),authorized_by=NULLIF(p_data->>'authorized_by','')::uuid,notes=NULLIF(p_data->>'notes',''),po_type=CASE WHEN v_has_product AND v_has_service THEN 'MIXTA' WHEN v_has_service THEN 'SERVICIOS' ELSE 'PRODUCTOS' END,net_total=round(v_net,2),discount_total=round(v_discounts,2),tax_total=round(v_taxes,2),exempt_total=0,grand_total=round(v_net+v_taxes,2),updated_by=p_user_id,updated_at=now() WHERE id=v_po.id AND company_id=p_company_id;
  RETURN jsonb_build_object('success',true,'po_id',v_po.id,'status','BORRADOR','gross_total',round(v_net+v_discounts,2),'net_total',round(v_net,2),'discount_total',round(v_discounts,2),'tax_total',round(v_taxes,2),'grand_total',round(v_net+v_taxes,2));
END;
$$;
REVOKE ALL ON FUNCTION adquisiciones.save_commercial_purchase_draft(uuid,jsonb,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
