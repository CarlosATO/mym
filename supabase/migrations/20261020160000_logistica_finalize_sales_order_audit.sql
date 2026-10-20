-- ============================================================================
-- Auditoría de Notas de Venta · Finalización (IN_AUDIT -> AUDITED)
--
-- Este bloque cierra la Auditoría física. No factura, no asigna ruta, no
-- modifica Bsale y no abre un estado posterior a AUDITED.
--
-- AUDITED es terminal en Preparación/Auditoría: sólo se entra por
-- logistica.finalize_sales_order_audit y no se sale por drag & drop.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. Estado AUDITED en la tarjeta
--    Se parte del constraint REAL vigente en producción:
--      PENDING_ROUTE_PREP, IN_PREPARATION, IN_AUDIT,
--      INVOICED_READY_FOR_ROUTE, CANCELLED
-- ============================================================================
ALTER TABLE logistica.sales_order_preparation_cards
    DROP CONSTRAINT IF EXISTS sales_order_preparation_cards_status_check;

ALTER TABLE logistica.sales_order_preparation_cards
    ADD CONSTRAINT sales_order_preparation_cards_status_check
    CHECK (status IN (
        'PENDING_ROUTE_PREP',
        'IN_PREPARATION',
        'IN_AUDIT',
        'INVOICED_READY_FOR_ROUTE',
        'CANCELLED',
        'AUDITED'
    ));

-- ============================================================================
-- 2. Estado COMPLETED en la sesión de Auditoría
--    Se conserva CLOSED por compatibilidad de datos históricos.
-- ============================================================================
ALTER TABLE logistica.sales_order_audits
    DROP CONSTRAINT IF EXISTS sales_order_audits_status_check;

ALTER TABLE logistica.sales_order_audits
    ADD CONSTRAINT sales_order_audits_status_check
    CHECK (status IN ('OPEN', 'CLOSED', 'COMPLETED'));

ALTER TABLE logistica.sales_order_audits
    DROP CONSTRAINT IF EXISTS sales_order_audits_completed_consistency;

ALTER TABLE logistica.sales_order_audits
    ADD CONSTRAINT sales_order_audits_completed_consistency
    CHECK (
        (status = 'OPEN' AND completed_at IS NULL)
        OR (status IN ('CLOSED', 'COMPLETED') AND completed_at IS NOT NULL)
    );

-- ============================================================================
-- 3. Kanban: la tarjeta Auditada sigue visible hasta facturación
--    Se replica la definición REAL vigente y sólo se agrega AUDITED.
-- ============================================================================
CREATE OR REPLACE VIEW logistica.vw_sales_order_preparation_board AS
SELECT
    c.id AS card_id, c.company_id, c.status, c.priority, c.assigned_user_id,
    c.route_date, c.normalized_city, nv.nv_bsale_id, nv.nv_folio,
    nv.nv_emission_date, nv.nv_generation_date, nv.client_name, nv.city_raw,
    nv.municipality_raw, nv.address_raw, nv.seller_bsale_id, nv.seller_name,
    nv.total_quantity, nv.total_amount, nv.invoice_folio, nv.is_invoiced,
    c.created_at, c.updated_at, nv.net_amount, nv.tax_amount, nv.gross_amount,
    c.locked_by_user_id, c.locked_at
FROM logistica.sales_order_preparation_cards c
JOIN integraciones.vw_bsale_sales_orders_for_preparation nv
  ON c.company_id = nv.company_id AND c.bsale_nv_id = nv.nv_bsale_id
WHERE c.closed_at IS NULL
  AND c.status IN ('PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT', 'AUDITED')
  AND nv.is_invoiced = false
  AND NOT EXISTS (
    SELECT 1
    FROM logistica.sales_order_preparation_exclusions e
    WHERE e.company_id = c.company_id
      AND e.bsale_nv_id = c.bsale_nv_id
      AND e.active = true
  );

ALTER VIEW logistica.vw_sales_order_preparation_board SET (security_invoker = true);

