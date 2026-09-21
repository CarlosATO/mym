-- Formal operation headers and transactional correction flow for manual Merma exits.

CREATE TABLE mermas.stock_exit_operations (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
  operation_type text NOT NULL CHECK (operation_type IN ('DESTRUCCION', 'REGULACION', 'REVERSA')),
  status text NOT NULL DEFAULT 'VIGENTE' CHECK (status IN ('VIGENTE', 'CORREGIDA')),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  observation text,
  created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  corrected_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
  corrected_at timestamptz,
  correction_reason text,
  corrects_operation_id uuid,
  reverses_operation_id uuid,
  CONSTRAINT stock_exit_operations_company_id_id_uq UNIQUE (company_id, id),
  CONSTRAINT stock_exit_operations_correction_dates_ck CHECK (
    (status = 'VIGENTE' AND corrected_by IS NULL AND corrected_at IS NULL AND correction_reason IS NULL)
    OR (
      status = 'CORREGIDA'
      AND corrected_by IS NOT NULL
      AND corrected_at IS NOT NULL
      AND correction_reason IS NOT NULL
      AND length(btrim(correction_reason)) > 0
    )
  ),
  CONSTRAINT stock_exit_operations_relation_type_ck CHECK (
    (operation_type = 'REVERSA' AND reverses_operation_id IS NOT NULL AND corrects_operation_id IS NULL)
    OR (operation_type IN ('DESTRUCCION', 'REGULACION') AND reverses_operation_id IS NULL)
  ),
  CONSTRAINT stock_exit_operations_reversal_status_ck CHECK (
    operation_type <> 'REVERSA' OR status = 'VIGENTE'
  ),
  CONSTRAINT stock_exit_operations_no_self_correction_ck CHECK (
    corrects_operation_id IS NULL OR corrects_operation_id <> id
  ),
  CONSTRAINT stock_exit_operations_no_self_reversal_ck CHECK (
    reverses_operation_id IS NULL OR reverses_operation_id <> id
  ),
  CONSTRAINT stock_exit_operations_corrects_fk
    FOREIGN KEY (company_id, corrects_operation_id)
    REFERENCES mermas.stock_exit_operations(company_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT stock_exit_operations_reverses_fk
    FOREIGN KEY (company_id, reverses_operation_id)
    REFERENCES mermas.stock_exit_operations(company_id, id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX stock_exit_operations_one_correction_idx
  ON mermas.stock_exit_operations(company_id, corrects_operation_id)
  WHERE corrects_operation_id IS NOT NULL;

CREATE UNIQUE INDEX stock_exit_operations_one_reversal_idx
  ON mermas.stock_exit_operations(company_id, reverses_operation_id)
  WHERE reverses_operation_id IS NOT NULL;

CREATE INDEX stock_exit_operations_company_created_idx
  ON mermas.stock_exit_operations(company_id, created_at DESC, id DESC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM mermas.movements
    WHERE movement_group_id IS NOT NULL
      AND movement_type NOT IN ('SALIDA_DESTRUCCION', 'SALIDA_REGULACION')
  ) THEN
    RAISE EXCEPTION 'Existen movimientos agrupados que no corresponden a una salida manual';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM mermas.movements
    WHERE movement_type IN ('SALIDA_DESTRUCCION', 'SALIDA_REGULACION')
      AND movement_group_id IS NOT NULL
    GROUP BY company_id, movement_group_id
    HAVING count(DISTINCT movement_type) > 1
  ) THEN
    RAISE EXCEPTION 'No se puede reconstruir una salida con tipos de movimiento mezclados';
  END IF;

  IF EXISTS (
    SELECT movement_group_id
    FROM mermas.movements
    WHERE movement_type IN ('SALIDA_DESTRUCCION', 'SALIDA_REGULACION')
      AND movement_group_id IS NOT NULL
    GROUP BY movement_group_id
    HAVING count(DISTINCT company_id) > 1
  ) THEN
    RAISE EXCEPTION 'No se puede reconstruir un grupo de salida compartido entre empresas';
  END IF;
END;
$$;

INSERT INTO mermas.stock_exit_operations (
  id, company_id, operation_type, status, reason, observation, created_by, created_at
)
SELECT
  m.movement_group_id,
  m.company_id,
  CASE min(m.movement_type)
    WHEN 'SALIDA_DESTRUCCION' THEN 'DESTRUCCION'
    WHEN 'SALIDA_REGULACION' THEN 'REGULACION'
  END,
  'VIGENTE',
  min(btrim(m.reason)),
  min(m.observation),
  (array_agg(m.created_by ORDER BY m.created_at, m.id))[1],
  min(m.created_at)
FROM mermas.movements m
WHERE m.movement_type IN ('SALIDA_DESTRUCCION', 'SALIDA_REGULACION')
  AND m.movement_group_id IS NOT NULL
GROUP BY m.company_id, m.movement_group_id
ON CONFLICT (id) DO NOTHING;

ALTER TABLE mermas.movements
  ADD CONSTRAINT mermas_movements_group_fk
  FOREIGN KEY (company_id, movement_group_id)
  REFERENCES mermas.stock_exit_operations(company_id, id)
  ON DELETE RESTRICT;

CREATE INDEX mermas_movements_group_detail_idx
  ON mermas.movements(company_id, movement_group_id, variant_id, created_at);

ALTER TABLE mermas.stock_exit_operations ENABLE ROW LEVEL SECURITY;

CREATE POLICY stock_exit_operations_select
  ON mermas.stock_exit_operations
  FOR SELECT TO authenticated
  USING (
    core.has_company_access(auth.uid(), company_id)
    AND portal.has_permission('logistica.mermas.view')
  );

GRANT SELECT ON mermas.stock_exit_operations TO authenticated, service_role;
GRANT ALL ON mermas.stock_exit_operations TO service_role;

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
  v_operation_type text;
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
  v_operation_type := CASE p_movement_type
    WHEN 'SALIDA_DESTRUCCION' THEN 'DESTRUCCION'
    ELSE 'REGULACION'
  END;
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

  INSERT INTO mermas.stock_exit_operations (
    id, company_id, operation_type, status, reason, observation, created_by
  ) VALUES (
    v_group_id, p_company_id, v_operation_type, 'VIGENTE', v_reason, v_observation, p_user_id
  );

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
    'mermas.stock_exit_operations', v_group_id, 'STOCK_EXIT',
    jsonb_build_object(
      'operation_id', v_group_id, 'movement_group_id', v_group_id,
      'movement_type', p_movement_type, 'operation_type', v_operation_type,
      'reason', v_reason, 'observation', v_observation, 'movements', v_movement_ids
    ), p_user_id
  );
  RETURN jsonb_build_object(
    'success', true, 'operation_id', v_group_id, 'movement_group_id', v_group_id,
    'operation_type', v_operation_type, 'status', 'VIGENTE', 'movements', v_movement_ids
  );
END;
$$;

CREATE OR REPLACE FUNCTION mermas.correct_stock_exit(
  p_company_id uuid,
  p_user_id uuid,
  p_original_operation_id uuid,
  p_correction_reason text,
  p_new_operation_type text,
  p_new_reason text,
  p_new_observation text,
  p_items jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, integraciones, mermas
AS $$
DECLARE
  v_original mermas.stock_exit_operations%ROWTYPE;
  v_item jsonb;
  v_lot record;
  v_variant_id integer;
  v_quantity numeric;
  v_key text;
  v_requested numeric;
  v_available numeric;
  v_remaining numeric;
  v_piece numeric;
  v_movement_id uuid;
  v_reversal_id uuid := gen_random_uuid();
  v_corrected_id uuid := gen_random_uuid();
  v_reason text := btrim(coalesce(p_new_reason, ''));
  v_observation text := nullif(btrim(coalesce(p_new_observation, '')), '');
  v_correction_reason text := btrim(coalesce(p_correction_reason, ''));
  v_items jsonb := '{}'::jsonb;
  v_reversal_movements jsonb := '[]'::jsonb;
  v_corrected_movements jsonb := '[]'::jsonb;
  v_original_movements jsonb := '[]'::jsonb;
  v_operation_type text;
  v_original_count integer;
BEGIN
  IF p_company_id IS NULL OR p_user_id IS NULL OR p_original_operation_id IS NULL THEN
    RAISE EXCEPTION 'Corrección de salida inválida';
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
    RAISE EXCEPTION 'Se requiere rol SUPER_USUARIO para corregir salidas de Mermas';
  END IF;
  IF v_correction_reason = '' THEN
    RAISE EXCEPTION 'El motivo de corrección es obligatorio';
  END IF;
  IF p_new_operation_type NOT IN ('DESTRUCCION', 'REGULACION') THEN
    RAISE EXCEPTION 'Tipo de salida corregida inválido';
  END IF;
  IF v_reason = '' THEN
    RAISE EXCEPTION 'El motivo de la salida corregida es obligatorio';
  END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'La salida corregida debe contener al menos un producto';
  END IF;

  SELECT * INTO v_original
  FROM mermas.stock_exit_operations
  WHERE id = p_original_operation_id AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Salida original no encontrada';
  END IF;
  IF v_original.operation_type = 'REVERSA' THEN
    RAISE EXCEPTION 'Una reversa no puede corregirse';
  END IF;
  IF v_original.status <> 'VIGENTE' THEN
    RAISE EXCEPTION 'La salida original ya fue corregida';
  END IF;
  IF EXISTS (
    SELECT 1 FROM mermas.stock_exit_operations o
    WHERE o.company_id = p_company_id
      AND (o.corrects_operation_id = p_original_operation_id OR o.reverses_operation_id = p_original_operation_id)
  ) THEN
    RAISE EXCEPTION 'La salida original ya tiene una corrección o reversa';
  END IF;

  SELECT count(*) INTO v_original_count
  FROM mermas.movements m
  WHERE m.company_id = p_company_id
    AND m.movement_group_id = p_original_operation_id
    AND m.movement_type = CASE v_original.operation_type
      WHEN 'DESTRUCCION' THEN 'SALIDA_DESTRUCCION'
      ELSE 'SALIDA_REGULACION'
    END
    AND m.quantity < 0;
  IF v_original_count = 0 THEN
    RAISE EXCEPTION 'La salida original no tiene movimientos válidos para revertir';
  END IF;
  IF EXISTS (
    SELECT 1 FROM mermas.movements m
    WHERE m.company_id = p_company_id
      AND m.movement_group_id = p_original_operation_id
      AND (m.quantity >= 0 OR m.authorization_status <> 'AUTORIZADA')
  ) THEN
    RAISE EXCEPTION 'La salida original contiene movimientos incompatibles';
  END IF;

  FOR v_variant_id IN
    SELECT DISTINCT m.variant_id
    FROM mermas.movements m
    WHERE m.company_id = p_company_id AND m.movement_group_id = p_original_operation_id
    ORDER BY m.variant_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'mermas-stock-exit:' || p_company_id::text || ':' || v_variant_id::text, 0));
    PERFORM 1 FROM mermas.movements m
      WHERE m.company_id = p_company_id AND m.variant_id = v_variant_id
      FOR UPDATE;
  END LOOP;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_variant_id := nullif(v_item->>'bsale_variant_id', '')::integer;
    v_quantity := nullif(v_item->>'quantity', '')::numeric;
    IF v_variant_id IS NULL OR v_variant_id <= 0 OR v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Producto o cantidad corregida inválida';
    END IF;
    v_items := jsonb_set(v_items, ARRAY[v_variant_id::text],
      to_jsonb(coalesce((v_items->>v_variant_id::text)::numeric, 0) + v_quantity), true);
  END LOOP;

  INSERT INTO mermas.stock_exit_operations (
    id, company_id, operation_type, status, reason, observation, created_by, reverses_operation_id
  ) VALUES (
    v_reversal_id, p_company_id, 'REVERSA', 'VIGENTE', v_correction_reason,
    v_observation, p_user_id, p_original_operation_id
  );

  FOR v_lot IN
    SELECT m.id, m.variant_id, m.quantity, m.expiration_date, m.lot, m.request_id
    FROM mermas.movements m
    WHERE m.company_id = p_company_id
      AND m.movement_group_id = p_original_operation_id
      AND m.quantity < 0
    ORDER BY m.id
  LOOP
    INSERT INTO mermas.movements (
      company_id, movement_type, variant_id, quantity, expiration_date, lot,
      request_id, source, authorization_status, created_by, reason, observation, movement_group_id
    ) VALUES (
      p_company_id, 'REVERSA', v_lot.variant_id, -v_lot.quantity,
      v_lot.expiration_date, v_lot.lot, v_lot.request_id, 'MANUAL_STOCK_EXIT_REVERSAL',
      'AUTORIZADA', p_user_id, v_correction_reason, v_observation, v_reversal_id
    ) RETURNING id INTO v_movement_id;
    v_original_movements := v_original_movements || jsonb_build_array(jsonb_build_object(
      'movement_id', v_lot.id, 'variant_id', v_lot.variant_id, 'quantity', -v_lot.quantity,
      'expiration_date', v_lot.expiration_date, 'lot', v_lot.lot, 'request_id', v_lot.request_id));
    v_reversal_movements := v_reversal_movements || jsonb_build_array(jsonb_build_object(
      'movement_id', v_movement_id, 'variant_id', v_lot.variant_id, 'quantity', -v_lot.quantity,
      'expiration_date', v_lot.expiration_date, 'lot', v_lot.lot, 'request_id', v_lot.request_id));
  END LOOP;

  INSERT INTO mermas.stock_exit_operations (
    id, company_id, operation_type, status, reason, observation, created_by, corrects_operation_id
  ) VALUES (
    v_corrected_id, p_company_id, p_new_operation_type, 'VIGENTE', v_reason,
    v_observation, p_user_id, p_original_operation_id
  );

  FOR v_key, v_requested IN SELECT key, value::numeric FROM jsonb_each_text(v_items) ORDER BY key LOOP
    v_variant_id := v_key::integer;
    PERFORM 1 FROM integraciones.bsale_variants v
      WHERE v.company_id = p_company_id AND v.bsale_id = v_variant_id AND v.state = 0;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Producto % no encontrado o inactivo en el catálogo', v_variant_id;
    END IF;
    SELECT coalesce(sum(sc.available), 0) INTO v_available
    FROM mermas.stock_current sc
    WHERE sc.company_id = p_company_id AND sc.variant_id = v_variant_id AND sc.available > 0;
    IF v_requested > v_available THEN
      RAISE EXCEPTION 'Stock insuficiente para la corrección de la variante %. Disponible: %, solicitado: %', v_variant_id, v_available, v_requested;
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
        p_company_id,
        CASE p_new_operation_type WHEN 'DESTRUCCION' THEN 'SALIDA_DESTRUCCION' ELSE 'SALIDA_REGULACION' END,
        v_variant_id, -v_piece, v_lot.expiration_date, v_lot.lot, v_lot.request_id,
        'MANUAL_STOCK_EXIT', 'AUTORIZADA', p_user_id, v_reason, v_observation, v_corrected_id
      ) RETURNING id INTO v_movement_id;
      v_corrected_movements := v_corrected_movements || jsonb_build_array(jsonb_build_object(
        'movement_id', v_movement_id, 'variant_id', v_variant_id, 'quantity', v_piece,
        'expiration_date', v_lot.expiration_date, 'lot', v_lot.lot, 'request_id', v_lot.request_id));
      v_remaining := v_remaining - v_piece;
    END LOOP;
    IF v_remaining > 0 THEN
      RAISE EXCEPTION 'Stock insuficiente para la corrección de la variante %', v_variant_id;
    END IF;
  END LOOP;

  UPDATE mermas.stock_exit_operations
  SET status = 'CORREGIDA', corrected_by = p_user_id, corrected_at = now(), correction_reason = v_correction_reason
  WHERE id = p_original_operation_id AND company_id = p_company_id;

  INSERT INTO portal.audit_logs(table_name, record_id, action, old_data, new_data, performed_by)
  VALUES (
    'mermas.stock_exit_operations', p_original_operation_id, 'STOCK_EXIT_CORRECTED',
    jsonb_build_object('operation_id', p_original_operation_id, 'status', 'VIGENTE'),
    jsonb_build_object(
      'original_operation_id', p_original_operation_id,
      'reversal_operation_id', v_reversal_id,
      'corrected_operation_id', v_corrected_id,
      'correction_reason', v_correction_reason,
      'original_movements', v_original_movements,
      'reversal_movements', v_reversal_movements,
      'corrected_movements', v_corrected_movements
    ), p_user_id
  );
  RETURN jsonb_build_object(
    'success', true, 'original_operation_id', p_original_operation_id,
    'reversal_operation_id', v_reversal_id, 'corrected_operation_id', v_corrected_id,
    'status', 'CORREGIDA', 'reversal_movements', v_reversal_movements,
    'corrected_movements', v_corrected_movements
  );
