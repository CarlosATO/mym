-- Auditoria de Notas de Venta: soporte para ciclos sucesivos.
--
-- No habilita la recuperacion de tarjetas AUDITED. Una tarjeta debe llegar a
-- IN_AUDIT por un procedimiento autorizado existente o futuro. Este bloque
-- solo evita reutilizar el ciclo anterior y hace que el ciclo abierto sea
-- determinista para toma, lectura y snapshot.

BEGIN;

-- El snapshot sigue siendo idempotente, pero solo permite avanzar un ciclo a
-- la vez. El bloqueo de la tarjeta serializa las llamadas de toma.
CREATE OR REPLACE FUNCTION logistica.materialize_sales_order_audit_snapshot(
    p_company_id uuid,
    p_card_id uuid,
    p_actor_id uuid,
    p_cycle_no integer DEFAULT 1
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = logistica, public
AS $$
DECLARE
    v_card logistica.sales_order_preparation_cards%ROWTYPE;
    v_audit_id uuid;
    v_existing_cycle integer;
    v_max_cycle integer;
    v_line_count integer;
    v_pending integer;
BEGIN
    IF p_actor_id IS NULL THEN
        RAISE EXCEPTION 'Actor de auditoría requerido.';
    END IF;
    IF p_cycle_no IS NULL OR p_cycle_no < 1 THEN
        RAISE EXCEPTION 'Ciclo de auditoría inválido.';
    END IF;

    SELECT * INTO v_card
    FROM logistica.sales_order_preparation_cards
    WHERE id = p_card_id AND company_id = p_company_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Tarjeta no encontrada para la empresa.';
    END IF;
    IF v_card.status <> 'IN_AUDIT' THEN
        RAISE EXCEPTION 'La tarjeta debe estar En auditoría.';
    END IF;

    SELECT a.cycle_no INTO v_existing_cycle
    FROM logistica.sales_order_audits a
    WHERE a.company_id = p_company_id
      AND a.card_id = p_card_id
      AND a.cycle_no = p_cycle_no;

    SELECT max(a.cycle_no) INTO v_max_cycle
    FROM logistica.sales_order_audits a
    WHERE a.company_id = p_company_id
      AND a.card_id = p_card_id;

    IF v_existing_cycle IS NULL
       AND p_cycle_no <> coalesce(v_max_cycle, 0) + 1 THEN
        RAISE EXCEPTION 'El ciclo de auditoría debe ser el siguiente al último ciclo cerrado.';
    END IF;

    SELECT count(*) INTO v_pending
    FROM logistica.sales_order_preparation_lines
    WHERE company_id = p_company_id
      AND card_id = p_card_id
      AND retired_at IS NULL
      AND prepared_quantity IS NULL;

    IF v_pending > 0 THEN
        RAISE EXCEPTION 'La preparación tiene % líneas sin cantidad preparada.', v_pending;
    END IF;

    INSERT INTO logistica.sales_order_audits (
        company_id, card_id, bsale_nv_id, bsale_nv_folio, cycle_no, status,
        prepared_by_user_id_snapshot, created_by
    ) VALUES (
        p_company_id, p_card_id, v_card.bsale_nv_id, v_card.bsale_nv_folio,
        p_cycle_no, 'OPEN', v_card.assigned_user_id, p_actor_id
    )
    ON CONFLICT (company_id, card_id, cycle_no) DO NOTHING;

    SELECT id INTO v_audit_id
    FROM logistica.sales_order_audits
    WHERE company_id = p_company_id
      AND card_id = p_card_id
      AND cycle_no = p_cycle_no;

    IF v_audit_id IS NULL THEN
        RAISE EXCEPTION 'No se pudo crear la sesión de auditoría.';
    END IF;

    INSERT INTO logistica.sales_order_audit_lines (
        company_id, audit_id, card_id, preparation_line_id,
        bsale_detail_id, bsale_variant_id, sku, product_name,
        requested_quantity_snapshot, prepared_quantity_snapshot,
        excluded_from_dispatch_snapshot
    )
    SELECT
        pl.company_id, v_audit_id, pl.card_id, pl.id,
        pl.bsale_detail_id, pl.bsale_variant_id, pl.sku, pl.product_name,
        pl.requested_quantity, pl.prepared_quantity,
        pl.excluded_from_dispatch
    FROM logistica.sales_order_preparation_lines pl
    WHERE pl.company_id = p_company_id
      AND pl.card_id = p_card_id
      AND pl.retired_at IS NULL
    ON CONFLICT (company_id, audit_id, preparation_line_id) DO NOTHING;

    SELECT count(*) INTO v_line_count
    FROM logistica.sales_order_audit_lines
    WHERE company_id = p_company_id AND audit_id = v_audit_id;

    IF v_line_count = 0 THEN
        RAISE EXCEPTION 'La tarjeta no tiene líneas de preparación para auditar.';
    END IF;

    RETURN v_audit_id;
END;
$$;

-- La firma no cambia; se calcula el ciclo dentro de la misma transacción que
-- bloquea la tarjeta. Una segunda llamada sobre el mismo estado reutiliza la
-- sesión OPEN y no crea una auditoría paralela.
CREATE OR REPLACE FUNCTION logistica.take_sales_order_audit(
    p_company_id uuid,
    p_card_id uuid,
    p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = logistica, public
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_card logistica.sales_order_preparation_cards%ROWTYPE;
    v_audit logistica.sales_order_audits%ROWTYPE;
    v_audit_id uuid;
    v_next_cycle integer;
    v_actor_name text;
    v_preparer_name text;
    v_event text;
    v_line_count integer;
BEGIN
    IF v_actor IS NULL OR NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'Sin acceso a la empresa indicada.';
    END IF;
    IF NOT core.has_permission_for_company(v_actor, p_company_id, 'logistica.audit.manage') THEN
        RAISE EXCEPTION 'No tienes permiso para gestionar Auditoría.';
    END IF;

    SELECT * INTO v_card
    FROM logistica.sales_order_preparation_cards
    WHERE id = p_card_id AND company_id = p_company_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Tarjeta no encontrada.';
    END IF;
    IF v_card.status <> 'IN_AUDIT' THEN
        RAISE EXCEPTION 'Solo se puede auditar una tarjeta En auditoría.';
    END IF;
    IF v_card.assigned_user_id = v_actor AND NOT portal.is_super_usuario(v_actor) THEN
        RAISE EXCEPTION 'No puedes auditar una preparación realizada por ti.';
    END IF;

    -- Reutilizar la sesión OPEN hace la toma idempotente. Sólo una tarjeta
    -- bloqueada sin sesión activa puede avanzar al siguiente ciclo.
    SELECT * INTO v_audit
    FROM logistica.sales_order_audits
    WHERE company_id = p_company_id
      AND card_id = p_card_id
      AND status = 'OPEN'
    ORDER BY cycle_no DESC
    LIMIT 1
    FOR UPDATE;

    IF FOUND THEN
        v_audit_id := v_audit.id;
    ELSE
        SELECT coalesce(max(cycle_no), 0) + 1 INTO v_next_cycle
        FROM logistica.sales_order_audits
        WHERE company_id = p_company_id AND card_id = p_card_id;

        v_audit_id := logistica.materialize_sales_order_audit_snapshot(
            p_company_id, p_card_id, v_actor, v_next_cycle
        );

        SELECT * INTO v_audit
        FROM logistica.sales_order_audits
        WHERE id = v_audit_id AND company_id = p_company_id
        FOR UPDATE;
    END IF;

    IF v_audit.status <> 'OPEN' THEN
        RAISE EXCEPTION 'La sesión de auditoría no está abierta.';
    END IF;
    IF v_audit.prepared_by_user_id_snapshot = v_actor AND NOT portal.is_super_usuario(v_actor) THEN
        RAISE EXCEPTION 'No puedes auditar una preparación realizada por ti.';
    END IF;

    IF v_audit.locked_by_user_id = v_actor THEN
        v_event := 'AUDIT_LOCK_ALREADY_OWNED';
    ELSIF v_audit.locked_by_user_id IS NOT NULL THEN
        IF NOT core.has_permission_for_company(v_actor, p_company_id, 'logistica.audit.authorize_exception') THEN
            RAISE EXCEPTION 'Esta auditoría está siendo realizada por otro usuario.';
        END IF;
        IF p_reason IS NULL OR btrim(p_reason) = '' THEN
            RAISE EXCEPTION 'El motivo es obligatorio para tomar la auditoría de otro usuario.';
        END IF;
        v_event := 'AUDIT_LOCK_TAKEOVER';
    ELSE
        v_event := 'AUDIT_LOCK_CLAIM';
    END IF;

    UPDATE logistica.sales_order_audits
       SET assigned_auditor_user_id = v_actor,
           locked_by_user_id = v_actor,
           locked_at = now(),
           updated_at = now()
     WHERE id = v_audit_id
     RETURNING * INTO v_audit;

    SELECT NULLIF(btrim(concat_ws(' ', u.nombre, u.apellido)), '')
      INTO v_actor_name FROM portal.users u WHERE u.id = v_actor;
    SELECT NULLIF(btrim(concat_ws(' ', u.nombre, u.apellido)), '')
      INTO v_preparer_name FROM portal.users u WHERE u.id = v_card.assigned_user_id;
    SELECT count(*) INTO v_line_count
      FROM logistica.sales_order_audit_lines
     WHERE company_id = p_company_id AND audit_id = v_audit_id;

    RETURN jsonb_build_object(
        'audit_id', v_audit.id,
        'card_id', p_card_id,
        'company_id', p_company_id,
        'status', v_audit.status,
        'cycle_no', v_audit.cycle_no,
        'assigned_auditor_user_id', v_audit.assigned_auditor_user_id,
        'auditor_name', v_actor_name,
        'locked_by_user_id', v_audit.locked_by_user_id,
        'locked_at', v_audit.locked_at,
        'prepared_by_user_id', v_audit.prepared_by_user_id_snapshot,
        'preparer_name', v_preparer_name,
        'line_count', v_line_count,
        'package_count', v_audit.package_count,
        'event', v_event
    );
END;
$$;

-- NULL significa "ciclo operativo": sesión OPEN, o el último ciclo si la
-- tarjeta ya fue finalizada. Un ciclo explícito sigue permitiendo consultar
-- historial sin cambiar el contrato de la RPC.
CREATE OR REPLACE FUNCTION logistica.get_sales_order_audit_detail(
    p_company_id uuid,
    p_card_id uuid,
    p_cycle_no integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = logistica, public
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_audit logistica.sales_order_audits%ROWTYPE;
    v_preparer_name text;
    v_auditor_name text;
    v_locked_by_name text;
    v_lines jsonb;
    v_incidents jsonb;
    v_attachments jsonb;
BEGIN
    IF v_actor IS NULL OR NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'Sin acceso a la empresa indicada.';
    END IF;
    IF NOT core.has_permission_for_company(v_actor, p_company_id, 'logistica.audit.manage') THEN
        RAISE EXCEPTION 'No tienes permiso para consultar Auditoría.';
    END IF;
    IF p_cycle_no IS NOT NULL AND p_cycle_no < 1 THEN
        RAISE EXCEPTION 'Ciclo de auditoría inválido.';
    END IF;

    IF p_cycle_no IS NULL THEN
        SELECT * INTO v_audit
        FROM logistica.sales_order_audits
        WHERE company_id = p_company_id AND card_id = p_card_id
        ORDER BY (status = 'OPEN') DESC, cycle_no DESC
        LIMIT 1;
    ELSE
        SELECT * INTO v_audit
        FROM logistica.sales_order_audits
        WHERE company_id = p_company_id
          AND card_id = p_card_id
          AND cycle_no = p_cycle_no;
    END IF;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('audit', NULL, 'lines', '[]'::jsonb,
            'incidents', '[]'::jsonb, 'attachments', '[]'::jsonb);
    END IF;

    SELECT NULLIF(btrim(concat_ws(' ', u.nombre, u.apellido)), '') INTO v_preparer_name
      FROM portal.users u WHERE u.id = v_audit.prepared_by_user_id_snapshot;
    SELECT NULLIF(btrim(concat_ws(' ', u.nombre, u.apellido)), '') INTO v_auditor_name
      FROM portal.users u WHERE u.id = v_audit.assigned_auditor_user_id;
    SELECT NULLIF(btrim(concat_ws(' ', u.nombre, u.apellido)), '') INTO v_locked_by_name
      FROM portal.users u WHERE u.id = v_audit.locked_by_user_id;
    SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.bsale_detail_id), '[]'::jsonb) INTO v_lines
      FROM logistica.sales_order_audit_lines l
     WHERE l.company_id = p_company_id AND l.audit_id = v_audit.id;
    SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.detected_at), '[]'::jsonb) INTO v_incidents
      FROM logistica.sales_order_audit_incidents i
     WHERE i.company_id = p_company_id AND i.audit_id = v_audit.id;
    SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.uploaded_at), '[]'::jsonb) INTO v_attachments
      FROM logistica.sales_order_audit_attachments a
     WHERE a.company_id = p_company_id AND a.audit_id = v_audit.id;

    RETURN jsonb_build_object(
        'audit', to_jsonb(v_audit) || jsonb_build_object(
            'preparer_name', v_preparer_name, 'auditor_name', v_auditor_name,
            'locked_by_name', v_locked_by_name),
        'lines', v_lines, 'incidents', v_incidents, 'attachments', v_attachments);
END;
$$;

REVOKE ALL ON FUNCTION logistica.materialize_sales_order_audit_snapshot(uuid, uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION logistica.materialize_sales_order_audit_snapshot(uuid, uuid, uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION logistica.take_sales_order_audit(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION logistica.take_sales_order_audit(uuid, uuid, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION logistica.get_sales_order_audit_detail(uuid, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION logistica.get_sales_order_audit_detail(uuid, uuid, integer) TO authenticated, service_role;

COMMIT;
