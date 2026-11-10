-- Require a current, persisted commercial verification before audit closure.
-- This is prospective: historical migrations remain unchanged.

BEGIN;

CREATE OR REPLACE FUNCTION logistica.finalize_sales_order_audit(
    p_company_id uuid,
    p_card_id uuid,
    p_audit_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = logistica, public, auth, core, integraciones
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_audit logistica.sales_order_audits%ROWTYPE;
    v_card logistica.sales_order_preparation_cards%ROWTYPE;
    v_verification logistica.sales_order_audit_commercial_verifications%ROWTYPE;
    v_canonical_current bigint;
    v_total_lines integer;
    v_pending_lines integer;
    v_open_incidents integer;
    v_missing_evidence integer;
    v_has_global_photo boolean;
    v_completed_at timestamptz := now();
    v_auditor_name text;
    v_snapshot jsonb;
    v_current_version jsonb;
BEGIN
    IF v_actor IS NULL OR NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'Sin acceso a la empresa indicada.';
    END IF;
    IF NOT core.has_permission_for_company(v_actor, p_company_id, 'logistica.audit.manage') THEN
        RAISE EXCEPTION 'No tienes permiso para gestionar Auditoría.';
    END IF;

    -- Lock order remains audit session, then card, matching the existing close path.
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
    IF v_audit.prepared_by_user_id_snapshot = v_actor AND NOT portal.is_super_usuario(v_actor) THEN
        RAISE EXCEPTION 'No puedes finalizar una auditoría de una preparación realizada por ti.';
    END IF;
    IF v_audit.assigned_auditor_user_id IS DISTINCT FROM v_actor THEN
        RAISE EXCEPTION 'Sólo el auditor asignado puede finalizar la Auditoría.';
    END IF;

    -- The persisted verification is the authoritative close prerequisite. The
    -- live Bsale provider/comparator runs before this RPC and persists its result.
    SELECT * INTO v_verification
    FROM logistica.sales_order_audit_commercial_verifications
    WHERE company_id = p_company_id
      AND card_id = p_card_id
      AND audit_id = p_audit_id
      AND is_current = true
    ORDER BY verified_at DESC
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe una verificación comercial vigente para esta Auditoría.';
    END IF;
    IF v_verification.status <> 'READY_TO_INVOICE' THEN
        RAISE EXCEPTION 'No se puede finalizar la Auditoría: la verificación comercial no está lista para facturar.';
    END IF;
    IF v_verification.verified_at IS NULL
       OR NULLIF(btrim(v_verification.fingerprint), '') IS NULL
       OR v_verification.fingerprint !~ '^[0-9A-Fa-f]{64}$' THEN
        RAISE EXCEPTION 'No se puede finalizar la Auditoría: la verificación comercial no tiene snapshot o fingerprint válido.';
    END IF;
    IF jsonb_typeof(v_verification.snapshot) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_verification.differences) IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_verification.differences) <> 0 THEN
        RAISE EXCEPTION 'No se puede finalizar la Auditoría: la verificación comercial tiene diferencias o snapshot inválido.';
    END IF;

    v_snapshot := v_verification.snapshot;
    v_current_version := v_snapshot->'currentVersion';
    IF v_snapshot->'identity'->>'companyId' IS DISTINCT FROM p_company_id::text
       OR v_snapshot->>'cardId' IS DISTINCT FROM p_card_id::text
       OR v_snapshot->>'auditId' IS DISTINCT FROM p_audit_id::text
       OR v_snapshot->>'status' IS DISTINCT FROM 'READY_TO_INVOICE'
       OR v_snapshot->'comparison'->>'status' IS DISTINCT FROM 'READY_TO_INVOICE'
       OR jsonb_typeof(v_snapshot->'comparison'->'differences') IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_snapshot->'comparison'->'differences') <> 0
       OR jsonb_typeof(v_current_version) IS DISTINCT FROM 'object'
       OR v_current_version->>'physicalId' IS DISTINCT FROM v_verification.current_bsale_nv_id::text
       OR v_current_version->'identity'->>'canonicalToken' IS DISTINCT FROM v_verification.canonical_bsale_token
       OR v_current_version->'identity'->>'currentBsaleId' IS DISTINCT FROM v_verification.current_bsale_nv_id::text THEN
        RAISE EXCEPTION 'No se puede finalizar la Auditoría: la identidad o el snapshot comercial no coincide.';
    END IF;

    IF v_verification.canonical_bsale_token IS NULL
       OR v_verification.current_bsale_nv_id IS NULL
       OR v_verification.canonical_bsale_token IS DISTINCT FROM v_card.canonical_bsale_token
       OR v_verification.current_bsale_nv_id IS DISTINCT FROM v_card.current_bsale_nv_id THEN
        RAISE EXCEPTION 'No se puede finalizar la Auditoría: el documento Bsale verificado ya no coincide con la tarjeta.';
    END IF;

    SELECT current_bsale_id INTO v_canonical_current
    FROM integraciones.vw_bsale_sales_order_documents_canonical
    WHERE company_id = p_company_id
      AND canonical_bsale_token = v_card.canonical_bsale_token;

    IF v_canonical_current IS NULL
       OR v_canonical_current IS DISTINCT FROM v_verification.current_bsale_nv_id THEN
        RAISE EXCEPTION 'No se puede finalizar la Auditoría: Bsale no responde con el documento comercial vigente.';
    END IF;

    SELECT count(*) INTO v_total_lines
    FROM logistica.sales_order_audit_lines
    WHERE company_id = p_company_id AND audit_id = v_audit.id;
    IF v_total_lines = 0 THEN
        RAISE EXCEPTION 'La auditoría no tiene líneas registradas.';
    END IF;

    SELECT count(*) INTO v_pending_lines
    FROM logistica.sales_order_audit_lines
    WHERE company_id = p_company_id AND audit_id = v_audit.id AND line_status = 'PENDING';
    IF v_pending_lines > 0 THEN
        RAISE EXCEPTION 'Faltan % líneas por auditar.', v_pending_lines;
    END IF;

    SELECT count(*) INTO v_open_incidents
    FROM logistica.sales_order_audit_incidents
    WHERE company_id = p_company_id AND audit_id = v_audit.id AND status = 'OPEN';
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

    SELECT EXISTS (
        SELECT 1 FROM logistica.sales_order_audit_attachments a
        WHERE a.company_id = p_company_id AND a.audit_id = v_audit.id
          AND a.attachment_type = 'GLOBAL_DISPATCH_PHOTO'
    ) INTO v_has_global_photo;

    UPDATE logistica.sales_order_audits
       SET status = 'COMPLETED', completed_at = v_completed_at,
           locked_by_user_id = NULL, locked_at = NULL, updated_at = v_completed_at
     WHERE id = v_audit.id
     RETURNING * INTO v_audit;

    UPDATE logistica.sales_order_preparation_cards
       SET status = 'AUDITED', last_moved_by = v_actor,
           last_moved_at = v_completed_at, updated_at = v_completed_at
     WHERE id = p_card_id
     RETURNING * INTO v_card;

    INSERT INTO logistica.sales_order_preparation_movements (
        company_id, card_id, from_status, to_status, moved_by,
        movement_source, observation, metadata
    ) VALUES (
        p_company_id, p_card_id, 'IN_AUDIT', 'AUDITED', v_actor,
        'USER', NULL, jsonb_build_object(
            'event', 'AUDIT_COMPLETED', 'audit_id', v_audit.id,
            'package_count', v_audit.package_count, 'auditor_user_id', v_actor,
            'has_global_dispatch_photo', v_has_global_photo,
            'commercial_verification_id', v_verification.id,
            'commercial_verification_fingerprint', v_verification.fingerprint
        )
    );

    SELECT NULLIF(btrim(concat_ws(' ', u.nombre, u.apellido)), '') INTO v_auditor_name
    FROM portal.users u WHERE u.id = v_actor;

    RETURN jsonb_build_object(
        'audit_id', v_audit.id, 'card_id', p_card_id, 'company_id', p_company_id,
        'audit_status', v_audit.status, 'card_status', v_card.status,
        'completed_at', v_audit.completed_at, 'package_count', v_audit.package_count,
        'assigned_auditor_user_id', v_audit.assigned_auditor_user_id,
        'auditor_name', v_auditor_name, 'prepared_by_user_id', v_audit.prepared_by_user_id_snapshot,
        'locked_by_user_id', v_audit.locked_by_user_id, 'locked_at', v_audit.locked_at,
        'has_global_dispatch_photo', v_has_global_photo,
        'commercial_verification_id', v_verification.id
    );
END;
$$;

REVOKE ALL ON FUNCTION logistica.finalize_sales_order_audit(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION logistica.finalize_sales_order_audit(uuid, uuid, uuid) TO authenticated, service_role;

COMMIT;
