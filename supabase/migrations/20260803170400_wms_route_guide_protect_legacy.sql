-- Migration: 20260803170400_wms_route_guide_protect_legacy.sql
-- Description: Fase WMS-RG.1. Protege las vias antiguas: delete_route_guide_draft
--              y update_route_guide_draft ahora exigen el permiso fail-closed
--              edit_unsettled (solo SUPER_USUARIO) y rechazan guias con rendicion
--              o dependencias.
-- Author: Assistant

-- ============================================================
-- 1. UPDATE ROUTE GUIDE DRAFT (vía antigua protegida)
--    Mantiene la firma; exige permiso edit_unsettled por empresa.
-- ============================================================
CREATE OR REPLACE FUNCTION logistica.update_route_guide_draft(
    p_company_id uuid,
    p_guide_id uuid,
    p_guide_data jsonb,
    p_items_data jsonb,
    p_user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    v_status text;
    v_item record;
    v_company_id uuid;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'No autorizado');
    END IF;

    SELECT company_id, status INTO v_company_id, v_status
    FROM logistica.route_guides WHERE id = p_guide_id AND company_id = p_company_id;
    IF v_status IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'Guia no encontrada');
    END IF;

    IF NOT core.has_permission_for_company(p_user_id, v_company_id, 'logistica.route_guides.edit_unsettled') THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'No tienes permisos para editar guias de ruta');
    END IF;

    IF v_status <> 'DRAFT' THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'Solo se pueden editar guias en borrador');
    END IF;

    IF EXISTS (SELECT 1 FROM adquisiciones.route_settlements rs WHERE rs.route_guide_id = p_guide_id)
       OR EXISTS (SELECT 1 FROM adquisiciones.route_fund_closure_items rci WHERE rci.route_guide_id = p_guide_id)
       OR EXISTS (SELECT 1 FROM adquisiciones.route_fund_closure_expenses rce WHERE rce.route_guide_id = p_guide_id) THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'La guia tiene rendicion o evidencia financiera asociada');
    END IF;

    UPDATE logistica.route_guides SET
        guide_date = (p_guide_data->>'guide_date')::date,
        route_id = (p_guide_data->>'route_id')::uuid,
        route_name_snapshot = p_guide_data->>'route_name_snapshot',
        vehicle_id = (p_guide_data->>'vehicle_id')::uuid,
        vehicle_name_snapshot = p_guide_data->>'vehicle_name_snapshot',
        driver_id = (p_guide_data->>'driver_id')::uuid,
        driver_name_snapshot = p_guide_data->>'driver_name_snapshot',
        dispatcher_id = (p_guide_data->>'dispatcher_id')::uuid,
        dispatcher_name_snapshot = p_guide_data->>'dispatcher_name_snapshot',
        notes = p_guide_data->>'notes',
        version_number = version_number + 1,
        updated_at = now()
    WHERE id = p_guide_id AND company_id = p_company_id;

    DELETE FROM logistica.route_guide_items WHERE route_guide_id = p_guide_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items_data) LOOP
        INSERT INTO logistica.route_guide_items (
            company_id, route_guide_id, line_number, invoice_number,
            customer_name, customer_address, commune, amount,
            payment_method_original, payment_method_normalized, requires_settlement,
            validation_status, validation_errors, notes, settlement_status
        ) VALUES (
            p_company_id, p_guide_id, (v_item.value->>'line_number')::integer, v_item.value->>'invoice_number',
            v_item.value->>'customer_name', v_item.value->>'customer_address', v_item.value->>'commune', (v_item.value->>'amount')::numeric,
            v_item.value->>'payment_method_original', v_item.value->>'payment_method_normalized', (v_item.value->>'requires_settlement')::boolean,
            v_item.value->>'validation_status', (v_item.value->>'validation_errors')::jsonb, v_item.value->>'notes',
            COALESCE(v_item.value->>'settlement_status', 'NOT_REQUIRED')
        );
    END LOOP;

    INSERT INTO portal.audit_logs (schema_name, module_code, table_name, record_id, action, old_data, new_data, performed_by, event_type, severity)
    VALUES ('logistica', 'LOGISTICA', 'route_guides', p_guide_id, 'UPDATE', '{}', '{}', p_user_id, 'ROUTE_GUIDE_UPDATED', 'INFO');

    RETURN pg_catalog.jsonb_build_object('success', true, 'id', p_guide_id);
