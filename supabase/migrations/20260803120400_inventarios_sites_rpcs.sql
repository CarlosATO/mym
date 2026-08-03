-- Migration: 20260803120400_inventarios_sites_rpcs.sql
-- Description: Fase 4I.2E. RPCs base de unidades inventariables y ubicaciones.
-- Author: Assistant

CREATE OR REPLACE FUNCTION inventarios.list_inventory_sites(
    p_company_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_rows jsonb;
BEGIN
    IF p_company_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sites.read');

    SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'id', is2.id,
            'company_id', is2.company_id,
            'name', is2.name,
            'code', is2.code,
            'site_type', is2.site_type,
            'warehouse_id', is2.warehouse_id,
            'warehouse_name', w.name,
            'is_active', is2.is_active,
            'inventory_enabled', is2.inventory_enabled,
            'created_at', is2.created_at,
            'updated_at', is2.updated_at
        ) ORDER BY is2.code
    )
    INTO v_rows
    FROM inventarios.inventory_sites is2
    LEFT JOIN adquisiciones.warehouses w ON w.id = is2.warehouse_id
    WHERE is2.company_id = p_company_id;

    RETURN pg_catalog.jsonb_build_object(
        'sites', CASE WHEN v_rows IS NULL THEN '[]'::jsonb ELSE v_rows END
    );
END;
$$;

