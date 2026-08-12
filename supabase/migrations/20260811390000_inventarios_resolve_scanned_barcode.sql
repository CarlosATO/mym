-- =========================================================================================
-- MIGRATION: M1.5E.21 - Resolucion inmediata de barcode PENDING_REVIEW al escanear
-- =========================================================================================
-- Nueva RPC de SOLO LECTURA para que Mobile resuelva un escaneo sin pasar por busqueda
-- manual cuando el barcode no tiene asociacion oficial pero ya tiene una propuesta
-- PENDING_REVIEW coherente.
-- Orden conceptual:
--   1) Asociacion oficial -> delega en lookup_my_counting_product (semantica certificada,
--      prioridad absoluta sobre propuestas; se devuelve su resultado tal cual).
--   2) Sin asociacion + propuesta pendiente unica y coherente (un solo bsale_variant_id):
--      PENDING_REVIEW con proposal + replacement_for_current_location (in_snapshot segun
--      snapshot de la zona/ubicacion actual).
--   3) Producto propuesto fuera del snapshot -> PENDING_REVIEW con blocked=true,
--      in_snapshot=false, snapshot_product_id=null.
--   4) Propuestas para mas de un bsale_variant_id -> INCONSISTENT_PENDING (no se elige).
--   5) Sin asociacion ni propuesta -> UNKNOWN.
-- Reglas: la coherencia se determina por bsale_variant_id (identidad maestra, igual que
-- get_my_manual_barcode_resolution). Propuestas repetidas del mismo bsale_variant_id no son
-- conflicto; se selecciona una referencia determinista (proposed_at ASC, id ASC) para
-- proposal.id. No se crea alias, no se modifica producto/propuesta, no se aprueba, no se
-- crea conteo ni fotografia, no se actualizan timestamps. Estrictamente lectura.
-- Solo esquema inventarios. Solo grants a authenticated (patron de RPCs moviles).

