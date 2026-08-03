-- Migration: 20260803140600_inventarios_campaign_scope_coalesce_fix.sql
-- Description: Fase 4I.2G. Reaplica funciones con coalesce sin calificador.
-- Author: Assistant

DROP FUNCTION IF EXISTS inventarios.set_inventory_campaign_sites(uuid, uuid, uuid[]);

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

CREATE OR REPLACE FUNCTION inventarios.set_inventory_campaign_site_locations(
    p_company_id uuid,
    p_campaign_id uuid,
    p_site_ids uuid[],
    p_location_ids uuid[][]
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_campaign_status text;
    v_campaign_site_id uuid;
    v_occurred_at timestamptz;
    v_site_index integer;
    v_loc_id uuid;
    v_order integer;
    v_response jsonb;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_site_ids IS NULL
       OR pg_catalog.array_length(p_site_ids, 1) IS NULL THEN
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

    v_site_index := 1;
    FOR v_site_index IN 1..pg_catalog.array_length(p_site_ids, 1)
    LOOP
        SELECT id INTO v_campaign_site_id
        FROM inventarios.inventory_campaign_sites
        WHERE company_id = p_company_id AND campaign_id = p_campaign_id
          AND inventory_site_id = p_site_ids[v_site_index];
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
                DETAIL=pg_catalog.jsonb_build_object('message','La unidad no pertenece a la campana.','retryable',false)::text;
        END IF;

        UPDATE inventarios.inventory_campaign_sites
        SET location_scope = 'SELECTED',
            updated_at = v_occurred_at
        WHERE id = v_campaign_site_id;

        DELETE FROM inventarios.inventory_campaign_site_locations
        WHERE company_id = p_company_id AND campaign_site_id = v_campaign_site_id;

        IF p_location_ids[v_site_index] IS NOT NULL THEN
            v_order := 1;
            FOR v_loc_id IN SELECT unnest(p_location_ids[v_site_index])
            LOOP
                PERFORM 1 FROM inventarios.inventory_site_locations isl
                JOIN inventarios.inventory_campaign_sites ics
                  ON ics.company_id = p_company_id AND ics.id = v_campaign_site_id
                 AND ics.inventory_site_id = isl.inventory_site_id
                WHERE isl.company_id = p_company_id AND isl.id = v_loc_id;
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
    END LOOP;

    v_response := pg_catalog.jsonb_build_object(
        'entity_id', p_campaign_id, 'state', 'DRAFT', 'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object('campaign_id', p_campaign_id)
    );
    RETURN v_response;
END;
$$;

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
            SELECT isl.id AS inventory_site_location_id, isl.location_id
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
            SELECT isl.id AS inventory_site_location_id, isl.location_id
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


ALTER FUNCTION inventarios.set_inventory_campaign_sites(uuid, uuid, uuid[], uuid[]) OWNER TO postgres;
ALTER FUNCTION inventarios.set_inventory_campaign_site_locations(uuid, uuid, uuid[], uuid[][]) OWNER TO postgres;
ALTER FUNCTION inventarios.create_inventory_session_from_campaign_site(uuid, uuid, uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.set_inventory_campaign_sites(uuid, uuid, uuid[], uuid[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.set_inventory_campaign_site_locations(uuid, uuid, uuid[], uuid[][]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.create_inventory_session_from_campaign_site(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.set_inventory_campaign_sites(uuid, uuid, uuid[], uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.set_inventory_campaign_site_locations(uuid, uuid, uuid[], uuid[][]) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.create_inventory_session_from_campaign_site(uuid, uuid, uuid, uuid) TO authenticated;
