-- Bloque 6: aceptación transaccional de una versión comercial verificada.
-- Esta migración no consulta Bsale ni sincroniza datos. La acción de servidor
-- registra una solicitud verificada y la RPC aplica sólo esa solicitud.

BEGIN;

ALTER TABLE logistica.sales_order_preparation_lines
  ADD COLUMN IF NOT EXISTS retired_at timestamptz,
  ADD COLUMN IF NOT EXISTS retired_by uuid,
  ADD COLUMN IF NOT EXISTS retirement_acceptance_id uuid;

CREATE INDEX IF NOT EXISTS idx_sales_order_preparation_lines_active
  ON logistica.sales_order_preparation_lines(company_id, card_id, bsale_detail_id)
  WHERE retired_at IS NULL;

CREATE TABLE IF NOT EXISTS logistica.sales_order_preparation_commercial_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  card_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_cards(id) ON DELETE RESTRICT,
  sequence_no integer NOT NULL,
  canonical_bsale_token text NOT NULL,
  historical_bsale_nv_id bigint NOT NULL,
  current_bsale_nv_id bigint NOT NULL,
  previous_fingerprint text,
  fingerprint text NOT NULL,
  version_snapshot jsonb NOT NULL,
  applied_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  accepted_by uuid NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, card_id, sequence_no),
  UNIQUE (company_id, card_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_sales_order_preparation_commercial_versions_card
  ON logistica.sales_order_preparation_commercial_versions(company_id, card_id, accepted_at DESC);

CREATE TABLE IF NOT EXISTS logistica.sales_order_preparation_commercial_acceptance_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  card_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_cards(id) ON DELETE RESTRICT,
  expected_fingerprint text NOT NULL,
  previous_fingerprint text,
  verified_current_bsale_nv_id bigint NOT NULL,
  version_snapshot jsonb NOT NULL,
  plan_snapshot jsonb NOT NULL,
  verified_at timestamptz NOT NULL,
  requested_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, card_id, expected_fingerprint)
);

ALTER TABLE logistica.sales_order_preparation_commercial_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistica.sales_order_preparation_commercial_acceptance_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE logistica.sales_order_preparation_commercial_versions FROM anon, authenticated;
REVOKE ALL ON TABLE logistica.sales_order_preparation_commercial_acceptance_requests FROM anon, authenticated;
GRANT ALL ON TABLE logistica.sales_order_preparation_commercial_versions TO service_role;
GRANT ALL ON TABLE logistica.sales_order_preparation_commercial_acceptance_requests TO service_role;

