-- Migration: 20260803160200_inventarios_coverage_from_session_scope.sql
-- Description: Fase 4I.2H.1. La cobertura selectiva se determina desde
--              session_product_scopes (alcance congelado de la sesion), no desde
--              inventory_campaigns.product_scope. product_id -> snapshot_product_id
--              se resuelve via snapshot_products.product_id.
-- Author: Assistant

-- ============================================================
-- 1. TASK SELECTED COVERAGE OK (desde session_product_scopes)
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.task_selected_coverage_ok(
    p_company_id uuid,
    p_session_id uuid,
    p_task_id uuid,
    p_session_zone_id uuid,
    p_cycle integer
)
RETURNS boolean LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_required bigint;
BEGIN
    -- Productos requeridos: alcance congelado de la sesion (INCLUDED).
    -- Si no hay productos INCLUDED, la guarda selectiva no aplica.
    SELECT pg_catalog.count(*) INTO v_required
    FROM (
        SELECT sps.product_id
        FROM inventarios.session_product_scopes sps
        JOIN inventarios.snapshot_products sp
          ON sp.company_id = sps.company_id
         AND sp.product_id = sps.product_id
         AND sp.snapshot_id = (
             SELECT os.id FROM inventarios.operational_snapshots os
             WHERE os.company_id = sps.company_id AND os.session_id = sps.session_id
             ORDER BY os.snapshot_version DESC LIMIT 1
         )
        WHERE sps.company_id = p_company_id
          AND sps.session_id = p_session_id
          AND sps.inclusion_type = 'INCLUDED'
          AND sps.product_id IS NOT NULL
    ) required_products;

    IF v_required = 0 THEN
        RETURN true;
    END IF;

    -- Combinaciones pendientes: producto efectivo x ubicacion de la zona
    -- sin una count_entry efectiva (no invalidada) en el ciclo vigente.
    SELECT pg_catalog.count(*) INTO v_required
    FROM (
        SELECT sp.id AS snapshot_product_id, szl.snapshot_location_id
        FROM inventarios.session_product_scopes sps
        JOIN inventarios.snapshot_products sp
          ON sp.company_id = sps.company_id
         AND sp.product_id = sps.product_id
         AND sp.snapshot_id = (
             SELECT os.id FROM inventarios.operational_snapshots os
             WHERE os.company_id = sps.company_id AND os.session_id = sps.session_id
             ORDER BY os.snapshot_version DESC LIMIT 1
         )
        JOIN inventarios.session_zone_locations szl
          ON szl.company_id = sps.company_id
         AND szl.session_id = sps.session_id
         AND szl.session_zone_id = p_session_zone_id
        WHERE sps.company_id = p_company_id
          AND sps.session_id = p_session_id
          AND sps.inclusion_type = 'INCLUDED'
          AND sps.product_id IS NOT NULL
        EXCEPT
        SELECT ce.snapshot_product_id, ce.snapshot_location_id
        FROM inventarios.count_entries ce
        WHERE ce.company_id = p_company_id
          AND ce.session_id = p_session_id
          AND ce.task_id = p_task_id
          AND ce.task_cycle = p_cycle
          AND ce.invalidated_at IS NULL AND ce.invalidated_by IS NULL
          AND ce.invalidation_reason IS NULL
    ) missing_combos;

    RETURN v_required = 0;
END;
$$;

-- ============================================================
-- 2. GET TASK COVERAGE (misma fuente)
-- ============================================================
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
    v_required_products bigint;
    v_required bigint;
    v_reviewed bigint;
    v_pending bigint;
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

    SELECT pg_catalog.count(*) INTO v_required_products
    FROM inventarios.session_product_scopes sps
    WHERE sps.company_id = p_company_id AND sps.session_id = v_session_id
      AND sps.inclusion_type = 'INCLUDED' AND sps.product_id IS NOT NULL;

    SELECT pg_catalog.count(*) INTO v_required
    FROM (
        SELECT sp.id AS snapshot_product_id, szl.snapshot_location_id
        FROM inventarios.session_product_scopes sps
        JOIN inventarios.snapshot_products sp
          ON sp.company_id = sps.company_id
         AND sp.product_id = sps.product_id
         AND sp.snapshot_id = (
             SELECT os.id FROM inventarios.operational_snapshots os
             WHERE os.company_id = sps.company_id AND os.session_id = sps.session_id
             ORDER BY os.snapshot_version DESC LIMIT 1
         )
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
        'is_selected', v_required_products > 0,
        'required', v_required, 'reviewed', v_reviewed, 'pending', v_pending,
        'progress', CASE WHEN v_required = 0 THEN 100 ELSE
            pg_catalog.round((v_reviewed::numeric / v_required::numeric) * 100, 1) END,
        'required_products', v_required_products,
        'required_locations', (
            SELECT pg_catalog.count(*) FROM inventarios.session_zone_locations szl
            WHERE szl.company_id = p_company_id AND szl.session_id = v_session_id
              AND szl.session_zone_id = v_session_zone_id
        ),
        'required_rows', '[]'::jsonb,
        'reviewed_rows', '[]'::jsonb
    );
END;
$$;

-- ============================================================
-- 3. INDICE PARA LA RESOLUCION product_id -> snapshot_products
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_inventarios_snapshot_products_product
    ON inventarios.snapshot_products (company_id, product_id)
    WHERE product_id IS NOT NULL;

-- ============================================================
-- 4. GRANTS / OWNER
-- ============================================================
ALTER FUNCTION inventarios.task_selected_coverage_ok(uuid, uuid, uuid, uuid, integer) OWNER TO postgres;
ALTER FUNCTION inventarios.get_task_coverage(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.task_selected_coverage_ok(uuid, uuid, uuid, uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.get_task_coverage(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.task_selected_coverage_ok(uuid, uuid, uuid, uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.get_task_coverage(uuid, uuid) TO authenticated;
