-- Add fixed per-unit discounts to purchase-order lines.
-- discount_amount remains the derived total discount for the complete line.

ALTER TABLE adquisiciones.purchase_order_items
  ADD COLUMN IF NOT EXISTS discount_unit_amount numeric(14,4) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_order_items_discount_unit_amount_nonnegative' AND conrelid = 'adquisiciones.purchase_order_items'::regclass) THEN
    ALTER TABLE adquisiciones.purchase_order_items ADD CONSTRAINT purchase_order_items_discount_unit_amount_nonnegative CHECK (discount_unit_amount >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_order_items_discount_methods_exclusive' AND conrelid = 'adquisiciones.purchase_order_items'::regclass) THEN
    ALTER TABLE adquisiciones.purchase_order_items ADD CONSTRAINT purchase_order_items_discount_methods_exclusive CHECK (NOT (COALESCE(discount_percent, 0) > 0 AND discount_unit_amount > 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_order_items_discount_unit_amount_lte_price' AND conrelid = 'adquisiciones.purchase_order_items'::regclass) THEN
    ALTER TABLE adquisiciones.purchase_order_items ADD CONSTRAINT purchase_order_items_discount_unit_amount_lte_price CHECK (discount_unit_amount <= unit_price);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION adquisiciones.validate_purchase_order_item_shape()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_percent numeric := COALESCE(NEW.discount_percent, 0);
  v_unit numeric := COALESCE(NEW.discount_unit_amount, 0);
BEGIN
  IF NEW.item_type = 'SERVICE' THEN
    IF NEW.product_id IS NOT NULL THEN RAISE EXCEPTION 'Una línea SERVICE no puede tener product_id'; END IF;
    IF NULLIF(btrim(NEW.product_description), '') IS NULL THEN RAISE EXCEPTION 'La descripción es obligatoria en una línea SERVICE'; END IF;
  ELSIF NEW.item_type = 'PRODUCT' AND NEW.product_id IS NULL THEN
    RAISE EXCEPTION 'Una línea PRODUCT requiere product_id';
  END IF;
  IF NEW.quantity <= 0 THEN RAISE EXCEPTION 'La cantidad debe ser mayor que cero'; END IF;
  IF v_percent < 0 OR v_percent > 100 THEN RAISE EXCEPTION 'El descuento debe estar entre 0 y 100'; END IF;
  IF NEW.tax_rate < 0 OR NEW.tax_rate > 100 THEN RAISE EXCEPTION 'El IVA debe estar entre 0 y 100'; END IF;
  IF v_unit < 0 THEN RAISE EXCEPTION 'El descuento unitario no puede ser negativo'; END IF;
  IF v_percent > 0 AND v_unit > 0 THEN RAISE EXCEPTION 'No se pueden combinar descuento porcentual y descuento unitario'; END IF;
  IF v_unit > COALESCE(NEW.unit_price, 0) THEN RAISE EXCEPTION 'El descuento unitario no puede superar el precio unitario'; END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.create_purchase_order(jsonb, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION adquisiciones.create_purchase_order(jsonb, uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION adquisiciones.get_purchase_order_detail(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION adquisiciones.get_purchase_order_detail(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION adquisiciones.update_purchase_order_supplier_review(uuid, jsonb, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION adquisiciones.update_purchase_order_supplier_review(uuid, jsonb, uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION adquisiciones.get_purchase_order_supplier_review_comparison(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION adquisiciones.get_purchase_order_supplier_review_comparison(uuid, uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION adquisiciones.validate_purchase_order_discounts_on_confirm()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'CONFIRMADA' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) AND EXISTS (
    SELECT 1 FROM adquisiciones.purchase_order_items i
    WHERE i.po_id = NEW.id
      AND (COALESCE(i.discount_unit_amount, 0) < 0 OR COALESCE(i.discount_unit_amount, 0) > i.unit_price OR (COALESCE(i.discount_percent, 0) > 0 AND COALESCE(i.discount_unit_amount, 0) > 0))
  ) THEN
    RAISE EXCEPTION 'No se puede confirmar la OC: descuentos tienen valores inválidos';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_purchase_order_discounts_on_confirm ON adquisiciones.purchase_orders;
CREATE TRIGGER trg_validate_purchase_order_discounts_on_confirm
  BEFORE INSERT OR UPDATE OF status ON adquisiciones.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION adquisiciones.validate_purchase_order_discounts_on_confirm();

CREATE OR REPLACE FUNCTION adquisiciones.get_purchase_order_detail(p_po_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_po jsonb; v_items jsonb;
BEGIN
  SELECT jsonb_build_object('id', po.id, 'correlative', po.correlative, 'issue_date', po.issue_date, 'required_date', po.required_date, 'supplier_id', po.supplier_id, 'supplier_name', s.business_name, 'supplier_rut', s.rut, 'supplier_contact', s.contact_name, 'supplier_email', s.contact_email, 'supplier_phone', s.contact_phone, 'supplier_address', s.address, 'warehouse_id', po.warehouse_id, 'warehouse_name', w.name, 'po_type', po.po_type, 'currency', po.currency, 'payment_terms', po.payment_terms, 'requested_by', po.requested_by, 'requester_name', u.nombre || ' ' || u.apellido, 'requester_email', u.email, 'authorized_by', po.authorized_by, 'authorized_name', ap.full_name, 'authorized_position', ap.position, 'notes', po.notes, 'source_type', po.source_type, 'net_total', po.net_total, 'discount_total', po.discount_total, 'tax_total', po.tax_total, 'exempt_total', po.exempt_total, 'grand_total', po.grand_total, 'status', po.status, 'receipt_status', po.receipt_status, 'invoice_status', po.invoice_status, 'cancel_reason', po.cancel_reason, 'cancelled_at', po.cancelled_at, 'email_sent_at', po.email_sent_at, 'supplier_email_snapshot', po.supplier_email_snapshot, 'created_at', po.created_at, 'updated_at', po.updated_at, 'company_name', c.business_name, 'company_rut', c.rut, 'company_logo_url', c.logo_url, 'company_phone', c.phone, 'company_email', c.email, 'company_address', c.address, 'company_giro', c.giro, 'company_region', c.region, 'company_comuna', c.comuna, 'company_city', c.city, 'company_purchase_terms', c.purchase_terms, 'company_document_footer', c.document_footer) INTO v_po
  FROM adquisiciones.purchase_orders po LEFT JOIN core.companies c ON c.id = po.company_id LEFT JOIN adquisiciones.suppliers s ON s.id = po.supplier_id LEFT JOIN adquisiciones.warehouses w ON w.id = po.warehouse_id LEFT JOIN portal.users u ON u.id = po.requested_by LEFT JOIN adquisiciones.authorized_personnel ap ON ap.id = po.authorized_by WHERE po.id = p_po_id;
  SELECT jsonb_agg(jsonb_build_object('id', i.id, 'line_number', i.line_number, 'item_type', i.item_type, 'product_id', i.product_id, 'product_description', i.product_description, 'unit', i.unit, 'quantity', i.quantity, 'unit_price', i.unit_price, 'discount_percent', i.discount_percent, 'discount_unit_amount', COALESCE(i.discount_unit_amount, 0), 'discount_amount', i.discount_amount, 'tax_rate', i.tax_rate, 'tax_amount', i.tax_amount, 'line_total', i.line_total, 'warehouse_id', i.warehouse_id, 'warehouse_name', iw.name, 'cost_center', i.cost_center, 'required_date', i.required_date, 'notes', i.notes, 'quantity_received', i.quantity_received, 'quantity_pending', i.quantity_pending, 'lot_number', i.lot_number, 'expiration_date', i.expiration_date) ORDER BY i.line_number) INTO v_items FROM adquisiciones.purchase_order_items i LEFT JOIN adquisiciones.warehouses iw ON iw.id = i.warehouse_id WHERE i.po_id = p_po_id AND i.is_active = true;
  RETURN jsonb_build_object('po', v_po, 'items', COALESCE(v_items, '[]'::jsonb));
END;
$$;

-- Preserve the new source value even when legacy snapshot RPCs create the JSON.
CREATE OR REPLACE FUNCTION adquisiciones.enrich_purchase_order_snapshot_discount_unit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_set(item, '{discount_unit_amount}', to_jsonb(COALESCE(i.discount_unit_amount, 0)), true) ORDER BY COALESCE((item->>'line_number')::integer, 2147483647)), '[]'::jsonb)
  INTO NEW.items_snapshot
  FROM jsonb_array_elements(COALESCE(NEW.items_snapshot, '[]'::jsonb)) item
  LEFT JOIN adquisiciones.purchase_order_items i ON i.id = NULLIF(item->>'item_id', '')::uuid AND i.po_id = NEW.po_id AND i.company_id = NEW.company_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enrich_purchase_order_snapshot_discount_unit ON adquisiciones.purchase_order_snapshots;
CREATE TRIGGER trg_enrich_purchase_order_snapshot_discount_unit
  BEFORE INSERT ON adquisiciones.purchase_order_snapshots
  FOR EACH ROW EXECUTE FUNCTION adquisiciones.enrich_purchase_order_snapshot_discount_unit();

CREATE OR REPLACE FUNCTION adquisiciones.get_purchase_order_supplier_review_comparison(p_po_id uuid, p_user_id uuid, p_company_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_po adquisiciones.purchase_orders%ROWTYPE; v_snapshot adquisiciones.purchase_order_snapshots%ROWTYPE; v_original jsonb; v_current jsonb; v_comparison jsonb := '[]'; v_current_items jsonb := '[]'; v_original_ids uuid[] := ARRAY[]::uuid[]; v_item_id uuid; v_field text; v_changed_fields jsonb; v_changed boolean; v_original_total numeric; v_current_total numeric; v_unchanged integer := 0; v_modified integer := 0; v_removed integer := 0; v_added integer := 0; v_admin boolean; v_supplier text; v_rut text; v_warehouse text;
  v_fields constant text[] := ARRAY['item_type','product_id','product_description','unit','quantity','unit_price','discount_percent','discount_unit_amount','tax_rate','notes']; v_field_changed boolean;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM p_user_id THEN RAISE EXCEPTION 'El usuario de la sesión no coincide con p_user_id'; END IF;
  v_admin := portal.user_has_permission(p_user_id, 'system.admin');
  IF NOT (v_admin OR core.has_company_access(p_user_id, p_company_id)) THEN RAISE EXCEPTION 'El usuario no tiene acceso a la empresa'; END IF;
  IF NOT (v_admin OR portal.user_has_permission(p_user_id, 'adquisiciones.po.view')) THEN RAISE EXCEPTION 'Permisos insuficientes para consultar la comparación de la orden de compra'; END IF;
  SELECT * INTO v_po FROM adquisiciones.purchase_orders WHERE id = p_po_id AND company_id = p_company_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'La OC no existe o no pertenece a la empresa'; END IF;
  SELECT * INTO v_snapshot FROM adquisiciones.purchase_order_snapshots WHERE po_id = p_po_id AND company_id = p_company_id AND snapshot_type = 'ORIGINAL_SENT';
  IF NOT FOUND THEN RAISE EXCEPTION 'La OC no tiene snapshot ORIGINAL_SENT'; END IF;
  SELECT COALESCE(NULLIF(s.business_name, ''), NULLIF(s.fantasy_name, '')), s.rut INTO v_supplier, v_rut FROM adquisiciones.suppliers s WHERE s.id = v_po.supplier_id AND s.company_id = p_company_id;
  SELECT w.name INTO v_warehouse FROM adquisiciones.warehouses w WHERE w.id = v_po.warehouse_id AND w.company_id = p_company_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('item_id', i.id, 'line_number', i.line_number, 'item_type', i.item_type, 'product_id', i.product_id, 'sku', CASE WHEN i.item_type = 'SERVICE' THEN NULL ELSE pr.sku END, 'product_description', i.product_description, 'unit', i.unit, 'quantity', i.quantity, 'unit_price', i.unit_price, 'discount_percent', i.discount_percent, 'discount_unit_amount', COALESCE(i.discount_unit_amount, 0), 'discount_amount', i.discount_amount, 'tax_rate', i.tax_rate, 'tax_amount', i.tax_amount, 'line_total', i.line_total, 'notes', i.notes) ORDER BY i.line_number), '[]') INTO v_current_items FROM adquisiciones.purchase_order_items i LEFT JOIN adquisiciones.products pr ON pr.id = i.product_id AND pr.company_id = p_company_id WHERE i.po_id = p_po_id AND i.company_id = p_company_id;
  FOR v_original IN SELECT value FROM jsonb_array_elements(v_snapshot.items_snapshot) ORDER BY COALESCE((value->>'line_number')::integer, 2147483647) LOOP
    v_item_id := NULLIF(v_original->>'item_id', '')::uuid; v_original_ids := array_append(v_original_ids, v_item_id);
    SELECT jsonb_build_object('item_id', i.id, 'line_number', i.line_number, 'item_type', i.item_type, 'product_id', i.product_id, 'sku', CASE WHEN i.item_type = 'SERVICE' THEN NULL ELSE pr.sku END, 'product_description', i.product_description, 'unit', i.unit, 'quantity', i.quantity, 'unit_price', i.unit_price, 'discount_percent', i.discount_percent, 'discount_unit_amount', COALESCE(i.discount_unit_amount, 0), 'discount_amount', i.discount_amount, 'tax_rate', i.tax_rate, 'tax_amount', i.tax_amount, 'line_total', i.line_total, 'notes', i.notes) INTO v_current FROM adquisiciones.purchase_order_items i LEFT JOIN adquisiciones.products pr ON pr.id = i.product_id AND pr.company_id = p_company_id WHERE i.id = v_item_id AND i.po_id = p_po_id AND i.company_id = p_company_id;
    IF v_current IS NULL THEN
      v_removed := v_removed + 1; v_comparison := v_comparison || jsonb_build_array(jsonb_build_object('item_id', v_item_id, 'comparison_status', 'ELIMINADA', 'original_item', v_original, 'current_item', NULL, 'changed_fields', '[]')); CONTINUE;
    END IF;
    v_changed := false; v_changed_fields := '[]';
    FOREACH v_field IN ARRAY v_fields LOOP
      v_field_changed := false;
      IF v_field = 'discount_unit_amount' THEN
        IF COALESCE(NULLIF(v_original->>v_field, '')::numeric, 0) IS DISTINCT FROM COALESCE(NULLIF(v_current->>v_field, '')::numeric, 0) THEN v_changed := true; v_field_changed := true; END IF;
      ELSIF v_field IN ('quantity','unit_price','discount_percent','tax_rate') THEN
        IF NULLIF(v_original->>v_field, '')::numeric IS DISTINCT FROM NULLIF(v_current->>v_field, '')::numeric THEN v_changed := true; v_field_changed := true; END IF;
      ELSIF NULLIF(v_original->>v_field, '') IS DISTINCT FROM NULLIF(v_current->>v_field, '') THEN v_changed := true; v_field_changed := true;
      END IF;
      IF v_field_changed THEN v_changed_fields := v_changed_fields || jsonb_build_array(jsonb_build_object('field', v_field, 'original', v_original->v_field, 'current', v_current->v_field)); END IF;
    END LOOP;
    IF v_changed THEN v_modified := v_modified + 1; v_comparison := v_comparison || jsonb_build_array(jsonb_build_object('item_id', v_item_id, 'comparison_status', 'MODIFICADA', 'original_item', v_original, 'current_item', v_current, 'changed_fields', v_changed_fields)); ELSE v_unchanged := v_unchanged + 1; v_comparison := v_comparison || jsonb_build_array(jsonb_build_object('item_id', v_item_id, 'comparison_status', 'SIN_CAMBIOS', 'original_item', v_original, 'current_item', v_current, 'changed_fields', '[]')); END IF;
  END LOOP;
  FOR v_current IN SELECT value FROM jsonb_array_elements(v_current_items) ORDER BY COALESCE((value->>'line_number')::integer, 2147483647) LOOP
    v_item_id := (v_current->>'item_id')::uuid;
    IF NOT (v_item_id = ANY(v_original_ids)) THEN v_added := v_added + 1; v_comparison := v_comparison || jsonb_build_array(jsonb_build_object('item_id', v_item_id, 'comparison_status', 'AGREGADA', 'original_item', NULL, 'current_item', v_current, 'changed_fields', '[]')); END IF;
  END LOOP;
  v_original_total := NULLIF(v_snapshot.header_snapshot->>'grand_total', '')::numeric; v_current_total := v_po.grand_total;
  RETURN jsonb_build_object('success', true, 'po', jsonb_build_object('id', v_po.id, 'correlative', v_po.correlative, 'status', v_po.status, 'supplier_id', v_po.supplier_id, 'supplier_name', v_supplier, 'supplier_rut', v_rut, 'warehouse_id', v_po.warehouse_id, 'warehouse_name', v_warehouse, 'currency', v_po.currency, 'issue_date', v_po.issue_date, 'required_date', v_po.required_date, 'payment_terms', v_po.payment_terms, 'net_total', v_po.net_total, 'discount_total', v_po.discount_total, 'tax_total', v_po.tax_total, 'grand_total', v_po.grand_total), 'original', jsonb_build_object('snapshot_id', v_snapshot.id, 'created_at', v_snapshot.created_at, 'header', v_snapshot.header_snapshot, 'items', v_snapshot.items_snapshot), 'current', jsonb_build_object('items', v_current_items), 'comparison', v_comparison, 'summary', jsonb_build_object('total_lines', v_unchanged + v_modified + v_removed + v_added, 'unchanged_count', v_unchanged, 'modified_count', v_modified, 'removed_count', v_removed, 'added_count', v_added, 'original_grand_total', v_original_total, 'current_grand_total', v_current_total, 'total_difference', v_current_total - v_original_total));
END;
$$;

-- Effective supplier-review RPC (including service lines and restoration).
CREATE OR REPLACE FUNCTION adquisiciones.update_purchase_order_supplier_review(p_po_id uuid, p_data jsonb, p_user_id uuid, p_company_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_po adquisiciones.purchase_orders%ROWTYPE; v_item jsonb; v_original jsonb; v_current adquisiciones.purchase_order_items%ROWTYPE; v_product adquisiciones.products%ROWTYPE;
  v_item_id uuid; v_product_id uuid; v_type text; v_description text; v_quantity numeric; v_price numeric; v_percent numeric; v_unit_discount numeric; v_tax_rate numeric; v_notes text;
  v_base numeric; v_discount numeric; v_tax numeric; v_total numeric; v_line integer := 0; v_original_count integer; v_retained uuid[] := ARRAY[]::uuid[];
  v_has_product boolean := false; v_has_service boolean := false; v_net numeric := 0; v_discounts numeric := 0; v_taxes numeric := 0; v_count integer := 0; v_admin boolean; v_restore boolean;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM p_user_id THEN RAISE EXCEPTION 'El usuario de la sesión no coincide con p_user_id'; END IF;
  v_admin := portal.user_has_permission(p_user_id, 'system.admin');
  IF NOT (v_admin OR core.has_company_access(p_user_id, p_company_id)) THEN RAISE EXCEPTION 'El usuario no tiene acceso a la empresa'; END IF;
  IF NOT (v_admin OR portal.user_has_permission(p_user_id, 'adquisiciones.po.update')) THEN RAISE EXCEPTION 'Permisos insuficientes para revisar la orden de compra'; END IF;
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' OR COALESCE(jsonb_typeof(p_data->'items'), '') <> 'array' OR COALESCE(jsonb_array_length(p_data->'items'), 0) = 0 THEN RAISE EXCEPTION 'La revisión debe contener al menos una línea'; END IF;
  SELECT * INTO v_po FROM adquisiciones.purchase_orders WHERE id = p_po_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'La OC no existe o no pertenece a la empresa'; END IF;
  IF v_po.status <> 'ENVIADA_PROVEEDOR' THEN RAISE EXCEPTION 'Solo se puede revisar una OC ENVIADA_PROVEEDOR'; END IF;
  IF v_po.receipt_status IS DISTINCT FROM 'PENDIENTE' THEN RAISE EXCEPTION 'No se puede revisar una OC con recepción iniciada'; END IF;
  IF EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items WHERE po_id = p_po_id AND company_id = p_company_id AND COALESCE(quantity_received, 0) > 0) THEN RAISE EXCEPTION 'No se puede revisar una OC con cantidades recibidas'; END IF;
  IF NOT EXISTS (SELECT 1 FROM adquisiciones.purchase_order_snapshots WHERE po_id = p_po_id AND company_id = p_company_id AND snapshot_type = 'ORIGINAL_SENT') THEN RAISE EXCEPTION 'La OC no tiene snapshot ORIGINAL_SENT'; END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_data->'items') LOOP
    v_line := v_line + 1; v_count := v_count + 1; v_type := v_item->>'item_type'; v_item_id := NULLIF(v_item->>'item_id', '')::uuid; v_product_id := NULLIF(v_item->>'product_id', '')::uuid; v_quantity := (v_item->>'quantity')::numeric; v_price := (v_item->>'unit_price')::numeric;
    IF v_type NOT IN ('PRODUCT', 'SERVICE') THEN RAISE EXCEPTION 'Tipo de línea inválido en la posición %', v_line; END IF;
    IF v_item->>'quantity' IS NULL OR v_item->>'unit_price' IS NULL THEN RAISE EXCEPTION 'Cantidad y precio unitario son obligatorios en la línea %', v_line; END IF;
    IF v_quantity <= 0 THEN RAISE EXCEPTION 'La cantidad debe ser mayor que cero en la línea %', v_line; END IF;
    IF v_price < 0 THEN RAISE EXCEPTION 'El precio unitario no puede ser negativo en la línea %', v_line; END IF;
    v_restore := false; v_original := NULL;
    IF v_item_id IS NULL THEN
      IF v_type = 'PRODUCT' THEN
        IF v_product_id IS NULL THEN RAISE EXCEPTION 'Las líneas PRODUCT nuevas requieren un producto existente'; END IF;
        SELECT * INTO v_product FROM adquisiciones.products WHERE id = v_product_id AND company_id = p_company_id AND is_active = true;
        IF NOT FOUND THEN RAISE EXCEPTION 'El producto nuevo no existe o no está activo en la empresa'; END IF;
        v_description := v_product.description;
      ELSE
        IF v_product_id IS NOT NULL THEN RAISE EXCEPTION 'Una línea SERVICE no puede tener product_id'; END IF;
        v_description := NULLIF(btrim(v_item->>'product_description'), '');
        IF v_description IS NULL THEN RAISE EXCEPTION 'La descripción es obligatoria en la línea SERVICE %', v_line; END IF;
      END IF;
      v_percent := COALESCE((v_item->>'discount_percent')::numeric, 0); v_unit_discount := COALESCE((v_item->>'discount_unit_amount')::numeric, 0); v_tax_rate := COALESCE((v_item->>'tax_rate')::numeric, 19); v_notes := CASE WHEN v_item ? 'notes' THEN v_item->>'notes' ELSE NULL END;
    ELSE
      SELECT * INTO v_current FROM adquisiciones.purchase_order_items WHERE id = v_item_id AND po_id = p_po_id AND company_id = p_company_id FOR UPDATE;
      IF NOT FOUND THEN
        SELECT count(*), (array_agg(item))[1] INTO v_original_count, v_original FROM adquisiciones.purchase_order_snapshots s, jsonb_array_elements(s.items_snapshot) item WHERE s.po_id = p_po_id AND s.company_id = p_company_id AND s.snapshot_type = 'ORIGINAL_SENT' AND item->>'item_id' = v_item_id::text;
        IF v_original_count <> 1 THEN RAISE EXCEPTION 'El item_id no pertenece a la OC ni a su snapshot ORIGINAL_SENT'; END IF;
        IF v_type IS DISTINCT FROM v_original->>'item_type' OR v_product_id IS DISTINCT FROM NULLIF(v_original->>'product_id', '')::uuid THEN RAISE EXCEPTION 'No se permite cambiar el tipo o producto de una línea restaurada'; END IF;
        v_restore := true;
      ELSE
        IF v_item_id = ANY(v_retained) THEN RAISE EXCEPTION 'Una línea existente aparece más de una vez en el payload'; END IF;
        IF v_type <> v_current.item_type OR v_product_id IS DISTINCT FROM v_current.product_id THEN RAISE EXCEPTION 'No se permite cambiar el tipo o producto de una línea existente'; END IF;
        IF v_type = 'SERVICE' AND v_product_id IS NOT NULL THEN RAISE EXCEPTION 'Una línea SERVICE no puede tener product_id'; END IF;
      END IF;
      v_percent := COALESCE((v_item->>'discount_percent')::numeric, CASE WHEN v_restore THEN 0 ELSE v_current.discount_percent END, 0);
      v_unit_discount := COALESCE((v_item->>'discount_unit_amount')::numeric, CASE WHEN v_restore THEN COALESCE(NULLIF(v_original->>'discount_unit_amount', '')::numeric, 0) ELSE v_current.discount_unit_amount END, 0);
      v_tax_rate := COALESCE((v_item->>'tax_rate')::numeric, CASE WHEN v_restore THEN 19 ELSE v_current.tax_rate END, 19);
      v_notes := CASE WHEN v_item ? 'notes' THEN v_item->>'notes' WHEN v_restore THEN NULL ELSE v_current.notes END;
      v_description := CASE WHEN v_restore THEN v_original->>'product_description' ELSE v_current.product_description END;
    END IF;
    IF v_percent < 0 OR v_percent > 100 THEN RAISE EXCEPTION 'El descuento debe estar entre 0 y 100 en la línea %', v_line; END IF;
    IF v_unit_discount < 0 THEN RAISE EXCEPTION 'El descuento unitario no puede ser negativo en la línea %', v_line; END IF;
    IF v_percent > 0 AND v_unit_discount > 0 THEN RAISE EXCEPTION 'No se pueden combinar descuento porcentual y descuento unitario en la línea %', v_line; END IF;
    IF v_unit_discount > v_price THEN RAISE EXCEPTION 'El descuento unitario no puede superar el precio unitario en la línea %', v_line; END IF;
    IF v_tax_rate < 0 OR v_tax_rate > 100 THEN RAISE EXCEPTION 'El IVA debe estar entre 0 y 100 en la línea %', v_line; END IF;
    v_base := v_quantity * v_price; v_discount := CASE WHEN v_percent > 0 THEN v_base * v_percent / 100 ELSE v_quantity * v_unit_discount END; v_tax := (v_base - v_discount) * v_tax_rate / 100; v_total := v_base - v_discount + v_tax;
    v_net := v_net + v_base - v_discount; v_discounts := v_discounts + v_discount; v_taxes := v_taxes + v_tax;
    IF v_type = 'PRODUCT' THEN v_has_product := true; ELSE v_has_service := true; END IF;
    IF v_item_id IS NULL THEN
      INSERT INTO adquisiciones.purchase_order_items (company_id, po_id, line_number, item_type, product_id, product_description, unit, quantity, unit_price, discount_percent, discount_unit_amount, discount_amount, tax_rate, tax_amount, line_total, warehouse_id, required_date, notes, quantity_received, created_by, updated_by) VALUES (p_company_id, p_po_id, v_line, v_type, v_product_id, v_description, CASE WHEN v_type = 'PRODUCT' THEN v_product.unit_of_measure ELSE NULL END, v_quantity, v_price, v_percent, v_unit_discount, v_discount, v_tax_rate, v_tax, v_total, v_po.warehouse_id, v_po.required_date, v_notes, 0, p_user_id, p_user_id) RETURNING id INTO v_item_id;
    ELSIF v_restore THEN
      INSERT INTO adquisiciones.purchase_order_items (id, company_id, po_id, line_number, item_type, product_id, product_description, unit, quantity, unit_price, discount_percent, discount_unit_amount, discount_amount, tax_rate, tax_amount, line_total, warehouse_id, cost_center, required_date, notes, quantity_received, created_by, updated_by) VALUES (v_item_id, p_company_id, p_po_id, v_line, v_original->>'item_type', NULLIF(v_original->>'product_id', '')::uuid, v_description, v_original->>'unit', v_quantity, v_price, v_percent, v_unit_discount, v_discount, v_tax_rate, v_tax, v_total, NULLIF(v_original->>'warehouse_id', '')::uuid, v_original->>'cost_center', NULLIF(v_original->>'required_date', '')::date, v_notes, 0, p_user_id, p_user_id);
    ELSE
      UPDATE adquisiciones.purchase_order_items SET line_number = v_line, quantity = v_quantity, unit_price = v_price, discount_percent = v_percent, discount_unit_amount = v_unit_discount, discount_amount = v_discount, tax_rate = v_tax_rate, tax_amount = v_tax, line_total = v_total, notes = v_notes, updated_by = p_user_id, updated_at = now() WHERE id = v_item_id AND po_id = p_po_id AND company_id = p_company_id;
    END IF;
    v_retained := array_append(v_retained, v_item_id);
  END LOOP;
  DELETE FROM adquisiciones.purchase_order_items WHERE po_id = p_po_id AND company_id = p_company_id AND NOT (id = ANY(v_retained));
  UPDATE adquisiciones.purchase_orders SET po_type = CASE WHEN v_has_product AND v_has_service THEN 'MIXTA' WHEN v_has_service THEN 'SERVICIOS' ELSE 'PRODUCTOS' END, net_total = ROUND(v_net, 2), discount_total = ROUND(v_discounts, 2), tax_total = ROUND(v_taxes, 2), exempt_total = 0, grand_total = ROUND(v_net + v_taxes, 2), updated_by = p_user_id, updated_at = now() WHERE id = p_po_id AND company_id = p_company_id;
  RETURN jsonb_build_object('success', true, 'po_id', p_po_id, 'status', 'ENVIADA_PROVEEDOR', 'item_count', v_count, 'net_total', ROUND(v_net, 2), 'discount_total', ROUND(v_discounts, 2), 'tax_total', ROUND(v_taxes, 2), 'exempt_total', 0, 'grand_total', ROUND(v_net + v_taxes, 2));
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_purchase_order_item_shape ON adquisiciones.purchase_order_items;
CREATE TRIGGER trg_validate_purchase_order_item_shape
  BEFORE INSERT OR UPDATE OF item_type, product_id, product_description, quantity, unit_price, discount_percent, discount_unit_amount, tax_rate
  ON adquisiciones.purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION adquisiciones.validate_purchase_order_item_shape();

-- Effective create_purchase_order (previously defined by 20260901170000).
CREATE OR REPLACE FUNCTION adquisiciones.create_purchase_order(p_data jsonb, p_user_id uuid, p_company_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_po_id uuid; v_corr text; v_item jsonb; v_net numeric(14,2) := 0; v_disc numeric(14,2) := 0;
  v_tax numeric(14,2) := 0; v_exempt numeric(14,2) := 0; v_total numeric(14,2) := 0;
  v_base numeric; v_line_total numeric; v_line_disc numeric; v_line_tax numeric;
  v_percent numeric; v_unit_discount numeric; v_line_num integer := 0;
  v_po_type varchar(20); v_has_product boolean := false; v_has_service boolean := false;
  v_wh_id uuid; v_initial_status varchar(30); v_source_type text;
BEGIN
  IF NOT core.has_company_access(p_user_id, p_company_id) AND NOT portal.has_permission('system.admin') THEN RETURN jsonb_build_object('success', false, 'error', 'No tiene acceso a la empresa especificada'); END IF;
  v_initial_status := COALESCE(p_data->>'status', 'EMITIDA');
  IF v_initial_status NOT IN ('BORRADOR', 'EMITIDA') THEN RETURN jsonb_build_object('success', false, 'error', 'El estado inicial de la OC debe ser BORRADOR o EMITIDA.'); END IF;
  v_source_type := COALESCE(p_data->>'source_type', 'MANUAL');
  IF v_source_type NOT IN ('MANUAL', 'REPLENISHMENT') THEN RETURN jsonb_build_object('success', false, 'error', 'El origen de la OC debe ser MANUAL o REPLENISHMENT.'); END IF;
  v_corr := adquisiciones.generate_po_correlative(p_company_id);
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_data->'items') LOOP
    IF v_item->>'item_type' = 'PRODUCT' THEN v_has_product := true; ELSIF v_item->>'item_type' = 'SERVICE' THEN v_has_service := true; END IF;
  END LOOP;
  v_po_type := CASE WHEN v_has_product AND v_has_service THEN 'MIXTA' WHEN v_has_service THEN 'SERVICIOS' ELSE 'PRODUCTOS' END;
  v_wh_id := (p_data->>'warehouse_id')::uuid;
  INSERT INTO adquisiciones.purchase_orders (company_id, correlative, issue_date, required_date, supplier_id, warehouse_id, po_type, currency, payment_terms, requested_by, authorized_by, notes, source_type, net_total, discount_total, tax_total, exempt_total, grand_total, status, receipt_status, invoice_status, created_by, updated_by)
  VALUES (p_company_id, v_corr, CURRENT_DATE, (p_data->>'required_date')::date, (p_data->>'supplier_id')::uuid, v_wh_id, v_po_type, COALESCE(p_data->>'currency', 'CLP'), p_data->>'payment_terms', p_user_id, (p_data->>'authorized_by')::uuid, p_data->>'notes', v_source_type, 0, 0, 0, 0, 0, v_initial_status, 'PENDIENTE', 'PENDIENTE', p_user_id, p_user_id) RETURNING id INTO v_po_id;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_data->'items') LOOP
    v_line_num := v_line_num + 1;
    v_base := COALESCE((v_item->>'quantity')::numeric, 0) * COALESCE((v_item->>'unit_price')::numeric, 0);
    v_percent := COALESCE((v_item->>'discount_percent')::numeric, 0);
    v_unit_discount := COALESCE((v_item->>'discount_unit_amount')::numeric, 0);
    v_line_disc := CASE WHEN v_percent > 0 THEN v_base * v_percent / 100 ELSE COALESCE((v_item->>'quantity')::numeric, 0) * v_unit_discount END;
    v_line_tax := (v_base - v_line_disc) * COALESCE((v_item->>'tax_rate')::numeric, 19) / 100;
    v_line_total := v_base - v_line_disc + v_line_tax;
    INSERT INTO adquisiciones.purchase_order_items (company_id, po_id, line_number, item_type, product_id, product_description, unit, quantity, unit_price, discount_percent, discount_unit_amount, discount_amount, tax_rate, tax_amount, line_total, warehouse_id, cost_center, required_date, notes, created_by, updated_by)
    VALUES (p_company_id, v_po_id, v_line_num, v_item->>'item_type', (v_item->>'product_id')::uuid, v_item->>'product_description', v_item->>'unit', (v_item->>'quantity')::numeric, (v_item->>'unit_price')::numeric, v_percent, v_unit_discount, v_line_disc, COALESCE((v_item->>'tax_rate')::numeric, 19), v_line_tax, v_line_total, COALESCE((v_item->>'warehouse_id')::uuid, v_wh_id), v_item->>'cost_center', (v_item->>'required_date')::date, v_item->>'notes', p_user_id, p_user_id);
    v_net := v_net + v_base - v_line_disc; v_disc := v_disc + v_line_disc; v_tax := v_tax + v_line_tax;
  END LOOP;
  v_total := v_net + v_tax;
  UPDATE adquisiciones.purchase_orders SET net_total = ROUND(v_net, 2), discount_total = ROUND(v_disc, 2), tax_total = ROUND(v_tax, 2), exempt_total = ROUND(v_exempt, 2), grand_total = ROUND(v_total, 2), updated_by = p_user_id WHERE id = v_po_id;
  INSERT INTO adquisiciones.purchase_order_status_history (company_id, po_id, from_status, to_status, changed_by) VALUES (p_company_id, v_po_id, NULL, v_initial_status, p_user_id);
  RETURN jsonb_build_object('success', true, 'po_id', v_po_id, 'correlative', v_corr);
END;
$$;