END;
$$;

CREATE OR REPLACE FUNCTION mermas.get_stock_exit_operations(
  p_company_id uuid,
  p_user_id uuid,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
) RETURNS TABLE (
  operation_id uuid,
  created_at timestamptz,
  operation_type text,
  status text,
  reason text,
  observation text,
  created_by uuid,
  created_by_name text,
  total_units numeric,
  product_count integer,
  corrects_operation_id uuid,
  reverses_operation_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, integraciones, mermas
AS $$
BEGIN
  IF p_company_id IS NULL OR p_user_id IS NULL
     OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.view') THEN
    RAISE EXCEPTION 'No autorizado para consultar salidas de Mermas';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'Límite inválido';
  END IF;
  IF p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'Desplazamiento inválido';
  END IF;

  RETURN QUERY
  SELECT
    o.id,
    o.created_at,
    o.operation_type,
    o.status,
    o.reason,
    o.observation,
    o.created_by,
    concat_ws(' ', u.nombre, u.apellido),
    coalesce(sum(abs(m.quantity)), 0),
    count(DISTINCT m.variant_id)::integer,
    o.corrects_operation_id,
    o.reverses_operation_id
  FROM mermas.stock_exit_operations o
  JOIN portal.users u ON u.id = o.created_by
  LEFT JOIN mermas.movements m
    ON m.company_id = o.company_id AND m.movement_group_id = o.id
  WHERE o.company_id = p_company_id
  GROUP BY o.id, o.created_at, o.operation_type, o.status, o.reason, o.observation,
    o.created_by, u.nombre, u.apellido, o.corrects_operation_id, o.reverses_operation_id
  ORDER BY o.created_at DESC, o.id DESC
  LIMIT p_limit OFFSET p_offset;
END;
$$;

CREATE OR REPLACE FUNCTION mermas.get_stock_exit_operation_detail(
  p_company_id uuid,
  p_user_id uuid,
  p_operation_id uuid
) RETURNS TABLE (
  operation_id uuid,
  company_id uuid,
  created_at timestamptz,
  operation_type text,
  status text,
  reason text,
  observation text,
  created_by uuid,
  created_by_name text,
  corrected_by uuid,
  corrected_at timestamptz,
  correction_reason text,
  corrects_operation_id uuid,
  reverses_operation_id uuid,
  products jsonb,
  movements jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, integraciones, mermas
AS $$
BEGIN
  IF p_company_id IS NULL OR p_user_id IS NULL OR p_operation_id IS NULL
     OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.view') THEN
    RAISE EXCEPTION 'No autorizado para consultar el detalle de salidas de Mermas';
  END IF;

  RETURN QUERY
  SELECT
    o.id,
    o.company_id,
    o.created_at,
    o.operation_type,
    o.status,
    o.reason,
    o.observation,
    o.created_by,
    concat_ws(' ', u.nombre, u.apellido),
    o.corrected_by,
    o.corrected_at,
    o.correction_reason,
    o.corrects_operation_id,
    o.reverses_operation_id,
    coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'variant_id', p.variant_id,
        'sku', p.sku,
        'product_name', p.product_name,
        'quantity', p.quantity,
        'movement_count', p.movement_count
      ) ORDER BY p.variant_id)
      FROM (
        SELECT
          m.variant_id,
          coalesce(v.code, 'BS-' || m.variant_id::text) AS sku,
          coalesce(bp.name, v.description, 'Producto Bsale') AS product_name,
          sum(abs(m.quantity)) AS quantity,
          count(*)::integer AS movement_count
        FROM mermas.movements m
        LEFT JOIN integraciones.bsale_variants v
          ON v.company_id = m.company_id AND v.bsale_id = m.variant_id
        LEFT JOIN integraciones.bsale_products bp
          ON bp.company_id = v.company_id AND bp.bsale_id = v.bsale_product_id
        WHERE m.company_id = p_company_id AND m.movement_group_id = o.id
        GROUP BY m.variant_id, v.code, v.description, bp.name
      ) p
    ), '[]'::jsonb),
    coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'movement_id', m.id,
        'movement_type', m.movement_type,
        'variant_id', m.variant_id,
        'quantity', m.quantity,
        'quantity_absolute', abs(m.quantity),
        'expiration_date', m.expiration_date,
        'lot', m.lot,
        'request_id', m.request_id,
        'source', m.source,
        'authorization_status', m.authorization_status,
        'created_by', m.created_by,
        'created_at', m.created_at
      ) ORDER BY m.created_at, m.id)
      FROM mermas.movements m
      WHERE m.company_id = p_company_id AND m.movement_group_id = o.id
    ), '[]'::jsonb)
  FROM mermas.stock_exit_operations o
  JOIN portal.users u ON u.id = o.created_by
  WHERE o.company_id = p_company_id AND o.id = p_operation_id;
END;
$$;

REVOKE ALL ON FUNCTION mermas.create_stock_exit(uuid, uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION mermas.correct_stock_exit(uuid, uuid, uuid, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION mermas.get_stock_exit_operations(uuid, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION mermas.get_stock_exit_operation_detail(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION mermas.create_stock_exit(uuid, uuid, text, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION mermas.correct_stock_exit(uuid, uuid, uuid, text, text, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION mermas.get_stock_exit_operations(uuid, uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION mermas.get_stock_exit_operation_detail(uuid, uuid, uuid) TO service_role;