CREATE OR REPLACE FUNCTION inventarios.create_inventory_site(
    p_company_id uuid,
    p_name text,
    p_code text,
    p_site_type text,
    p_warehouse_id uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_name text; v_code text; v_site_type text;
    v_site_id uuid; v_occurred_at timestamptz;
    v_response jsonb;
BEGIN
    v_name := pg_catalog.btrim(coalesce(p_name, ''));
    v_code := pg_catalog.btrim(coalesce(p_code, ''));
    v_site_type := pg_catalog.upper(pg_catalog.btrim(coalesce(p_site_type, '')));
    IF p_company_id IS NULL OR v_name = '' OR pg_catalog.char_length(v_name) > 200
       OR v_code = '' OR pg_catalog.char_length(v_code) > 50
       OR v_site_type NOT IN ('INTERNAL_WAREHOUSE','OWN_STORE','EXTERNAL_SITE') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    IF v_site_type = 'INTERNAL_WAREHOUSE' AND p_warehouse_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La bodega interna es obligatoria.','retryable',false)::text;
    END IF;
    IF v_site_type IN ('OWN_STORE','EXTERNAL_SITE') AND p_warehouse_id IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','Los sitios externos no llevan bodega interna.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sites.manage');
    v_occurred_at := pg_catalog.now();

    IF v_site_type = 'INTERNAL_WAREHOUSE' THEN
        IF NOT EXISTS (SELECT 1 FROM adquisiciones.warehouses w
                       WHERE w.id = p_warehouse_id AND w.company_id = p_company_id) THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
                DETAIL=pg_catalog.jsonb_build_object('message','La bodega no existe en la empresa.','retryable',false)::text;
        END IF;
    END IF;

    IF EXISTS (SELECT 1 FROM inventarios.inventory_sites
               WHERE company_id = p_company_id AND code = v_code) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
            DETAIL=pg_catalog.jsonb_build_object('message','Ya existe una unidad con ese codigo.','retryable',false)::text;
    END IF;

    INSERT INTO inventarios.inventory_sites (
        company_id, name, code, site_type, warehouse_id, is_active,
        inventory_enabled, created_at, created_by, updated_at, updated_by
    ) VALUES (
        p_company_id, v_name, v_code, v_site_type, p_warehouse_id, true, true,
        v_occurred_at, v_actor_id, v_occurred_at, v_actor_id
    )
    RETURNING id INTO v_site_id;

    v_response := pg_catalog.jsonb_build_object(
        'entity_id', v_site_id, 'state', 'ACTIVE', 'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object('site_id', v_site_id, 'code', v_code)
    );
    RETURN v_response;
END;
$$;

CREATE OR REPLACE FUNCTION inventarios.update_inventory_site(
    p_company_id uuid,
    p_site_id uuid,
    p_name text,
    p_is_active boolean,
    p_inventory_enabled boolean
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_name text;
    v_occurred_at timestamptz;
    v_response jsonb;
BEGIN
    v_name := pg_catalog.btrim(coalesce(p_name, ''));
    IF p_company_id IS NULL OR p_site_id IS NULL OR v_name = '' OR pg_catalog.char_length(v_name) > 200 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sites.manage');
    v_occurred_at := pg_catalog.now();

    UPDATE inventarios.inventory_sites
    SET name = v_name,
        is_active = coalesce(p_is_active, is_active),
        inventory_enabled = coalesce(p_inventory_enabled, inventory_enabled),
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE company_id = p_company_id AND id = p_site_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La unidad inventariable no existe.','retryable',false)::text;
    END IF;

    v_response := pg_catalog.jsonb_build_object(
        'entity_id', p_site_id, 'state', 'UPDATED', 'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object('site_id', p_site_id)
    );
    RETURN v_response;
END;
$$;

CREATE OR REPLACE FUNCTION inventarios.create_inventory_site_location(
    p_company_id uuid,
    p_inventory_site_id uuid,
    p_code text,
    p_name text,
    p_aisle text,
    p_rack text,
    p_level text,
    p_position text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_code text; v_site_type text;
    v_location_id uuid; v_occurred_at timestamptz;
    v_response jsonb;
BEGIN
    v_code := pg_catalog.btrim(coalesce(p_code, ''));
    IF p_company_id IS NULL OR p_inventory_site_id IS NULL OR v_code = ''
       OR pg_catalog.char_length(v_code) > 50 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sites.manage');
    v_occurred_at := pg_catalog.now();

    SELECT site_type INTO v_site_type
    FROM inventarios.inventory_sites
    WHERE company_id = p_company_id AND id = p_inventory_site_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La unidad inventariable no existe.','retryable',false)::text;
    END IF;
    IF v_site_type = 'INTERNAL_WAREHOUSE' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','Las ubicaciones internas provienen de Logistica.','retryable',false)::text;
    END IF;

    INSERT INTO inventarios.inventory_site_locations (
        company_id, inventory_site_id, source_logistics_location_id,
        code, name, aisle, rack, level, position, is_active,
        created_at, created_by, updated_at, updated_by
    ) VALUES (
        p_company_id, p_inventory_site_id, NULL,
        v_code, pg_catalog.btrim(coalesce(p_name, '')), pg_catalog.btrim(coalesce(p_aisle, '')),
        pg_catalog.btrim(coalesce(p_rack, '')), pg_catalog.btrim(coalesce(p_level, '')),
        pg_catalog.btrim(coalesce(p_position, '')), true,
        v_occurred_at, v_actor_id, v_occurred_at, v_actor_id
    )
    RETURNING id INTO v_location_id;

    v_response := pg_catalog.jsonb_build_object(
        'entity_id', v_location_id, 'state', 'ACTIVE', 'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object('location_id', v_location_id, 'code', v_code)
    );
    RETURN v_response;
END;
$$;

CREATE OR REPLACE FUNCTION inventarios.update_inventory_site_location(
    p_company_id uuid,
    p_location_id uuid,
    p_name text,
    p_is_active boolean
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_occurred_at timestamptz;
    v_response jsonb;
BEGIN
    IF p_company_id IS NULL OR p_location_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sites.manage');
    v_occurred_at := pg_catalog.now();

    UPDATE inventarios.inventory_site_locations
    SET name = coalesce(pg_catalog.btrim(coalesce(p_name, '')), name),
        is_active = coalesce(p_is_active, is_active),
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE company_id = p_company_id AND id = p_location_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La ubicacion no existe.','retryable',false)::text;
    END IF;

    v_response := pg_catalog.jsonb_build_object(
        'entity_id', p_location_id, 'state', 'UPDATED', 'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object('location_id', p_location_id)
    );
    RETURN v_response;
END;
$$;


ALTER FUNCTION inventarios.list_inventory_sites(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.list_inventory_sites(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.list_inventory_sites(uuid) TO authenticated;
ALTER FUNCTION inventarios.create_inventory_site(uuid, text, text, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.create_inventory_site(uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.create_inventory_site(uuid, text, text, text, uuid) TO authenticated;
ALTER FUNCTION inventarios.update_inventory_site(uuid, uuid, text, boolean, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.update_inventory_site(uuid, uuid, text, boolean, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.update_inventory_site(uuid, uuid, text, boolean, boolean) TO authenticated;
ALTER FUNCTION inventarios.create_inventory_site_location(uuid, uuid, text, text, text, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.create_inventory_site_location(uuid, uuid, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.create_inventory_site_location(uuid, uuid, text, text, text, text, text, text) TO authenticated;
ALTER FUNCTION inventarios.update_inventory_site_location(uuid, uuid, text, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.update_inventory_site_location(uuid, uuid, text, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.update_inventory_site_location(uuid, uuid, text, boolean) TO authenticated;
