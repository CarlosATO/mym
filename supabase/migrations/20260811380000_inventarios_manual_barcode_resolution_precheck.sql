-- =========================================================================================
-- MIGRATION: M1.5E.20 - Prevalidacion de barcode PENDING_REVIEW (solo lectura)
-- =========================================================================================
-- RPC de solo lectura para que Mobile resuelva, ANTES de tomar/subir fotografia, si un
-- barcode fisico no asociado tiene una propuesta PENDING_REVIEW que lo contradice.
-- Guardas identicas al conteo manual (COUNTER contextual, empresa, sesion COUNTING, tarea
-- propia IN_PROGRESS, active_user_id, asignacion vigente, ubicacion OPEN por actor,
-- snapshot_product del snapshot de la zona). No acepta actor/company/task/session desde
-- Mobile. No escribe count_entries, propuestas, eventos, evidence_files ni Storage.
-- Los objetos Storage huerfanos existentes no se tocan.

CREATE OR REPLACE FUNCTION inventarios.get_my_manual_barcode_resolution(p_zone_id uuid, p_location_id uuid, p_snapshot_product_id uuid, p_scanned_code text)
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
    v_clean_scanned_code text;
    v_cur_bsale_variant_id integer;
    v_pending_count bigint;
    v_same_count bigint;
    v_other_count bigint;
    v_distinct_products bigint;
    v_other_proposal_id uuid;
    v_other_count_entry_id uuid;
    v_other_bsale_variant_id integer;
    v_other_sku text;
    v_other_name text;
    v_other_product_id uuid;
    v_repl_snapshot_product_id uuid;
    v_repl_in_snapshot boolean := false;
    v_conflict_variants jsonb;
