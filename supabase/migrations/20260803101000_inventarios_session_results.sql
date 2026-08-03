-- Migration: 20260803101000_inventarios_session_results.sql
-- Description: Fase 4H.2G4. RPC de consulta de resultados oficiales de una jornada
--              APPROVED/EXPORTED/RECONCILED. Paginada y filtrada. No inventa
--              costos ni valorizaciones.
-- Author: Assistant

CREATE OR REPLACE FUNCTION inventarios.get_inventory_session_results(
    p_company_id uuid,
    p_session_id uuid,
    p_search text,
    p_difference_type text,
    p_page integer,
    p_page_size integer
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_search text;
    v_diff_type text;
    v_page integer; v_page_size integer; v_offset integer;
    v_session jsonb;
    v_version jsonb;
    v_total bigint;
    v_items jsonb;
    v_missing bigint;
    v_surplus bigint;
    v_no_diff bigint;
    v_product_count bigint;
    v_abs_diff numeric;
    v_office_id integer;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');
    v_search := pg_catalog.btrim(pg_catalog.coalesce(p_search, ''));
    v_diff_type := pg_catalog.upper(pg_catalog.btrim(pg_catalog.coalesce(p_difference_type, '')));
    v_page := pg_catalog.coalesce(p_page, 1);
    v_page_size := pg_catalog.coalesce(p_page_size, 50);
    IF v_page < 1 THEN v_page := 1; END IF;
    IF v_page_size < 1 THEN v_page_size := 50; END IF;
    IF v_page_size > 100 THEN v_page_size := 100; END IF;
    v_offset := (v_page - 1) * v_page_size;

    SELECT s.bsale_office_id INTO v_office_id
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.id = p_session_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;

    SELECT pg_catalog.jsonb_build_object(
        'id', s.id, 'session_number', s.session_number, 'name', s.name,
        'inventory_type', s.inventory_type, 'status', s.status,
        'scope_mode', s.scope_mode, 'warehouse_name', w.name,
        'responsible_user_id', s.responsible_user_id,
        'responsible_name', inventarios.user_display_name(s.responsible_user_id),
        'approved_at', s.approved_at, 'approved_by_name', inventarios.user_display_name(s.approved_by),
        'exported_at', s.exported_at, 'reconciled_at', s.reconciled_at,
        'cancelled_at', s.cancelled_at, 'cancelled_by_name', inventarios.user_display_name(s.cancelled_by),
        'cancellation_reason', s.cancellation_reason,
        'created_at', s.created_at
    )
    INTO v_session
    FROM inventarios.sessions s
    LEFT JOIN adquisiciones.warehouses w ON w.id = s.warehouse_id
    WHERE s.company_id = p_company_id AND s.id = p_session_id;

    SELECT pg_catalog.jsonb_build_object(
        'version_number', ov.version_number,
        'task_count', ov.task_count,
        'contribution_count', ov.contribution_count,
        'normal_contribution_count', ov.normal_contribution_count,
        'recount_contribution_count', ov.recount_contribution_count,
        'item_count', ov.item_count,
        'approved_at', ov.approved_at,
        'approved_by_name', inventarios.user_display_name(ov.approved_by)
    )
    INTO v_version
    FROM inventarios.official_versions ov
    WHERE ov.company_id = p_company_id AND ov.session_id = p_session_id
    ORDER BY (ov.superseded_at IS NULL) DESC, ov.version_number DESC
    LIMIT 1;

    -- Resumen de diferencias
    SELECT
        pg_catalog.count(*),
        pg_catalog.count(*) FILTER (WHERE (coalesce(ss.theoretical_quantity, 0) - ovi.physical_quantity) = 0),
        pg_catalog.count(*) FILTER (WHERE (coalesce(ss.theoretical_quantity, 0) - ovi.physical_quantity) > 0),
        pg_catalog.count(*) FILTER (WHERE (coalesce(ss.theoretical_quantity, 0) - ovi.physical_quantity) < 0),
        pg_catalog.sum(pg_catalog.abs(coalesce(ss.theoretical_quantity, 0) - ovi.physical_quantity))
    INTO v_product_count, v_no_diff, v_missing, v_surplus, v_abs_diff
    FROM inventarios.official_version_items ovi
    JOIN inventarios.snapshot_products sp ON sp.company_id = ovi.company_id
      AND sp.snapshot_id = ovi.snapshot_id AND sp.id = ovi.snapshot_product_id
    LEFT JOIN inventarios.snapshot_stocks ss ON ss.company_id = ovi.company_id
      AND ss.snapshot_id = ovi.snapshot_id AND ss.snapshot_product_id = ovi.snapshot_product_id
      AND ss.office_id = v_office_id
    WHERE ovi.company_id = p_company_id AND ovi.session_id = p_session_id
      AND ovi.official_version_id = (SELECT ov.id FROM inventarios.official_versions ov
          WHERE ov.company_id = p_company_id AND ov.session_id = p_session_id
          ORDER BY (ov.superseded_at IS NULL) DESC, ov.version_number DESC LIMIT 1);

    SELECT pg_catalog.count(*) INTO v_total
    FROM inventarios.official_version_items ovi
    JOIN inventarios.snapshot_products sp ON sp.company_id = ovi.company_id
      AND sp.snapshot_id = ovi.snapshot_id AND sp.id = ovi.snapshot_product_id
    LEFT JOIN inventarios.snapshot_stocks ss ON ss.company_id = ovi.company_id
      AND ss.snapshot_id = ovi.snapshot_id AND ss.snapshot_product_id = ovi.snapshot_product_id
      AND ss.office_id = v_office_id
    WHERE ovi.company_id = p_company_id AND ovi.session_id = p_session_id
      AND ovi.official_version_id = (SELECT ov.id FROM inventarios.official_versions ov
          WHERE ov.company_id = p_company_id AND ov.session_id = p_session_id
          ORDER BY (ov.superseded_at IS NULL) DESC, ov.version_number DESC LIMIT 1)
      AND (v_search = '' OR sp.sku ILIKE '%' || v_search || '%' OR sp.name ILIKE '%' || v_search || '%')
      AND (v_diff_type = '' OR
           (v_diff_type = 'FALTANTE' AND coalesce(ss.theoretical_quantity,0) - ovi.physical_quantity > 0)
           OR (v_diff_type = 'SOBRANTE' AND coalesce(ss.theoretical_quantity,0) - ovi.physical_quantity < 0)
           OR (v_diff_type = 'SIN_DIFERENCIA' AND coalesce(ss.theoretical_quantity,0) - ovi.physical_quantity = 0));

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'sku', x.sku,
                'product', x.name,
                'barcode', x.bar_code,
                'theoretical', coalesce(x.theoretical, 0),
                'physical', x.physical_quantity,
                'difference', coalesce(x.theoretical,0) - x.physical_quantity,
                'difference_type', CASE
                    WHEN coalesce(x.theoretical,0) - x.physical_quantity > 0 THEN 'FALTANTE'
                    WHEN coalesce(x.theoretical,0) - x.physical_quantity < 0 THEN 'SOBRANTE'
                    ELSE 'SIN_DIFERENCIA'
                END,
                'provenance', CASE WHEN x.recount_contribution_count > 0 THEN 'RECUENTO' ELSE 'NORMAL' END
            )
            ORDER BY x.sku
        )
    END
    INTO v_items
    FROM (
        SELECT ovi.snapshot_product_id, ovi.physical_quantity, ovi.recount_contribution_count,
               ovi.snapshot_id, sp2.sku, sp2.name, sp2.bar_code,
               (SELECT ss2.theoretical_quantity FROM inventarios.snapshot_stocks ss2
                WHERE ss2.company_id = ovi.company_id AND ss2.snapshot_id = ovi.snapshot_id
                  AND ss2.snapshot_product_id = ovi.snapshot_product_id AND ss2.office_id = v_office_id) AS theoretical
        FROM inventarios.official_version_items ovi
        JOIN inventarios.snapshot_products sp2
          ON sp2.company_id = ovi.company_id AND sp2.snapshot_id = ovi.snapshot_id
          AND sp2.id = ovi.snapshot_product_id
        WHERE ovi.company_id = p_company_id AND ovi.session_id = p_session_id
          AND ovi.official_version_id = (SELECT ov.id FROM inventarios.official_versions ov
              WHERE ov.company_id = p_company_id AND ov.session_id = p_session_id
              ORDER BY (ov.superseded_at IS NULL) DESC, ov.version_number DESC LIMIT 1)
    ) x
    WHERE (v_search = '' OR x.sku ILIKE '%' || v_search || '%' OR x.name ILIKE '%' || v_search || '%')
      AND (v_diff_type = '' OR
           (v_diff_type = 'FALTANTE' AND coalesce(x.theoretical,0) - x.physical_quantity > 0)
           OR (v_diff_type = 'SOBRANTE' AND coalesce(x.theoretical,0) - x.physical_quantity < 0)
           OR (v_diff_type = 'SIN_DIFERENCIA' AND coalesce(x.theoretical,0) - x.physical_quantity = 0))
    LIMIT v_page_size OFFSET v_offset;

    RETURN pg_catalog.jsonb_build_object(
        'session', v_session,
        'official_version', v_version,
        'summary', pg_catalog.jsonb_build_object(
            'product_count', v_product_count,
            'no_difference', v_no_diff,
            'missing', v_missing,
            'surplus', v_surplus,
            'absolute_difference_total', coalesce(v_abs_diff, 0)
        ),
        'total', v_total,
        'page', v_page,
        'page_size', v_page_size,
        'has_more', v_offset + pg_catalog.jsonb_array_length(CASE WHEN v_items IS NULL THEN '[]'::jsonb ELSE v_items END) < v_total,
        'items', CASE WHEN v_items IS NULL THEN '[]'::jsonb ELSE v_items END
    );
END;
$$;

ALTER FUNCTION inventarios.get_inventory_session_results(uuid, uuid, text, text, integer, integer) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.get_inventory_session_results(uuid, uuid, text, text, integer, integer)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.get_inventory_session_results(uuid, uuid, text, text, integer, integer) TO authenticated;
