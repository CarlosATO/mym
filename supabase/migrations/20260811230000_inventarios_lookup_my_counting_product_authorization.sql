-- =========================================================================================
-- MIGRATION: M1.5E.5 - Autorizacion operativa para busqueda de producto por codigo de barras
-- =========================================================================================

CREATE OR REPLACE FUNCTION inventarios.lookup_my_counting_product(p_zone_id uuid, p_location_id uuid, p_barcode text)
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
    v_matches jsonb;
    v_match_count integer;
    v_clean_barcode text;
BEGIN
    v_clean_barcode := pg_catalog.btrim(p_barcode);
    IF v_clean_barcode IS NULL OR v_clean_barcode = '' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El código de barras es obligatorio.', 'retryable', false)::text;
    END IF;

    v_actor_id := inventarios.require_actor();

    SELECT z.company_id, t.id, z.session_id, z.snapshot_id, true
    INTO v_company_id, v_task_id, v_session_id, v_snapshot_id, v_is_authorized
    FROM inventarios.task_assignments a
    JOIN inventarios.tasks t ON t.id = a.task_id
    JOIN inventarios.session_zones z ON z.id = t.session_zone_id
    JOIN inventarios.sessions s ON s.id = z.session_id
    JOIN inventarios.session_participants p ON p.id = a.session_participant_id
    WHERE z.id = p_zone_id
      AND a.user_id = v_actor_id
      AND a.released_at IS NULL
      AND p.user_id = v_actor_id
      AND p.functional_role = 'COUNTER'
      AND p.active_from <= pg_catalog.now()
      AND p.revoked_at IS NULL
      AND s.status = 'COUNTING'
      AND z.is_enabled = true
      AND t.status = 'IN_PROGRESS'
      AND t.active_user_id = v_actor_id
      AND t.cancelled_at IS NULL
      AND t.superseded_at IS NULL
      AND t.invalidated_at IS NULL;

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

    WITH snapshot_inventory AS (
        SELECT DISTINCT ON (sp.bsale_variant_id)
            sp.bsale_variant_id, sp.id AS snapshot_product_id, sp.product_id, sp.sku, sp.barcode, sp.name
        FROM inventarios.snapshot_products sp
        WHERE sp.company_id = v_company_id AND sp.snapshot_id = v_snapshot_id AND sp.bsale_variant_id IS NOT NULL
        ORDER BY sp.bsale_variant_id, sp.id
    ),
    snapshot_matches AS (
        SELECT DISTINCT ON (sp.bsale_variant_id)
            sp.product_id, sp.bsale_variant_id, sp.sku, sp.barcode, sp.name, 1 AS source_rank
        FROM inventarios.snapshot_products sp
        WHERE sp.company_id = v_company_id AND sp.snapshot_id = v_snapshot_id AND sp.bsale_variant_id IS NOT NULL AND sp.barcode = v_clean_barcode
        ORDER BY sp.bsale_variant_id, sp.id
    ),
    master_matches AS (
        SELECT DISTINCT ON (bv.bsale_id)
            p.id AS product_id, bv.bsale_id AS bsale_variant_id, bv.code AS sku, bv.bar_code AS barcode,
            pg_catalog.concat_ws(' - ', bp.name, bv.description) AS name, 2 AS source_rank
        FROM adquisiciones.products p
        JOIN integraciones.bsale_variants bv ON bv.company_id = p.company_id AND bv.bsale_id = p.bsale_variant_id
        JOIN integraciones.bsale_products bp ON bp.company_id = bv.company_id AND bp.bsale_id = bv.bsale_product_id
        WHERE p.company_id = v_company_id AND p.is_active = true AND bv.state = 0 AND bp.state = 0 AND bv.bar_code = v_clean_barcode
        ORDER BY bv.bsale_id, p.updated_at DESC NULLS LAST, p.id, bv.id, bp.id
    ),
    candidate_rows AS (
        SELECT * FROM snapshot_matches UNION ALL SELECT * FROM master_matches
    ),
    candidates AS (
        SELECT DISTINCT ON (cr.bsale_variant_id)
            cr.product_id, cr.bsale_variant_id, cr.sku, cr.barcode, cr.name
        FROM candidate_rows cr
        ORDER BY cr.bsale_variant_id, cr.source_rank, cr.product_id, cr.sku, cr.barcode, cr.name
    )
    SELECT pg_catalog.coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'product_id', c.product_id,
            'bsale_variant_id', c.bsale_variant_id,
            'sku', c.sku,
            'barcode', c.barcode,
            'name', c.name,
            'snapshot_product_id', si.snapshot_product_id,
            'in_snapshot', CASE WHEN si.snapshot_product_id IS NOT NULL THEN true ELSE false END
        ) ORDER BY c.sku ASC, c.name ASC, c.bsale_variant_id ASC
    ), '[]'::jsonb), pg_catalog.count(*)
    INTO v_matches, v_match_count
    FROM candidates c
    LEFT JOIN snapshot_inventory si ON si.bsale_variant_id = c.bsale_variant_id;

    IF v_match_count = 0 THEN
        RETURN pg_catalog.jsonb_build_object('status', 'NOT_FOUND', 'match_count', 0, 'matches', '[]'::jsonb);
    ELSIF v_match_count = 1 THEN
        RETURN pg_catalog.jsonb_build_object('status', 'MATCHED', 'match_count', 1, 'matches', v_matches);
    ELSE
        RETURN pg_catalog.jsonb_build_object('status', 'MULTIPLE_MATCHES', 'match_count', v_match_count, 'matches', v_matches);
    END IF;
END;
$function$;

ALTER FUNCTION inventarios.lookup_my_counting_product(uuid, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.lookup_my_counting_product(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.lookup_my_counting_product(uuid, uuid, text) TO authenticated;
