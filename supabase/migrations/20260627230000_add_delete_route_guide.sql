-- =========================================================================================
-- MIGRATION: 20260627230000_add_delete_route_guide.sql
-- DESCRIPTION: Añadir RPC para eliminar borrador de Guía de Ruta con auditoría estricta.
-- =========================================================================================

CREATE OR REPLACE FUNCTION logistica.delete_route_guide_draft(
    p_guide_id uuid,
    p_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_company_id uuid;
    v_has_access boolean;
    v_status text;
    v_guide_number text;
    v_guide_date date;
    v_route_name text;
    v_vehicle_name text;
    v_driver_name text;
    v_seller_name text;
    v_dispatcher_name text;
    v_total_amount numeric;
    v_total_invoices integer;
    v_old_data jsonb;
BEGIN
    -- 1. Validar autenticación básica y congruencia de usuario
    IF auth.uid() IS NULL OR auth.uid() != p_user_id THEN
        RAISE EXCEPTION 'No autorizado. Autenticación inválida.';
    END IF;

    -- 2. Obtener datos de la guía y validar existencia
    SELECT 
        company_id, status, guide_number, guide_date, 
        route_name_snapshot, vehicle_name_snapshot,
        driver_name_snapshot, seller_name_snapshot, dispatcher_name_snapshot,
        total_amount, total_invoices
    INTO 
        v_company_id, v_status, v_guide_number, v_guide_date,
        v_route_name, v_vehicle_name, v_driver_name, v_seller_name, v_dispatcher_name,
        v_total_amount, v_total_invoices
    FROM logistica.route_guides
    WHERE id = p_guide_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'La guía no existe.';
    END IF;

    -- 3. Validar estado (Solo se permite borrar DRAFT)
    IF v_status != 'DRAFT' THEN
        RAISE EXCEPTION 'Solo se pueden eliminar guías en estado BORRADOR (DRAFT).';
    END IF;

    -- 4. Validar acceso a la empresa y permisos
    SELECT core.has_company_access(p_user_id, v_company_id) INTO v_has_access;
    IF NOT v_has_access THEN
        RAISE EXCEPTION 'No tienes acceso a la empresa de esta guía.';
    END IF;

    IF NOT (portal.has_permission('system.admin') OR portal.has_permission('logistica.route_guides.update_draft')) THEN
        RAISE EXCEPTION 'No tienes permisos para eliminar borradores de guías de ruta.';
    END IF;

    -- 5. Preparar payload de auditoría con todo el contexto solicitado
    v_old_data := jsonb_build_object(
        'guide_id', p_guide_id,
        'guide_number', v_guide_number,
        'status', v_status,
        'guide_date', v_guide_date,
        'route_name_snapshot', v_route_name,
        'vehicle_name_snapshot', v_vehicle_name,
        'driver_name_snapshot', v_driver_name,
        'seller_name_snapshot', v_seller_name,
        'dispatcher_name_snapshot', v_dispatcher_name,
        'total_amount', v_total_amount,
        'total_invoices', v_total_invoices,
        'reason', 'Eliminación de borrador desde bandeja'
    );

    -- 6. Insertar log de auditoría
    INSERT INTO portal.audit_logs (
        schema_name,
        module_code,
        table_name,
        record_id,
        action,
        old_data,
        new_data,
        performed_by,
        event_type,
        severity
    ) VALUES (
        'logistica',
        'LOGISTICA',
        'route_guides',
        p_guide_id,
        'DELETE',
        v_old_data,
        NULL,
        p_user_id,
        'ROUTE_GUIDE_DRAFT_DELETED',
        'WARNING'
    );

    -- 7. Eliminar la guía. 
    -- NOTA: logistica.route_guide_items tiene ON DELETE CASCADE, por lo que se borran automáticamente.
    DELETE FROM logistica.route_guides WHERE id = p_guide_id;

END;
$$;
