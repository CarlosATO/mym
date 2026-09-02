-- Mantiene el catalogo derivado de Inventarios sincronizado con Logistica.
-- La sincronizacion interna no usa auth.uid() ni require_permission porque se
-- ejecuta dentro de la misma transaccion de la mutacion origen.

CREATE OR REPLACE FUNCTION inventarios.sync_internal_warehouse(
    p_company_id uuid,
    p_warehouse_id uuid,
    p_actor_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_warehouse record;
    v_site_id uuid;
    v_actor_id uuid := p_actor_id;
BEGIN
    SELECT w.id, w.company_id, w.code, w.name, w.is_active
    INTO v_warehouse
    FROM adquisiciones.warehouses w
    WHERE w.company_id = p_company_id AND w.id = p_warehouse_id;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    IF v_actor_id IS NULL THEN
        SELECT u.id INTO v_actor_id
        FROM portal.users u
        JOIN core.user_company_access a ON a.user_id = u.id
            AND a.company_id = p_company_id AND a.is_active = true
        WHERE u.is_active = true
        ORDER BY u.created_at
        LIMIT 1;
    END IF;
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'No existe un usuario activo para registrar la sincronizacion de Inventarios';
    END IF;

    INSERT INTO inventarios.inventory_sites (
        company_id, name, code, site_type, warehouse_id, is_active,
        inventory_enabled, created_at, created_by, updated_at, updated_by
    ) VALUES (
        v_warehouse.company_id, v_warehouse.name, v_warehouse.code,
        'INTERNAL_WAREHOUSE', v_warehouse.id, coalesce(v_warehouse.is_active, true),
        coalesce(v_warehouse.is_active, true), now(), v_actor_id, now(), v_actor_id
    )
    ON CONFLICT (company_id, warehouse_id) WHERE warehouse_id IS NOT NULL
    DO UPDATE SET
        name = EXCLUDED.name,
        code = EXCLUDED.code,
        is_active = EXCLUDED.is_active,
        inventory_enabled = CASE WHEN EXCLUDED.is_active THEN inventarios.inventory_sites.inventory_enabled ELSE false END,
        updated_at = now(),
        updated_by = EXCLUDED.updated_by
    RETURNING id INTO v_site_id;

    INSERT INTO inventarios.inventory_site_locations (
            company_id, inventory_site_id, source_logistics_location_id,
            code, name, aisle, rack, level, position, is_active,
            created_at, created_by, updated_at, updated_by
        )
        SELECT l.company_id, v_site_id, l.id, l.code, l.name, l.aisle, l.rack,
               l.level, l.position, l.is_active, now(), v_actor_id, now(), v_actor_id
        FROM logistica.locations l
        WHERE l.company_id = p_company_id AND l.warehouse_id = p_warehouse_id
    ON CONFLICT (company_id, source_logistics_location_id)
        WHERE source_logistics_location_id IS NOT NULL
    DO UPDATE SET
            inventory_site_id = EXCLUDED.inventory_site_id,
            code = EXCLUDED.code,
            name = EXCLUDED.name,
            aisle = EXCLUDED.aisle,
            rack = EXCLUDED.rack,
            level = EXCLUDED.level,
            position = EXCLUDED.position,
            is_active = EXCLUDED.is_active,
        updated_at = now(),
        updated_by = EXCLUDED.updated_by;
END;
$$;

CREATE OR REPLACE FUNCTION inventarios.sync_internal_location(
    p_company_id uuid,
    p_location_id uuid,
    p_actor_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_location record;
    v_actor_id uuid := p_actor_id;
    v_site_id uuid;
BEGIN
    SELECT l.* INTO v_location FROM logistica.locations l
    WHERE l.company_id = p_company_id AND l.id = p_location_id;
    IF NOT FOUND THEN RETURN; END IF;

    SELECT id INTO v_site_id FROM inventarios.inventory_sites
    WHERE company_id = p_company_id AND warehouse_id = v_location.warehouse_id
      AND site_type = 'INTERNAL_WAREHOUSE';
    IF v_site_id IS NULL THEN
        PERFORM inventarios.sync_internal_warehouse(p_company_id, v_location.warehouse_id, p_actor_id);
        SELECT id INTO v_site_id FROM inventarios.inventory_sites
        WHERE company_id = p_company_id AND warehouse_id = v_location.warehouse_id
          AND site_type = 'INTERNAL_WAREHOUSE';
    END IF;
    IF v_site_id IS NULL THEN RETURN; END IF;

    IF v_actor_id IS NULL THEN
        SELECT u.id INTO v_actor_id FROM portal.users u
        JOIN core.user_company_access a ON a.user_id = u.id
            AND a.company_id = p_company_id AND a.is_active = true
        WHERE u.is_active = true ORDER BY u.created_at LIMIT 1;
    END IF;
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'No existe un usuario activo para registrar la sincronizacion de Inventarios';
    END IF;

    INSERT INTO inventarios.inventory_site_locations (
        company_id, inventory_site_id, source_logistics_location_id,
        code, name, aisle, rack, level, position, is_active,
        created_at, created_by, updated_at, updated_by
    ) VALUES (
        p_company_id, v_site_id, v_location.id, v_location.code, v_location.name,
        v_location.aisle, v_location.rack, v_location.level, v_location.position,
        v_location.is_active, now(), v_actor_id, now(), v_actor_id
    )
    ON CONFLICT (company_id, source_logistics_location_id)
    WHERE source_logistics_location_id IS NOT NULL
    DO UPDATE SET
        inventory_site_id = EXCLUDED.inventory_site_id,
        code = EXCLUDED.code, name = EXCLUDED.name, aisle = EXCLUDED.aisle,
        rack = EXCLUDED.rack, level = EXCLUDED.level, position = EXCLUDED.position,
        is_active = EXCLUDED.is_active, updated_at = now(), updated_by = EXCLUDED.updated_by;
END;
$$;

CREATE OR REPLACE FUNCTION inventarios.trg_sync_warehouse()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    PERFORM inventarios.sync_internal_warehouse(
        NEW.company_id, NEW.id, coalesce(NEW.updated_by, NEW.created_by, auth.uid())
    );
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION inventarios.trg_sync_location()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    PERFORM inventarios.sync_internal_location(
        NEW.company_id, NEW.id, coalesce(NEW.updated_by, NEW.created_by, auth.uid())
    );
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION inventarios.trg_remove_location_mapping()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    DELETE FROM inventarios.inventory_site_locations
    WHERE company_id = OLD.company_id AND source_logistics_location_id = OLD.id;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_warehouse_to_inventory ON adquisiciones.warehouses;
CREATE TRIGGER trg_sync_warehouse_to_inventory
AFTER INSERT OR UPDATE OF code, name, is_active, status ON adquisiciones.warehouses
FOR EACH ROW EXECUTE FUNCTION inventarios.trg_sync_warehouse();

DROP TRIGGER IF EXISTS trg_sync_location_to_inventory ON logistica.locations;
CREATE TRIGGER trg_sync_location_to_inventory
AFTER INSERT OR UPDATE OF warehouse_id, code, name, aisle, rack, level, position, is_active
ON logistica.locations FOR EACH ROW EXECUTE FUNCTION inventarios.trg_sync_location();

DROP TRIGGER IF EXISTS trg_remove_location_inventory_mapping ON logistica.locations;
CREATE TRIGGER trg_remove_location_inventory_mapping
BEFORE DELETE ON logistica.locations
FOR EACH ROW EXECUTE FUNCTION inventarios.trg_remove_location_mapping();

ALTER FUNCTION inventarios.sync_internal_warehouse(uuid, uuid, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.sync_internal_location(uuid, uuid, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.trg_sync_warehouse() OWNER TO postgres;
ALTER FUNCTION inventarios.trg_sync_location() OWNER TO postgres;
ALTER FUNCTION inventarios.trg_remove_location_mapping() OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.sync_internal_warehouse(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.sync_internal_location(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- El mapping anterior es derivado. No debe convertir por si solo un borrado
-- permitido de Logistica en un borrado imposible; la FK sigue protegiendo
-- cualquier referencia historica/operativa que dependa de ese mapping.
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
