-- Evidencia fotográfica obligatoria por línea y autorización por entrada.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('mermas-evidence', 'mermas-evidence', false, 10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic']::text[])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE TABLE mermas.evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES mermas.requests(id) ON DELETE RESTRICT,
  request_line_id uuid NOT NULL REFERENCES mermas.request_lines(id) ON DELETE RESTRICT,
  storage_bucket text NOT NULL DEFAULT 'mermas-evidence',
  storage_path text NOT NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  file_size bigint NOT NULL CHECK (file_size > 0),
  uploaded_by uuid NOT NULL REFERENCES portal.users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, storage_path)
);

ALTER TABLE mermas.movements
  ADD COLUMN IF NOT EXISTS authorization_status text NOT NULL DEFAULT 'PENDIENTE_AUTORIZACION'
    CHECK (authorization_status IN ('PENDIENTE_AUTORIZACION', 'AUTORIZADA')),
  ADD COLUMN IF NOT EXISTS authorized_by uuid REFERENCES portal.users(id),
  ADD COLUMN IF NOT EXISTS authorized_at timestamptz;

CREATE INDEX mermas_evidence_line_idx ON mermas.evidence(company_id, request_line_id);
CREATE INDEX mermas_movements_authorization_idx ON mermas.movements(company_id, authorization_status);

ALTER TABLE mermas.evidence ENABLE ROW LEVEL SECURITY;
CREATE POLICY mermas_evidence_select ON mermas.evidence FOR SELECT TO authenticated
  USING (core.has_company_access(auth.uid(), company_id) AND portal.has_permission('logistica.mermas.view'));
GRANT SELECT ON mermas.evidence TO authenticated;
GRANT ALL ON mermas.evidence TO service_role;

DROP POLICY IF EXISTS mermas_evidence_storage_select ON storage.objects;
CREATE POLICY mermas_evidence_storage_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'mermas-evidence'
    AND core.has_company_access(auth.uid(), split_part(name, '/', 1)::uuid)
    AND portal.has_permission('logistica.mermas.view'));