CREATE OR REPLACE FUNCTION inventarios.resolve_my_scanned_barcode(p_zone_id uuid, p_location_id uuid, p_barcode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
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
    v_clean_barcode text;
    v_lookup jsonb;
    v_lookup_status text;
    v_pending_count bigint;
    v_distinct_products bigint;
    v_ref_proposal_id uuid;
    v_ref_bsale_variant_id integer;
    v_ref_sku text;
    v_ref_name text;
    v_ref_product_id uuid;
    v_repl_snapshot_product_id uuid;
    v_conflict_variants jsonb;
BEGIN
    v_clean_barcode := pg_catalog.btrim(p_barcode);
    IF p_zone_id IS NULL OR p_location_id IS NULL OR v_clean_barcode IS NULL OR v_clean_barcode = '' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
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
    WHERE tl.company_id = v_company_id
      AND tl.task_id = v_task_id
      AND tl.session_zone_id = p_zone_id
      AND szl.session_zone_id = p_zone_id
      AND szl.location_id = p_location_id
      AND tl.opened_by = v_actor_id
      AND tl.status = 'OPEN';
    IF v_is_open IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La ubicación no está abierta para esta tarea.', 'retryable', false)::text;
    END IF;

    -- 1) Asociacion oficial: prioridad absoluta; se usa la semantica certificada del lookup.
    v_lookup := inventarios.lookup_my_counting_product(p_zone_id, p_location_id, v_clean_barcode);
    v_lookup_status := v_lookup ->> 'status';
    IF v_lookup_status IS NOT NULL AND v_lookup_status <> 'NOT_FOUND' THEN
        RETURN v_lookup;
    END IF;

    -- 2..5) Sin asociacion oficial: analizar propuestas PENDING_REVIEW del barcode
    SELECT
        pg_catalog.count(*),
        pg_catalog.count(DISTINCT ce.bsale_variant_id)
    INTO v_pending_count, v_distinct_products
    FROM inventarios.product_barcode_proposals pbp
    JOIN inventarios.count_entries ce ON ce.id = pbp.count_entry_id
    WHERE pbp.company_id = v_company_id
      AND pbp.status = 'PENDING_REVIEW'
      AND pbp.scanned_code = v_clean_barcode;

    IF v_pending_count = 0 THEN
        RETURN pg_catalog.jsonb_build_object('status', 'UNKNOWN', 'proposal', NULL::jsonb);
    END IF;

    -- 4) Contradiccion: propuestas para mas de un producto
    IF v_distinct_products > 1 THEN
        SELECT pg_catalog.coalesce(pg_catalog.jsonb_agg(DISTINCT ce.bsale_variant_id ORDER BY ce.bsale_variant_id), '[]'::jsonb)
        INTO v_conflict_variants
        FROM inventarios.product_barcode_proposals pbp
        JOIN inventarios.count_entries ce ON ce.id = pbp.count_entry_id
        WHERE pbp.company_id = v_company_id
          AND pbp.status = 'PENDING_REVIEW'
          AND pbp.scanned_code = v_clean_barcode;

        RETURN pg_catalog.jsonb_build_object(
            'status', 'INCONSISTENT_PENDING',
            'proposal', NULL::jsonb,
            'conflicting_bsale_variant_ids', v_conflict_variants
        );
    END IF;

    -- 3) Propuesta unica y coherente: referencia determinista (la mas antigua)
    SELECT pbp.id, ce.bsale_variant_id, sp.sku, sp.name
    INTO v_ref_proposal_id, v_ref_bsale_variant_id, v_ref_sku, v_ref_name
    FROM inventarios.product_barcode_proposals pbp
    JOIN inventarios.count_entries ce ON ce.id = pbp.count_entry_id
    JOIN inventarios.snapshot_products sp ON sp.id = ce.snapshot_product_id
    WHERE pbp.company_id = v_company_id
      AND pbp.status = 'PENDING_REVIEW'
      AND pbp.scanned_code = v_clean_barcode
    ORDER BY pbp.proposed_at ASC, pbp.id ASC
    LIMIT 1;

    IF v_ref_proposal_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('status', 'UNKNOWN', 'proposal', NULL::jsonb);
    END IF;

    -- Membresia del producto propuesto en el snapshot de la zona/ubicacion actual
    SELECT sp.id INTO v_repl_snapshot_product_id
    FROM inventarios.snapshot_products sp
    WHERE sp.company_id = v_company_id
      AND sp.snapshot_id = v_snapshot_id
      AND sp.bsale_variant_id = v_ref_bsale_variant_id
    ORDER BY sp.id ASC
    LIMIT 1;

    SELECT p.id INTO v_ref_product_id
    FROM adquisiciones.products p
    WHERE p.company_id = v_company_id AND p.bsale_variant_id = v_ref_bsale_variant_id
    ORDER BY p.updated_at DESC NULLS LAST, p.id ASC
    LIMIT 1;

    IF v_repl_snapshot_product_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object(
            'status', 'PENDING_REVIEW',
            'proposal', pg_catalog.jsonb_build_object(
                'id', v_ref_proposal_id,
                'product_id', v_ref_product_id,
                'bsale_variant_id', v_ref_bsale_variant_id,
                'sku', v_ref_sku,
                'name', v_ref_name
            ),
            'replacement_for_current_location', pg_catalog.jsonb_build_object(
                'in_snapshot', false,
                'snapshot_product_id', NULL::uuid
            ),
            'blocked', true
        );
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'status', 'PENDING_REVIEW',
        'proposal', pg_catalog.jsonb_build_object(
            'id', v_ref_proposal_id,
            'product_id', v_ref_product_id,
            'bsale_variant_id', v_ref_bsale_variant_id,
            'sku', v_ref_sku,
            'name', v_ref_name
        ),
        'replacement_for_current_location', pg_catalog.jsonb_build_object(
            'in_snapshot', true,
            'snapshot_product_id', v_repl_snapshot_product_id
        )
    );
END;
$function$;

ALTER FUNCTION inventarios.resolve_my_scanned_barcode(uuid, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.resolve_my_scanned_barcode(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.resolve_my_scanned_barcode(uuid, uuid, text) TO authenticated;
