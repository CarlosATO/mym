-- COMV2-13A: cancel a V2 draft atomically and release its reservations.

INSERT INTO portal.permissions (code, name, description, module_id)
SELECT
    'comisiones.v2.draft.cancel',
    'Cancelar borradores de Comisiones V2',
    'Cancelar borradores V2 y liberar sus reservas de líneas',
    id
FROM portal.modules
WHERE code = 'comercial'
ON CONFLICT (code) DO NOTHING;

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM portal.roles r
JOIN portal.permissions p ON p.code = 'comisiones.v2.draft.cancel'
WHERE r.name IN ('SUPER_USUARIO', 'GERENCIA', 'FINANZAS')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION comisiones.cancel_settlement_draft(
    p_company_id uuid,
    p_settlement_id uuid,
    p_reason text
)
RETURNS TABLE (
    settlement_id uuid,
    previous_status text,
    status text,
    released_locks bigint,
    preserved_lines bigint,
    cancelled_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, comisiones
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_settlement comisiones.settlements%ROWTYPE;
    v_before jsonb;
    v_after jsonb;
    v_released_locks bigint;
    v_preserved_lines bigint;
    v_cancelled_at timestamptz;
BEGIN
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'AUTH_REQUIRED';
    END IF;
    IF NOT (portal.has_permission('system.admin') OR portal.has_permission('comisiones.v2.draft.cancel')) THEN
        RAISE EXCEPTION 'PERMISSION_DENIED';
    END IF;
    IF NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'COMPANY_ACCESS_DENIED';
    END IF;
    IF p_settlement_id IS NULL THEN
        RAISE EXCEPTION 'SETTLEMENT_ID_REQUIRED';
    END IF;
    IF p_reason IS NULL OR btrim(p_reason) = '' THEN
        RAISE EXCEPTION 'CANCELLATION_REASON_REQUIRED';
    END IF;

    SELECT * INTO v_settlement
    FROM comisiones.settlements
    WHERE company_id = p_company_id AND id = p_settlement_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'SETTLEMENT_NOT_FOUND';
    END IF;
    IF v_settlement.status <> 'DRAFT' THEN
        RAISE EXCEPTION 'ONLY_DRAFT_SETTLEMENT_CAN_BE_CANCELLED';
    END IF;

    v_before := to_jsonb(v_settlement);
    v_cancelled_at := clock_timestamp();

    UPDATE comisiones.settlements
    SET status = 'CANCELLED',
        cancelled_at = v_cancelled_at,
        cancelled_by = v_actor,
        cancellation_reason = btrim(p_reason),
        updated_at = v_cancelled_at,
        updated_by = v_actor
    WHERE company_id = p_company_id AND id = p_settlement_id;

    UPDATE comisiones.line_locks
    SET status = 'RELEASED',
        released_at = v_cancelled_at,
        reason = concat_ws(' | ', NULLIF(reason, ''), 'COMV2 draft cancelled')
    WHERE company_id = p_company_id
      AND settlement_id = p_settlement_id
      AND status = 'ACTIVE';
    GET DIAGNOSTICS v_released_locks = ROW_COUNT;

    SELECT count(*) INTO v_preserved_lines
    FROM comisiones.settlement_lines
    WHERE company_id = p_company_id AND settlement_id = p_settlement_id;

    SELECT to_jsonb(s) INTO v_after
    FROM comisiones.settlements s
    WHERE s.company_id = p_company_id AND s.id = p_settlement_id;

    INSERT INTO comisiones.audit_events (
        company_id, actor_user_id, event_type, entity_type, entity_id,
        before_data, after_data, reason
    ) VALUES (
        p_company_id, v_actor, 'SETTLEMENT_DRAFT_CANCELLED', 'SETTLEMENT',
        p_settlement_id, v_before, v_after, btrim(p_reason)
    );

    RETURN QUERY SELECT
        p_settlement_id,
        v_settlement.status,
        'CANCELLED'::text,
        v_released_locks,
        v_preserved_lines,
        v_cancelled_at;
END;
$$;

REVOKE ALL ON FUNCTION comisiones.cancel_settlement_draft(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION comisiones.cancel_settlement_draft(uuid, uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION comisiones.cancel_settlement_draft(uuid, uuid, text) IS
    'COMV2-13A atomic logical cancellation of a DRAFT settlement, preserving snapshot lines and releasing ACTIVE reservations.';
