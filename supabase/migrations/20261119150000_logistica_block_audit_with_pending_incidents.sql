-- Bloque 1: impedir que una Nota de Venta avance de IN_PREPARATION a IN_AUDIT
-- con líneas pendientes, diferencias comerciales sin reconciliar, incidencias
-- abiertas o una versión Bsale modificada todavía no aceptada.
-- Forward-only: no altera auditorías históricas ni estados previos.

BEGIN;

CREATE OR REPLACE FUNCTION logistica.move_sales_order_preparation_card(
  p_company_id uuid, p_card_id uuid, p_to_status text, p_observation text,
  p_user_id uuid, p_user_name text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = logistica, integraciones, core, portal, public AS $$
DECLARE
  v_card logistica.sales_order_preparation_cards%ROWTYPE;
  v_from_status text;
  v_active_lines integer;
  v_pending integer;
  v_incident_lines integer;
  v_open_incidents integer;
  v_latest_accepted_nv_id bigint;
  v_latest_accepted_at timestamptz;
  v_known_bsale_nv_id bigint;
  v_canonical_current_nv_id bigint;
  v_pending_acceptance_requests integer;
  v_effective_bsale_nv_id bigint;
  v_bsale_doc_state integer;
  v_bsale_doc_found boolean := false;
  v_bsale_detail_count integer := 0;
  v_known_doc_found boolean := false;
  v_known_detail_count integer := 0;
  v_commercial_header_diff boolean := false;
  v_commercial_version_diff_count integer := 0;
  v_bsale_diff_count integer := 0;
  v_assigned_user_name text;
  v_locked_by_user_name text;
  v_interrupted_audit_id uuid;
  v_interrupted_at timestamptz := now();
BEGIN
  SELECT * INTO v_card
  FROM logistica.sales_order_preparation_cards
  WHERE id = p_card_id
  FOR UPDATE;
  IF NOT FOUND OR v_card.company_id <> p_company_id THEN
    RAISE EXCEPTION 'Tarjeta no encontrada o empresa invalida.';
  END IF;
  v_from_status := v_card.status;

  IF p_to_status = 'AUDITED' THEN
    RAISE EXCEPTION 'El estado Auditada sólo se obtiene finalizando la Auditoría.';
  END IF;
  IF v_from_status = 'AUDITED' THEN
    RAISE EXCEPTION 'Una Nota de Venta Auditada es terminal y no puede moverse manualmente.';
  END IF;
  IF v_from_status = 'IN_PREPARATION' AND p_to_status = 'IN_PREPARATION' THEN
    RAISE EXCEPTION 'Esta Nota de Venta ya fue tomada por otro preparador.';
  END IF;

  IF v_from_status = 'PENDING_ROUTE_PREP' AND p_to_status <> 'IN_PREPARATION' THEN
    RAISE EXCEPTION 'Desde Pendiente solo se puede pasar a En Preparacion.';
  END IF;
  IF v_from_status = 'IN_PREPARATION' AND p_to_status NOT IN ('IN_AUDIT', 'PENDING_ROUTE_PREP') THEN
    RAISE EXCEPTION 'Transicion invalida desde En Preparacion.';
  END IF;
  IF v_from_status = 'IN_AUDIT' AND p_to_status NOT IN ('IN_PREPARATION', 'PENDING_ROUTE_PREP') THEN
    RAISE EXCEPTION 'Transicion invalida desde Auditoria.';
  END IF;
  IF p_to_status = v_from_status THEN
    RAISE EXCEPTION 'La tarjeta ya se encuentra en el estado indicado.';
  END IF;

  IF v_from_status = 'IN_PREPARATION' THEN
    IF v_card.locked_by_user_id IS NULL THEN
      RAISE EXCEPTION 'Esta preparación aún no tiene responsable. Tómala antes de moverla.';
    END IF;
    IF v_card.locked_by_user_id <> p_user_id THEN
      RAISE EXCEPTION 'Esta preparación está asignada a otro usuario.';
    END IF;
  END IF;

  IF (p_to_status IN ('PENDING_ROUTE_PREP', 'IN_PREPARATION') AND v_from_status = 'IN_AUDIT')
     OR p_to_status = 'PENDING_ROUTE_PREP' THEN
    IF p_observation IS NULL OR btrim(p_observation) = '' THEN
      RAISE EXCEPTION 'Se requiere observacion para retroceder.';
    END IF;
  END IF;

  -- El snapshot OPEN deja de ser operativo antes de que la tarjeta vuelva a
  -- Preparacion. La siguiente toma calculara max(cycle_no) + 1.
  IF v_from_status = 'IN_AUDIT' AND p_to_status IN ('IN_PREPARATION', 'PENDING_ROUTE_PREP') THEN
    SELECT id INTO v_interrupted_audit_id
    FROM logistica.sales_order_audits
    WHERE company_id = p_company_id
      AND card_id = p_card_id
      AND status = 'OPEN'
    ORDER BY cycle_no DESC
    LIMIT 1
    FOR UPDATE;

    IF v_interrupted_audit_id IS NOT NULL THEN
      UPDATE logistica.sales_order_audits
         SET status = 'CLOSED',
             completed_at = v_interrupted_at,
             locked_by_user_id = NULL,
             locked_at = NULL,
             updated_at = v_interrupted_at
       WHERE id = v_interrupted_audit_id;

      UPDATE logistica.sales_order_audit_incidents
         SET status = 'SUPERSEDED',
             metadata = metadata || jsonb_build_object(
               'superseded_reason', 'AUDIT_INTERRUPTED_RETURN_TO_PREPARATION',
               'superseded_at', v_interrupted_at,
               'superseded_by', p_user_id
             ),
             updated_at = v_interrupted_at
       WHERE company_id = p_company_id
         AND audit_id = v_interrupted_audit_id
         AND status = 'OPEN';
    END IF;
  END IF;

  IF p_to_status = 'IN_PREPARATION' THEN
    PERFORM logistica.materialize_sales_order_preparation_snapshot(p_company_id, p_card_id);
  ELSIF p_to_status = 'IN_AUDIT' THEN
    PERFORM logistica.materialize_sales_order_preparation_snapshot(p_company_id, p_card_id);

    SELECT * INTO v_card
    FROM logistica.sales_order_preparation_cards
    WHERE id = p_card_id;

    -- 1. Líneas activas: ninguna línea puede estar pendiente ni con diferencias/exclusiones sin reconciliar.
    --    Tras aceptar una reducción parcial comercial (20261104140000), la línea conserva
    --    line_status = 'INCIDENT' pero con requested_quantity = prepared_quantity > 0 e incidencia RESOLVED + MATCHED.
    SELECT
      count(*),
      count(*) FILTER (WHERE pl.line_status = 'PENDING' OR pl.prepared_quantity IS NULL),
      count(*) FILTER (
        WHERE NOT (pl.line_status = 'PENDING' OR pl.prepared_quantity IS NULL)
          AND (
            pl.prepared_quantity <= 0
            OR pl.prepared_quantity <> pl.requested_quantity
            OR COALESCE(pl.excluded_from_dispatch, false) = true
            OR pl.line_status NOT IN ('CONFIRMED', 'INCIDENT')
            OR (
              pl.line_status = 'INCIDENT'
              AND NOT EXISTS (
                SELECT 1
                FROM logistica.sales_order_preparation_incidents ri
                WHERE ri.company_id = p_company_id
                  AND ri.card_id = p_card_id
                  AND ri.preparation_line_id = pl.id
                  AND ri.status = 'RESOLVED'
                  AND ri.verification_status = 'MATCHED'
              )
            )
          )
      )
    INTO v_active_lines, v_pending, v_incident_lines
    FROM logistica.sales_order_preparation_lines pl
    WHERE pl.company_id = p_company_id
      AND pl.card_id = p_card_id
      AND pl.retired_at IS NULL;

    IF v_active_lines = 0 THEN
      RAISE EXCEPTION 'La Nota de Venta no tiene líneas activas confirmadas para enviar a Auditoría.';
    END IF;

    IF v_pending > 0 THEN
      RAISE EXCEPTION 'Faltan % productos por confirmar.', v_pending;
    END IF;

    IF v_incident_lines > 0 THEN
      RAISE EXCEPTION 'Preparación con incidencias. La nota permanecerá En preparación mientras se regularizan las diferencias en Bsale. Puedes continuar preparando los demás productos. Una vez reconciliados todos los cambios y confirmadas las líneas, se habilitará el envío a Auditoría.';
    END IF;

    -- 2. Incidencias comerciales abiertas bloquean el paso a Auditoría.
    SELECT count(*) INTO v_open_incidents
    FROM logistica.sales_order_preparation_incidents
    WHERE company_id = p_company_id
      AND card_id = p_card_id
      AND status = 'OPEN';

    IF v_open_incidents > 0 THEN
      RAISE EXCEPTION 'Preparación con incidencias. La nota permanecerá En preparación mientras se regularizan las diferencias en Bsale. Puedes continuar preparando los demás productos. Una vez reconciliados todos los cambios y confirmadas las líneas, se habilitará el envío a Auditoría.';
    END IF;

    -- 3. Identidad canónica Bsale y solicitudes comerciales pendientes (fail-closed).
    SELECT current_bsale_nv_id, accepted_at
      INTO v_latest_accepted_nv_id, v_latest_accepted_at
    FROM logistica.sales_order_preparation_commercial_versions
    WHERE company_id = p_company_id
      AND card_id = p_card_id
    ORDER BY sequence_no DESC
    LIMIT 1;

    v_known_bsale_nv_id := COALESCE(v_latest_accepted_nv_id, v_card.bsale_nv_id);

    IF NULLIF(btrim(v_card.canonical_bsale_token), '') IS NULL THEN
      RAISE EXCEPTION 'No se pudo verificar la identidad canónica vigente de la Nota de Venta en Bsale. Sincroniza e intenta nuevamente antes de enviar a Auditoría.';
    END IF;

    SELECT current_bsale_id INTO v_canonical_current_nv_id
    FROM integraciones.vw_bsale_sales_order_documents_canonical
    WHERE company_id = p_company_id
      AND canonical_bsale_token = v_card.canonical_bsale_token;

    IF v_canonical_current_nv_id IS NULL THEN
      RAISE EXCEPTION 'No se encontró la identidad canónica vigente de la Nota de Venta en el espejo Bsale. Sincroniza antes de enviar a Auditoría.';
    END IF;

    IF v_card.current_bsale_nv_id IS NOT NULL
       AND v_card.current_bsale_nv_id IS DISTINCT FROM v_canonical_current_nv_id
       AND v_card.current_bsale_nv_id IS DISTINCT FROM v_known_bsale_nv_id THEN
      RAISE EXCEPTION 'La Nota de Venta fue modificada en Bsale y todavía tiene cambios comerciales sin aceptar. Acepta y reconcilia los cambios antes de enviar a Auditoría.';
    END IF;

    SELECT count(*) INTO v_pending_acceptance_requests
    FROM logistica.sales_order_preparation_commercial_acceptance_requests r
    WHERE r.company_id = p_company_id
      AND r.card_id = p_card_id
      AND (v_latest_accepted_at IS NULL OR r.created_at > v_latest_accepted_at)
      AND NOT EXISTS (
        SELECT 1
        FROM logistica.sales_order_preparation_commercial_versions v
        WHERE v.company_id = r.company_id
          AND v.card_id = r.card_id
          AND v.fingerprint = r.expected_fingerprint
      );

    IF v_pending_acceptance_requests > 0 THEN
      RAISE EXCEPTION 'La Nota de Venta fue modificada en Bsale y todavía tiene cambios comerciales sin aceptar. Acepta y reconcilia los cambios antes de enviar a Auditoría.';
    END IF;

    -- 4. Consistencia verificable contra el espejo local vigente de Bsale (fail-closed).
    v_effective_bsale_nv_id := v_canonical_current_nv_id;

    SELECT d.state, true INTO v_bsale_doc_state, v_bsale_doc_found
    FROM integraciones.bsale_documents d
    WHERE d.company_id = p_company_id
      AND d.bsale_id = v_effective_bsale_nv_id
      AND d.document_type_id = 23
      AND d.number::text = v_card.bsale_nv_folio
      AND NULLIF(btrim(d.raw_json ->> 'token'), '') = v_card.canonical_bsale_token
    LIMIT 1;

    IF NOT COALESCE(v_bsale_doc_found, false) THEN
      RAISE EXCEPTION 'No se encontró el documento vigente de la Nota de Venta en el espejo Bsale. Sincroniza antes de enviar a Auditoría.';
    END IF;

    IF v_bsale_doc_state IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'La Nota de Venta no está vigente en Bsale y no puede enviarse a Auditoría.';
    END IF;

    SELECT count(*) INTO v_bsale_detail_count
    FROM integraciones.bsale_document_details det
    WHERE det.company_id = p_company_id
      AND det.bsale_document_id = v_effective_bsale_nv_id;

    IF v_bsale_detail_count = 0 THEN
      RAISE EXCEPTION 'La Nota de Venta vigente en Bsale no tiene detalles verificables. Sincroniza antes de enviar a Auditoría.';
    END IF;

    -- Si Bsale recreó la NV con un nuevo ID físico, sólo permitir avanzar
    -- sin aceptación comercial cuando se verifique equivalencia comercial total
    -- (encabezado + totales + multiconjunto exacto de líneas) contra la versión conocida.
    IF v_effective_bsale_nv_id IS DISTINCT FROM v_known_bsale_nv_id THEN
      SELECT
        true,
        (
          known_doc.net_amount IS DISTINCT FROM current_doc.net_amount
          OR known_doc.tax_amount IS DISTINCT FROM current_doc.tax_amount
          OR known_doc.total_amount IS DISTINCT FROM current_doc.total_amount
          OR known_doc.exempt_amount IS DISTINCT FROM current_doc.exempt_amount
          OR known_doc.client_id IS DISTINCT FROM current_doc.client_id
          OR known_doc.office_id IS DISTINCT FROM current_doc.office_id
        )
      INTO v_known_doc_found, v_commercial_header_diff
      FROM integraciones.bsale_documents known_doc
      JOIN integraciones.bsale_documents current_doc
        ON current_doc.company_id = known_doc.company_id
       AND current_doc.bsale_id = v_effective_bsale_nv_id
      WHERE known_doc.company_id = p_company_id
        AND known_doc.bsale_id = v_known_bsale_nv_id
        AND known_doc.document_type_id = 23
        AND known_doc.number::text = v_card.bsale_nv_folio
        AND NULLIF(btrim(known_doc.raw_json ->> 'token'), '') = v_card.canonical_bsale_token
      LIMIT 1;

      IF NOT COALESCE(v_known_doc_found, false) OR COALESCE(v_commercial_header_diff, true) THEN
        RAISE EXCEPTION 'La Nota de Venta fue modificada en Bsale y todavía tiene cambios comerciales sin aceptar. Acepta y reconcilia los cambios antes de enviar a Auditoría.';
      END IF;

      SELECT count(*) INTO v_known_detail_count
      FROM integraciones.bsale_document_details det
      WHERE det.company_id = p_company_id
        AND det.bsale_document_id = v_known_bsale_nv_id;

      IF v_known_detail_count = 0 THEN
        RAISE EXCEPTION 'La Nota de Venta fue modificada en Bsale y todavía tiene cambios comerciales sin aceptar. Acepta y reconcilia los cambios antes de enviar a Auditoría.';
      END IF;

      WITH known_lines AS (
        SELECT
          det.variant_id,
          NULLIF(upper(btrim(det.variant_code)), '') AS sku,
          det.quantity,
          det.net_unit_value,
          det.net_amount,
          det.tax_amount,
          det.total_amount,
          COALESCE(det.net_discount, 0) AS net_discount
        FROM integraciones.bsale_document_details det
        WHERE det.company_id = p_company_id
          AND det.bsale_document_id = v_known_bsale_nv_id
      ),
      current_lines AS (
        SELECT
          det.variant_id,
          NULLIF(upper(btrim(det.variant_code)), '') AS sku,
          det.quantity,
          det.net_unit_value,
          det.net_amount,
          det.tax_amount,
          det.total_amount,
          COALESCE(det.net_discount, 0) AS net_discount
        FROM integraciones.bsale_document_details det
        WHERE det.company_id = p_company_id
          AND det.bsale_document_id = v_effective_bsale_nv_id
      ),
      commercial_diffs AS (
        (SELECT * FROM known_lines EXCEPT ALL SELECT * FROM current_lines)
        UNION ALL
        (SELECT * FROM current_lines EXCEPT ALL SELECT * FROM known_lines)
      )
      SELECT count(*) INTO v_commercial_version_diff_count
      FROM commercial_diffs;

      IF v_commercial_version_diff_count > 0 THEN
        RAISE EXCEPTION 'La Nota de Venta fue modificada en Bsale y todavía tiene cambios comerciales sin aceptar. Acepta y reconcilia los cambios antes de enviar a Auditoría.';
      END IF;
    END IF;

    WITH prepared_keys AS (
      SELECT
        CASE
          WHEN NULLIF(btrim(pl.sku), '') IS NOT NULL THEN 'SKU:' || upper(btrim(pl.sku))
          WHEN pl.bsale_variant_id IS NOT NULL THEN 'VARIANT:' || pl.bsale_variant_id::text
          ELSE 'LINE:' || pl.id::text
        END AS product_key,
        sum(COALESCE(pl.prepared_quantity, 0)) AS qty
      FROM logistica.sales_order_preparation_lines pl
      WHERE pl.company_id = p_company_id
        AND pl.card_id = p_card_id
        AND pl.retired_at IS NULL
      GROUP BY 1
    ),
    bsale_keys AS (
      SELECT
        CASE
          WHEN NULLIF(btrim(det.variant_code), '') IS NOT NULL THEN 'SKU:' || upper(btrim(det.variant_code))
          WHEN det.variant_id IS NOT NULL THEN 'VARIANT:' || det.variant_id::text
          ELSE 'DETAIL:' || det.bsale_id::text
        END AS product_key,
        sum(COALESCE(det.quantity, 0)) AS qty
      FROM integraciones.bsale_document_details det
      WHERE det.company_id = p_company_id
        AND det.bsale_document_id = v_effective_bsale_nv_id
      GROUP BY 1
    )
    SELECT count(*) INTO v_bsale_diff_count
    FROM prepared_keys p
    FULL JOIN bsale_keys b ON b.product_key = p.product_key
    WHERE COALESCE(p.qty, 0) <> COALESCE(b.qty, 0);

    IF v_bsale_diff_count > 0 THEN
      RAISE EXCEPTION 'Preparación con incidencias. La nota permanecerá En preparación mientras se regularizan las diferencias en Bsale. Puedes continuar preparando los demás productos. Una vez reconciliados todos los cambios y confirmadas las líneas, se habilitará el envío a Auditoría.';
    END IF;
  END IF;

  INSERT INTO logistica.sales_order_preparation_movements (
    company_id, card_id, from_status, to_status, moved_by, movement_source,
    observation, metadata
  ) VALUES (
    p_company_id, p_card_id, v_from_status, p_to_status, p_user_id, 'USER',
    p_observation,
    jsonb_build_object(
      'moved_by_name', p_user_name,
      'lock_acquired', p_to_status = 'IN_PREPARATION',
      'lock_released', v_from_status = 'IN_PREPARATION'
        AND p_to_status IN ('IN_AUDIT', 'PENDING_ROUTE_PREP'),
      'interrupted_audit_id', v_interrupted_audit_id
    )
  );

  UPDATE logistica.sales_order_preparation_cards
     SET status = p_to_status,
         assigned_user_id = CASE
           WHEN p_to_status IN ('IN_PREPARATION', 'IN_AUDIT') THEN p_user_id
           ELSE assigned_user_id
         END,
         locked_by_user_id = CASE WHEN p_to_status = 'IN_PREPARATION' THEN p_user_id ELSE NULL END,
         locked_at = CASE WHEN p_to_status = 'IN_PREPARATION' THEN now() ELSE NULL END,
         last_moved_by = p_user_id,
         last_moved_at = now(),
         updated_at = now()
   WHERE id = p_card_id
   RETURNING * INTO v_card;

  SELECT NULLIF(btrim(concat_ws(' ', u.nombre, u.apellido)), '')
    INTO v_assigned_user_name FROM portal.users u WHERE u.id = v_card.assigned_user_id;
  SELECT NULLIF(btrim(concat_ws(' ', u.nombre, u.apellido)), '')
    INTO v_locked_by_user_name FROM portal.users u WHERE u.id = v_card.locked_by_user_id;

  RETURN jsonb_build_object(
    'card_id', p_card_id,
    'from_status', v_from_status,
    'to_status', p_to_status,
    'assigned_user_id', v_card.assigned_user_id,
    'assigned_user_name', v_assigned_user_name,
    'locked_by_user_id', v_card.locked_by_user_id,
    'locked_by_user_name', v_locked_by_user_name,
    'locked_at', v_card.locked_at,
    'interrupted_audit_id', v_interrupted_audit_id
  );
END;
$$;

REVOKE ALL ON FUNCTION logistica.move_sales_order_preparation_card(uuid, uuid, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION logistica.move_sales_order_preparation_card(uuid, uuid, text, text, uuid, text) TO service_role;

COMMIT;
