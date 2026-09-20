-- Salidas manuales de la Bodega de Mermas.

ALTER TABLE mermas.movements
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS reason text,
  ADD COLUMN IF NOT EXISTS observation text,
  ADD COLUMN IF NOT EXISTS movement_group_id uuid;

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'mermas'
      AND rel.relname = 'movements'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) LIKE '%movement_type%'
  LOOP
    EXECUTE format('ALTER TABLE mermas.movements DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END;
$$;

ALTER TABLE mermas.movements
  ADD CONSTRAINT mermas_movements_movement_type_check
  CHECK (movement_type IN (
    'ENTRADA_BSALE', 'VENTA_INTERNA', 'ELIMINACION', 'REVERSA', 'STOCK_INICIAL',
    'SALIDA_DESTRUCCION', 'SALIDA_REGULACION'
  ));

ALTER TABLE mermas.movements
  ADD CONSTRAINT mermas_movements_manual_exit_fields_check
  CHECK (
    movement_type NOT IN ('SALIDA_DESTRUCCION', 'SALIDA_REGULACION')
    OR (created_by IS NOT NULL AND reason IS NOT NULL AND length(btrim(reason)) > 0 AND movement_group_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS mermas_movements_group_idx
  ON mermas.movements(company_id, movement_group_id)
  WHERE movement_group_id IS NOT NULL;

CREATE OR REPLACE FUNCTION mermas.create_stock_exit(
  p_company_id uuid,
  p_user_id uuid,
  p_movement_type text,
  p_reason text,
  p_observation text,
  p_items jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, integraciones, mermas
AS $$
DECLARE
  v_group_id uuid := gen_random_uuid();
  v_item jsonb;
  v_variant_id integer;
  v_quantity numeric;
  v_key text;
  v_requested numeric;
  v_available numeric;
  v_remaining numeric;
  v_piece numeric;
  v_lot record;
  v_movement_id uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_observation text := nullif(btrim(coalesce(p_observation, '')), '');
  v_items jsonb := '{}'::jsonb;
  v_movement_ids jsonb := '[]'::jsonb;
BEGIN
  IF p_company_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'Salida de Mermas inválida';
  END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Usuario inválido';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM portal.users u
    WHERE u.id = p_user_id AND u.is_active AND u.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'El usuario responsable no está activo';
  END IF;
  IF NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT portal.is_super_usuario(p_user_id) THEN
    RAISE EXCEPTION 'Se requiere rol SUPER_USUARIO para registrar salidas de Mermas';
  END IF;
  IF p_movement_type NOT IN ('SALIDA_DESTRUCCION', 'SALIDA_REGULACION') THEN
    RAISE EXCEPTION 'Tipo de salida inválido';
  END IF;
  IF v_reason = '' THEN
    RAISE EXCEPTION 'El motivo de la salida es obligatorio';
  END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'La salida debe contener al menos un producto';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_variant_id := nullif(v_item->>'bsale_variant_id', '')::integer;
    v_quantity := nullif(v_item->>'quantity', '')::numeric;
    IF v_variant_id IS NULL OR v_variant_id <= 0 OR v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Producto o cantidad inválida';
    END IF;
    v_items := jsonb_set(v_items, ARRAY[v_variant_id::text],
      to_jsonb(coalesce((v_items->>v_variant_id::text)::numeric, 0) + v_quantity), true);
  END LOOP;

  FOR v_key, v_requested IN SELECT key, value::numeric FROM jsonb_each_text(v_items) ORDER BY key LOOP
    v_variant_id := v_key::integer;
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'mermas-stock-exit:' || p_company_id::text || ':' || v_variant_id::text, 0));
    PERFORM 1 FROM mermas.movements m
      WHERE m.company_id = p_company_id AND m.variant_id = v_variant_id
      FOR UPDATE;
    IF NOT EXISTS (
      SELECT 1 FROM integraciones.bsale_variants v
      WHERE v.company_id = p_company_id AND v.bsale_id = v_variant_id AND v.state = 0
    ) THEN
      RAISE EXCEPTION 'Producto % no encontrado o inactivo en el catálogo', v_variant_id;
    END IF;
    SELECT coalesce(sum(sc.available), 0) INTO v_available
    FROM mermas.stock_current sc
    WHERE sc.company_id = p_company_id AND sc.variant_id = v_variant_id AND sc.available > 0;
    IF v_requested > v_available THEN
      RAISE EXCEPTION 'Stock insuficiente para la variante %. Disponible: %, solicitado: %', v_variant_id, v_available, v_requested;
    END IF;
  END LOOP;

  FOR v_key, v_requested IN SELECT key, value::numeric FROM jsonb_each_text(v_items) ORDER BY key LOOP
    v_variant_id := v_key::integer;
    v_remaining := v_requested;
    FOR v_lot IN
      SELECT sc.variant_id, sc.expiration_date, sc.lot, sc.available, sc.entered_at, sc.request_id
      FROM mermas.stock_current sc
      WHERE sc.company_id = p_company_id AND sc.variant_id = v_variant_id AND sc.available > 0
      ORDER BY sc.expiration_date IS NULL, sc.expiration_date, sc.entered_at, sc.lot NULLS FIRST, sc.request_id NULLS FIRST
    LOOP
      EXIT WHEN v_remaining <= 0;
      v_piece := least(v_remaining, v_lot.available);
      INSERT INTO mermas.movements (
        company_id, movement_type, variant_id, quantity, expiration_date, lot,
        request_id, source, authorization_status, created_by, reason, observation, movement_group_id
      ) VALUES (
        p_company_id, p_movement_type, v_variant_id, -v_piece, v_lot.expiration_date, v_lot.lot,
        v_lot.request_id, 'MANUAL_STOCK_EXIT', 'AUTORIZADA', p_user_id, v_reason, v_observation, v_group_id
      ) RETURNING id INTO v_movement_id;
      v_movement_ids := v_movement_ids || jsonb_build_array(jsonb_build_object(
        'movement_id', v_movement_id, 'variant_id', v_variant_id, 'quantity', v_piece,
        'expiration_date', v_lot.expiration_date, 'lot', v_lot.lot, 'request_id', v_lot.request_id));
      v_remaining := v_remaining - v_piece;
    END LOOP;
    IF v_remaining > 0 THEN
      RAISE EXCEPTION 'Stock insuficiente para la variante %', v_variant_id;
    END IF;
  END LOOP;

  INSERT INTO portal.audit_logs(table_name, record_id, action, new_data, performed_by)
  VALUES (
    'mermas.movements', v_group_id, 'STOCK_EXIT',
    jsonb_build_object('movement_group_id', v_group_id, 'movement_type', p_movement_type,
      'reason', v_reason, 'observation', v_observation, 'movements', v_movement_ids),
    p_user_id
  );
  RETURN jsonb_build_object('success', true, 'movement_group_id', v_group_id, 'movements', v_movement_ids);
END;
$$;

REVOKE ALL ON FUNCTION mermas.create_stock_exit(uuid, uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.create_stock_exit(uuid, uuid, text, text, text, jsonb) TO service_role;
