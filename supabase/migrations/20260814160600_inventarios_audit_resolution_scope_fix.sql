-- =========================================================================================
-- MIGRATION: M1.5H fix - _inventarios_audit_resolution_scope: falta g.session_id
-- =========================================================================================
-- El CTE contribs no seleccionaba g.session_id, pero la agregacion final usaba
-- c.session_id para el conteo de contextos. Se agrega la columna.
-- Esquema afectado EXCLUSIVAMENTE: inventarios.
-- =========================================================================================

BEGIN;

CREATE OR REPLACE FUNCTION inventarios._inventarios_audit_resolution_scope(
    p_company_id uuid,
    p_audit_location_id uuid,
    p_bsale_variant_id integer
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_session_id uuid;
    v_snapshot_location_id uuid;
    v_manifest jsonb := '[]'::jsonb;
    v_replaced_physical numeric := 0;
    v_ctx_count bigint := 0;
    v_anchor jsonb := NULL;
    v_error text := NULL;
    v_error_detail text := NULL;
    v_snapshot_id uuid;
    v_zone_id uuid;
    v_task_id uuid;
    v_task_cycle integer;
    v_snapshot_product_id uuid;
    v_zone_count bigint;
    v_task_count bigint;
    v_sp_count bigint;
    v_primary_snapshot_id uuid;
    v_primary_zone_id uuid;
    v_primary_task_id uuid;
    v_primary_cycle integer;
    v_primary_location_id uuid;
    v_primary_product_id uuid;
BEGIN
    SELECT l.session_id, l.snapshot_location_id
    INTO v_session_id, v_snapshot_location_id
    FROM inventarios.inventory_audit_locations l
    WHERE l.company_id = p_company_id AND l.id = p_audit_location_id;
    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object(
            'manifest','[]'::jsonb, 'replaced_physical', 0::numeric,
            'anchor', NULL::jsonb, 'error', 'NO_CONTEXT',
            'error_detail', 'La ubicación de auditoría no existe.');
    END IF;

    -- 1) Manifest: contribuciones efectivas actuales del (producto, ubicacion).
    IF v_session_id IS NOT NULL THEN
        WITH contribs AS (
            SELECT g.contribution_count_entry_id, g.contribution_source, g.root_count_entry_id,
                   g.recount_request_id, g.recount_decision_id, g.task_id, g.task_cycle,
                   g.session_id, g.session_zone_id, g.snapshot_id, g.snapshot_location_id,
                   g.snapshot_product_id,
                   ce.captured_at, ce.physical_quantity
            FROM inventarios.tasks t
            CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, v_session_id, t.id) g
            JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
            WHERE t.company_id = p_company_id AND t.session_id = v_session_id
              AND t.cancelled_at IS NULL AND t.cancelled_by IS NULL
              AND ce.bsale_variant_id = p_bsale_variant_id
              AND ce.snapshot_location_id IS NOT DISTINCT FROM v_snapshot_location_id
        )
        SELECT
            CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
                 ELSE pg_catalog.jsonb_agg(
                    pg_catalog.jsonb_build_object(
                        'contribution_count_entry_id', c.contribution_count_entry_id,
                        'source', c.contribution_source,
                        'root_count_entry_id', c.root_count_entry_id,
                        'recount_request_id', c.recount_request_id,
                        'recount_decision_id', c.recount_decision_id,
                        'task_id', c.task_id,
                        'task_cycle', c.task_cycle,
                        'session_zone_id', c.session_zone_id,
                        'snapshot_id', c.snapshot_id,
                        'snapshot_location_id', c.snapshot_location_id,
                        'snapshot_product_id', c.snapshot_product_id,
                        'captured_at', c.captured_at,
                        'physical_quantity', c.physical_quantity
                    ) ORDER BY c.captured_at, c.contribution_count_entry_id)
            END,
            coalesce(pg_catalog.sum(c.physical_quantity), 0),
            pg_catalog.count(DISTINCT c.session_id || '|' || c.snapshot_id || '|'
                             || c.session_zone_id || '|' || c.snapshot_location_id)
        INTO v_manifest, v_replaced_physical, v_ctx_count
        FROM contribs c;
    END IF;

    IF jsonb_array_length(v_manifest) > 0 THEN
        IF v_ctx_count > 1 THEN
            RETURN pg_catalog.jsonb_build_object(
                'manifest', v_manifest, 'replaced_physical', v_replaced_physical,
                'anchor', NULL::jsonb, 'error', 'AMBIGUOUS_CONTEXT',
                'error_detail', 'Las contribuciones reemplazadas abarcan más de un contexto de ubicación.');
        END IF;
        v_primary_task_id := (v_manifest->0->>'task_id')::uuid;
        v_primary_cycle := (v_manifest->0->>'task_cycle')::integer;
        v_primary_snapshot_id := (v_manifest->0->>'snapshot_id')::uuid;
        v_primary_zone_id := (v_manifest->0->>'session_zone_id')::uuid;
        v_primary_location_id := (v_manifest->0->>'snapshot_location_id')::uuid;
        v_primary_product_id := (v_manifest->0->>'snapshot_product_id')::uuid;
        v_anchor := pg_catalog.jsonb_build_object(
            'session_id', v_session_id,
            'snapshot_id', v_primary_snapshot_id,
            'session_zone_id', v_primary_zone_id,
            'task_id', v_primary_task_id,
            'task_cycle', v_primary_cycle,
            'snapshot_location_id', v_primary_location_id,
            'snapshot_product_id', v_primary_product_id);
        RETURN pg_catalog.jsonb_build_object(
            'manifest', v_manifest, 'replaced_physical', v_replaced_physical,
            'anchor', v_anchor, 'error', NULL::text);
    END IF;

    -- 2) Manifest vacio: resolver contexto unico contractual (sin inferencia arbitraria).
    IF v_session_id IS NULL OR v_snapshot_location_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object(
            'manifest', v_manifest, 'replaced_physical', v_replaced_physical,
            'anchor', NULL::jsonb, 'error', 'NO_CONTEXT',
            'error_detail', 'La ubicación no tiene sesión ni snapshot_location para anclar el conteo sintético.');
    END IF;

    SELECT os.id INTO v_snapshot_id
    FROM inventarios.operational_snapshots os
    WHERE os.company_id = p_company_id AND os.session_id = v_session_id;
    IF v_snapshot_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object(
            'manifest', v_manifest, 'replaced_physical', v_replaced_physical,
            'anchor', NULL::jsonb, 'error', 'NO_CONTEXT',
            'error_detail', 'La sesión no tiene snapshot operacional.');
    END IF;

    SELECT pg_catalog.count(*), pg_catalog.min(szl.session_zone_id)
    INTO v_zone_count, v_zone_id
    FROM inventarios.session_zone_locations szl
    WHERE szl.company_id = p_company_id AND szl.session_id = v_session_id
      AND szl.snapshot_id = v_snapshot_id AND szl.snapshot_location_id = v_snapshot_location_id;
    IF v_zone_count = 0 THEN
        RETURN pg_catalog.jsonb_build_object(
            'manifest', v_manifest, 'replaced_physical', v_replaced_physical,
            'anchor', NULL::jsonb, 'error', 'NO_CONTEXT',
            'error_detail', 'La ubicación no pertenece a una zona del snapshot.');
    END IF;
    IF v_zone_count > 1 THEN
        RETURN pg_catalog.jsonb_build_object(
            'manifest', v_manifest, 'replaced_physical', v_replaced_physical,
            'anchor', NULL::jsonb, 'error', 'AMBIGUOUS_CONTEXT',
            'error_detail', 'La ubicación pertenece a más de una zona del snapshot.');
    END IF;

    SELECT pg_catalog.count(*), pg_catalog.min(t.id), pg_catalog.min(t.validation_cycle)
    INTO v_task_count, v_task_id, v_task_cycle
    FROM inventarios.tasks t
    WHERE t.company_id = p_company_id AND t.session_id = v_session_id
      AND t.session_zone_id = v_zone_id AND t.cancelled_at IS NULL AND t.cancelled_by IS NULL;
    IF v_task_count = 0 THEN
        RETURN pg_catalog.jsonb_build_object(
            'manifest', v_manifest, 'replaced_physical', v_replaced_physical,
            'anchor', NULL::jsonb, 'error', 'NO_CONTEXT',
            'error_detail', 'La zona no tiene tareas activas.');
    END IF;
    IF v_task_count > 1 THEN
        RETURN pg_catalog.jsonb_build_object(
            'manifest', v_manifest, 'replaced_physical', v_replaced_physical,
            'anchor', NULL::jsonb, 'error', 'AMBIGUOUS_CONTEXT',
            'error_detail', 'La zona tiene más de una tarea activa.');
    END IF;

    SELECT pg_catalog.count(*), pg_catalog.min(sp.id)
    INTO v_sp_count, v_snapshot_product_id
    FROM inventarios.snapshot_products sp
    WHERE sp.company_id = p_company_id AND sp.snapshot_id = v_snapshot_id
      AND sp.bsale_variant_id = p_bsale_variant_id;
    IF v_sp_count = 0 THEN
        RETURN pg_catalog.jsonb_build_object(
            'manifest', v_manifest, 'replaced_physical', v_replaced_physical,
            'anchor', NULL::jsonb, 'error', 'NO_CONTEXT',
            'error_detail', 'El producto no existe en el snapshot de la sesión.');
    END IF;
    IF v_sp_count > 1 THEN
        RETURN pg_catalog.jsonb_build_object(
            'manifest', v_manifest, 'replaced_physical', v_replaced_physical,
            'anchor', NULL::jsonb, 'error', 'AMBIGUOUS_CONTEXT',
            'error_detail', 'El producto tiene más de un registro en el snapshot.');
    END IF;

    v_anchor := pg_catalog.jsonb_build_object(
        'session_id', v_session_id,
        'snapshot_id', v_snapshot_id,
        'session_zone_id', v_zone_id,
        'task_id', v_task_id,
        'task_cycle', v_task_cycle,
        'snapshot_location_id', v_snapshot_location_id,
        'snapshot_product_id', v_snapshot_product_id);
    RETURN pg_catalog.jsonb_build_object(
        'manifest', v_manifest, 'replaced_physical', v_replaced_physical,
        'anchor', v_anchor, 'error', NULL::text);
END;
$function$;

ALTER FUNCTION inventarios._inventarios_audit_resolution_scope(uuid, uuid, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios._inventarios_audit_resolution_scope(uuid, uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios._inventarios_audit_resolution_scope(uuid, uuid, integer) TO authenticated, service_role;

COMMIT;
