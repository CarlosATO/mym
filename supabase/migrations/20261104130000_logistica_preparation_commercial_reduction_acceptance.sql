-- ============================================================================
-- MEJ-01 Forward-only: Aceptación comercial segura de reducciones con
-- incidencias físicas resueltas durante Preparación (IN_PREPARATION).
--
-- Ajusta logistica.accept_sales_order_preparation_commercial_changes para
-- permitir UPDATE_QUANTITY sobre una línea con incidencia únicamente cuando:
--   1. La tarjeta permanece en IN_PREPARATION y bloqueada por el actor.
--   2. No existe evidencia de Auditoría.
--   3. La línea está en line_status = 'INCIDENT', no está excluida del
--      despacho (excluded_from_dispatch = false) y tiene prepared_quantity > 0.
--   4. La nueva cantidad comercial solicitada reduce requested_quantity y
--      coincide exactamente con prepared_quantity.
--   5. No existen incidencias OPEN ni de estado inválido en la línea.
--   6. Existe al menos una incidencia RESOLVED en la misma empresa, tarjeta y
--      línea con verification_status = 'MATCHED', incident_type =
--      'QUANTITY_REDUCTION', required_bsale_action = 'SET_QUANTITY',
--      requested_quantity = v_line.requested_quantity,
--      prepared_quantity = v_line.prepared_quantity,
--      expected_bsale_quantity = v_new_quantity e identidad de producto/versión
--      consistente con la versión comercial verificada.
--
-- Preserva prepared_quantity, line_status = 'INCIDENT', confirmed_by,
-- confirmed_at y el historial completo de incidencias sin alteración.
-- ============================================================================

