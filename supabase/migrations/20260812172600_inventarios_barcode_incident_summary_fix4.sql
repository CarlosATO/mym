-- Corrección forward del resumen de incidencias de códigos (V1, rev4):
--   * coalesce sin prefijo pg_catalog (keyword SQL).
--
-- Esquema afectado EXCLUSIVAMENTE: inventarios.

BEGIN;

CREATE OR REPLACE FUNCTION inventarios.list_inventory_barcode_incident_summary(
    p_company_id uuid,
    p_campaign_id uuid,
    p_page integer DEFAULT 1,
    p_page_size integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_page integer;
    v_page_size integer;
    v_offset integer;
    v_total bigint;
    v_items jsonb;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');
    v_page := coalesce(p_page, 1);
    v_page_size := coalesce(p_page_size, 50);
    IF v_page < 1 THEN v_page := 1; END IF;
    IF v_page_size < 1 THEN v_page_size := 50; END IF;
    IF v_page_size > 100 THEN v_page_size := 100; END IF;
    v_offset := (v_page - 1) * v_page_size;

    WITH agg AS (
        SELECT ce.bsale_variant_id,
               pg_catalog.count(*) AS occurrence_count,
               pg_catalog.count(DISTINCT pbp.scanned_code) AS pending_barcode_count,
               pg_catalog.count(DISTINCT ce.snapshot_location_id) AS location_count,
               pg_catalog.max(ce.captured_at) AS latest_detected_at
        FROM inventarios.product_barcode_proposals pbp
        JOIN inventarios.count_entries ce ON ce.company_id = pbp.company_id AND ce.id = pbp.count_entry_id
        JOIN inventarios.sessions s ON s.company_id = pbp.company_id AND s.id = pbp.session_id
        WHERE pbp.company_id = p_company_id
          AND pbp.status = 'PENDING_REVIEW'
          AND s.campaign_id = p_campaign_id
        GROUP BY ce.bsale_variant_id
    )
    SELECT pg_catalog.count(*) INTO v_total FROM agg;

    WITH agg AS (
        SELECT ce.bsale_variant_id,
               pg_catalog.count(*) AS occurrence_count,
               pg_catalog.count(DISTINCT pbp.scanned_code) AS pending_barcode_count,
               pg_catalog.count(DISTINCT ce.snapshot_location_id) AS location_count,
               pg_catalog.max(ce.captured_at) AS latest_detected_at
        FROM inventarios.product_barcode_proposals pbp
        JOIN inventarios.count_entries ce ON ce.company_id = pbp.company_id AND ce.id = pbp.count_entry_id
        JOIN inventarios.sessions s ON s.company_id = pbp.company_id AND s.id = pbp.session_id
        WHERE pbp.company_id = p_company_id
          AND pbp.status = 'PENDING_REVIEW'
          AND s.campaign_id = p_campaign_id
        GROUP BY ce.bsale_variant_id
    )
    SELECT coalesce(pg_catalog.jsonb_agg(sub.row_data ORDER BY sub.row_data ->> 'sku', sub.row_data ->> 'bsale_variant_id'), '[]'::jsonb)
    INTO v_items
    FROM (
        SELECT pg_catalog.jsonb_build_object(
            'bsale_variant_id', a.bsale_variant_id,
            'product_id', csp.product_id,
            'sku', csp.sku,
            'product_name', coalesce(NULLIF(inventarios.campaign_product_display_name(a.bsale_variant_id), ''), csp.name),
            'pending_barcode_count', a.pending_barcode_count,
            'occurrence_count', a.occurrence_count,
            'location_count', a.location_count,
            'latest_detected_at', a.latest_detected_at,
            'status', 'Pendiente'
        ) AS row_data
        FROM agg a
        LEFT JOIN inventarios.inventory_campaign_snapshot_products csp
          ON csp.company_id = p_company_id
         AND csp.bsale_variant_id = a.bsale_variant_id
         AND csp.campaign_snapshot_id = (
             SELECT cs.id FROM inventarios.inventory_campaign_snapshots cs
             WHERE cs.company_id = p_company_id AND cs.campaign_id = p_campaign_id
             ORDER BY cs.created_at DESC LIMIT 1
         )
        ORDER BY csp.sku NULLS LAST, a.bsale_variant_id
    ) sub
    LIMIT v_page_size OFFSET v_offset;

    RETURN pg_catalog.jsonb_build_object(
        'campaign_id', p_campaign_id,
        'total', v_total,
        'page', v_page,
        'page_size', v_page_size,
        'items', CASE WHEN v_items IS NULL THEN '[]'::jsonb ELSE v_items END
    );
END;
$function$;

GRANT EXECUTE ON FUNCTION inventarios.list_inventory_barcode_incident_summary(uuid, uuid, integer, integer) TO authenticated, service_role;

COMMIT;
