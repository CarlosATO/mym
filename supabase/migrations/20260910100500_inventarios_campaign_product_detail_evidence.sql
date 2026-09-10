-- Muestra la evidencia de cada conteo efectivo en el detalle del producto,
-- incluidos los conteos por búsqueda manual que no generan incidencias.
BEGIN;

CREATE OR REPLACE FUNCTION inventarios.get_inventory_campaign_product_breakdown(
    p_company_id uuid,
    p_campaign_id uuid,
    p_bsale_variant_id integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_campaign_status text;
    v_header jsonb;
    v_contributions jsonb;
    v_is_final boolean;
    v_active_sessions bigint;
    v_sku text;
    v_name text;
    v_product_id uuid;
    v_theoretical_quantity numeric := 0;
    v_physical_quantity numeric := 0;
    v_unit_cost numeric;
    v_difference_quantity numeric := 0;
    v_in_theoretical_stock boolean := false;
    v_in_any_snapshot boolean := false;
    v_coverage_status text;
    v_variance_status text;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_bsale_variant_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');

    SELECT ic.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id;
    IF v_campaign_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario no existe.','retryable',false)::text;
    END IF;

    SELECT pg_catalog.count(*) INTO v_active_sessions
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id
      AND s.status IN ('DRAFT','PREPARED','COUNTING','UNDER_REVIEW');
    v_is_final := (v_active_sessions = 0);

    SELECT t.theoretical_quantity, t.unit_cost, t.sku,
           COALESCE(NULLIF(inventarios.campaign_product_display_name(t.bsale_variant_id), ''), t.sku),
           t.product_id
    INTO v_theoretical_quantity, v_unit_cost, v_sku, v_name, v_product_id
    FROM inventarios.get_campaign_theoretical_stock(p_company_id, p_campaign_id) t
    WHERE t.bsale_variant_id = p_bsale_variant_id;

    IF FOUND THEN
        v_in_theoretical_stock := true;
    ELSE
        v_theoretical_quantity := 0;
        v_unit_cost := NULL;
        SELECT sp2.sku,
               COALESCE(NULLIF(inventarios.campaign_product_display_name(sp2.bsale_variant_id), ''), sp2.name),
               sp2.product_id
        INTO v_sku, v_name, v_product_id
        FROM inventarios.snapshot_products sp2
        WHERE sp2.bsale_variant_id = p_bsale_variant_id
        ORDER BY sp2.sku NULLS LAST
        LIMIT 1;
    END IF;
    IF v_name IS NULL THEN v_name := 'PRODUCTO ' || p_bsale_variant_id::text; END IF;

    SELECT EXISTS (
        SELECT 1
        FROM inventarios.snapshot_products sp
        JOIN inventarios.operational_snapshots os ON os.id = sp.snapshot_id AND os.company_id = sp.company_id
        JOIN inventarios.sessions s ON s.company_id = os.company_id AND s.id = os.session_id
        WHERE s.campaign_id = p_campaign_id AND sp.bsale_variant_id = p_bsale_variant_id
    ) INTO v_in_any_snapshot;

    SELECT coalesce(sum(x.physical_quantity), 0) INTO v_physical_quantity
    FROM (
        SELECT ovi.physical_quantity
        FROM inventarios.official_version_items ovi
        JOIN inventarios.sessions s ON s.company_id = ovi.company_id AND s.id = ovi.session_id
        WHERE ovi.company_id = p_company_id AND s.campaign_id = p_campaign_id
          AND s.status = 'APPROVED' AND v_campaign_status = 'APPROVED'
          AND ovi.bsale_variant_id = p_bsale_variant_id
        UNION ALL
        SELECT ce.physical_quantity
        FROM (
            SELECT t.id AS task_id, t.session_id
            FROM inventarios.tasks t
            JOIN inventarios.sessions s ON s.company_id = t.company_id AND s.id = t.session_id
            WHERE s.campaign_id = p_campaign_id AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
        ) ct
        CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id, false) g
        JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
        WHERE ce.bsale_variant_id = p_bsale_variant_id AND coalesce(v_campaign_status, '') <> 'APPROVED'
    ) x;

    v_difference_quantity := v_physical_quantity - v_theoretical_quantity;
    v_coverage_status := CASE WHEN v_physical_quantity > 0 THEN 'COUNTED' WHEN v_in_any_snapshot THEN 'NOT_COUNTED' ELSE 'OUT_OF_SNAPSHOT' END;
    v_variance_status := CASE WHEN v_difference_quantity < 0 THEN 'FALTANTE' WHEN v_difference_quantity > 0 THEN 'SOBRANTE' ELSE 'SIN_DIFERENCIA' END;

    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb ELSE pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'count_entry_id', ce.id,
            'session_id', s.id,
            'session_name', s.name,
            'session_status', s.status,
            'zone_code', sz.zone_code,
            'zone_name', sz.display_name,
            'location_code', sl.code,
            'location_name', sl.name,
            'counted_by', ce.counted_by,
            'counted_by_name', inventarios.user_display_name(ce.counted_by),
            'physical_quantity', ce.physical_quantity,
            'identification_method', ce.identification_method,
            'scanned_code', ce.scanned_code,
            'captured_at', ce.captured_at,
            'contribution_source', g.contribution_source,
            'task_cycle', ce.task_cycle,
            'evidence_files', COALESCE(ev.files, '[]'::jsonb)
        ) ORDER BY ce.captured_at, s.name, sz.zone_code, sl.code
    ) END INTO v_contributions
    FROM (
        SELECT t.id AS task_id, t.session_id
        FROM inventarios.tasks t
        JOIN inventarios.sessions s ON s.company_id = t.company_id AND s.id = t.session_id
        WHERE s.campaign_id = p_campaign_id AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
    ) ct
    CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id, false) g
    JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
    JOIN inventarios.sessions s ON s.company_id = ce.company_id AND s.id = ce.session_id
    LEFT JOIN inventarios.session_zones sz ON sz.company_id = ce.company_id AND sz.session_id = ce.session_id AND sz.id = ce.session_zone_id
    LEFT JOIN inventarios.snapshot_locations sl ON sl.company_id = ce.company_id AND sl.snapshot_id = ce.snapshot_id AND sl.id = ce.snapshot_location_id
    LEFT JOIN LATERAL (
        SELECT pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'evidence_id', ef.id,
                'bucket', ef.storage_bucket,
                'path', ef.storage_path,
                'mime_type', ef.mime_type,
                'captured_at', ef.captured_at,
                'sync_status', ef.sync_status
            ) ORDER BY ef.captured_at, ef.id
        ) AS files
        FROM inventarios.evidence_files ef
        WHERE ef.company_id = ce.company_id
          AND (
              ef.count_entry_id = ce.id
              OR EXISTS (
                  SELECT 1
                  FROM inventarios.product_barcode_proposals pbp
                  WHERE pbp.company_id = ce.company_id
                    AND pbp.id = ef.proposal_id
                    AND pbp.count_entry_id = ce.id
              )
          )
          AND ef.invalidated_at IS NULL
    ) ev ON true
    WHERE ce.bsale_variant_id = p_bsale_variant_id;

    RETURN pg_catalog.jsonb_build_object(
        'campaign_id', p_campaign_id,
        'campaign_status', v_campaign_status,
        'is_final', v_is_final,
        'header', pg_catalog.jsonb_build_object(
            'bsale_variant_id', p_bsale_variant_id, 'sku', v_sku, 'name', v_name, 'product_id', v_product_id,
            'in_theoretical_stock', v_in_theoretical_stock, 'in_any_snapshot', v_in_any_snapshot,
            'theoretical_quantity', v_theoretical_quantity, 'physical_quantity', v_physical_quantity,
            'difference_quantity', v_difference_quantity, 'unit_cost', v_unit_cost,
            'difference_value', coalesce(v_difference_quantity, 0) * coalesce(v_unit_cost, 0),
            'variance_status', v_variance_status, 'coverage_status', v_coverage_status
        ),
        'contributions', CASE WHEN v_contributions IS NULL THEN '[]'::jsonb ELSE v_contributions END
    );
END;
$function$;

ALTER FUNCTION inventarios.get_inventory_campaign_product_breakdown(uuid, uuid, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.get_inventory_campaign_product_breakdown(uuid, uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.get_inventory_campaign_product_breakdown(uuid, uuid, integer) TO authenticated, service_role;

COMMIT;