BEGIN;

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
      IF EXISTS (SELECT 1 FROM logistica.sales_order_audit_lines WHERE preparation_line_id = v_line.id)
         OR EXISTS (SELECT 1 FROM logistica.sales_order_audit_incidents WHERE preparation_line_id = v_line.id)
         OR EXISTS (SELECT 1 FROM logistica.sales_order_audits WHERE company_id = p_company_id AND card_id = p_card_id) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'COMMERCIAL_ACCEPTANCE_REQUIRES_RESOLUTION: la línea tiene evidencia de Auditoría.';
      END IF;
      IF v_kind = 'REMOVE' THEN
        IF EXISTS (SELECT 1 FROM logistica.sales_order_preparation_incidents WHERE preparation_line_id = v_line.id) THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'COMMERCIAL_ACCEPTANCE_REQUIRES_RESOLUTION: la línea tiene una incidencia operativa.';
        END IF;
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
        v_current := v_action->'current';
        IF v_line.excluded_from_dispatch THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'COMMERCIAL_ACCEPTANCE_REQUIRES_RESOLUTION: la línea está excluida del despacho.';
        END IF;
        IF v_new_quantity IS NULL
           OR v_current IS NULL
           OR (v_current->>'quantity') IS NULL
           OR v_new_quantity IS DISTINCT FROM (v_current->>'quantity')::numeric
           OR v_new_quantity < v_prepared THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'COMMERCIAL_ACCEPTANCE_REQUIRES_RESOLUTION: UPDATE_QUANTITY es incompatible con lo preparado.';
        END IF;
        IF (NULLIF(v_current->>'variantId', '') IS NULL AND NULLIF(btrim(v_current->>'sku'), '') IS NULL)
           OR NULLIF(v_current->>'variantId', '')::bigint IS DISTINCT FROM v_line.bsale_variant_id
           OR NULLIF(upper(btrim(v_current->>'sku')), '') IS DISTINCT FROM NULLIF(upper(btrim(v_line.sku)), '') THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'COMMERCIAL_ACCEPTANCE_REQUIRES_RESOLUTION: la identidad canónica del producto no coincide con la línea operativa.';
        END IF;
        IF v_line.line_status = 'INCIDENT'
           OR EXISTS (SELECT 1 FROM logistica.sales_order_preparation_incidents WHERE preparation_line_id = v_line.id) THEN
          IF v_line.line_status <> 'INCIDENT'
             OR v_line.prepared_quantity IS NULL
             OR v_line.prepared_quantity <= 0
             OR v_line.requested_quantity <= v_line.prepared_quantity
             OR v_new_quantity <> v_line.prepared_quantity
             OR EXISTS (
               SELECT 1
                 FROM logistica.sales_order_preparation_incidents i
                WHERE i.preparation_line_id = v_line.id
                  AND (
                    i.company_id IS DISTINCT FROM p_company_id
                    OR i.card_id IS DISTINCT FROM p_card_id
                    OR i.status NOT IN ('RESOLVED', 'SUPERSEDED')
                  )
             )
             OR NOT EXISTS (
               SELECT 1
                 FROM logistica.sales_order_preparation_incidents i
                WHERE i.preparation_line_id = v_line.id
                  AND i.company_id = p_company_id
                  AND i.card_id = p_card_id
                  AND i.status = 'RESOLVED'
             )
             OR EXISTS (
               SELECT 1
                 FROM logistica.sales_order_preparation_incidents i
                WHERE i.preparation_line_id = v_line.id
                  AND i.status = 'RESOLVED'
                  AND (
                    i.company_id IS DISTINCT FROM p_company_id
                    OR i.card_id IS DISTINCT FROM p_card_id
                    OR i.incident_type IS DISTINCT FROM 'QUANTITY_REDUCTION'
                    OR i.required_bsale_action IS DISTINCT FROM 'SET_QUANTITY'
                    OR i.verification_status IS DISTINCT FROM 'MATCHED'
                    OR i.requested_quantity IS DISTINCT FROM v_line.requested_quantity
                    OR i.prepared_quantity IS DISTINCT FROM v_line.prepared_quantity
                    OR i.expected_bsale_quantity IS DISTINCT FROM v_new_quantity
                    OR i.bsale_observed_quantity IS DISTINCT FROM v_new_quantity
                    OR (i.bsale_variant_id IS NULL AND NULLIF(btrim(i.sku), '') IS NULL)
                    OR i.bsale_variant_id IS DISTINCT FROM v_line.bsale_variant_id
                    OR NULLIF(upper(btrim(i.sku)), '') IS DISTINCT FROM NULLIF(upper(btrim(v_line.sku)), '')
                    OR i.bsale_observed_snapshot IS NULL
                    OR jsonb_typeof(i.bsale_observed_snapshot) IS DISTINCT FROM 'object'
                    OR jsonb_typeof(i.bsale_observed_snapshot->'verification_basis') IS DISTINCT FROM 'string'
                    OR (i.bsale_observed_snapshot->>'verification_basis') IS DISTINCT FROM 'FULL_CARD_AND_INCIDENT_ACTION_WITH_PHYSICAL_LINE'
                    OR (
                      i.bsale_observed_snapshot ? 'verification_error'
                      AND i.bsale_observed_snapshot->'verification_error' IS DISTINCT FROM 'null'::jsonb
                      AND i.bsale_observed_snapshot->'verification_error' IS DISTINCT FROM '""'::jsonb
                    )
                    OR jsonb_typeof(i.bsale_observed_snapshot->'document_state') IS DISTINCT FROM 'number'
                    OR (i.bsale_observed_snapshot->>'document_state') !~ '^[0-9]+$'
                    OR (i.bsale_observed_snapshot->>'document_state')::integer IS DISTINCT FROM 0
                    OR i.bsale_observed_snapshot->'canonical_identity_matched' IS DISTINCT FROM 'true'::jsonb
                    OR i.bsale_observed_snapshot->'sync_proven' IS DISTINCT FROM 'true'::jsonb
                    OR i.bsale_observed_snapshot->'line_link_valid' IS DISTINCT FROM 'true'::jsonb
                    OR i.bsale_observed_snapshot->'full_card_matched' IS DISTINCT FROM 'true'::jsonb
                    OR i.bsale_observed_snapshot->'incident_action_matched' IS DISTINCT FROM 'true'::jsonb
                    OR jsonb_typeof(i.bsale_observed_snapshot->'required_bsale_action') IS DISTINCT FROM 'string'
                    OR (i.bsale_observed_snapshot->>'required_bsale_action') IS DISTINCT FROM 'SET_QUANTITY'
                    OR jsonb_typeof(i.bsale_observed_snapshot->'preparation_line_id') IS DISTINCT FROM 'string'
                    OR (i.bsale_observed_snapshot->>'preparation_line_id') IS DISTINCT FROM v_line.id::text
                    OR jsonb_typeof(i.bsale_observed_snapshot->'matched_preparation_line_id') IS DISTINCT FROM 'string'
                    OR (i.bsale_observed_snapshot->>'matched_preparation_line_id') IS DISTINCT FROM v_line.id::text
                    OR jsonb_typeof(i.bsale_observed_snapshot->'expected_bsale_quantity') IS DISTINCT FROM 'number'
                    OR (i.bsale_observed_snapshot->>'expected_bsale_quantity')::numeric IS DISTINCT FROM v_new_quantity
                    OR jsonb_typeof(i.bsale_observed_snapshot->'bsale_observed_quantity') IS DISTINCT FROM 'number'
                    OR (i.bsale_observed_snapshot->>'bsale_observed_quantity')::numeric IS DISTINCT FROM v_new_quantity
                    OR jsonb_typeof(i.bsale_observed_snapshot->'physically_prepared_quantity') IS DISTINCT FROM 'number'
                    OR (i.bsale_observed_snapshot->>'physically_prepared_quantity')::numeric IS DISTINCT FROM v_line.prepared_quantity
                    OR jsonb_typeof(i.bsale_observed_snapshot->'document_id') IS DISTINCT FROM 'number'
                    OR (i.bsale_observed_snapshot->>'document_id') !~ '^[0-9]+$'
                    OR (i.bsale_observed_snapshot->>'document_id')::bigint <= 0
                    OR (i.bsale_observed_snapshot->>'document_id')::bigint IS DISTINCT FROM (v_request.version_snapshot->>'physicalId')::bigint
                    OR jsonb_typeof(i.bsale_observed_snapshot->'current_nv_id') IS DISTINCT FROM 'number'
                    OR (i.bsale_observed_snapshot->>'current_nv_id') !~ '^[0-9]+$'
                    OR (i.bsale_observed_snapshot->>'current_nv_id')::bigint <= 0
                    OR (i.bsale_observed_snapshot->>'current_nv_id')::bigint IS DISTINCT FROM (v_request.version_snapshot->>'physicalId')::bigint
                    OR EXISTS (
                      SELECT 1
                        FROM unnest(ARRAY['physical_id', 'physicalId', 'documentId', 'currentNvId', 'nv_id', 'nvId']) AS extra_key(k)
                       WHERE i.bsale_observed_snapshot ? extra_key.k
                         AND (
                           jsonb_typeof(i.bsale_observed_snapshot->extra_key.k) IS DISTINCT FROM 'number'
                           OR (i.bsale_observed_snapshot->>extra_key.k) !~ '^[0-9]+$'
                           OR (i.bsale_observed_snapshot->>extra_key.k)::bigint <= 0
                           OR (i.bsale_observed_snapshot->>extra_key.k)::bigint IS DISTINCT FROM (v_request.version_snapshot->>'physicalId')::bigint
                         )
                    )
                  )
             ) THEN
            RAISE EXCEPTION USING
              ERRCODE = 'P0001',
              MESSAGE = 'COMMERCIAL_ACCEPTANCE_REQUIRES_RESOLUTION: la línea tiene una incidencia operativa.';
          END IF;
        END IF;
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

COMMIT;
