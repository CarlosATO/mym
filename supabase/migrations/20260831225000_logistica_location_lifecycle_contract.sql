-- Contrato central de ciclo de vida para ubicaciones logisticas.
-- Las mutaciones publicas de locations deben pasar por estas funciones para
-- que la evaluacion y el cambio ocurran en la misma transaccion.

CREATE OR REPLACE FUNCTION logistica.evaluate_location_lifecycle(
    p_company_id uuid,
    p_location_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_location_exists boolean;
    v_has_stock boolean;
    v_has_history boolean;
    v_has_inventory_reference boolean;
    v_has_active_operation boolean;
    v_reasons jsonb := '[]'::jsonb;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM logistica.locations l
        WHERE l.company_id = p_company_id AND l.id = p_location_id
    ) INTO v_location_exists;

    IF NOT v_location_exists THEN
        RETURN jsonb_build_object(
            'found', false,
            'location_id', p_location_id,
            'has_stock', false,
            'has_history', false,
            'has_inventory_reference', false,
            'has_active_operation', false,
            'can_edit_structure', false,
            'can_deactivate', false,
            'can_delete', false,
            'blocking_reasons', jsonb_build_array(jsonb_build_object(
                'code', 'LOCATION_NOT_FOUND',
                'message', 'La ubicacion no existe o no pertenece a la empresa activa.'
            ))
        );
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM logistica.v_stock_by_location s
        WHERE s.company_id = p_company_id
          AND s.location_id = p_location_id
          AND s.quantity > 0
    ) INTO v_has_stock;

    v_has_inventory_reference :=
        EXISTS (SELECT 1 FROM inventarios.inventory_site_locations x WHERE x.company_id = p_company_id AND x.source_logistics_location_id = p_location_id)
        OR EXISTS (SELECT 1 FROM inventarios.session_location_scopes x WHERE x.company_id = p_company_id AND x.location_id = p_location_id)
        OR EXISTS (SELECT 1 FROM inventarios.session_zone_locations x WHERE x.company_id = p_company_id AND x.location_id = p_location_id)
        OR EXISTS (SELECT 1 FROM inventarios.snapshot_locations x WHERE x.company_id = p_company_id AND x.location_id = p_location_id)
        OR EXISTS (SELECT 1 FROM inventarios.stock_import_rows x WHERE x.company_id = p_company_id AND x.location_id = p_location_id)
        OR EXISTS (SELECT 1 FROM inventarios.inventory_audit_locations x WHERE x.company_id = p_company_id AND x.location_id = p_location_id)
        OR EXISTS (SELECT 1 FROM inventarios.inventory_audit_results x WHERE x.company_id = p_company_id AND x.location_id = p_location_id);

    v_has_history :=
        EXISTS (SELECT 1 FROM logistica.kardex_movements x WHERE x.company_id = p_company_id AND x.location_id = p_location_id)
        OR EXISTS (SELECT 1 FROM logistica.purchase_receipt_items x WHERE x.company_id = p_company_id AND x.location_id = p_location_id)
        OR EXISTS (SELECT 1 FROM logistica.stock_adjustment_items x WHERE x.company_id = p_company_id AND x.location_id = p_location_id)
        OR EXISTS (SELECT 1 FROM logistica.stock_transfer_items x WHERE x.company_id = p_company_id AND x.from_location_id = p_location_id)
        OR EXISTS (SELECT 1 FROM logistica.stock_transfers x WHERE x.company_id = p_company_id AND x.to_location_id = p_location_id)
        OR v_has_inventory_reference;

    v_has_active_operation :=
        EXISTS (
            SELECT 1
            FROM inventarios.session_location_scopes sls
            JOIN inventarios.sessions s ON s.company_id = sls.company_id AND s.id = sls.session_id
            WHERE sls.company_id = p_company_id
              AND sls.location_id = p_location_id
              AND s.status IN ('COUNTING', 'UNDER_REVIEW')
        )
        OR EXISTS (
            SELECT 1
            FROM inventarios.session_zone_locations szl
            JOIN inventarios.sessions s ON s.company_id = szl.company_id AND s.id = szl.session_id
            WHERE szl.company_id = p_company_id
              AND szl.location_id = p_location_id
              AND s.status IN ('COUNTING', 'UNDER_REVIEW')
        )
        OR EXISTS (
            SELECT 1
            FROM inventarios.task_locations tl
            JOIN inventarios.session_zone_locations szl ON szl.id = tl.session_zone_location_id
            JOIN inventarios.tasks t ON t.id = tl.task_id
            WHERE tl.company_id = p_company_id
              AND szl.company_id = p_company_id
              AND szl.location_id = p_location_id
              AND tl.status = 'OPEN'
              AND t.status IN ('IN_PROGRESS', 'PAUSED')
        );

    IF v_has_stock THEN
        v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
            'code', 'STOCK_PRESENT',
            'message', 'La ubicacion tiene saldo de stock positivo.'
        ));
    END IF;
    IF v_has_history THEN
        v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
            'code', 'HISTORY_PRESENT',
            'message', 'La ubicacion tiene historial o referencias operativas.'
        ));
    END IF;
    IF v_has_inventory_reference THEN
        v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
            'code', 'INVENTORY_REFERENCE',
            'message', 'La ubicacion esta referenciada por Inventarios.'
        ));
    END IF;
    IF v_has_active_operation THEN
        v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
            'code', 'ACTIVE_OPERATION',
            'message', 'La ubicacion participa en una operacion o inventario activo.'
        ));
    END IF;

    RETURN jsonb_build_object(
        'found', true,
        'location_id', p_location_id,
        'has_stock', v_has_stock,
        'has_history', v_has_history,
        'has_inventory_reference', v_has_inventory_reference,
        'has_active_operation', v_has_active_operation,
        'can_edit_structure', NOT v_has_stock AND NOT v_has_history AND NOT v_has_active_operation,
        'can_deactivate', NOT v_has_stock AND NOT v_has_active_operation,
        'can_delete', NOT v_has_stock AND NOT v_has_history AND NOT v_has_inventory_reference AND NOT v_has_active_operation,
        'blocking_reasons', v_reasons
    );
