-- Migration: 20260803120410_inventarios_campaigns_rpcs.sql
-- Description: Fase 4I.2E. RPCs base de campanas y alcance por unidad.
-- Author: Assistant

CREATE OR REPLACE FUNCTION inventarios.create_inventory_campaign(
    p_company_id uuid,
    p_name text,
    p_campaign_type text,
    p_planned_at timestamptz
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_name text; v_campaign_type text;
    v_campaign_id uuid; v_occurred_at timestamptz;
    v_response jsonb;
BEGIN
    v_name := pg_catalog.btrim(coalesce(p_name, ''));
    v_campaign_type := pg_catalog.upper(pg_catalog.btrim(coalesce(p_campaign_type, '')));
    IF p_company_id IS NULL OR v_name = '' OR pg_catalog.char_length(v_name) > 200
       OR v_campaign_type NOT IN ('GENERAL','SELECTIVE','EXTERNAL') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.manage');
    v_occurred_at := pg_catalog.now();

    INSERT INTO inventarios.inventory_campaigns (
        company_id, name, campaign_type, status, planned_at,
        created_at, created_by, updated_at, updated_by
    ) VALUES (
        p_company_id, v_name, v_campaign_type, 'DRAFT', p_planned_at,
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

CREATE OR REPLACE FUNCTION inventarios.set_inventory_campaign_sites(
    p_company_id uuid,
    p_campaign_id uuid,
    p_site_ids uuid[]
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_campaign_type text;
    v_campaign_status text;
    v_site_id uuid;
    v_order integer := 1;
    v_occurred_at timestamptz;
    v_response jsonb;
    v_has_evidence boolean;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL THEN
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

    IF v_campaign_type = 'GENERAL' THEN
        INSERT INTO inventarios.inventory_campaign_sites (
            company_id, campaign_id, inventory_site_id, is_required, display_order,
            created_at, created_by
        )
        SELECT p_company_id, p_campaign_id, is2.id, true,
               pg_catalog.row_number() OVER (ORDER BY is2.code),
               v_occurred_at, v_actor_id
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

        FOR v_site_id IN
            SELECT unnest(p_site_ids)
        LOOP
            PERFORM 1 FROM inventarios.inventory_sites is2
            WHERE is2.company_id = p_company_id AND is2.id = v_site_id
              AND is2.inventory_enabled = true;
            IF NOT FOUND THEN
                RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
                    DETAIL=pg_catalog.jsonb_build_object('message','La unidad no existe o no esta habilitada.','retryable',false,'site_id',v_site_id)::text;
            END IF;

            IF v_campaign_type = 'EXTERNAL' THEN
                PERFORM 1 FROM inventarios.inventory_sites is2
                WHERE is2.company_id = p_company_id AND is2.id = v_site_id
                  AND is2.site_type IN ('OWN_STORE','EXTERNAL_SITE');
                IF NOT FOUND THEN
                    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
                        DETAIL=pg_catalog.jsonb_build_object('message','Las campanas externas solo admiten sitios externos.','retryable',false)::text;
                END IF;
            END IF;

            INSERT INTO inventarios.inventory_campaign_sites (
                company_id, campaign_id, inventory_site_id, is_required, display_order,
                created_at, created_by
            ) VALUES (
                p_company_id, p_campaign_id, v_site_id, true, v_order,
                v_occurred_at, v_actor_id
            )
            ON CONFLICT (company_id, campaign_id, inventory_site_id) DO NOTHING;
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
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');

    SELECT pg_catalog.jsonb_build_object(
        'id', ic.id, 'name', ic.name, 'campaign_type', ic.campaign_type,
        'status', ic.status, 'planned_at', ic.planned_at,
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
            'site_id', ics.inventory_site_id,
            'site_name', is2.name,
            'site_code', is2.code,
            'site_type', is2.site_type,
            'is_required', ics.is_required,
            'display_order', ics.display_order
        ) ORDER BY ics.display_order
    )
    INTO v_sites
    FROM inventarios.inventory_campaign_sites ics
    JOIN inventarios.inventory_sites is2
      ON is2.company_id = ics.company_id AND is2.id = ics.inventory_site_id
    WHERE ics.company_id = p_company_id AND ics.campaign_id = p_campaign_id;

    RETURN pg_catalog.jsonb_build_object(
        'campaign', v_campaign,
        'sites', CASE WHEN v_sites IS NULL THEN '[]'::jsonb ELSE v_sites END
    );
END;
$$;

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
            'status', ic.status, 'planned_at', ic.planned_at,
            'started_at', ic.started_at, 'completed_at', ic.completed_at,
            'approved_at', ic.approved_at,
            'cancelled_at', ic.cancelled_at,
            'created_at', ic.created_at,
            'site_count', (
                SELECT pg_catalog.count(*) FROM inventarios.inventory_campaign_sites ics
                WHERE ics.company_id = ic.company_id AND ics.campaign_id = ic.id
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


ALTER FUNCTION inventarios.create_inventory_campaign(uuid, text, text, timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.create_inventory_campaign(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.create_inventory_campaign(uuid, text, text, timestamptz) TO authenticated;
ALTER FUNCTION inventarios.set_inventory_campaign_sites(uuid, uuid, uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.set_inventory_campaign_sites(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.set_inventory_campaign_sites(uuid, uuid, uuid[]) TO authenticated;
ALTER FUNCTION inventarios.get_inventory_campaign(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.get_inventory_campaign(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.get_inventory_campaign(uuid, uuid) TO authenticated;
ALTER FUNCTION inventarios.list_inventory_campaigns(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.list_inventory_campaigns(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.list_inventory_campaigns(uuid) TO authenticated;
