-- Migration: 20260803140300_inventarios_campaign_scope_rpcs.sql
-- Description: Fase 4I.2G. RPCs de campanas con dimensiones de alcance
--              (site_scope, product_scope, location_scope) y seleccion de
--              productos y ubicaciones. Reglas GENERAL/SELECTIVE/EXTERNAL.
-- Author: Assistant

-- ============================================================
-- 1. CREATE INVENTORY CAMPAIGN (con scopes)
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.create_inventory_campaign(
    p_company_id uuid,
    p_name text,
    p_campaign_type text,
    p_planned_at timestamptz,
    p_site_scope text,
    p_product_scope text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_name text; v_campaign_type text; v_site_scope text; v_product_scope text;
    v_campaign_id uuid; v_occurred_at timestamptz;
    v_response jsonb;
BEGIN
    v_name := pg_catalog.btrim(coalesce(p_name, ''));
    v_campaign_type := pg_catalog.upper(pg_catalog.btrim(coalesce(p_campaign_type, '')));
    v_site_scope := pg_catalog.upper(pg_catalog.btrim(coalesce(p_site_scope, '')));
    v_product_scope := pg_catalog.upper(pg_catalog.btrim(coalesce(p_product_scope, '')));
    IF p_company_id IS NULL OR v_name = '' OR pg_catalog.char_length(v_name) > 200
       OR v_campaign_type NOT IN ('GENERAL','SELECTIVE','EXTERNAL')
       OR v_site_scope NOT IN ('ALL_INTERNAL','SELECTED')
       OR v_product_scope NOT IN ('ALL','SELECTED') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    -- Reglas por tipo
    IF v_campaign_type = 'GENERAL' AND (v_site_scope <> 'ALL_INTERNAL' OR v_product_scope <> 'ALL') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','Una campana general usa todas las bodegas internas y todos los productos.','retryable',false)::text;
    END IF;
    IF v_campaign_type = 'EXTERNAL' AND v_site_scope <> 'SELECTED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','Una campana externa requiere unidades seleccionadas.','retryable',false)::text;
    END IF;
    IF v_campaign_type = 'SELECTIVE' AND v_site_scope = 'ALL_INTERNAL' AND v_product_scope = 'ALL' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SELECTIVE_SCOPE_REQUIRED',
            DETAIL=pg_catalog.jsonb_build_object('message','Una campana selectiva debe restringir al menos una dimension.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.manage');
    v_occurred_at := pg_catalog.now();

    INSERT INTO inventarios.inventory_campaigns (
        company_id, name, campaign_type, status, planned_at, site_scope, product_scope,
        created_at, created_by, updated_at, updated_by
    ) VALUES (
        p_company_id, v_name, v_campaign_type, 'DRAFT', p_planned_at,
        v_site_scope, v_product_scope,
        v_occurred_at, v_actor_id, v_occurred_at, v_actor_id
    )
    RETURNING id INTO v_campaign_id;

    v_response := pg_catalog.jsonb_build_object(
        'entity_id', v_campaign_id, 'state', 'DRAFT', 'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object('campaign_id', v_campaign_id, 'status', 'DRAFT')
    );
    RETURN v_response;
END;
$$;

-- ============================================================
-- 2. UPDATE INVENTORY CAMPAIGN SCOPE
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.update_inventory_campaign_scope(
    p_company_id uuid,
    p_campaign_id uuid,
    p_site_scope text,
    p_product_scope text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_campaign_type text;
    v_campaign_status text;
    v_site_scope text; v_product_scope text;
    v_occurred_at timestamptz;
    v_response jsonb;
BEGIN
    v_site_scope := pg_catalog.upper(pg_catalog.btrim(coalesce(p_site_scope, '')));
    v_product_scope := pg_catalog.upper(pg_catalog.btrim(coalesce(p_product_scope, '')));
    IF p_company_id IS NULL OR p_campaign_id IS NULL
       OR v_site_scope NOT IN ('ALL_INTERNAL','SELECTED')
       OR v_product_scope NOT IN ('ALL','SELECTED') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.manage');
    v_occurred_at := pg_catalog.now();

    SELECT campaign_type, status INTO v_campaign_type, v_campaign_status
    FROM inventarios.inventory_campaigns
    WHERE company_id = p_company_id AND id = p_campaign_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La campana no existe.','retryable',false)::text;
    END IF;
    IF v_campaign_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','Solo se puede configurar el alcance en DRAFT.','retryable',false,'status',v_campaign_status)::text;
    END IF;

    IF v_campaign_type = 'GENERAL' AND (v_site_scope <> 'ALL_INTERNAL' OR v_product_scope <> 'ALL') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','Una campana general usa todas las bodegas internas y todos los productos.','retryable',false)::text;
    END IF;
    IF v_campaign_type = 'EXTERNAL' AND v_site_scope <> 'SELECTED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','Una campana externa requiere unidades seleccionadas.','retryable',false)::text;
    END IF;
    IF v_campaign_type = 'SELECTIVE' AND v_site_scope = 'ALL_INTERNAL' AND v_product_scope = 'ALL' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SELECTIVE_SCOPE_REQUIRED',
            DETAIL=pg_catalog.jsonb_build_object('message','Una campana selectiva debe restringir al menos una dimension.','retryable',false)::text;
    END IF;

    UPDATE inventarios.inventory_campaigns
    SET site_scope = v_site_scope,
        product_scope = v_product_scope,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE company_id = p_company_id AND id = p_campaign_id;

    v_response := pg_catalog.jsonb_build_object(
        'entity_id', p_campaign_id, 'state', 'UPDATED', 'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object('campaign_id', p_campaign_id)
    );
    RETURN v_response;