-- La versión comercial aceptada es la autoridad después de la primera
-- aceptación. La tarjeta se bloquea antes de consultar la versión para
-- serializar esta lectura con la aceptación y con el movimiento de la tarjeta.
CREATE OR REPLACE FUNCTION logistica.materialize_sales_order_preparation_snapshot(
  p_company_id uuid,
  p_card_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = logistica, integraciones, public
AS $$
DECLARE
  v_card logistica.sales_order_preparation_cards%ROWTYPE;
  v_accepted_version logistica.sales_order_preparation_commercial_versions%ROWTYPE;
  v_inserted integer;
BEGIN
  SELECT * INTO v_card
    FROM logistica.sales_order_preparation_cards
   WHERE id = p_card_id AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tarjeta no encontrada para la empresa.';
  END IF;

  SELECT * INTO v_accepted_version
    FROM logistica.sales_order_preparation_commercial_versions
   WHERE company_id = p_company_id AND card_id = p_card_id
   ORDER BY sequence_no DESC
   LIMIT 1;

  IF FOUND THEN
    IF v_accepted_version.canonical_bsale_token IS DISTINCT FROM v_card.canonical_bsale_token
       OR v_accepted_version.current_bsale_nv_id IS DISTINCT FROM v_card.current_bsale_nv_id
       OR jsonb_typeof(v_accepted_version.version_snapshot->'identity') IS DISTINCT FROM 'object'
       OR v_accepted_version.version_snapshot->'identity'->>'canonicalToken' IS DISTINCT FROM v_card.canonical_bsale_token
       OR NULLIF(v_accepted_version.version_snapshot->>'physicalId', '') IS NULL
       OR (v_accepted_version.version_snapshot->>'physicalId') !~ '^[0-9]+$'
       OR jsonb_typeof(v_accepted_version.version_snapshot->'lines') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'La versión comercial aceptada no coincide con la tarjeta.';
    END IF;
    IF (v_accepted_version.version_snapshot->>'physicalId')::bigint IS DISTINCT FROM v_card.current_bsale_nv_id THEN
      RAISE EXCEPTION 'La versión comercial aceptada no coincide con la tarjeta.';
    END IF;

    -- Un snapshot aceptado inválido no puede habilitar un fallback al histórico.
    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_accepted_version.version_snapshot->'lines') AS accepted_line(value)
       WHERE jsonb_typeof(accepted_line.value) <> 'object'
          OR NULLIF(accepted_line.value->>'detailId', '') IS NULL
          OR (accepted_line.value->>'detailId') !~ '^[0-9]+$'
    ) THEN
      RAISE EXCEPTION 'La versión comercial aceptada contiene líneas sin detailId válido.';
    END IF;

    -- Las líneas activas deben ser exactamente las de la versión aceptada.
    -- Ante divergencia se falla cerrado: nunca se rehidrata desde Bsale.
    IF EXISTS (
      SELECT 1
        FROM logistica.sales_order_preparation_lines active_line
       WHERE active_line.company_id = p_company_id
         AND active_line.card_id = p_card_id
         AND active_line.retired_at IS NULL
         AND NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements(v_accepted_version.version_snapshot->'lines') AS accepted_line(value)
            WHERE (accepted_line.value->>'detailId')::bigint = active_line.bsale_detail_id
         )
    ) OR EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_accepted_version.version_snapshot->'lines') AS accepted_line(value)
       WHERE NOT EXISTS (
         SELECT 1
           FROM logistica.sales_order_preparation_lines active_line
          WHERE active_line.company_id = p_company_id
            AND active_line.card_id = p_card_id
            AND active_line.retired_at IS NULL
            AND active_line.bsale_detail_id = (accepted_line.value->>'detailId')::bigint
       )
    ) THEN
      RAISE EXCEPTION 'Las líneas activas no coinciden con la versión comercial aceptada.';
    END IF;

    RETURN 0;
  END IF;

  -- No se reconstruye el snapshot histórico para tarjetas que ya llegaron a
  -- Auditoría o a un estado posterior. La transición a Auditoría materializa
  -- mientras la tarjeta aún está bloqueada en IN_PREPARATION.
  IF v_card.status NOT IN ('PENDING_ROUTE_PREP', 'IN_PREPARATION') THEN
    RETURN 0;
  END IF;

  -- Antes de aceptar una versión, la materialización histórica inicial sigue
  -- siendo válida y conserva su idempotencia por la clave de detalle.
  INSERT INTO logistica.sales_order_preparation_lines (
    company_id, card_id, bsale_nv_id, bsale_detail_id, bsale_variant_id,
    sku, product_name, requested_quantity, source_snapshot
  )
  SELECT i.company_id, v_card.id, i.nv_bsale_id, i.detail_id, i.variant_id,
         i.sku, i.product_name, i.quantity, to_jsonb(i)
    FROM integraciones.vw_bsale_sales_order_items_for_preparation i
   WHERE i.company_id = p_company_id AND i.nv_bsale_id = v_card.bsale_nv_id
   ON CONFLICT (company_id, card_id, bsale_detail_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

CREATE OR REPLACE FUNCTION logistica.accept_sales_order_preparation_commercial_changes(
  p_request_id uuid,
  p_company_id uuid,
  p_card_id uuid,
  p_expected_fingerprint text,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = logistica, public
AS $$
DECLARE
  v_request logistica.sales_order_preparation_commercial_acceptance_requests%ROWTYPE;
  v_card logistica.sales_order_preparation_cards%ROWTYPE;
  v_line logistica.sales_order_preparation_lines%ROWTYPE;
  v_current jsonb;
  v_action jsonb;
  v_kind text;
  v_line_id uuid;
  v_new_quantity numeric;
  v_prepared numeric;
  v_sequence integer;
  v_version_id uuid;
  v_conflicts integer;
  v_latest_fingerprint text;
  v_action_index integer := 0;
  v_has_conflict boolean := false;
  v_validation_number numeric;
  v_validation_bigint bigint;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'COMMERCIAL_ACCEPTANCE_ACTOR_REQUIRED';
  END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM p_actor_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'COMMERCIAL_ACCEPTANCE_ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM portal.users u
     WHERE u.id = p_actor_id
       AND u.is_active = true
       AND u.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'COMMERCIAL_ACCEPTANCE_ACTOR_INACTIVE';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM core.companies c
     WHERE c.id = p_company_id
       AND c.is_active = true
  ) OR NOT core.has_company_access(p_actor_id, p_company_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'COMMERCIAL_ACCEPTANCE_COMPANY_ACCESS_DENIED';
  END IF;
  IF NOT core.has_permission_for_company(p_actor_id, p_company_id, 'logistica.preparation.manage') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'COMMERCIAL_ACCEPTANCE_PERMISSION_DENIED';
  END IF;

  v_version_id := gen_random_uuid();
  SELECT * INTO v_request
    FROM logistica.sales_order_preparation_commercial_acceptance_requests
   WHERE id = p_request_id
     AND company_id = p_company_id
     AND card_id = p_card_id
   FOR UPDATE;
  IF NOT FOUND OR v_request.expected_fingerprint IS DISTINCT FROM p_expected_fingerprint THEN
    RETURN jsonb_build_object('status', 'VERSION_CHANGED');
  END IF;
  IF v_request.requested_by IS DISTINCT FROM p_actor_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'COMMERCIAL_ACCEPTANCE_ACTOR_MISMATCH';
  END IF;

  SELECT * INTO v_card
    FROM logistica.sales_order_preparation_cards
   WHERE id = p_card_id AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'ERROR', 'detail', 'Tarjeta no encontrada.'); END IF;
  IF v_card.status <> 'IN_PREPARATION' THEN
    RETURN jsonb_build_object('status', 'INVALID_STATUS', 'current_status', v_card.status);
  END IF;
  IF v_card.locked_by_user_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'COMMERCIAL_ACCEPTANCE_LOCK_REQUIRED';
  END IF;
  IF v_card.locked_by_user_id IS DISTINCT FROM p_actor_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'COMMERCIAL_ACCEPTANCE_LOCK_OWNER_REQUIRED';
  END IF;
  IF v_card.canonical_bsale_token IS NULL
     OR v_card.canonical_bsale_token <> v_request.version_snapshot->'identity'->>'canonicalToken' THEN
    RETURN jsonb_build_object('status', 'AMBIGUOUS', 'detail', 'La identidad canónica no coincide.');
  END IF;
  IF v_request.verified_current_bsale_nv_id IS DISTINCT FROM (v_request.version_snapshot->>'physicalId')::bigint THEN
    RETURN jsonb_build_object('status', 'VERSION_CHANGED');
  END IF;

  IF jsonb_typeof(v_request.plan_snapshot->'conflicts') = 'array' THEN
    SELECT count(*) INTO v_conflicts FROM jsonb_array_elements(v_request.plan_snapshot->'conflicts');
    IF v_conflicts > 0 OR v_request.plan_snapshot->>'status' <> 'READY' THEN
      RETURN jsonb_build_object('status', 'REQUIRES_RESOLUTION');
    END IF;
  ELSE
    RETURN jsonb_build_object('status', 'REQUIRES_RESOLUTION');
  END IF;

  IF jsonb_typeof(v_request.plan_snapshot->'actions') IS DISTINCT FROM 'array'
     OR jsonb_array_length(v_request.plan_snapshot->'actions') = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'COMMERCIAL_ACCEPTANCE_INVALID_ACTIONS: el plan debe contener acciones.';
  END IF;

  -- Se valida el plan completo antes de tocar líneas. Los códigos coinciden
  -- con PreparationCommercialReconciliationActionKind; no se acepta ningún
  -- valor implícito o desconocido.
  FOR v_action IN SELECT value FROM jsonb_array_elements(v_request.plan_snapshot->'actions') LOOP
    v_action_index := v_action_index + 1;
    IF jsonb_typeof(v_action) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = format('COMMERCIAL_ACCEPTANCE_INVALID_ACTION: acción %s no es un objeto.', v_action_index);
    END IF;

    v_kind := NULLIF(btrim(v_action->>'kind'), '');
    IF v_kind IS NULL OR v_kind NOT IN ('KEEP', 'ADD', 'REMOVE', 'UPDATE_QUANTITY', 'CONFLICT') THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = format('COMMERCIAL_ACCEPTANCE_UNKNOWN_ACTION: acción %s tiene un código no permitido.', v_action_index);
    END IF;

    IF v_kind IN ('KEEP', 'REMOVE', 'UPDATE_QUANTITY') THEN
      IF jsonb_typeof(v_action->'preparationLineId') IS DISTINCT FROM 'string'
         OR NULLIF(btrim(v_action->>'preparationLineId'), '') IS NULL
         OR (v_action->>'preparationLineId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = format('COMMERCIAL_ACCEPTANCE_INVALID_ACTION: acción %s requiere preparationLineId válido.', v_action_index);
      END IF;
      BEGIN
        v_line_id := (v_action->>'preparationLineId')::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = format('COMMERCIAL_ACCEPTANCE_INVALID_ACTION: acción %s tiene preparationLineId inválido.', v_action_index);
      END;
    END IF;

    IF v_kind = 'ADD' THEN
      IF jsonb_typeof(v_action->'current') IS DISTINCT FROM 'object'
         OR NULLIF(v_action->'current'->>'detailId', '') IS NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = format('COMMERCIAL_ACCEPTANCE_INVALID_ACTION: acción %s requiere current.detailId.', v_action_index);
      END IF;
      BEGIN
        v_validation_bigint := (v_action->'current'->>'detailId')::bigint;
      EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = format('COMMERCIAL_ACCEPTANCE_INVALID_ACTION: acción %s tiene current.detailId inválido.', v_action_index);
      END;
      IF v_validation_bigint < 0 OR v_action->'current'->>'quantity' IS NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = format('COMMERCIAL_ACCEPTANCE_INVALID_ACTION: acción %s requiere quantity no negativa.', v_action_index);
      END IF;
      BEGIN
        v_validation_number := (v_action->'current'->>'quantity')::numeric;
      EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = format('COMMERCIAL_ACCEPTANCE_INVALID_ACTION: acción %s tiene quantity inválida.', v_action_index);
      END;
      IF v_validation_number < 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = format('COMMERCIAL_ACCEPTANCE_INVALID_ACTION: acción %s requiere quantity no negativa.', v_action_index);
      END IF;
      IF NULLIF(v_action->'current'->>'variantId', '') IS NOT NULL THEN
        BEGIN
          v_validation_bigint := (v_action->'current'->>'variantId')::bigint;
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = format('COMMERCIAL_ACCEPTANCE_INVALID_ACTION: acción %s tiene variantId inválido.', v_action_index);
        END;
      END IF;
    ELSIF v_kind = 'UPDATE_QUANTITY' THEN
      IF v_action->>'newRequestedQuantity' IS NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = format('COMMERCIAL_ACCEPTANCE_INVALID_ACTION: acción %s requiere newRequestedQuantity.', v_action_index);
      END IF;
      BEGIN
        v_validation_number := (v_action->>'newRequestedQuantity')::numeric;
      EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = format('COMMERCIAL_ACCEPTANCE_INVALID_ACTION: acción %s tiene newRequestedQuantity inválida.', v_action_index);
      END;
      IF v_validation_number < 0 OR jsonb_typeof(v_action->'current') IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = format('COMMERCIAL_ACCEPTANCE_INVALID_ACTION: acción %s requiere current y cantidad válida.', v_action_index);
      END IF;
      IF NULLIF(v_action->'current'->>'detailId', '') IS NOT NULL THEN
        BEGIN
          v_validation_bigint := (v_action->'current'->>'detailId')::bigint;
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = format('COMMERCIAL_ACCEPTANCE_INVALID_ACTION: acción %s tiene current.detailId inválido.', v_action_index);
        END;
      END IF;
      IF NULLIF(v_action->'current'->>'variantId', '') IS NOT NULL THEN
        BEGIN
          v_validation_bigint := (v_action->'current'->>'variantId')::bigint;
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = format('COMMERCIAL_ACCEPTANCE_INVALID_ACTION: acción %s tiene variantId inválido.', v_action_index);
        END;
      END IF;
    ELSIF v_kind = 'CONFLICT' THEN
      IF jsonb_typeof(v_action->'conflict') IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = format('COMMERCIAL_ACCEPTANCE_INVALID_ACTION: acción %s tiene conflicto incompleto.', v_action_index);
      END IF;
      v_has_conflict := true;
    END IF;
  END LOOP;

  IF v_has_conflict THEN
    RETURN jsonb_build_object('status', 'REQUIRES_RESOLUTION');
  END IF;

  IF EXISTS (
    SELECT 1 FROM logistica.sales_order_preparation_commercial_versions
     WHERE company_id = p_company_id AND card_id = p_card_id
       AND fingerprint = p_expected_fingerprint
  ) THEN
    RETURN jsonb_build_object('status', 'ALREADY_ACCEPTED');
  END IF;

  SELECT fingerprint INTO v_latest_fingerprint
    FROM logistica.sales_order_preparation_commercial_versions
   WHERE company_id = p_company_id AND card_id = p_card_id
   ORDER BY sequence_no DESC
   LIMIT 1;
  IF v_latest_fingerprint IS NOT NULL
     AND v_request.previous_fingerprint IS DISTINCT FROM v_latest_fingerprint THEN
    RETURN jsonb_build_object('status', 'VERSION_CHANGED');
  END IF;

  -- El bloqueo de la tarjeta ocurre antes de estas filas. Así, la RPC de
  -- movimiento no puede intercalarse entre la validación y la escritura.
  PERFORM 1 FROM logistica.sales_order_preparation_lines
   WHERE company_id = p_company_id AND card_id = p_card_id AND retired_at IS NULL
   FOR UPDATE;

  FOR v_action IN SELECT value FROM jsonb_array_elements(v_request.plan_snapshot->'actions') LOOP
    v_kind := v_action->>'kind';
    v_line_id := NULLIF(v_action->>'preparationLineId', '')::uuid;
    IF v_kind = 'CONFLICT' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'COMMERCIAL_ACCEPTANCE_REQUIRES_RESOLUTION: el plan contiene un conflicto.';
    ELSIF v_kind = 'KEEP' THEN
      IF NOT EXISTS (
        SELECT 1 FROM logistica.sales_order_preparation_lines
         WHERE id = v_line_id
           AND company_id = p_company_id
           AND card_id = p_card_id
           AND retired_at IS NULL
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'COMMERCIAL_ACCEPTANCE_CONCURRENT_MODIFICATION: la línea KEEP ya no está activa.';
      END IF;
      CONTINUE;
    ELSIF v_kind = 'ADD' THEN
      v_current := v_action->'current';
      IF v_current IS NULL OR (v_current->>'detailId') IS NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'COMMERCIAL_ACCEPTANCE_INVALID_ACTION: ADD sin current.detailId.';
      END IF;
      IF EXISTS (
        SELECT 1 FROM logistica.sales_order_preparation_lines
         WHERE company_id = p_company_id AND card_id = p_card_id
            AND bsale_detail_id = (v_current->>'detailId')::bigint
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'COMMERCIAL_ACCEPTANCE_CONCURRENT_MODIFICATION: la línea ADD ya existe.';
      END IF;
      INSERT INTO logistica.sales_order_preparation_lines (
        company_id, card_id, bsale_nv_id, bsale_detail_id, bsale_variant_id,
        sku, product_name, requested_quantity, line_status, source_snapshot
      ) VALUES (
        p_company_id, p_card_id, (v_request.version_snapshot->>'physicalId')::bigint,
        (v_current->>'detailId')::bigint, NULLIF(v_current->>'variantId', '')::bigint,
        NULLIF(v_current->>'sku', ''), COALESCE(NULLIF(v_current->>'productName', ''), 'Producto sin descripción'),
        (v_current->>'quantity')::numeric, 'PENDING', v_current
      );
    ELSIF v_kind IN ('UPDATE_QUANTITY', 'REMOVE') THEN
      SELECT * INTO v_line FROM logistica.sales_order_preparation_lines
       WHERE id = v_line_id AND company_id = p_company_id AND card_id = p_card_id
        FOR UPDATE;
      IF NOT FOUND OR v_line.retired_at IS NOT NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'COMMERCIAL_ACCEPTANCE_CONCURRENT_MODIFICATION: la línea ya no está activa.';
      END IF;
      IF EXISTS (SELECT 1 FROM logistica.sales_order_preparation_incidents WHERE preparation_line_id = v_line.id) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'COMMERCIAL_ACCEPTANCE_REQUIRES_RESOLUTION: la línea tiene una incidencia operativa.';
      END IF;
      IF EXISTS (SELECT 1 FROM logistica.sales_order_audit_lines WHERE preparation_line_id = v_line.id)
         OR EXISTS (SELECT 1 FROM logistica.sales_order_audit_incidents WHERE preparation_line_id = v_line.id) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'COMMERCIAL_ACCEPTANCE_REQUIRES_RESOLUTION: la línea tiene evidencia de Auditoría.';
      END IF;
      IF v_kind = 'REMOVE' THEN
        IF v_line.line_status <> 'PENDING' OR v_line.prepared_quantity IS NOT NULL OR v_line.excluded_from_dispatch THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'COMMERCIAL_ACCEPTANCE_REQUIRES_RESOLUTION: REMOVE descartaría trabajo operativo.';
        END IF;
        UPDATE logistica.sales_order_preparation_lines
           SET retired_at = now(), retired_by = p_actor_id,
               retirement_acceptance_id = v_version_id, updated_at = now()
         WHERE id = v_line.id;
      ELSE
        v_new_quantity := (v_action->>'newRequestedQuantity')::numeric;
        v_prepared := COALESCE(v_line.prepared_quantity, 0);
        IF v_new_quantity IS NULL OR v_new_quantity < v_prepared THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'COMMERCIAL_ACCEPTANCE_REQUIRES_RESOLUTION: UPDATE_QUANTITY es incompatible con lo preparado.';
        END IF;
        v_current := v_action->'current';
        UPDATE logistica.sales_order_preparation_lines
           SET requested_quantity = v_new_quantity,
               bsale_nv_id = (v_request.version_snapshot->>'physicalId')::bigint,
               bsale_detail_id = COALESCE(NULLIF(v_current->>'detailId', '')::bigint, bsale_detail_id),
               bsale_variant_id = NULLIF(v_current->>'variantId', '')::bigint,
               sku = NULLIF(v_current->>'sku', ''),
               product_name = COALESCE(NULLIF(v_current->>'productName', ''), product_name),
               source_snapshot = v_current,
               updated_at = now()
         WHERE id = v_line.id;
      END IF;
    END IF;
  END LOOP;

  SELECT COALESCE(max(sequence_no), 0) + 1 INTO v_sequence
    FROM logistica.sales_order_preparation_commercial_versions
   WHERE company_id = p_company_id AND card_id = p_card_id;
  INSERT INTO logistica.sales_order_preparation_commercial_versions (
    id, company_id, card_id, sequence_no, canonical_bsale_token,
    historical_bsale_nv_id, current_bsale_nv_id, previous_fingerprint,
    fingerprint, version_snapshot, applied_actions, accepted_by
  ) VALUES (
    v_version_id, p_company_id, p_card_id, v_sequence, v_card.canonical_bsale_token,
    v_card.bsale_nv_id, (v_request.version_snapshot->>'physicalId')::bigint,
    v_request.previous_fingerprint, p_expected_fingerprint,
    v_request.version_snapshot, v_request.plan_snapshot->'actions', p_actor_id
  );

  UPDATE logistica.sales_order_preparation_cards
     SET current_bsale_nv_id = (v_request.version_snapshot->>'physicalId')::bigint,
         updated_at = now()
   WHERE id = p_card_id;

  RETURN jsonb_build_object('status', 'ACCEPTED', 'version_id', v_version_id,
                            'fingerprint', p_expected_fingerprint);
END;
$$;

REVOKE ALL ON FUNCTION logistica.accept_sales_order_preparation_commercial_changes(uuid, uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION logistica.accept_sales_order_preparation_commercial_changes(uuid, uuid, uuid, text, uuid) TO service_role;

-- Una línea retirada conserva su evidencia, pero deja de ser mutable y no
-- puede volver a confirmarse por la RPC operativa existente.
CREATE OR REPLACE FUNCTION logistica.guard_retired_preparation_line()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = logistica, public
AS $$
BEGIN
  IF OLD.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'La línea de preparación está retirada y no puede modificarse.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_retired_preparation_line ON logistica.sales_order_preparation_lines;
CREATE TRIGGER guard_retired_preparation_line
  BEFORE UPDATE ON logistica.sales_order_preparation_lines
  FOR EACH ROW EXECUTE FUNCTION logistica.guard_retired_preparation_line();

-- Las funciones instaladas por los bloques anteriores deben tratar retired_at
-- como fuera del flujo activo. Se reemplaza sólo el predicado puntual, sin
-- editar migraciones históricas.
DO $patch_active_consumers$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_definition
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'logistica'
    AND p.proname = 'move_sales_order_preparation_card'
    AND pg_get_function_identity_arguments(p.oid) = 'p_company_id uuid, p_card_id uuid, p_to_status text, p_observation text, p_user_id uuid, p_user_name text';
  IF v_definition IS NULL THEN RAISE EXCEPTION 'No existe move_sales_order_preparation_card para proteger líneas retiradas.'; END IF;
  IF position('AND (line_status = ''PENDING'' OR prepared_quantity IS NULL)' IN v_definition) = 0
     AND position('AND retired_at IS NULL AND (line_status = ''PENDING'' OR prepared_quantity IS NULL)' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'No se encontró el predicado de pendientes de movimiento.';
  END IF;
  IF position('AND retired_at IS NULL AND (line_status = ''PENDING'' OR prepared_quantity IS NULL)' IN v_definition) = 0 THEN
    v_definition := replace(v_definition,
      'AND (line_status = ''PENDING'' OR prepared_quantity IS NULL)',
      'AND retired_at IS NULL AND (line_status = ''PENDING'' OR prepared_quantity IS NULL)');
  END IF;
  EXECUTE v_definition;

  SELECT pg_get_functiondef(p.oid) INTO v_definition
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'logistica'
    AND p.proname = 'confirm_sales_order_preparation_line'
    AND pg_get_function_identity_arguments(p.oid) = 'p_company_id uuid, p_line_id uuid, p_prepared_quantity numeric, p_reason_code text, p_observation text, p_excluded boolean';
  IF v_definition IS NULL THEN RAISE EXCEPTION 'No existe confirm_sales_order_preparation_line.'; END IF;
  IF position('WHERE l.id = p_line_id AND l.company_id = p_company_id FOR UPDATE' IN v_definition) = 0
     AND position('WHERE l.id = p_line_id AND l.company_id = p_company_id AND l.retired_at IS NULL FOR UPDATE' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'No se encontró el selector de líneas de confirmación.';
  END IF;
  v_definition := replace(v_definition,
    'WHERE l.id = p_line_id AND l.company_id = p_company_id FOR UPDATE',
    'WHERE l.id = p_line_id AND l.company_id = p_company_id AND l.retired_at IS NULL FOR UPDATE');
  EXECUTE v_definition;

  SELECT pg_get_functiondef(p.oid) INTO v_definition
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'logistica'
    AND p.proname = 'materialize_sales_order_audit_snapshot'
    AND pg_get_function_identity_arguments(p.oid) = 'p_company_id uuid, p_card_id uuid, p_actor_id uuid, p_cycle_no integer';
  IF v_definition IS NULL THEN RAISE EXCEPTION 'No existe materialize_sales_order_audit_snapshot.'; END IF;
  IF position('AND prepared_quantity IS NULL' IN v_definition) > 0 THEN
    v_definition := replace(v_definition, 'AND prepared_quantity IS NULL', 'AND retired_at IS NULL AND prepared_quantity IS NULL');
  END IF;
  IF position('AND pl.card_id = p_card_id' IN v_definition) > 0 THEN
    v_definition := replace(v_definition, 'AND pl.card_id = p_card_id', 'AND pl.card_id = p_card_id AND pl.retired_at IS NULL');
  END IF;
  EXECUTE v_definition;
END;
$patch_active_consumers$;

CREATE OR REPLACE FUNCTION logistica.get_sales_order_preparation_lines(
  p_company_id uuid, p_card_id uuid
)
RETURNS SETOF logistica.sales_order_preparation_lines
LANGUAGE plpgsql SECURITY DEFINER SET search_path = logistica, public AS $$
DECLARE v_actor uuid := auth.uid(); v_card logistica.sales_order_preparation_cards%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR NOT core.has_company_access(v_actor, p_company_id) THEN RAISE EXCEPTION 'Sin acceso a la empresa indicada.'; END IF;
  SELECT * INTO v_card FROM logistica.sales_order_preparation_cards WHERE id = p_card_id AND company_id = p_company_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tarjeta no encontrada.'; END IF;
  PERFORM logistica.materialize_sales_order_preparation_snapshot(p_company_id, p_card_id);
  RETURN QUERY SELECT * FROM logistica.sales_order_preparation_lines
    WHERE company_id = p_company_id AND card_id = p_card_id AND retired_at IS NULL
    ORDER BY bsale_detail_id;
END;
$$;

COMMIT;
