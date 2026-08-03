-- Migration: 20260803140400_inventarios_campaign_query_and_session.sql
-- Description: Fase 4I.2G. GET/LIST de campanas con dimensiones de alcance,
--              productos y ubicaciones seleccionadas; y creacion de sesion
--              desde un campaign_site en DRAFT.
-- Author: Assistant

-- ============================================================
-- 1. GET INVENTORY CAMPAIGN (con scopes)
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.get_inventory_campaign(
    p_company_id uuid,
    p_campaign_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_campaign jsonb;
    v_sites jsonb;
    v_products jsonb;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');

    SELECT pg_catalog.jsonb_build_object(
        'id', ic.id, 'name', ic.name, 'campaign_type', ic.campaign_type,
        'status', ic.status, 'site_scope', ic.site_scope, 'product_scope', ic.product_scope,
        'planned_at', ic.planned_at,
        'started_at', ic.started_at, 'completed_at', ic.completed_at,
        'approved_at', ic.approved_at, 'approved_by_name', inventarios.user_display_name(ic.approved_by),
        'cancelled_at', ic.cancelled_at, 'cancelled_by_name', inventarios.user_display_name(ic.cancelled_by),
        'cancellation_reason', ic.cancellation_reason,
        'created_at', ic.created_at, 'created_by_name', inventarios.user_display_name(ic.created_by),
        'updated_at', ic.updated_at
    )
    INTO v_campaign
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id;

    IF v_campaign IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La campana no existe.','retryable',false)::text;
    END IF;

    SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'campaign_site_id', ics.id,
            'site_id', ics.inventory_site_id,
            'site_name', is2.name,
            'site_code', is2.code,
            'site_type', is2.site_type,
            'is_required', ics.is_required,
            'display_order', ics.display_order,
            'location_scope', ics.location_scope,
            'selected_location_count', (
                SELECT pg_catalog.count(*) FROM inventarios.inventory_campaign_site_locations icl
                WHERE icl.company_id = ics.company_id AND icl.campaign_site_id = ics.id
            ),
            'locations', (
                SELECT CASE
                    WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
                    ELSE pg_catalog.jsonb_agg(
                        pg_catalog.jsonb_build_object(
                            'location_id', isl.id,
                            'code', isl.code,
                            'name', isl.name,
                            'is_active', isl.is_active
                        ) ORDER BY icl.display_order
                    )
                END
                FROM inventarios.inventory_campaign_site_locations icl
                JOIN inventarios.inventory_site_locations isl
                  ON isl.company_id = icl.company_id AND isl.id = icl.inventory_site_location_id
                WHERE icl.company_id = ics.company_id AND icl.campaign_site_id = ics.id
            )
        ) ORDER BY ics.display_order
    )
    INTO v_sites
    FROM inventarios.inventory_campaign_sites ics
    JOIN inventarios.inventory_sites is2
      ON is2.company_id = ics.company_id AND is2.id = ics.inventory_site_id
    WHERE ics.company_id = p_company_id AND ics.campaign_id = p_campaign_id;

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'product_id', icp.product_id,
                'sku', icp.sku,
                'display_order', icp.display_order
            ) ORDER BY icp.display_order
        )
    END
    INTO v_products
    FROM inventarios.inventory_campaign_products icp
    WHERE icp.company_id = p_company_id AND icp.campaign_id = p_campaign_id;

    RETURN pg_catalog.jsonb_build_object(
        'campaign', v_campaign,
        'sites', CASE WHEN v_sites IS NULL THEN '[]'::jsonb ELSE v_sites END,
        'products', CASE WHEN v_products IS NULL THEN '[]'::jsonb ELSE v_products END
    );
END;
$$;

-- ============================================================
-- 2. LIST INVENTORY CAMPAIGNS (con scopes)
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.list_inventory_campaigns(
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
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');

    SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'id', ic.id, 'name', ic.name, 'campaign_type', ic.campaign_type,
            'status', ic.status, 'site_scope', ic.site_scope, 'product_scope', ic.product_scope,
            'planned_at', ic.planned_at,
            'started_at', ic.started_at, 'completed_at', ic.completed_at,
            'approved_at', ic.approved_at,
            'cancelled_at', ic.cancelled_at,
            'created_at', ic.created_at,
            'site_count', (
                SELECT pg_catalog.count(*) FROM inventarios.inventory_campaign_sites ics
                WHERE ics.company_id = ic.company_id AND ics.campaign_id = ic.id
            ),
            'product_count', (
                SELECT pg_catalog.count(*) FROM inventarios.inventory_campaign_products icp
                WHERE icp.company_id = ic.company_id AND icp.campaign_id = ic.id
            ),
            'session_count', (
                SELECT pg_catalog.count(*) FROM inventarios.sessions s
                WHERE s.company_id = ic.company_id AND s.campaign_id = ic.id
            )
        ) ORDER BY ic.created_at DESC
    )
    INTO v_rows
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id;

    RETURN pg_catalog.jsonb_build_object(
        'campaigns', CASE WHEN v_rows IS NULL THEN '[]'::jsonb ELSE v_rows END
    );