END;
$$;

-- ============================================================
-- 3. SET INVENTORY CAMPAIGN SITES
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.set_inventory_campaign_sites(
    p_company_id uuid,
    p_campaign_id uuid,
    p_site_ids uuid[],
    p_location_scopes uuid[]
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_campaign_type text;
    v_campaign_status text;
    v_site_scope text;
    v_site_id uuid;
    v_order integer := 1;
    v_occurred_at timestamptz;
    v_response jsonb;
    v_general_count bigint;
    v_location_scope text;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.manage');
    v_occurred_at := pg_catalog.now();

    SELECT campaign_type, status, site_scope INTO v_campaign_type, v_campaign_status, v_site_scope
    FROM inventarios.inventory_campaigns
    WHERE company_id = p_company_id AND id = p_campaign_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La campana no existe.','retryable',false)::text;
    END IF;
    IF v_campaign_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','Solo se puede configurar el alcance en DRAFT.','retryable',false,'status',v_campaign_status)::text;
    END IF;

    IF v_campaign_type = 'GENERAL' THEN
        SELECT pg_catalog.count(*) INTO v_general_count
        FROM inventarios.inventory_sites is2
        WHERE is2.company_id = p_company_id
          AND is2.site_type = 'INTERNAL_WAREHOUSE'
          AND is2.is_active = true AND is2.inventory_enabled = true;

        IF v_general_count < 1 THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NO_GENERAL_SITES_CONFIGURED',
                DETAIL=pg_catalog.jsonb_build_object('message','No hay bodegas internas habilitadas para el inventario general.','retryable',false)::text;
        END IF;

        INSERT INTO inventarios.inventory_campaign_sites (
            company_id, campaign_id, inventory_site_id, is_required, display_order,
            location_scope, created_at, created_by
        )
        SELECT p_company_id, p_campaign_id, is2.id, true,
               pg_catalog.row_number() OVER (ORDER BY is2.code),
               'ALL', v_occurred_at, v_actor_id
        FROM inventarios.inventory_sites is2
        WHERE is2.company_id = p_company_id
          AND is2.site_type = 'INTERNAL_WAREHOUSE'
          AND is2.is_active = true AND is2.inventory_enabled = true
        ON CONFLICT (company_id, campaign_id, inventory_site_id) DO NOTHING;
    ELSIF v_campaign_type = 'EXTERNAL' THEN
        IF p_site_ids IS NULL OR pg_catalog.array_length(p_site_ids, 1) IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
                DETAIL=pg_catalog.jsonb_build_object('message','Selecciona al menos una unidad.','retryable',false)::text;
        END IF;
        FOR v_site_id IN SELECT unnest(p_site_ids)
        LOOP
            PERFORM 1 FROM inventarios.inventory_sites is2
            WHERE is2.company_id = p_company_id AND is2.id = v_site_id
              AND is2.inventory_enabled = true AND is2.is_active = true
              AND is2.site_type IN ('OWN_STORE','EXTERNAL_SITE');
            IF NOT FOUND THEN
                RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
                    DETAIL=pg_catalog.jsonb_build_object('message','La unidad no existe, no esta habilitada o no es externa.','retryable',false,'site_id',v_site_id)::text;
            END IF;
            INSERT INTO inventarios.inventory_campaign_sites (
                company_id, campaign_id, inventory_site_id, is_required, display_order,
                location_scope, created_at, created_by
            ) VALUES (
                p_company_id, p_campaign_id, v_site_id, true, v_order, 'ALL',
                v_occurred_at, v_actor_id
            )
            ON CONFLICT (company_id, campaign_id, inventory_site_id) DO NOTHING;
            v_order := v_order + 1;
        END LOOP;
    ELSE -- SELECTIVE
        IF v_site_scope = 'ALL_INTERNAL' THEN
            INSERT INTO inventarios.inventory_campaign_sites (
                company_id, campaign_id, inventory_site_id, is_required, display_order,
                location_scope, created_at, created_by
            )
            SELECT p_company_id, p_campaign_id, is2.id, true,
                   pg_catalog.row_number() OVER (ORDER BY is2.code),
                   'ALL', v_occurred_at, v_actor_id
            FROM inventarios.inventory_sites is2
            WHERE is2.company_id = p_company_id
              AND is2.site_type = 'INTERNAL_WAREHOUSE'
              AND is2.is_active = true AND is2.inventory_enabled = true
            ON CONFLICT (company_id, campaign_id, inventory_site_id) DO NOTHING;
        ELSE
            IF p_site_ids IS NULL OR pg_catalog.array_length(p_site_ids, 1) IS NULL THEN
                RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
                    DETAIL=pg_catalog.jsonb_build_object('message','Selecciona al menos una unidad.','retryable',false)::text;
            END IF;
            FOR v_site_id IN SELECT unnest(p_site_ids)
            LOOP
                PERFORM 1 FROM inventarios.inventory_sites is2
                WHERE is2.company_id = p_company_id AND is2.id = v_site_id
                  AND is2.inventory_enabled = true AND is2.is_active = true;
                IF NOT FOUND THEN
                    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
                        DETAIL=pg_catalog.jsonb_build_object('message','La unidad no existe o no esta habilitada.','retryable',false,'site_id',v_site_id)::text;
                END IF;
                INSERT INTO inventarios.inventory_campaign_sites (
                    company_id, campaign_id, inventory_site_id, is_required, display_order,
                    location_scope, created_at, created_by
                ) VALUES (
                    p_company_id, p_campaign_id, v_site_id, true, v_order, 'ALL',
                    v_occurred_at, v_actor_id
                )
                ON CONFLICT (company_id, campaign_id, inventory_site_id) DO NOTHING;
                v_order := v_order + 1;
            END LOOP;
        END IF;
    END IF;

    v_response := pg_catalog.jsonb_build_object(
        'entity_id', p_campaign_id, 'state', 'DRAFT', 'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object('campaign_id', p_campaign_id)
    );
    RETURN v_response;
END;
$$;

-- ============================================================
-- 4. SET INVENTORY CAMPAIGN SITE LOCATIONS
--    p_site_ids y p_location_ids alineados por posicion.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.set_inventory_campaign_site_locations(
    p_company_id uuid,
    p_campaign_id uuid,
    p_site_id uuid,
    p_location_ids uuid[]
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_campaign_status text;
    v_campaign_site_id uuid;
    v_occurred_at timestamptz;
    v_loc_id uuid;
    v_order integer;
    v_response jsonb;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_site_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.manage');
    v_occurred_at := pg_catalog.now();

    SELECT status INTO v_campaign_status
    FROM inventarios.inventory_campaigns
    WHERE company_id = p_company_id AND id = p_campaign_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La campana no existe.','retryable',false)::text;
    END IF;
    IF v_campaign_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','Solo se puede configurar el alcance en DRAFT.','retryable',false,'status',v_campaign_status)::text;
    END IF;

    SELECT id INTO v_campaign_site_id
    FROM inventarios.inventory_campaign_sites
    WHERE company_id = p_company_id AND campaign_id = p_campaign_id
      AND inventory_site_id = p_site_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La unidad no pertenece a la campana.','retryable',false)::text;
    END IF;

    UPDATE inventarios.inventory_campaign_sites
    SET location_scope = 'SELECTED'
    WHERE id = v_campaign_site_id;

    DELETE FROM inventarios.inventory_campaign_site_locations
    WHERE company_id = p_company_id AND campaign_site_id = v_campaign_site_id;

    IF p_location_ids IS NOT NULL AND pg_catalog.array_length(p_location_ids, 1) IS NOT NULL THEN
        v_order := 1;
        FOR v_loc_id IN SELECT unnest(p_location_ids)
        LOOP
            PERFORM 1 FROM inventarios.inventory_site_locations isl
            WHERE isl.company_id = p_company_id AND isl.id = v_loc_id
              AND isl.inventory_site_id = p_site_id;
            IF NOT FOUND THEN
                RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
                    DETAIL=pg_catalog.jsonb_build_object('message','La ubicacion no pertenece a la unidad de la campana.','retryable',false,'location_id',v_loc_id)::text;
            END IF;
            INSERT INTO inventarios.inventory_campaign_site_locations (
                company_id, campaign_site_id, inventory_site_location_id, display_order,
                created_at, created_by
            ) VALUES (
                p_company_id, v_campaign_site_id, v_loc_id, v_order,
                v_occurred_at, v_actor_id
            );
            v_order := v_order + 1;
        END LOOP;
    END IF;

    v_response := pg_catalog.jsonb_build_object(
        'entity_id', p_campaign_id, 'state', 'DRAFT', 'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object('campaign_id', p_campaign_id)
    );
    RETURN v_response;
END;
$$;

-- ============================================================
-- 5. SET INVENTORY CAMPAIGN PRODUCTS
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.set_inventory_campaign_products(
    p_company_id uuid,
    p_campaign_id uuid,
    p_product_ids uuid[]
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_product_scope text;
    v_campaign_status text;
    v_product_id uuid;
    v_sku text;
    v_order integer := 1;
    v_occurred_at timestamptz;
    v_response jsonb;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_product_ids IS NULL
       OR pg_catalog.array_length(p_product_ids, 1) IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','Selecciona al menos un producto.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.manage');
    v_occurred_at := pg_catalog.now();

    SELECT product_scope, status INTO v_product_scope, v_campaign_status
    FROM inventarios.inventory_campaigns
    WHERE company_id = p_company_id AND id = p_campaign_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La campana no existe.','retryable',false)::text;
    END IF;
    IF v_campaign_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','Solo se puede configurar el alcance en DRAFT.','retryable',false,'status',v_campaign_status)::text;
    END IF;
    IF v_product_scope <> 'SELECTED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La campana no usa productos seleccionados.','retryable',false)::text;
    END IF;

    DELETE FROM inventarios.inventory_campaign_products
    WHERE company_id = p_company_id AND campaign_id = p_campaign_id;

    FOR v_product_id IN SELECT unnest(p_product_ids)
    LOOP
        SELECT sku INTO v_sku
        FROM adquisiciones.products
        WHERE company_id = p_company_id AND id = v_product_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
                DETAIL=pg_catalog.jsonb_build_object('message','El producto no existe en la empresa.','retryable',false,'product_id',v_product_id)::text;
        END IF;
        INSERT INTO inventarios.inventory_campaign_products (
            company_id, campaign_id, product_id, sku, display_order, created_at, created_by
        ) VALUES (
            p_company_id, p_campaign_id, v_product_id, v_sku, v_order, v_occurred_at, v_actor_id
        );
        v_order := v_order + 1;
    END LOOP;

    v_response := pg_catalog.jsonb_build_object(
        'entity_id', p_campaign_id, 'state', 'DRAFT', 'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object('campaign_id', p_campaign_id)
    );
    RETURN v_response;
END;
$$;

-- ============================================================
-- 6. GRANTS / OWNER
-- ============================================================
ALTER FUNCTION inventarios.create_inventory_campaign(uuid, text, text, timestamptz, text, text) OWNER TO postgres;
ALTER FUNCTION inventarios.update_inventory_campaign_scope(uuid, uuid, text, text) OWNER TO postgres;
ALTER FUNCTION inventarios.set_inventory_campaign_sites(uuid, uuid, uuid[], uuid[]) OWNER TO postgres;
ALTER FUNCTION inventarios.set_inventory_campaign_site_locations(uuid, uuid, uuid, uuid[]) OWNER TO postgres;
ALTER FUNCTION inventarios.set_inventory_campaign_products(uuid, uuid, uuid[]) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.create_inventory_campaign(uuid, text, text, timestamptz, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.update_inventory_campaign_scope(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.set_inventory_campaign_sites(uuid, uuid, uuid[], uuid[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.set_inventory_campaign_site_locations(uuid, uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.set_inventory_campaign_products(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.create_inventory_campaign(uuid, text, text, timestamptz, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.update_inventory_campaign_scope(uuid, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.set_inventory_campaign_sites(uuid, uuid, uuid[], uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.set_inventory_campaign_site_locations(uuid, uuid, uuid, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.set_inventory_campaign_products(uuid, uuid, uuid[]) TO authenticated;