EXCEPTION WHEN OTHERS THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- ============================================================
-- 2. DELETE ROUTE GUIDE DRAFT (vía antigua protegida)
-- ============================================================
CREATE OR REPLACE FUNCTION logistica.delete_route_guide_draft(
    p_guide_id uuid,
    p_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_company_id uuid;
    v_status text;
    v_guide_number text;
    v_guide_date date;
    v_old_data jsonb;
BEGIN
    -- 1. Actor desde auth.uid() (congruencia)
    IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_UNAUTHENTICATED',
            DETAIL=pg_catalog.jsonb_build_object('message','No autorizado. Autenticacion invalida.','retryable',false)::text;
    END IF;

    -- 2. Guia
    SELECT company_id, status, guide_number, guide_date
    INTO v_company_id, v_status, v_guide_number, v_guide_date
    FROM logistica.route_guides
    WHERE id = p_guide_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La guia no existe.','retryable',false)::text;
    END IF;

    -- 3. Estado: solo DRAFT
    IF v_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','Solo se pueden eliminar guias en estado DRAFT.','retryable',false,'status',v_status)::text;
    END IF;

    -- 4. Acceso y permiso fail-closed por empresa
    IF NOT core.has_company_access(p_user_id, v_company_id) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_COMPANY_ACCESS_DENIED',
            DETAIL=pg_catalog.jsonb_build_object('message','No tienes acceso a la empresa de esta guia.','retryable',false)::text;
    END IF;
    IF NOT core.has_permission_for_company(p_user_id, v_company_id, 'logistica.route_guides.edit_unsettled') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PERMISSION_REQUIRED',
            DETAIL=pg_catalog.jsonb_build_object('message','No tienes permisos para eliminar guias de ruta.','retryable',false)::text;
    END IF;

    -- 5. Dependencias
    IF EXISTS (SELECT 1 FROM adquisiciones.route_settlements rs WHERE rs.route_guide_id = p_guide_id)
       OR EXISTS (SELECT 1 FROM adquisiciones.route_fund_closure_items rci WHERE rci.route_guide_id = p_guide_id)
       OR EXISTS (SELECT 1 FROM adquisiciones.route_fund_closure_expenses rce WHERE rce.route_guide_id = p_guide_id) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='ROUTE_GUIDE_SETTLEMENT_STARTED',
            DETAIL=pg_catalog.jsonb_build_object('message','La guia tiene rendicion o evidencia financiera asociada.','retryable',false)::text;
    END IF;

    -- 6. Auditoria
    v_old_data := pg_catalog.jsonb_build_object(
        'guide_id', p_guide_id, 'guide_number', v_guide_number,
        'status', v_status, 'guide_date', v_guide_date,
        'reason', 'Eliminacion de borrador controlada'
    );
    INSERT INTO portal.audit_logs (schema_name, module_code, table_name, record_id, action, old_data, new_data, performed_by, event_type, severity)
    VALUES ('logistica', 'LOGISTICA', 'route_guides', p_guide_id, 'DELETE', v_old_data, NULL, p_user_id, 'ROUTE_GUIDE_DRAFT_DELETED', 'WARNING');

    -- 7. Eliminar (route_guide_items ON DELETE CASCADE)
    DELETE FROM logistica.route_guides WHERE id = p_guide_id;
END;
$$;

ALTER FUNCTION logistica.delete_route_guide_draft(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION logistica.update_route_guide_draft(uuid, uuid, jsonb, jsonb, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION logistica.delete_route_guide_draft(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION logistica.update_route_guide_draft(uuid, uuid, jsonb, jsonb, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION logistica.delete_route_guide_draft(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION logistica.update_route_guide_draft(uuid, uuid, jsonb, jsonb, uuid) TO authenticated;
