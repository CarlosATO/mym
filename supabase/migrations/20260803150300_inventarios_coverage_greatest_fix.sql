-- Migration: 20260803150300_inventarios_coverage_greatest_fix.sql
-- Description: Fase 4I.2H. Corrige greatest(bigint, integer) en get_task_coverage.
-- Author: Assistant

CREATE OR REPLACE FUNCTION inventarios.get_task_coverage(
    p_company_id uuid,
    p_task_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_session_id uuid;
    v_session_zone_id uuid;
    v_cycle integer;
    v_is_selected boolean;
    v_required bigint;
    v_reviewed bigint;
    v_pending bigint;
    v_required_products bigint;
    v_required_locations bigint;
    v_required_rows jsonb;
    v_reviewed_rows jsonb;
BEGIN
    IF p_company_id IS NULL OR p_task_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.tasks.read');

    SELECT t.session_id, t.session_zone_id, t.validation_cycle
    INTO v_session_id, v_session_zone_id, v_cycle
    FROM inventarios.tasks t
    WHERE t.company_id = p_company_id AND t.id = p_task_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La tarea no existe.','retryable',false)::text;
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM inventarios.sessions s
        JOIN inventarios.inventory_campaigns ic
          ON ic.company_id = s.company_id AND ic.id = s.campaign_id
        WHERE s.company_id = p_company_id AND s.id = v_session_id
          AND ic.product_scope = 'SELECTED'
    ) INTO v_is_selected;

    IF NOT v_is_selected THEN
        RETURN pg_catalog.jsonb_build_object(
            'is_selected', false,
            'required', 0, 'reviewed', 0, 'pending', 0, 'progress', 100,
            'required_products', 0, 'required_locations', 0,
            'required_rows', '[]'::jsonb, 'reviewed_rows', '[]'::jsonb
        );
    END IF;

    SELECT pg_catalog.count(*) INTO v_required_products
    FROM inventarios.session_product_scopes sps
    WHERE sps.company_id = p_company_id AND sps.session_id = v_session_id
      AND sps.inclusion_type = 'INCLUDED' AND sps.product_id IS NOT NULL;

    SELECT pg_catalog.count(*) INTO v_required_locations
    FROM inventarios.session_zone_locations szl
    WHERE szl.company_id = p_company_id AND szl.session_id = v_session_id
      AND szl.session_zone_id = v_session_zone_id;

    SELECT pg_catalog.count(*) INTO v_required
    FROM (
        SELECT sps.product_id, szl.snapshot_location_id
        FROM inventarios.session_product_scopes sps
        JOIN inventarios.session_zone_locations szl
          ON szl.company_id = sps.company_id
         AND szl.session_id = sps.session_id
         AND szl.session_zone_id = v_session_zone_id
        WHERE sps.company_id = p_company_id
          AND sps.session_id = v_session_id
          AND sps.inclusion_type = 'INCLUDED'
          AND sps.product_id IS NOT NULL
    ) required_combos;

    SELECT pg_catalog.count(*) INTO v_reviewed
    FROM (
        SELECT DISTINCT ce.snapshot_product_id, ce.snapshot_location_id
        FROM inventarios.count_entries ce
        WHERE ce.company_id = p_company_id
          AND ce.session_id = v_session_id
          AND ce.task_id = p_task_id
          AND ce.task_cycle = v_cycle
          AND ce.invalidated_at IS NULL AND ce.invalidated_by IS NULL
          AND ce.invalidation_reason IS NULL
    ) reviewed_combos;

    v_pending := CASE WHEN v_required > v_reviewed THEN v_required - v_reviewed ELSE 0 END;

    RETURN pg_catalog.jsonb_build_object(
        'is_selected', v_is_selected,
        'required', v_required, 'reviewed', v_reviewed, 'pending', v_pending,
        'progress', CASE WHEN v_required = 0 THEN 100 ELSE
            pg_catalog.round((v_reviewed::numeric / v_required::numeric) * 100, 1) END,
        'required_products', v_required_products,
        'required_locations', v_required_locations,
        'required_rows', '[]'::jsonb,
        'reviewed_rows', '[]'::jsonb
    );
END;
$$;


ALTER FUNCTION inventarios.get_task_coverage(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.get_task_coverage(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.get_task_coverage(uuid, uuid) TO authenticated;
