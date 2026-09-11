-- Mermas: validate current Bsale availability and cancel pending requests.

ALTER TABLE mermas.requests DROP CONSTRAINT IF EXISTS requests_status_check;
ALTER TABLE mermas.requests ADD CONSTRAINT requests_status_check CHECK (status IN ('PENDIENTE', 'CANCELADA'));
ALTER TABLE mermas.requests
  ADD COLUMN IF NOT EXISTS cancellation_reason text,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES portal.users(id),
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

INSERT INTO portal.permissions (code, name, description, module_id, is_active)
SELECT 'logistica.mermas.cancel', 'Cancelar solicitudes de Merma', 'Cancelar solicitudes de Merma mientras estén pendientes.', id, true
FROM portal.modules WHERE code = 'logistica'
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, module_id = EXCLUDED.module_id, is_active = true;

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM portal.roles r CROSS JOIN portal.permissions p
WHERE r.name IN ('SUPER_USUARIO', 'GERENCIA') AND p.code = 'logistica.mermas.cancel' AND p.is_active
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE OR REPLACE FUNCTION mermas.create_request(
    p_company_id uuid,
    p_user_id uuid,
    p_lines jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, integraciones, mermas
AS $$
DECLARE
    v_request_id uuid;
    v_code text;
    v_year integer := EXTRACT(YEAR FROM timezone('America/Santiago', now()))::integer;
    v_sequence bigint;
    v_line jsonb;
    v_variant record;
    v_quantity numeric;
    v_reason text;
    v_expiration date;
    v_line_count integer := 0;
    v_requested jsonb := '{}'::jsonb;
    v_stock_key text;
    v_requested_quantity numeric;
    v_stock_count integer;
    v_stock numeric;
BEGIN
    IF p_user_id IS NULL OR p_company_id IS NULL THEN RAISE EXCEPTION 'Solicitud inválida'; END IF;
    IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RAISE EXCEPTION 'Usuario inválido'; END IF;
    IF NOT core.has_company_access(p_user_id, p_company_id) THEN RAISE EXCEPTION 'El usuario no tiene acceso a la empresa activa'; END IF;
    IF NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.create') THEN RAISE EXCEPTION 'No autorizado para crear solicitudes de Merma'; END IF;
    IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN RAISE EXCEPTION 'La solicitud debe contener al menos una línea'; END IF;

    INSERT INTO mermas.request_correlatives(company_id, request_year, next_value)
    VALUES (p_company_id, v_year, 2)
    ON CONFLICT (company_id, request_year) DO UPDATE SET next_value = mermas.request_correlatives.next_value + 1
    RETURNING next_value - 1 INTO v_sequence;
    v_code := 'MER-' || v_year::text || '-' || lpad(v_sequence::text, 6, '0');

    INSERT INTO mermas.requests(company_id, request_code, status, created_by)
    VALUES (p_company_id, v_code, 'PENDIENTE', p_user_id) RETURNING id INTO v_request_id;

    FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
        SELECT bv.bsale_id, bv.code, bp.name, bv.description INTO v_variant
        FROM integraciones.bsale_variants bv
        JOIN integraciones.bsale_products bp ON bp.company_id = bv.company_id AND bp.bsale_id = bv.bsale_product_id
        WHERE bv.id = NULLIF(v_line->>'variant_id', '')::uuid AND bv.company_id = p_company_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Producto no encontrado en el catálogo Bsale de la empresa activa'; END IF;
        v_quantity := NULLIF(v_line->>'quantity', '')::numeric;
        v_reason := btrim(COALESCE(v_line->>'reason', ''));
        v_expiration := NULLIF(v_line->>'expiration_date', '')::date;
        IF v_quantity IS NULL OR v_quantity <= 0 THEN RAISE EXCEPTION 'La cantidad debe ser mayor que cero'; END IF;
        IF v_reason = '' THEN RAISE EXCEPTION 'El motivo es obligatorio'; END IF;
        IF v_expiration IS NULL THEN RAISE EXCEPTION 'La fecha de vencimiento es obligatoria'; END IF;
        v_stock_key := v_variant.bsale_id::text;
        v_requested := jsonb_set(v_requested, ARRAY[v_stock_key], to_jsonb(COALESCE((v_requested->>v_stock_key)::numeric, 0) + v_quantity), true);
    END LOOP;

    FOR v_stock_key, v_requested_quantity IN SELECT key, value::numeric FROM jsonb_each_text(v_requested) LOOP
        SELECT count(*)::integer, COALESCE(sum(quantity_available), 0)
        INTO v_stock_count, v_stock
        FROM integraciones.bsale_stock_current
        WHERE company_id = p_company_id AND variant_id = v_stock_key::integer
          AND quantity_available IS NOT NULL AND quantity_available >= 0;
        IF v_stock_count = 0 THEN RAISE EXCEPTION 'Sin información de stock Bsale para la variante %', v_stock_key; END IF;
        IF v_stock = 0 THEN RAISE EXCEPTION 'La variante % no tiene stock disponible en Bsale', v_stock_key; END IF;
        IF v_requested_quantity > v_stock THEN RAISE EXCEPTION 'La cantidad solicitada supera el stock disponible en Bsale (%) unidades', v_stock; END IF;
    END LOOP;

    FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
        SELECT bv.bsale_id, bv.code, bp.name, bv.description INTO v_variant
        FROM integraciones.bsale_variants bv
        JOIN integraciones.bsale_products bp ON bp.company_id = bv.company_id AND bp.bsale_id = bv.bsale_product_id
        WHERE bv.id = NULLIF(v_line->>'variant_id', '')::uuid AND bv.company_id = p_company_id;
        v_quantity := NULLIF(v_line->>'quantity', '')::numeric;
        INSERT INTO mermas.request_lines (request_id, company_id, bsale_variant_id, sku, product_name, variant_description, quantity, reason, expiration_date, lot, observation)
        VALUES (v_request_id, p_company_id, v_variant.bsale_id, COALESCE(v_variant.code, ''), COALESCE(v_variant.name, v_variant.code, 'Producto Bsale'), v_variant.description,
          v_quantity, btrim(v_line->>'reason'), NULLIF(v_line->>'expiration_date', '')::date, NULLIF(btrim(v_line->>'lot'), ''), NULLIF(btrim(v_line->>'observation'), ''));
        v_line_count := v_line_count + 1;
    END LOOP;

    INSERT INTO portal.audit_logs(table_name, record_id, action, new_data, performed_by)
    VALUES ('mermas.requests', v_request_id, 'CREATE', jsonb_build_object('request_code', v_code, 'company_id', p_company_id, 'status', 'PENDIENTE', 'line_count', v_line_count), p_user_id);
    RETURN jsonb_build_object('success', true, 'request_id', v_request_id, 'request_code', v_code, 'status', 'PENDIENTE');
END;
$$;

CREATE OR REPLACE FUNCTION mermas.cancel_request(p_request_id uuid, p_company_id uuid, p_user_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, mermas
AS $$
DECLARE v_request mermas.requests%ROWTYPE;
BEGIN
    IF p_user_id IS NULL OR auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RAISE EXCEPTION 'Usuario inválido'; END IF;
    IF NOT core.has_company_access(p_user_id, p_company_id) THEN RAISE EXCEPTION 'El usuario no tiene acceso a la empresa activa'; END IF;
    IF NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.cancel') THEN RAISE EXCEPTION 'No autorizado para cancelar solicitudes de Merma'; END IF;
    IF btrim(COALESCE(p_reason, '')) = '' THEN RAISE EXCEPTION 'El motivo de cancelación es obligatorio'; END IF;
    SELECT * INTO v_request FROM mermas.requests WHERE id = p_request_id AND company_id = p_company_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Solicitud no encontrada'; END IF;
    IF v_request.status <> 'PENDIENTE' THEN RAISE EXCEPTION 'Solo se pueden cancelar solicitudes PENDIENTE'; END IF;
    UPDATE mermas.requests SET status = 'CANCELADA', cancellation_reason = btrim(p_reason), cancelled_by = p_user_id, cancelled_at = now(), updated_at = now() WHERE id = p_request_id;
    INSERT INTO portal.audit_logs(table_name, record_id, action, old_data, new_data, performed_by)
    VALUES ('mermas.requests', p_request_id, 'CANCEL', jsonb_build_object('status','PENDIENTE'), jsonb_build_object('status','CANCELADA','reason',btrim(p_reason)), p_user_id);
    RETURN jsonb_build_object('success', true, 'status', 'CANCELADA');
END;
$$;

REVOKE ALL ON FUNCTION mermas.cancel_request(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.cancel_request(uuid, uuid, uuid, text) TO service_role;