END;
$$;

-- ============================================================
-- 3. CREATE INVENTORY SESSION FROM CAMPAIGN SITE
--    Crea una sesion DRAFT por campaign_site heredando campaign/site,
--    derivando warehouse_id del sitio interno, y copiando productos y
--    ubicaciones seleccionados a los scopes de la sesion.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.create_inventory_session_from_campaign_site(
    p_company_id uuid,
    p_campaign_site_id uuid,
    p_responsible_user_id uuid,
    p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_operation jsonb; v_operation_id uuid;
    v_campaign_id uuid;
    v_site_id uuid;
    v_site_type text;
    v_warehouse_id uuid;
    v_campaign_name text;
    v_site_name text;
    v_product_scope text;
    v_location_scope text;
    v_campaign_status text;
    v_session_number integer;
    v_session_id uuid;
    v_snapshot_id uuid;
    v_participant_id uuid;
    v_occurred_at timestamptz;
    v_response jsonb;
    v_payload jsonb;
    v_loc_row record;
BEGIN
    IF p_company_id IS NULL OR p_campaign_site_id IS NULL OR p_responsible_user_id IS NULL
       OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.create');
    v_occurred_at := pg_catalog.now();

    SELECT ics.campaign_id, ics.inventory_site_id, ics.location_scope,
           ic.name, ic.product_scope, ic.status, is2.site_type, is2.warehouse_id, is2.name
    INTO v_campaign_id, v_site_id, v_location_scope,
         v_campaign_name, v_product_scope, v_campaign_status,
         v_site_type, v_warehouse_id, v_site_name
    FROM inventarios.inventory_campaign_sites ics
    JOIN inventarios.inventory_campaigns ic
      ON ic.company_id = ics.company_id AND ic.id = ics.campaign_id
    JOIN inventarios.inventory_sites is2
      ON is2.company_id = ics.company_id AND is2.id = ics.inventory_site_id
    WHERE ics.company_id = p_company_id AND ics.id = p_campaign_site_id
    FOR UPDATE OF ics;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La unidad de campana no existe.','retryable',false)::text;
    END IF;
    IF v_campaign_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La campana no esta en DRAFT.','retryable',false,'status',v_campaign_status)::text;
    END IF;

    -- Unidades externas no requieren warehouse_id
    IF v_site_type = 'INTERNAL_WAREHOUSE' AND v_warehouse_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La bodega interna no tiene bodega vinculada.','retryable',false)::text;
    END IF;

    -- Validaciones previas a crear la sesion
    IF v_product_scope = 'SELECTED' AND NOT EXISTS (
        SELECT 1 FROM inventarios.inventory_campaign_products icp
        WHERE icp.company_id = p_company_id AND icp.campaign_id = v_campaign_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La campana requiere al menos un producto seleccionado.','retryable',false)::text;
    END IF;
    IF v_location_scope = 'SELECTED' AND NOT EXISTS (
        SELECT 1 FROM inventarios.inventory_campaign_site_locations icl
        WHERE icl.company_id = p_company_id AND icl.campaign_site_id = p_campaign_site_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La unidad requiere al menos una ubicacion seleccionada.','retryable',false)::text;
    END IF;

    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.create_from_campaign_site','company_id',p_company_id,
        'campaign_site_id',p_campaign_site_id);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.session.create_from_campaign_site',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT coalesce(pg_catalog.max(session_number), 0) + 1
    INTO v_session_number
    FROM inventarios.sessions
    WHERE company_id = p_company_id;

    INSERT INTO inventarios.sessions (company_id, session_number, name, inventory_type, status,
        warehouse_id, bsale_office_id, scope_mode, responsible_user_id, campaign_id, inventory_site_id,
        created_at, created_by, updated_at, updated_by)
    VALUES (p_company_id, v_session_number,
        v_campaign_name || ' - ' || v_site_name, 'GENERAL', 'DRAFT',
        v_warehouse_id, NULL, 'GENERAL', p_responsible_user_id, v_campaign_id, v_site_id,
        v_occurred_at, v_actor_id, v_occurred_at, v_actor_id)
    RETURNING id INTO v_session_id;

    INSERT INTO inventarios.operational_snapshots (company_id, session_id, snapshot_version,
        completion_status, captured_at, captured_by, created_at, created_by)
    VALUES (p_company_id, v_session_id, 1, 'PENDING', v_occurred_at, v_actor_id, v_occurred_at, v_actor_id)
    RETURNING id INTO v_snapshot_id;

    INSERT INTO inventarios.session_participants (company_id, session_id, user_id, functional_role,
        active_from, created_at, created_by)
    VALUES (p_company_id, v_session_id, p_responsible_user_id, 'ADMINISTRATOR',
        v_occurred_at, v_occurred_at, v_actor_id)
    RETURNING id INTO v_participant_id;

    -- Copiar productos seleccionados a session_product_scopes
    IF v_product_scope = 'SELECTED' THEN
        INSERT INTO inventarios.session_product_scopes (company_id, session_id, product_id, bsale_variant_id, inclusion_type, created_at, created_by)
        SELECT icp.company_id, v_session_id, icp.product_id, coalesce(bv.bsale_id, 0), 'INCLUDED', v_occurred_at, v_actor_id
        FROM inventarios.inventory_campaign_products icp
        LEFT JOIN integraciones.bsale_variants bv
          ON bv.company_id = icp.company_id AND bv.code = icp.sku
        WHERE icp.company_id = p_company_id AND icp.campaign_id = v_campaign_id
        ORDER BY icp.display_order;
    END IF;

    -- Materializar ubicaciones de la unidad (ALL activas o SELECTED)
    IF v_location_scope = 'ALL' THEN
        FOR v_loc_row IN
            SELECT isl.id AS inventory_site_location_id, isl.source_logistics_location_id AS location_id
            FROM inventarios.inventory_site_locations isl
            WHERE isl.company_id = p_company_id AND isl.inventory_site_id = v_site_id
              AND isl.is_active = true
            ORDER BY isl.code
        LOOP
            IF v_loc_row.location_id IS NOT NULL THEN
                INSERT INTO inventarios.session_location_scopes (company_id, session_id, location_id, inclusion_type, created_at, created_by)
                VALUES (p_company_id, v_session_id, v_loc_row.location_id, 'INCLUDED', v_occurred_at, v_actor_id)
                ON CONFLICT (company_id, session_id, location_id) DO NOTHING;
            END IF;
        END LOOP;
    ELSE
        FOR v_loc_row IN
            SELECT isl.id AS inventory_site_location_id, isl.source_logistics_location_id AS location_id
            FROM inventarios.inventory_campaign_site_locations icl
            JOIN inventarios.inventory_site_locations isl
              ON isl.company_id = icl.company_id AND isl.id = icl.inventory_site_location_id
            WHERE icl.company_id = p_company_id AND icl.campaign_site_id = p_campaign_site_id
            ORDER BY icl.display_order
        LOOP
            IF v_loc_row.location_id IS NOT NULL THEN
                INSERT INTO inventarios.session_location_scopes (company_id, session_id, location_id, inclusion_type, created_at, created_by)
                VALUES (p_company_id, v_session_id, v_loc_row.location_id, 'INCLUDED', v_occurred_at, v_actor_id)
                ON CONFLICT (company_id, session_id, location_id) DO NOTHING;
            END IF;
        END LOOP;
    END IF;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.create_from_campaign_site','entity_id',v_session_id,'state','DRAFT',
        'version',NULL::integer,'cycle_number',NULL::integer,'assignment_id',NULL::uuid,
        'event_id',NULL::uuid,'replayed',false,'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object('session_number',v_session_number,
            'snapshot_id',v_snapshot_id,'campaign_id',v_campaign_id,'inventory_site_id',v_site_id,
            'responsible_participant_id',v_participant_id,'completion_status','PENDING'));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, v_session_id, v_response);
END;
$$;

-- ============================================================
-- 4. GRANTS / OWNER
-- ============================================================
ALTER FUNCTION inventarios.get_inventory_campaign(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.list_inventory_campaigns(uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.create_inventory_session_from_campaign_site(uuid, uuid, uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.get_inventory_campaign(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.list_inventory_campaigns(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.create_inventory_session_from_campaign_site(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.get_inventory_campaign(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.list_inventory_campaigns(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.create_inventory_session_from_campaign_site(uuid, uuid, uuid, uuid) TO authenticated;
