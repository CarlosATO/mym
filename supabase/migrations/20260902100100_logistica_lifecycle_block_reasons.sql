-- Conserva las razones detalladas del contrato de ciclo de vida después de
-- excluir el mapping derivado como bloqueo autónomo de borrado.
CREATE OR REPLACE FUNCTION logistica.evaluate_location_lifecycle(
    p_company_id uuid, p_location_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    v_exists boolean; v_stock boolean; v_history boolean; v_reference boolean;
    v_operation boolean; v_reasons jsonb := '[]'::jsonb;
BEGIN
    SELECT EXISTS (SELECT 1 FROM logistica.locations WHERE company_id=p_company_id AND id=p_location_id) INTO v_exists;
    IF NOT v_exists THEN
        RETURN jsonb_build_object('found',false,'location_id',p_location_id,'can_edit_structure',false,'can_deactivate',false,'can_delete',false,'blocking_reasons',jsonb_build_array(jsonb_build_object('code','LOCATION_NOT_FOUND','message','La ubicacion no existe o no pertenece a la empresa activa.')));
    END IF;
    SELECT EXISTS (SELECT 1 FROM logistica.v_stock_by_location WHERE company_id=p_company_id AND location_id=p_location_id AND quantity > 0) INTO v_stock;
    v_reference := EXISTS (SELECT 1 FROM inventarios.session_location_scopes WHERE company_id=p_company_id AND location_id=p_location_id)
        OR EXISTS (SELECT 1 FROM inventarios.session_zone_locations WHERE company_id=p_company_id AND location_id=p_location_id)
        OR EXISTS (SELECT 1 FROM inventarios.snapshot_locations WHERE company_id=p_company_id AND location_id=p_location_id)
        OR EXISTS (SELECT 1 FROM inventarios.stock_import_rows WHERE company_id=p_company_id AND location_id=p_location_id)
        OR EXISTS (SELECT 1 FROM inventarios.inventory_audit_locations WHERE company_id=p_company_id AND location_id=p_location_id)
        OR EXISTS (SELECT 1 FROM inventarios.inventory_audit_results WHERE company_id=p_company_id AND location_id=p_location_id);
    v_history := EXISTS (SELECT 1 FROM logistica.kardex_movements WHERE company_id=p_company_id AND location_id=p_location_id)
        OR EXISTS (SELECT 1 FROM logistica.purchase_receipt_items WHERE company_id=p_company_id AND location_id=p_location_id)
        OR EXISTS (SELECT 1 FROM logistica.stock_adjustment_items WHERE company_id=p_company_id AND location_id=p_location_id)
        OR EXISTS (SELECT 1 FROM logistica.stock_transfer_items WHERE company_id=p_company_id AND from_location_id=p_location_id)
        OR EXISTS (SELECT 1 FROM logistica.stock_transfers WHERE company_id=p_company_id AND to_location_id=p_location_id)
        OR v_reference;
    v_operation := EXISTS (SELECT 1 FROM inventarios.session_location_scopes x JOIN inventarios.sessions s ON s.company_id=x.company_id AND s.id=x.session_id WHERE x.company_id=p_company_id AND x.location_id=p_location_id AND s.status IN ('COUNTING','UNDER_REVIEW'))
        OR EXISTS (SELECT 1 FROM inventarios.session_zone_locations x JOIN inventarios.sessions s ON s.company_id=x.company_id AND s.id=x.session_id WHERE x.company_id=p_company_id AND x.location_id=p_location_id AND s.status IN ('COUNTING','UNDER_REVIEW'))
        OR EXISTS (SELECT 1 FROM inventarios.task_locations tl JOIN inventarios.session_zone_locations szl ON szl.id=tl.session_zone_location_id JOIN inventarios.tasks t ON t.id=tl.task_id WHERE tl.company_id=p_company_id AND szl.company_id=p_company_id AND szl.location_id=p_location_id AND tl.status='OPEN' AND t.status IN ('IN_PROGRESS','PAUSED'));
    IF v_stock THEN v_reasons := v_reasons || jsonb_build_array(jsonb_build_object('code','STOCK_PRESENT','message','La ubicacion tiene saldo de stock positivo.')); END IF;
    IF v_history THEN v_reasons := v_reasons || jsonb_build_array(jsonb_build_object('code','HISTORY_PRESENT','message','La ubicacion tiene historial o referencias operativas.')); END IF;
    IF v_reference THEN v_reasons := v_reasons || jsonb_build_array(jsonb_build_object('code','INVENTORY_REFERENCE','message','La ubicacion esta referenciada por Inventarios.')); END IF;
    IF v_operation THEN v_reasons := v_reasons || jsonb_build_array(jsonb_build_object('code','ACTIVE_OPERATION','message','La ubicacion participa en una operacion o inventario activo.')); END IF;
    RETURN jsonb_build_object('found',true,'location_id',p_location_id,'has_stock',v_stock,'has_history',v_history,'has_inventory_reference',v_reference,'has_active_operation',v_operation,'can_edit_structure',NOT v_stock AND NOT v_history AND NOT v_operation,'can_deactivate',NOT v_stock AND NOT v_operation,'can_delete',NOT v_stock AND NOT v_history AND NOT v_operation,'blocking_reasons',v_reasons);
END;
$$;

ALTER FUNCTION logistica.evaluate_location_lifecycle(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION logistica.evaluate_location_lifecycle(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION logistica.evaluate_location_lifecycle(uuid, uuid) TO service_role;