BEGIN
    v_clean_scanned_code := pg_catalog.btrim(p_scanned_code);
    IF p_zone_id IS NULL OR p_location_id IS NULL OR p_snapshot_product_id IS NULL OR v_clean_scanned_code IS NULL OR v_clean_scanned_code = '' THEN
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

    SELECT sp.bsale_variant_id INTO v_cur_bsale_variant_id
    FROM inventarios.snapshot_products sp
    WHERE sp.company_id = v_company_id AND sp.snapshot_id = v_snapshot_id AND sp.id = p_snapshot_product_id;
    IF v_cur_bsale_variant_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_PRODUCT',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El producto no pertenece al inventario activo.', 'retryable', false)::text;
    END IF;

    -- Asociacion oficial (misma regla que submit_mobile_manual_match_count)
    IF EXISTS (
        SELECT 1 FROM integraciones.bsale_variants bv
        WHERE bv.company_id = v_company_id AND bv.state = 0 AND bv.bar_code = v_clean_scanned_code
    ) OR EXISTS (
        SELECT 1 FROM inventarios.snapshot_products sp
        WHERE sp.company_id = v_company_id AND sp.snapshot_id = v_snapshot_id
          AND sp.barcode = v_clean_scanned_code
          AND sp.bsale_variant_id IS DISTINCT FROM v_cur_bsale_variant_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_BARCODE_ALREADY_ASSOCIATED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El código de barras ya está asociado a un producto de la maestra.', 'retryable', false)::text;
    END IF;

    -- Propuestas PENDING_REVIEW del barcode en la empresa (identidad por variante maestra)
    SELECT
        pg_catalog.count(*),
        pg_catalog.count(*) FILTER (WHERE ce.bsale_variant_id IS NOT DISTINCT FROM v_cur_bsale_variant_id),
        pg_catalog.count(*) FILTER (WHERE ce.bsale_variant_id IS DISTINCT FROM v_cur_bsale_variant_id),
        pg_catalog.count(DISTINCT ce.bsale_variant_id)
    INTO v_pending_count, v_same_count, v_other_count, v_distinct_products
    FROM inventarios.product_barcode_proposals pbp
    JOIN inventarios.count_entries ce ON ce.id = pbp.count_entry_id
    WHERE pbp.company_id = v_company_id
      AND pbp.status = 'PENDING_REVIEW'
      AND pbp.scanned_code = v_clean_scanned_code;

    IF v_pending_count = 0 THEN
        RETURN pg_catalog.jsonb_build_object(
            'status', 'AVAILABLE',
            'selected_product', pg_catalog.jsonb_build_object(
                'snapshot_product_id', p_snapshot_product_id,
                'bsale_variant_id', v_cur_bsale_variant_id
            ),
            'proposal', NULL::jsonb
        );
    END IF;

    -- Inconsistencia explicita: propuestas del barcode apuntando a multiples productos
    IF v_distinct_products > 1 THEN
        SELECT pg_catalog.coalesce(pg_catalog.jsonb_agg(DISTINCT ce.bsale_variant_id), '[]'::jsonb)
        INTO v_conflict_variants
        FROM inventarios.product_barcode_proposals pbp
        JOIN inventarios.count_entries ce ON ce.id = pbp.count_entry_id
        WHERE pbp.company_id = v_company_id
          AND pbp.status = 'PENDING_REVIEW'
          AND pbp.scanned_code = v_clean_scanned_code;

        RETURN pg_catalog.jsonb_build_object(
            'status', 'INCONSISTENT_PENDING',
            'proposal', NULL::jsonb,
            'conflicting_bsale_variant_ids', v_conflict_variants,
            'message', 'El código de barras tiene propuestas pendientes contradictorias; requiere revisión administrativa.'
        );
    END IF;

    -- Solo propuestas del mismo producto -> reutilizable
    IF v_other_count = 0 THEN
        SELECT pbp.id
        INTO v_other_proposal_id
        FROM inventarios.product_barcode_proposals pbp
        JOIN inventarios.count_entries ce ON ce.id = pbp.count_entry_id
        WHERE pbp.company_id = v_company_id
          AND pbp.status = 'PENDING_REVIEW'
          AND pbp.scanned_code = v_clean_scanned_code
          AND ce.bsale_variant_id IS NOT DISTINCT FROM v_cur_bsale_variant_id
        ORDER BY pbp.proposed_at ASC, pbp.id ASC
        LIMIT 1;

        RETURN pg_catalog.jsonb_build_object(
            'status', 'SAME_PRODUCT_PENDING',
            'selected_product', pg_catalog.jsonb_build_object(
                'snapshot_product_id', p_snapshot_product_id,
                'bsale_variant_id', v_cur_bsale_variant_id
            ),
            'proposal', pg_catalog.jsonb_build_object('id', v_other_proposal_id)
        );
    END IF;

    -- Propuesta pendiente para OTRO producto
    SELECT pbp.id, ce.id, ce.bsale_variant_id, sp.sku, sp.name
    INTO v_other_proposal_id, v_other_count_entry_id, v_other_bsale_variant_id, v_other_sku, v_other_name
    FROM inventarios.product_barcode_proposals pbp
    JOIN inventarios.count_entries ce ON ce.id = pbp.count_entry_id
    JOIN inventarios.snapshot_products sp ON sp.id = ce.snapshot_product_id
    WHERE pbp.company_id = v_company_id
      AND pbp.status = 'PENDING_REVIEW'
      AND pbp.scanned_code = v_clean_scanned_code
      AND ce.bsale_variant_id IS DISTINCT FROM v_cur_bsale_variant_id
    ORDER BY pbp.proposed_at ASC, pbp.id ASC
    LIMIT 1;

    IF v_other_proposal_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object(
            'status', 'INCONSISTENT_PENDING',
            'proposal', NULL::jsonb,
            'conflicting_bsale_variant_ids', '[]'::jsonb,
            'message', 'El código de barras tiene propuestas pendientes contradictorias; requiere revisión administrativa.'
        );
    END IF;

    -- Membresia del producto previamente propuesto en el snapshot de la ubicacion actual
    SELECT sp.id INTO v_repl_snapshot_product_id
    FROM inventarios.snapshot_products sp
    WHERE sp.company_id = v_company_id
      AND sp.snapshot_id = v_snapshot_id
      AND sp.bsale_variant_id = v_other_bsale_variant_id
    ORDER BY sp.id ASC
    LIMIT 1;
    v_repl_in_snapshot := v_repl_snapshot_product_id IS NOT NULL;

    SELECT p.id INTO v_other_product_id
    FROM adquisiciones.products p
    WHERE p.company_id = v_company_id AND p.bsale_variant_id = v_other_bsale_variant_id
    ORDER BY p.updated_at DESC NULLS LAST, p.id ASC
    LIMIT 1;

    RETURN pg_catalog.jsonb_build_object(
        'status', 'OTHER_PRODUCT_PENDING',
        'proposal', pg_catalog.jsonb_build_object(
            'id', v_other_proposal_id,
            'product_id', v_other_product_id,
            'bsale_variant_id', v_other_bsale_variant_id,
            'sku', v_other_sku,
            'name', v_other_name
        ),
        'replacement_for_current_location', pg_catalog.jsonb_build_object(
            'in_snapshot', v_repl_in_snapshot,
            'snapshot_product_id', v_repl_snapshot_product_id
        )
    );
END;
$function$;

ALTER FUNCTION inventarios.get_my_manual_barcode_resolution(uuid, uuid, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.get_my_manual_barcode_resolution(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.get_my_manual_barcode_resolution(uuid, uuid, uuid, text) TO authenticated;