DROP FUNCTION IF EXISTS mermas.create_request(uuid, uuid, jsonb);
CREATE OR REPLACE FUNCTION mermas.create_request(
  p_request_id uuid, p_company_id uuid, p_user_id uuid, p_lines jsonb, p_evidence jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, integraciones, mermas, storage
AS $$
DECLARE
  v_code text;
  v_year integer := EXTRACT(YEAR FROM timezone('America/Santiago', now()))::integer;
  v_sequence bigint;
  v_line jsonb;
  v_photo jsonb;
  v_variant record;
  v_quantity numeric;
  v_reason text;
  v_expiration date;
  v_line_count integer := 0;
  v_line_id uuid;
  v_requested jsonb := '{}'::jsonb;
  v_stock_key text;
  v_requested_quantity numeric;
  v_stock_count integer;
  v_stock numeric;
  v_photo_count integer;
BEGIN
  IF p_request_id IS NULL OR p_user_id IS NULL OR p_company_id IS NULL
    OR NOT core.has_company_access(p_user_id, p_company_id)
    OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.create') THEN
    RAISE EXCEPTION 'No autorizado para crear solicitudes de Merma';
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN RAISE EXCEPTION 'La solicitud debe contener al menos una línea'; END IF;
  IF jsonb_typeof(COALESCE(p_evidence, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'La evidencia es inválida'; END IF;

  INSERT INTO mermas.request_correlatives(company_id, request_year, next_value)
  VALUES (p_company_id, v_year, 2)
  ON CONFLICT (company_id, request_year) DO UPDATE SET next_value = mermas.request_correlatives.next_value + 1
  RETURNING next_value - 1 INTO v_sequence;
  v_code := 'MER-' || v_year::text || '-' || lpad(v_sequence::text, 6, '0');
  INSERT INTO mermas.requests(id, company_id, request_code, status, created_by)
  VALUES (p_request_id, p_company_id, v_code, 'PENDIENTE', p_user_id);

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    SELECT bv.bsale_id, bv.code, bp.name, bv.description INTO v_variant
    FROM integraciones.bsale_variants bv
    JOIN integraciones.bsale_products bp ON bp.company_id = bv.company_id AND bp.bsale_id = bv.bsale_product_id
    WHERE bv.id = NULLIF(v_line->>'variant_id', '')::uuid AND bv.company_id = p_company_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Producto no encontrado en el catálogo Bsale'; END IF;
    v_quantity := NULLIF(v_line->>'quantity', '')::numeric;
    v_reason := btrim(COALESCE(v_line->>'reason', ''));
    v_expiration := NULLIF(v_line->>'expiration_date', '')::date;
    IF v_quantity IS NULL OR v_quantity <= 0 OR v_reason = '' OR v_expiration IS NULL THEN RAISE EXCEPTION 'Completa producto, cantidad, motivo y vencimiento en todas las líneas'; END IF;
    v_stock_key := v_variant.bsale_id::text;
    v_requested := jsonb_set(v_requested, ARRAY[v_stock_key], to_jsonb(COALESCE((v_requested->>v_stock_key)::numeric, 0) + v_quantity), true);
    INSERT INTO mermas.request_lines(request_id, company_id, bsale_variant_id, sku, product_name, variant_description, quantity, reason, expiration_date, lot, observation)
    VALUES (p_request_id, p_company_id, v_variant.bsale_id, COALESCE(v_variant.code, ''), COALESCE(v_variant.name, v_variant.code, 'Producto Bsale'), v_variant.description, v_quantity, v_reason, v_expiration, NULLIF(btrim(v_line->>'lot'), ''), NULLIF(btrim(v_line->>'observation'), ''))
    RETURNING id INTO v_line_id;
    SELECT count(*)::integer INTO v_photo_count FROM jsonb_array_elements(COALESCE(p_evidence, '[]'::jsonb)) e WHERE (e->>'line_index')::integer = v_line_count;
    IF v_photo_count < 1 THEN RAISE EXCEPTION 'Debes adjuntar al menos una fotografía en la línea %', v_line_count + 1; END IF;
    FOR v_photo IN SELECT value FROM jsonb_array_elements(p_evidence) WHERE (value->>'line_index')::integer = v_line_count LOOP
      IF v_photo->>'storage_path' IS NULL OR split_part(v_photo->>'storage_path', '/', 1) <> p_company_id::text
        OR NOT EXISTS (SELECT 1 FROM storage.objects so WHERE so.bucket_id = 'mermas-evidence' AND so.name = v_photo->>'storage_path') THEN
        RAISE EXCEPTION 'La evidencia de la línea % no está disponible', v_line_count + 1;
      END IF;
      INSERT INTO mermas.evidence(company_id, request_id, request_line_id, storage_path, file_name, mime_type, file_size, uploaded_by)
      VALUES (p_company_id, p_request_id, v_line_id, v_photo->>'storage_path', COALESCE(v_photo->>'file_name', 'evidencia'), COALESCE(v_photo->>'mime_type', 'image/jpeg'), COALESCE((v_photo->>'file_size')::bigint, 1), p_user_id);
    END LOOP;
    v_line_count := v_line_count + 1;
  END LOOP;

  FOR v_stock_key, v_requested_quantity IN SELECT key, value::numeric FROM jsonb_each_text(v_requested) LOOP
    SELECT count(*)::integer, COALESCE(sum(quantity_available), 0) INTO v_stock_count, v_stock FROM integraciones.bsale_stock_current
      WHERE company_id = p_company_id AND variant_id = v_stock_key::integer AND quantity_available IS NOT NULL AND quantity_available >= 0;
    IF v_stock_count = 0 THEN RAISE EXCEPTION 'Sin información de stock Bsale para la variante %', v_stock_key; END IF;
    IF v_requested_quantity > v_stock THEN RAISE EXCEPTION 'La cantidad solicitada supera el stock disponible en Bsale (%) unidades', v_stock; END IF;
  END LOOP;
  INSERT INTO portal.audit_logs(table_name, record_id, action, new_data, performed_by)
  VALUES ('mermas.requests', p_request_id, 'CREATE', jsonb_build_object('request_code', v_code, 'line_count', v_line_count, 'evidence_required', true), p_user_id);
  RETURN jsonb_build_object('success', true, 'request_id', p_request_id, 'request_code', v_code, 'status', 'PENDIENTE');
END;
$$;
REVOKE ALL ON FUNCTION mermas.create_request(uuid, uuid, uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.create_request(uuid, uuid, uuid, jsonb, jsonb) TO service_role;

DROP VIEW IF EXISTS mermas.stock_current;
CREATE VIEW mermas.stock_registered AS
SELECT company_id, variant_id, expiration_date, lot, sum(quantity) AS registered,
  min(source) AS source, request_id, min(created_at) AS entered_at
FROM mermas.movements
GROUP BY company_id, variant_id, expiration_date, lot, request_id
HAVING sum(quantity) <> 0;
CREATE VIEW mermas.stock_current AS
SELECT company_id, variant_id, expiration_date, lot, sum(quantity) AS available,
  min(source) AS source, request_id, min(created_at) AS entered_at
FROM mermas.movements WHERE authorization_status = 'AUTORIZADA'
GROUP BY company_id, variant_id, expiration_date, lot, request_id
HAVING sum(quantity) <> 0;
GRANT SELECT ON mermas.stock_registered, mermas.stock_current TO authenticated, service_role;

CREATE OR REPLACE FUNCTION mermas.authorize_movement(p_movement_id uuid, p_company_id uuid, p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, mermas
AS $$
DECLARE v_movement mermas.movements%ROWTYPE; v_evidence_count integer;
BEGIN
  IF NOT core.has_company_access(p_user_id, p_company_id) OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.authorize') THEN RAISE EXCEPTION 'No autorizado para autorizar entradas de Mermas'; END IF;
  SELECT * INTO v_movement FROM mermas.movements WHERE id = p_movement_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Entrada no encontrada'; END IF;
  IF v_movement.authorization_status = 'AUTORIZADA' THEN RETURN jsonb_build_object('success', false, 'already_authorized', true); END IF;
  SELECT count(*)::integer INTO v_evidence_count FROM mermas.evidence e JOIN mermas.request_lines rl ON rl.id = e.request_line_id WHERE e.company_id = p_company_id AND (rl.id = v_movement.request_line_id OR (v_movement.request_line_id IS NULL AND e.request_id = v_movement.request_id));
  IF v_evidence_count < 1 THEN RAISE EXCEPTION 'La entrada no puede autorizarse sin evidencia fotográfica'; END IF;
  UPDATE mermas.movements SET authorization_status = 'AUTORIZADA', authorized_by = p_user_id, authorized_at = now() WHERE id = p_movement_id;
  INSERT INTO portal.audit_logs(table_name, record_id, action, old_data, new_data, performed_by)
  VALUES ('mermas.movements', p_movement_id, 'AUTHORIZE', jsonb_build_object('authorization_status', 'PENDIENTE_AUTORIZACION'), jsonb_build_object('authorization_status', 'AUTORIZADA'), p_user_id);
  RETURN jsonb_build_object('success', true, 'status', 'AUTORIZADA');
END;
$$;
REVOKE ALL ON FUNCTION mermas.authorize_movement(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.authorize_movement(uuid, uuid, uuid) TO service_role;

INSERT INTO portal.permissions (code, name, description, module_id, is_active)
SELECT 'logistica.mermas.authorize', 'Autorizar entradas de Mermas', 'Autorizar entradas con evidencia fotográfica.', id, true
FROM portal.modules WHERE code = 'logistica'
ON CONFLICT (code) DO UPDATE SET is_active = true;
INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM portal.roles r CROSS JOIN portal.permissions p
WHERE r.name = 'SUPER_USUARIO' AND p.code = 'logistica.mermas.authorize' AND p.is_active
ON CONFLICT (role_id, permission_id) DO NOTHING;