-- ============================================================================
-- 4. Evidencia histórica visible después del cierre
--    Lectura: permite OPEN, COMPLETED y CLOSED.
--    Escritura: sólo OPEN (refuerza la inmutabilidad a nivel de Storage).
-- ============================================================================
CREATE OR REPLACE FUNCTION logistica.is_audit_evidence_path_allowed(p_object_name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_company_id uuid;
    v_card_id uuid;
    v_audit_id uuid;
BEGIN
    v_actor_id := auth.uid();

    IF v_actor_id IS NULL OR p_object_name IS NULL OR btrim(p_object_name) = '' THEN
        RETURN false;
    END IF;

    IF p_object_name !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[^/]+\.(jpg|jpeg|png|webp|heic)$' THEN
        RETURN false;
    END IF;

    BEGIN
        v_company_id := split_part(p_object_name, '/', 1)::uuid;
        v_card_id := split_part(p_object_name, '/', 2)::uuid;
        v_audit_id := split_part(p_object_name, '/', 3)::uuid;
    EXCEPTION WHEN OTHERS THEN
        RETURN false;
    END;

    IF NOT core.has_company_access(v_actor_id, v_company_id) THEN
        RETURN false;
    END IF;

    IF NOT core.has_permission_for_company(v_actor_id, v_company_id, 'logistica.audit.manage') THEN
        RETURN false;
    END IF;

    RETURN EXISTS (
        SELECT 1
        FROM logistica.sales_order_audits a
        WHERE a.company_id = v_company_id
          AND a.card_id = v_card_id
          AND a.id = v_audit_id
          AND a.status IN ('OPEN', 'COMPLETED', 'CLOSED')
    );
END;
$$;

ALTER FUNCTION logistica.is_audit_evidence_path_allowed(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION logistica.is_audit_evidence_path_allowed(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION logistica.is_audit_evidence_path_allowed(text) TO authenticated;

CREATE OR REPLACE FUNCTION logistica.is_audit_evidence_path_writable(p_object_name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_company_id uuid;
    v_card_id uuid;
    v_audit_id uuid;
BEGIN
    v_actor_id := auth.uid();

    IF v_actor_id IS NULL OR p_object_name IS NULL OR btrim(p_object_name) = '' THEN
        RETURN false;
    END IF;

    IF p_object_name !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[^/]+\.(jpg|jpeg|png|webp|heic)$' THEN
        RETURN false;
    END IF;

    BEGIN
        v_company_id := split_part(p_object_name, '/', 1)::uuid;
        v_card_id := split_part(p_object_name, '/', 2)::uuid;
        v_audit_id := split_part(p_object_name, '/', 3)::uuid;
    EXCEPTION WHEN OTHERS THEN
        RETURN false;
    END;

    IF NOT core.has_company_access(v_actor_id, v_company_id) THEN
        RETURN false;
    END IF;

    IF NOT core.has_permission_for_company(v_actor_id, v_company_id, 'logistica.audit.manage') THEN
        RETURN false;
    END IF;

    RETURN EXISTS (
        SELECT 1
        FROM logistica.sales_order_audits a
        WHERE a.company_id = v_company_id
          AND a.card_id = v_card_id
          AND a.id = v_audit_id
          AND a.status = 'OPEN'
    );
END;
$$;

ALTER FUNCTION logistica.is_audit_evidence_path_writable(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION logistica.is_audit_evidence_path_writable(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION logistica.is_audit_evidence_path_writable(text) TO authenticated;

DROP POLICY IF EXISTS audit_evidence_insert ON storage.objects;
CREATE POLICY audit_evidence_insert ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
    bucket_id = 'audit-evidence'
    AND owner = auth.uid()
    AND logistica.is_audit_evidence_path_writable(name)
);

DROP POLICY IF EXISTS audit_evidence_delete ON storage.objects;
CREATE POLICY audit_evidence_delete ON storage.objects FOR DELETE TO authenticated
USING (
    bucket_id = 'audit-evidence'
    AND logistica.is_audit_evidence_path_writable(name)
);

-- ============================================================================
-- 5. Movimiento genérico: AUDITED no es una transición de drag & drop
--    Se conserva toda la lógica vigente y se agregan dos guardas explícitas.
-- ============================================================================
CREATE OR REPLACE FUNCTION logistica.move_sales_order_preparation_card(
  p_company_id uuid, p_card_id uuid, p_to_status text, p_observation text,
  p_user_id uuid, p_user_name text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = logistica, public AS $$
DECLARE
  v_card logistica.sales_order_preparation_cards%ROWTYPE;
  v_from_status text;
  v_pending integer;
  v_assigned_user_name text;
  v_locked_by_user_name text;
BEGIN
  SELECT * INTO v_card FROM logistica.sales_order_preparation_cards WHERE id = p_card_id FOR UPDATE;
  IF NOT FOUND OR v_card.company_id <> p_company_id THEN RAISE EXCEPTION 'Tarjeta no encontrada o empresa invalida.'; END IF;
  v_from_status := v_card.status;

  -- AUDITED es terminal en este bloque. Sólo finalize_sales_order_audit entra.
  IF p_to_status = 'AUDITED' THEN
    RAISE EXCEPTION 'El estado Auditada sólo se obtiene finalizando la Auditoría.';
  END IF;
  IF v_from_status = 'AUDITED' THEN
    RAISE EXCEPTION 'Una Nota de Venta Auditada es terminal y no puede moverse manualmente.';
  END IF;

  -- Carrera Pending -> Preparacion: el segundo usuario encuentra la tarjeta ya
  -- en IN_PREPARATION y recibe un error operacional claro.
  IF v_from_status = 'IN_PREPARATION' AND p_to_status = 'IN_PREPARATION' THEN
    RAISE EXCEPTION 'Esta Nota de Venta ya fue tomada por otro preparador.';
  END IF;

  IF v_from_status = 'PENDING_ROUTE_PREP' AND p_to_status <> 'IN_PREPARATION' THEN RAISE EXCEPTION 'Desde Pendiente solo se puede pasar a En Preparacion.'; END IF;
  IF v_from_status = 'IN_PREPARATION' AND p_to_status NOT IN ('IN_AUDIT', 'PENDING_ROUTE_PREP') THEN RAISE EXCEPTION 'Transicion invalida desde En Preparacion.'; END IF;
  IF v_from_status = 'IN_AUDIT' AND p_to_status NOT IN ('IN_PREPARATION', 'PENDING_ROUTE_PREP') THEN RAISE EXCEPTION 'Transicion invalida desde Auditoria.'; END IF;

  IF p_to_status = v_from_status THEN RAISE EXCEPTION 'La tarjeta ya se encuentra en el estado indicado.'; END IF;

  -- Mientras esta En preparacion, solo el owner del lock puede moverla.
  IF v_from_status = 'IN_PREPARATION' THEN
    IF v_card.locked_by_user_id IS NULL THEN
      RAISE EXCEPTION 'Esta preparación aún no tiene responsable. Tómala antes de moverla.';
    END IF;
    IF v_card.locked_by_user_id <> p_user_id THEN
      RAISE EXCEPTION 'Esta preparación está asignada a otro usuario.';
    END IF;
  END IF;

  IF p_to_status IN ('PENDING_ROUTE_PREP', 'IN_PREPARATION') AND v_from_status = 'IN_AUDIT' OR p_to_status = 'PENDING_ROUTE_PREP' THEN
    IF p_observation IS NULL OR btrim(p_observation) = '' THEN RAISE EXCEPTION 'Se requiere observacion para retroceder.'; END IF;
  END IF;

  IF p_to_status = 'IN_PREPARATION' THEN
    PERFORM logistica.materialize_sales_order_preparation_snapshot(p_company_id, p_card_id);
  ELSIF p_to_status = 'IN_AUDIT' THEN
    PERFORM logistica.materialize_sales_order_preparation_snapshot(p_company_id, p_card_id);
    SELECT count(*) INTO v_pending FROM logistica.sales_order_preparation_lines
      WHERE company_id = p_company_id AND card_id = p_card_id
        AND (line_status = 'PENDING' OR prepared_quantity IS NULL);
    IF v_pending > 0 THEN RAISE EXCEPTION 'Faltan % productos por confirmar.', v_pending; END IF;
  END IF;

  INSERT INTO logistica.sales_order_preparation_movements (
    company_id, card_id, from_status, to_status, moved_by, movement_source, observation, metadata
  ) VALUES (p_company_id, p_card_id, v_from_status, p_to_status, p_user_id, 'USER', p_observation,
    jsonb_build_object(
      'moved_by_name', p_user_name,
      'lock_acquired', p_to_status = 'IN_PREPARATION',
      'lock_released', v_from_status = 'IN_PREPARATION' AND p_to_status IN ('IN_AUDIT', 'PENDING_ROUTE_PREP')
    ));

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

  SELECT NULLIF(btrim(concat_ws(' ', u.nombre, u.apellido)), '') INTO v_assigned_user_name
    FROM portal.users u WHERE u.id = v_card.assigned_user_id;
  SELECT NULLIF(btrim(concat_ws(' ', u.nombre, u.apellido)), '') INTO v_locked_by_user_name
    FROM portal.users u WHERE u.id = v_card.locked_by_user_id;

  RETURN jsonb_build_object(
    'card_id', p_card_id,
    'from_status', v_from_status,
    'to_status', p_to_status,
    'assigned_user_id', v_card.assigned_user_id,
    'assigned_user_name', v_assigned_user_name,
    'locked_by_user_id', v_card.locked_by_user_id,
    'locked_by_user_name', v_locked_by_user_name,
    'locked_at', v_card.locked_at
  );
END;
$$;

REVOKE ALL ON FUNCTION logistica.move_sales_order_preparation_card(uuid, uuid, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION logistica.move_sales_order_preparation_card(uuid, uuid, text, text, uuid, text) TO service_role;

-- ============================================================================
-- 6. Finalización transaccional de Auditoría
--
--    Vuelve a validar TODO dentro de la misma transacción. No confía en
--    can_finalize_sales_order_audit: esa función es sólo un pre-cierre
--    informativo para la UI.
--
--    Read-only posterior: confirm_sales_order_audit_line,
--    set_sales_order_audit_package_count, register_sales_order_audit_attachment
--    y take_sales_order_audit ya rechazan la sesión cuando status <> 'OPEN'
--    y/o la tarjeta cuando status <> 'IN_AUDIT'. No se duplica esa lógica;
--    esta migración refuerza Storage para que tampoco se puedan subir o
--    borrar objetos de evidencia después del cierre.
-- ============================================================================
CREATE OR REPLACE FUNCTION logistica.finalize_sales_order_audit(
    p_company_id uuid,
    p_card_id uuid,
    p_audit_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = logistica, public
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_audit logistica.sales_order_audits%ROWTYPE;
    v_card logistica.sales_order_preparation_cards%ROWTYPE;
    v_total_lines integer;
    v_pending_lines integer;
    v_open_incidents integer;
    v_missing_evidence integer;
    v_has_global_photo boolean;
    v_completed_at timestamptz := now();
    v_auditor_name text;
BEGIN
    IF v_actor IS NULL OR NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'Sin acceso a la empresa indicada.';
    END IF;
    IF NOT core.has_permission_for_company(v_actor, p_company_id, 'logistica.audit.manage') THEN
        RAISE EXCEPTION 'No tienes permiso para gestionar Auditoría.';
    END IF;

    -- Mismo orden de locks que confirm_sales_order_audit_line: sesión y luego tarjeta.
    SELECT * INTO v_audit
    FROM logistica.sales_order_audits
    WHERE id = p_audit_id
      AND company_id = p_company_id
      AND card_id = p_card_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Sesión de auditoría no encontrada para la tarjeta indicada.';
    END IF;
    IF v_audit.status <> 'OPEN' THEN
        RAISE EXCEPTION 'La sesión de auditoría no está abierta.';
    END IF;

    SELECT * INTO v_card
    FROM logistica.sales_order_preparation_cards
    WHERE id = p_card_id AND company_id = p_company_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Tarjeta no encontrada.';
    END IF;
    IF v_card.status <> 'IN_AUDIT' THEN
        RAISE EXCEPTION 'La tarjeta debe estar En auditoría para finalizar.';
    END IF;

    IF v_audit.locked_by_user_id IS NULL THEN
        RAISE EXCEPTION 'Esta auditoría aún no tiene responsable. Tómala antes de continuar.';
    END IF;
    IF v_audit.locked_by_user_id <> v_actor THEN
        RAISE EXCEPTION 'Esta auditoría está asignada a otro usuario.';
    END IF;
    IF v_audit.prepared_by_user_id_snapshot = v_actor THEN
        RAISE EXCEPTION 'No puedes finalizar una auditoría de una preparación realizada por ti.';
    END IF;
    IF v_audit.assigned_auditor_user_id IS DISTINCT FROM v_actor THEN
        RAISE EXCEPTION 'Sólo el auditor asignado puede finalizar la Auditoría.';
    END IF;

    SELECT count(*) INTO v_total_lines
    FROM logistica.sales_order_audit_lines
    WHERE company_id = p_company_id AND audit_id = v_audit.id;

    IF v_total_lines = 0 THEN
        RAISE EXCEPTION 'La auditoría no tiene líneas registradas.';
    END IF;

    SELECT count(*) INTO v_pending_lines
    FROM logistica.sales_order_audit_lines
    WHERE company_id = p_company_id
      AND audit_id = v_audit.id
      AND line_status = 'PENDING';

    IF v_pending_lines > 0 THEN
        RAISE EXCEPTION 'Faltan % líneas por auditar.', v_pending_lines;
    END IF;

    SELECT count(*) INTO v_open_incidents
    FROM logistica.sales_order_audit_incidents
    WHERE company_id = p_company_id
      AND audit_id = v_audit.id
      AND status = 'OPEN';

    IF v_open_incidents > 0 THEN
        RAISE EXCEPTION 'Existen % incidencias de auditoría abiertas.', v_open_incidents;
    END IF;

    IF v_audit.package_count IS NULL OR v_audit.package_count < 1 THEN
        RAISE EXCEPTION 'La cantidad final de bultos es obligatoria y debe ser mayor a 0.';
    END IF;

    SELECT count(*) INTO v_missing_evidence
    FROM logistica.sales_order_audit_incidents i
    WHERE i.company_id = p_company_id
      AND i.audit_id = v_audit.id
      AND i.status = 'OPEN'
      AND i.incident_type IN ('WRONG_PRODUCT', 'DAMAGED_PRODUCT')
      AND NOT logistica.audit_incident_has_required_evidence(i.company_id, i.id);

    IF v_missing_evidence > 0 THEN
        RAISE EXCEPTION 'Faltan fotografías obligatorias en % incidencias.', v_missing_evidence;
    END IF;

    -- La foto global es opcional por diseño: no bloquea la finalización.
    SELECT EXISTS (
        SELECT 1
        FROM logistica.sales_order_audit_attachments a
        WHERE a.company_id = p_company_id
          AND a.audit_id = v_audit.id
          AND a.attachment_type = 'GLOBAL_DISPATCH_PHOTO'
    ) INTO v_has_global_photo;

    UPDATE logistica.sales_order_audits
       SET status = 'COMPLETED',
           completed_at = v_completed_at,
           locked_by_user_id = NULL,
           locked_at = NULL,
           updated_at = v_completed_at
     WHERE id = v_audit.id
     RETURNING * INTO v_audit;

    -- No se modifica assigned_user_id: debe seguir identificando al preparador.
    UPDATE logistica.sales_order_preparation_cards
       SET status = 'AUDITED',
           last_moved_by = v_actor,
           last_moved_at = v_completed_at,
           updated_at = v_completed_at
     WHERE id = p_card_id
     RETURNING * INTO v_card;

    INSERT INTO logistica.sales_order_preparation_movements (
        company_id, card_id, from_status, to_status, moved_by,
        movement_source, observation, metadata
    ) VALUES (
        p_company_id, p_card_id, 'IN_AUDIT', 'AUDITED', v_actor,
        'USER', NULL,
        jsonb_build_object(
            'event', 'AUDIT_COMPLETED',
            'audit_id', v_audit.id,
            'package_count', v_audit.package_count,
            'auditor_user_id', v_actor,
            'has_global_dispatch_photo', v_has_global_photo
        )
    );

    SELECT NULLIF(btrim(concat_ws(' ', u.nombre, u.apellido)), '')
      INTO v_auditor_name
      FROM portal.users u
     WHERE u.id = v_actor;

    RETURN jsonb_build_object(
        'audit_id', v_audit.id,
        'card_id', p_card_id,
        'company_id', p_company_id,
        'audit_status', v_audit.status,
        'card_status', v_card.status,
        'completed_at', v_audit.completed_at,
        'package_count', v_audit.package_count,
        'assigned_auditor_user_id', v_audit.assigned_auditor_user_id,
        'auditor_name', v_auditor_name,
        'prepared_by_user_id', v_audit.prepared_by_user_id_snapshot,
        'locked_by_user_id', v_audit.locked_by_user_id,
        'locked_at', v_audit.locked_at,
        'has_global_dispatch_photo', v_has_global_photo
    );
END;
$$;

REVOKE ALL ON FUNCTION logistica.finalize_sales_order_audit(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION logistica.finalize_sales_order_audit(uuid, uuid, uuid) TO authenticated, service_role;

COMMIT;