END;
$$;

CREATE OR REPLACE FUNCTION logistica.update_location_lifecycle(
    p_company_id uuid,
    p_location_id uuid,
    p_code text,
    p_name text,
    p_aisle text,
    p_rack text,
    p_level text,
    p_position text,
    p_description text,
    p_is_active boolean,
    p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_current logistica.locations%ROWTYPE;
    v_eval jsonb;
    v_code text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_code, '')));
    v_name text := NULLIF(pg_catalog.upper(pg_catalog.btrim(p_name)), '');
    v_aisle text := NULLIF(pg_catalog.upper(pg_catalog.btrim(p_aisle)), '');
    v_rack text := NULLIF(pg_catalog.upper(pg_catalog.btrim(p_rack)), '');
    v_level text := NULLIF(pg_catalog.upper(pg_catalog.btrim(p_level)), '');
    v_position text := NULLIF(pg_catalog.upper(pg_catalog.btrim(p_position)), '');
    v_description text := NULLIF(pg_catalog.upper(pg_catalog.btrim(p_description)), '');
    v_structure_changed boolean;
BEGIN
    SELECT * INTO v_current
    FROM logistica.locations
    WHERE company_id = p_company_id AND id = p_location_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'La ubicacion no existe o no pertenece a la empresa activa.', 'blocking_reasons', jsonb_build_array(jsonb_build_object('code', 'LOCATION_NOT_FOUND', 'message', 'La ubicacion no existe o no pertenece a la empresa activa.')));
    END IF;
    IF v_code = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'El codigo es obligatorio.', 'blocking_reasons', jsonb_build_array(jsonb_build_object('code', 'INVALID_CODE', 'message', 'El codigo es obligatorio.')));
    END IF;

    v_eval := logistica.evaluate_location_lifecycle(p_company_id, p_location_id);
    v_structure_changed := v_current.code IS DISTINCT FROM v_code
        OR v_current.aisle IS DISTINCT FROM v_aisle
        OR v_current.rack IS DISTINCT FROM v_rack
        OR v_current.level IS DISTINCT FROM v_level
        OR v_current.position IS DISTINCT FROM v_position;

    IF v_structure_changed AND (v_eval ->> 'can_edit_structure')::boolean IS NOT TRUE THEN
        RETURN jsonb_build_object('success', false, 'error', 'La estructura fisica de la ubicacion no puede modificarse.', 'blocking_reasons', v_eval -> 'blocking_reasons');
    END IF;
    IF p_is_active IS FALSE AND v_current.is_active IS TRUE AND (v_eval ->> 'can_deactivate')::boolean IS NOT TRUE THEN
        RETURN jsonb_build_object('success', false, 'error', 'La ubicacion no puede desactivarse mientras tenga stock u operacion activa.', 'blocking_reasons', v_eval -> 'blocking_reasons');
    END IF;

    UPDATE logistica.locations
    SET code = v_code, name = v_name, aisle = v_aisle, rack = v_rack,
        level = v_level, position = v_position, description = v_description,
        is_active = coalesce(p_is_active, v_current.is_active),
        updated_at = pg_catalog.now(), updated_by = p_user_id
    WHERE company_id = p_company_id AND id = p_location_id;

    RETURN jsonb_build_object('success', true, 'location_id', p_location_id);
EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'La ubicacion con ese codigo ya existe en esta bodega.', 'blocking_reasons', jsonb_build_array(jsonb_build_object('code', 'DUPLICATE_CODE', 'message', 'La ubicacion con ese codigo ya existe en esta bodega.')));
END;
$$;

CREATE OR REPLACE FUNCTION logistica.toggle_location_lifecycle(
    p_company_id uuid,
    p_location_id uuid,
    p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_current logistica.locations%ROWTYPE;
    v_eval jsonb;
    v_new_active boolean;
BEGIN
    SELECT * INTO v_current FROM logistica.locations
    WHERE company_id = p_company_id AND id = p_location_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Ubicacion no encontrada.', 'blocking_reasons', jsonb_build_array(jsonb_build_object('code', 'LOCATION_NOT_FOUND', 'message', 'Ubicacion no encontrada.')));
    END IF;

    v_new_active := NOT v_current.is_active;
    IF v_new_active IS FALSE THEN
        v_eval := logistica.evaluate_location_lifecycle(p_company_id, p_location_id);
        IF (v_eval ->> 'can_deactivate')::boolean IS NOT TRUE THEN
            RETURN jsonb_build_object('success', false, 'error', 'La ubicacion no puede desactivarse mientras tenga stock u operacion activa.', 'blocking_reasons', v_eval -> 'blocking_reasons');
        END IF;
    END IF;

    UPDATE logistica.locations
    SET is_active = v_new_active, updated_at = pg_catalog.now(), updated_by = p_user_id
    WHERE company_id = p_company_id AND id = p_location_id;
    RETURN jsonb_build_object('success', true, 'new_active', v_new_active, 'location_id', p_location_id);
END;
$$;

CREATE OR REPLACE FUNCTION logistica.delete_location_lifecycle(
    p_company_id uuid,
    p_location_id uuid,
    p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_eval jsonb;
BEGIN
    PERFORM 1 FROM logistica.locations
    WHERE company_id = p_company_id AND id = p_location_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Ubicacion no encontrada.', 'blocking_reasons', jsonb_build_array(jsonb_build_object('code', 'LOCATION_NOT_FOUND', 'message', 'Ubicacion no encontrada.')));
    END IF;
    v_eval := logistica.evaluate_location_lifecycle(p_company_id, p_location_id);
    IF (v_eval ->> 'can_delete')::boolean IS NOT TRUE THEN
        RETURN jsonb_build_object('success', false, 'error', 'La ubicacion no puede eliminarse porque tiene historial, referencias, stock u operacion activa.', 'blocking_reasons', v_eval -> 'blocking_reasons');
    END IF;

    DELETE FROM logistica.locations WHERE company_id = p_company_id AND id = p_location_id;
    RETURN jsonb_build_object('success', true, 'location_id', p_location_id);
EXCEPTION WHEN foreign_key_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'La ubicacion tiene referencias y no puede eliminarse.', 'blocking_reasons', jsonb_build_array(jsonb_build_object('code', 'FOREIGN_KEY_REFERENCE', 'message', 'La ubicacion tiene referencias y no puede eliminarse.')));
END;
$$;

CREATE OR REPLACE FUNCTION logistica.deactivate_locations_by_aisle(
    p_company_id uuid,
    p_warehouse_id uuid,
    p_aisle text,
    p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_location record;
    v_eval jsonb;
    v_found boolean := false;
BEGIN
    FOR v_location IN
        SELECT l.id FROM logistica.locations l
        WHERE l.company_id = p_company_id AND l.warehouse_id = p_warehouse_id AND l.aisle = p_aisle
        FOR UPDATE
    LOOP
        v_found := true;
        v_eval := logistica.evaluate_location_lifecycle(p_company_id, v_location.id);
        IF (v_eval ->> 'can_deactivate')::boolean IS NOT TRUE THEN
            RETURN jsonb_build_object('success', false, 'error', 'No se puede desactivar el pasillo porque una ubicacion tiene stock u operacion activa.', 'blocking_reasons', v_eval -> 'blocking_reasons', 'location_id', v_location.id);
        END IF;
    END LOOP;
    IF NOT v_found THEN
        RETURN jsonb_build_object('success', false, 'error', 'Pasillo no encontrado.');
    END IF;

    UPDATE logistica.locations
    SET is_active = false, updated_at = pg_catalog.now(), updated_by = p_user_id
    WHERE company_id = p_company_id AND warehouse_id = p_warehouse_id AND aisle = p_aisle;
    RETURN jsonb_build_object('success', true);
END;
$$;

CREATE OR REPLACE FUNCTION logistica.rename_locations_aisle_if_safe(
    p_company_id uuid,
    p_warehouse_id uuid,
    p_old_aisle text,
    p_new_aisle text,
    p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_location record;
    v_eval jsonb;
    v_new_code text;
    v_found boolean := false;
BEGIN
    IF EXISTS (SELECT 1 FROM logistica.locations WHERE company_id = p_company_id AND warehouse_id = p_warehouse_id AND aisle = p_new_aisle) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Ya existe un pasillo con el nombre destino.', 'blocking_reasons', jsonb_build_array(jsonb_build_object('code', 'DUPLICATE_AISLE', 'message', 'Ya existe un pasillo con el nombre destino.')));
    END IF;

    FOR v_location IN
        SELECT l.id, l.rack, l.level, l.position
        FROM logistica.locations l
        WHERE l.company_id = p_company_id AND l.warehouse_id = p_warehouse_id AND l.aisle = p_old_aisle
        FOR UPDATE
    LOOP
        v_found := true;
        v_eval := logistica.evaluate_location_lifecycle(p_company_id, v_location.id);
        IF (v_eval ->> 'can_edit_structure')::boolean IS NOT TRUE THEN
            RETURN jsonb_build_object('success', false, 'error', 'El pasillo no puede renombrarse porque una ubicacion tiene historial, stock o una operacion activa.', 'blocking_reasons', v_eval -> 'blocking_reasons', 'location_id', v_location.id);
        END IF;
        v_new_code := 'P' || p_new_aisle
            || CASE WHEN v_location.rack IS NULL THEN '' ELSE '-R' || v_location.rack END
            || CASE WHEN v_location.level IS NULL THEN '' ELSE '-N' || v_location.level END
            || CASE WHEN v_location.position IS NULL THEN '' ELSE '-U' || v_location.position END;
        UPDATE logistica.locations SET aisle = p_new_aisle, code = v_new_code, updated_at = pg_catalog.now(), updated_by = p_user_id WHERE company_id = p_company_id AND id = v_location.id;
    END LOOP;
    IF NOT v_found THEN
        RETURN jsonb_build_object('success', false, 'error', 'Pasillo no encontrado.');
    END IF;
    RETURN jsonb_build_object('success', true);
EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'El renombrado genera un codigo de ubicacion duplicado.', 'blocking_reasons', jsonb_build_array(jsonb_build_object('code', 'DUPLICATE_CODE', 'message', 'El renombrado genera un codigo de ubicacion duplicado.')));
END;
$$;

REVOKE ALL ON FUNCTION logistica.evaluate_location_lifecycle(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION logistica.update_location_lifecycle(uuid, uuid, text, text, text, text, text, text, text, boolean, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION logistica.toggle_location_lifecycle(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION logistica.delete_location_lifecycle(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION logistica.deactivate_locations_by_aisle(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION logistica.rename_locations_aisle_if_safe(uuid, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION logistica.evaluate_location_lifecycle(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION logistica.update_location_lifecycle(uuid, uuid, text, text, text, text, text, text, text, boolean, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION logistica.toggle_location_lifecycle(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION logistica.delete_location_lifecycle(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION logistica.deactivate_locations_by_aisle(uuid, uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION logistica.rename_locations_aisle_if_safe(uuid, uuid, text, text, uuid) TO service_role;
