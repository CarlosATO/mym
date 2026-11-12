-- Additional endpoint exclusively for bulk confirmation. The existing RPC and
-- its permissions remain unchanged. Requires the original non-deferred FK from
-- audit incidents to audit lines and the ordinary READ COMMITTED isolation.
BEGIN;

-- The insertion guard below relies on PostgreSQL's immediate FK key-share
-- check. Refuse to install if a different schema cannot provide that guard.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint c
        WHERE c.contype = 'f'
          AND c.conrelid = 'logistica.sales_order_audit_incidents'::regclass
          AND c.confrelid = 'logistica.sales_order_audit_lines'::regclass
          AND c.conkey = ARRAY[(SELECT attnum FROM pg_catalog.pg_attribute
                                WHERE attrelid = c.conrelid AND attname = 'audit_line_id')]::smallint[]
          AND c.confkey = ARRAY[(SELECT attnum FROM pg_catalog.pg_attribute
                                 WHERE attrelid = c.confrelid AND attname = 'id')]::smallint[]
          AND c.convalidated AND NOT c.condeferrable
    ) THEN
        RAISE EXCEPTION 'AUDIT_BULK_IMMEDIATE_LINE_FK_REQUIRED';
    END IF;
END;
$$;

CREATE FUNCTION logistica.register_pending_sales_order_audit_line(
    p_company_id uuid,
    p_audit_id uuid,
    p_audit_line_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, logistica, public
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_line logistica.sales_order_audit_lines%ROWTYPE;
    v_audit logistica.sales_order_audits%ROWTYPE;
    v_card logistica.sales_order_preparation_cards%ROWTYPE;
BEGIN
    IF v_actor IS NULL OR NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'Sin acceso a la empresa indicada.';
    END IF;
    IF NOT core.has_permission_for_company(v_actor, p_company_id, 'logistica.audit.manage') THEN
        RAISE EXCEPTION 'No tienes permiso para gestionar Auditoría.';
    END IF;
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'AUDIT_BULK_ISOLATION_UNSUPPORTED' USING ERRCODE = '22023';
    END IF;

    -- Same lock order as confirm_sales_order_audit_line: line, audit, card.
    SELECT * INTO v_line FROM logistica.sales_order_audit_lines
      WHERE id = p_audit_line_id AND company_id = p_company_id AND audit_id = p_audit_id
      FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Línea de auditoría no encontrada.'; END IF;
    SELECT * INTO v_audit FROM logistica.sales_order_audits
      WHERE id = p_audit_id AND company_id = p_company_id FOR UPDATE;
    IF NOT FOUND OR v_audit.status <> 'OPEN' THEN
        RAISE EXCEPTION 'La sesión de auditoría no está abierta.';
    END IF;
    SELECT * INTO v_card FROM logistica.sales_order_preparation_cards
      WHERE id = v_audit.card_id AND company_id = p_company_id FOR UPDATE;
    IF NOT FOUND OR v_card.status <> 'IN_AUDIT' OR v_line.card_id <> v_card.id THEN
        RAISE EXCEPTION 'La tarjeta debe estar En auditoría.';
    END IF;
    IF v_audit.locked_by_user_id IS NULL THEN
        RAISE EXCEPTION 'Esta auditoría aún no tiene responsable. Tómala antes de continuar.';
    END IF;
    IF v_audit.locked_by_user_id <> v_actor THEN
        RAISE EXCEPTION 'Esta auditoría está asignada a otro usuario.';
    END IF;

    IF v_line.line_status <> 'PENDING' OR v_line.audit_quantity IS NOT NULL THEN
        RAISE EXCEPTION 'AUDIT_BULK_LINE_NOT_PENDING' USING ERRCODE = 'P0001';
    END IF;

    -- Lock all existing incident rows, including historical ones: a privileged
    -- writer could otherwise reopen one after an OPEN-only check. NOWAIT avoids
    -- waiting in the opposite direction if another writer holds an incident.
    -- The line FOR UPDATE conflicts with the FK key-share lock of new inserts.
    PERFORM i.id FROM logistica.sales_order_audit_incidents i
      WHERE i.audit_line_id = v_line.id
      ORDER BY i.id FOR UPDATE NOWAIT;
    IF EXISTS (SELECT 1 FROM logistica.sales_order_audit_incidents i
               WHERE i.audit_line_id = v_line.id AND i.status = 'OPEN') THEN
        RAISE EXCEPTION 'AUDIT_BULK_OPEN_INCIDENT' USING ERRCODE = 'P0001';
    END IF;

    RETURN logistica.confirm_sales_order_audit_line(
        p_company_id, p_audit_line_id, v_line.prepared_quantity_snapshot, NULL::text, NULL::text
    );
END;
$$;

REVOKE ALL ON FUNCTION logistica.register_pending_sales_order_audit_line(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION logistica.register_pending_sales_order_audit_line(uuid, uuid, uuid) TO authenticated, service_role;
COMMIT;
