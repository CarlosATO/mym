-- Migration: 20260803140800_inventarios_campaign_site_locations_simple.sql
-- Description: Fase 4I.2G. Redefine set_inventory_campaign_site_locations con
--              firma simple (un site por llamada) en lugar de arrays 2D.
-- Author: Assistant

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


DROP FUNCTION IF EXISTS inventarios.set_inventory_campaign_site_locations(uuid, uuid, uuid[], uuid[][]);

ALTER FUNCTION inventarios.set_inventory_campaign_site_locations(uuid, uuid, uuid, uuid[]) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.set_inventory_campaign_site_locations(uuid, uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.set_inventory_campaign_site_locations(uuid, uuid, uuid, uuid[]) TO authenticated;
