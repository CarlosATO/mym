-- =========================================================================================
-- MIGRATION M2-FIX: 20260811390030_inventarios_mobile_count_review_coalesce_fix.sql
-- =========================================================================================
-- Correccion: list_my_location_counts uso pg_catalog.coalesce(jsonb_agg(...), '[]'::jsonb)
-- que falla en runtime (42883 function pg_catalog.coalesce does not exist). Unico cambio:
-- pg_catalog.coalesce -> coalesce. No altera contrato, guardas ni grants.

CREATE OR REPLACE FUNCTION inventarios.list_my_location_counts(p_zone_id uuid, p_location_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_company_id uuid;
    v_session_id uuid;
    v_task_id uuid;
    v_is_authorized boolean := false;
    v_szl_id uuid;
    v_snapshot_location_id uuid;
    v_loc_status text := 'PENDING';
    v_records jsonb;
    v_zone_id uuid;
BEGIN
    IF p_zone_id IS NULL OR p_location_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;

    v_actor_id := inventarios.require_actor();

    SELECT z.company_id, t.id, z.session_id, z.id, true
    INTO v_company_id, v_task_id, v_session_id, v_zone_id, v_is_authorized
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

    SELECT szl.id, szl.snapshot_location_id
    INTO v_szl_id, v_snapshot_location_id
    FROM inventarios.session_zone_locations szl
    WHERE szl.company_id = v_company_id
      AND szl.session_id = v_session_id
      AND szl.session_zone_id = p_zone_id
      AND szl.location_id = p_location_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta ubicación.', 'retryable', false)::text;
    END IF;

    SELECT CASE WHEN tl.status = 'OPEN' THEN 'OPEN' ELSE 'CLOSED' END
    INTO v_loc_status
    FROM inventarios.task_locations tl
    WHERE tl.company_id = v_company_id
      AND tl.task_id = v_task_id
      AND tl.session_zone_id = p_zone_id
      AND tl.session_zone_location_id = v_szl_id
      AND tl.opened_by = v_actor_id
    ORDER BY tl.opened_at DESC, tl.id DESC
    LIMIT 1;

    WITH my_roots AS (
        SELECT DISTINCT ce.id AS root_count_entry_id
        FROM inventarios.count_entries ce
        WHERE ce.company_id = v_company_id
          AND ce.session_id = v_session_id
          AND ce.task_id = v_task_id
          AND ce.session_zone_id = p_zone_id
          AND ce.snapshot_location_id = v_snapshot_location_id
          AND ce.counted_by = v_actor_id
          AND NOT EXISTS (
              SELECT 1 FROM inventarios.count_entry_corrections cec
              WHERE cec.company_id = v_company_id AND cec.replacement_count_entry_id = ce.id
          )
    ),
    resolved AS (
        SELECT r.root_count_entry_id,
               COALESCE(
                   (SELECT cec.replacement_count_entry_id
                    FROM inventarios.count_entry_corrections cec
                    WHERE cec.company_id = v_company_id AND cec.root_count_entry_id = r.root_count_entry_id
                      AND cec.superseded_at IS NULL),
                   r.root_count_entry_id
               ) AS current_count_entry_id
        FROM my_roots r
    ),
    final_rows AS (
        SELECT res.root_count_entry_id, res.current_count_entry_id,
               ce.snapshot_product_id, ce.bsale_variant_id, ce.physical_quantity,
               ce.identification_method, ce.scanned_code, ce.captured_at,
               COALESCE((SELECT cec.revision_number FROM inventarios.count_entry_corrections cec
                         WHERE cec.company_id = v_company_id AND cec.root_count_entry_id = res.root_count_entry_id
                           AND cec.superseded_at IS NULL), 0) AS revision_number,
               sp.sku, sp.name
        FROM resolved res
        JOIN inventarios.count_entries ce ON ce.id = res.current_count_entry_id
        LEFT JOIN inventarios.snapshot_products sp ON sp.id = ce.snapshot_product_id
        WHERE ce.invalidated_at IS NULL
          AND ce.invalidated_by IS NULL
          AND ce.invalidation_reason IS NULL
    )
    SELECT coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'root_count_entry_id', root_count_entry_id,
            'current_count_entry_id', current_count_entry_id,
            'snapshot_product_id', snapshot_product_id,
            'bsale_variant_id', bsale_variant_id,
            'sku', sku,
            'name', name,
            'physical_quantity', physical_quantity,
            'identification_method', identification_method,
            'scanned_code', scanned_code,
            'captured_at', captured_at,
            'revision_number', revision_number
        ) ORDER BY captured_at ASC, root_count_entry_id ASC
    ), '[]'::jsonb)
    INTO v_records
    FROM final_rows;

    RETURN pg_catalog.jsonb_build_object(
        'zone_id', p_zone_id,
        'location_id', p_location_id,
        'location_status', v_loc_status,
        'records', v_records
    );
END;
$function$;

ALTER FUNCTION inventarios.list_my_location_counts(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.list_my_location_counts(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.list_my_location_counts(uuid, uuid) TO authenticated;
