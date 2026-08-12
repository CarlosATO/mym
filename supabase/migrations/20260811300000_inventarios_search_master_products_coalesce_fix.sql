-- =========================================================================================
-- MIGRATION: M1.5E.12 - Fix coalesce de search_master_products (scope global)
-- =========================================================================================
-- En la migracion anterior (20260811290000) el campo 'name' de search_master_products
-- uso pg_catalog.coalesce(...), que falla en runtime (42883 function pg_catalog.coalesce
-- does not exist). Unico cambio funcional: pg_catalog.coalesce(...) -> coalesce(...).
-- No se altera alcance, autorizacion, ranking, limite, in_snapshot ni grants.

CREATE OR REPLACE FUNCTION inventarios.search_master_products(p_zone_id uuid, p_location_id uuid, p_query text, p_limit integer DEFAULT 20)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_company_id uuid;
    v_session_id uuid;
    v_snapshot_id uuid;
    v_task_id uuid;
    v_is_authorized boolean := false;
    v_is_open boolean := false;
    v_clean_query text;
    v_limit integer;
    v_results jsonb;
BEGIN
    v_clean_query := pg_catalog.btrim(p_query);
    IF v_clean_query IS NULL OR pg_catalog.length(v_clean_query) < 2 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La búsqueda debe tener al menos 2 caracteres.', 'retryable', false)::text;
    END IF;
    v_limit := COALESCE(p_limit, 20);
    v_limit := LEAST(20, GREATEST(1, v_limit));
    v_actor_id := inventarios.require_actor();

    SELECT z.company_id, t.id, z.session_id, z.snapshot_id, true
    INTO v_company_id, v_task_id, v_session_id, v_snapshot_id, v_is_authorized
    FROM inventarios.task_assignments a
    JOIN inventarios.tasks t ON t.id = a.task_id
    JOIN inventarios.session_zones z ON z.id = t.session_zone_id
    JOIN inventarios.sessions s ON s.id = z.session_id
    JOIN inventarios.session_participants p ON p.id = a.session_participant_id
    WHERE z.id = p_zone_id AND a.user_id = v_actor_id AND a.released_at IS NULL
      AND p.user_id = v_actor_id AND p.functional_role = 'COUNTER'
      AND p.active_from <= pg_catalog.now() AND p.revoked_at IS NULL
      AND s.status = 'COUNTING' AND z.is_enabled = true AND t.status = 'IN_PROGRESS'
      AND t.active_user_id = v_actor_id
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL AND t.invalidated_at IS NULL;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;
    PERFORM inventarios.require_company_access(v_company_id);

    SELECT true INTO v_is_open
    FROM inventarios.task_locations tl
    JOIN inventarios.session_zone_locations szl ON szl.id = tl.session_zone_location_id
    WHERE tl.company_id = v_company_id AND tl.task_id = v_task_id AND tl.session_zone_id = p_zone_id
      AND szl.session_zone_id = p_zone_id AND szl.location_id = p_location_id
      AND tl.opened_by = v_actor_id AND tl.status = 'OPEN';

    IF v_is_open IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La ubicación no está abierta para esta tarea.', 'retryable', false)::text;
    END IF;

    -- Maestra global de la empresa: todos los productos activos (fuente oficial),
    -- sin excluir por estado del espejo Bsale ni por snapshot.
    WITH snapshot_inventory AS (
        SELECT DISTINCT ON (sp.bsale_variant_id) sp.bsale_variant_id, sp.id AS snapshot_product_id
        FROM inventarios.snapshot_products sp
        WHERE sp.company_id = v_company_id AND sp.snapshot_id = v_snapshot_id AND sp.bsale_variant_id IS NOT NULL
        ORDER BY sp.bsale_variant_id, sp.id
    ),
    master_rows AS (
        SELECT
            p.id AS product_id,
            p.bsale_variant_id AS bsale_variant_id,
            p.sku AS sku,
            p.barcode AS barcode,
            coalesce(NULLIF(pg_catalog.btrim(p.description), ''), NULLIF(pg_catalog.btrim(p.short_description), '')) AS name,
            CASE
                WHEN p.sku ILIKE v_clean_query OR p.description ILIKE v_clean_query OR p.short_description ILIKE v_clean_query OR p.barcode ILIKE v_clean_query THEN 1
                WHEN p.sku ILIKE v_clean_query || '%' OR p.description ILIKE v_clean_query || '%' OR p.short_description ILIKE v_clean_query || '%' OR p.barcode ILIKE v_clean_query || '%' THEN 2
                ELSE 3
            END AS match_rank,
            CASE
                WHEN p.sku ILIKE v_clean_query THEN 1
                WHEN p.description ILIKE v_clean_query THEN 2
                WHEN p.short_description ILIKE v_clean_query THEN 3
                WHEN p.barcode ILIKE v_clean_query THEN 4
                WHEN p.sku ILIKE v_clean_query || '%' THEN 5
                WHEN p.description ILIKE v_clean_query || '%' THEN 6
                WHEN p.short_description ILIKE v_clean_query || '%' THEN 7
                WHEN p.barcode ILIKE v_clean_query || '%' THEN 8
                WHEN p.sku ILIKE '%' || v_clean_query || '%' THEN 9
                WHEN p.description ILIKE '%' || v_clean_query || '%' THEN 10
                WHEN p.short_description ILIKE '%' || v_clean_query || '%' THEN 11
                WHEN p.barcode ILIKE '%' || v_clean_query || '%' THEN 12
                ELSE 13
            END AS match_field_rank
        FROM adquisiciones.products p
        WHERE p.company_id = v_company_id AND p.is_active = true
          AND (
              p.sku ILIKE '%' || v_clean_query || '%'
              OR p.description ILIKE '%' || v_clean_query || '%'
              OR p.short_description ILIKE '%' || v_clean_query || '%'
              OR p.barcode ILIKE '%' || v_clean_query || '%'
          )
    ),
    search_dedup AS (
        SELECT mr.*, pg_catalog.row_number() OVER (
            PARTITION BY mr.product_id
            ORDER BY mr.match_rank ASC, mr.match_field_rank ASC, mr.name ASC, mr.product_id ASC
        ) AS rn
        FROM master_rows mr
    ),
    search_unique AS (
        SELECT product_id, bsale_variant_id, sku, barcode, name, match_rank, match_field_rank
        FROM search_dedup WHERE rn = 1
    ),
    ranked_results AS (
        SELECT su.product_id, su.bsale_variant_id, su.sku, su.barcode, su.name, su.match_rank, su.match_field_rank,
               si.snapshot_product_id,
               CASE WHEN si.snapshot_product_id IS NOT NULL THEN true ELSE false END AS in_snapshot
        FROM search_unique su
        LEFT JOIN snapshot_inventory si ON si.bsale_variant_id = su.bsale_variant_id
        ORDER BY su.match_rank ASC, su.match_field_rank ASC, su.name ASC, su.product_id ASC
        LIMIT v_limit
    )
    SELECT coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'product_id', r.product_id,
            'bsale_variant_id', r.bsale_variant_id,
            'sku', r.sku,
            'barcode', r.barcode,
            'name', r.name,
            'snapshot_product_id', r.snapshot_product_id,
            'in_snapshot', r.in_snapshot
        ) ORDER BY r.match_rank ASC, r.match_field_rank ASC, r.name ASC, r.product_id ASC
    ), '[]'::jsonb)
    INTO v_results
    FROM ranked_results r;

    RETURN v_results;
END;
$function$;

ALTER FUNCTION inventarios.search_master_products(uuid, uuid, text, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.search_master_products(uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.search_master_products(uuid, uuid, text, integer) TO authenticated;
