-- Corrección forward del detalle de incidencias de códigos (V1): el header del
-- producto se resuelve con campaign_product_display_name y fallback al snapshot
-- de sesión (productos no presentes en el snapshot de campaña, p.ej. sobrantes).
--
-- Esquema afectado EXCLUSIVAMENTE: inventarios.

BEGIN;

CREATE OR REPLACE FUNCTION inventarios.get_inventory_barcode_incident_detail(
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
    v_product jsonb;
    v_barcodes jsonb;
    v_occurrences jsonb;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_bsale_variant_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');

    SELECT pg_catalog.jsonb_build_object(
        'bsale_variant_id', p_bsale_variant_id,
        'product_id', coalesce(csp.product_id, sessp.product_id),
        'sku', coalesce(csp.sku, sessp.sku),
        'product_name', coalesce(NULLIF(inventarios.campaign_product_display_name(p_bsale_variant_id), ''),
            coalesce(NULLIF(pg_catalog.btrim(csp.name), ''), sessp.name))
    )
    INTO v_product
    FROM (
        SELECT 1 AS x
    ) dummy
    LEFT JOIN inventarios.inventory_campaign_snapshot_products csp
      ON csp.company_id = p_company_id
     AND csp.bsale_variant_id = p_bsale_variant_id
     AND csp.campaign_snapshot_id = (
         SELECT cs.id FROM inventarios.inventory_campaign_snapshots cs
         WHERE cs.company_id = p_company_id AND cs.campaign_id = p_campaign_id
         ORDER BY cs.created_at DESC LIMIT 1
     )
    LEFT JOIN LATERAL (
        SELECT sp.product_id, sp.sku, sp.name
        FROM inventarios.snapshot_products sp
        WHERE sp.bsale_variant_id = p_bsale_variant_id
        ORDER BY sp.sku NULLS LAST
        LIMIT 1
    ) sessp ON true;

    -- Barcodes pendientes del producto (agrupado por scanned_code)
    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'scanned_code', b.scanned_code,
                'location_count', b.location_count,
                'occurrence_count', b.occurrence_count,
                'first_detected_at', b.first_detected_at,
                'latest_detected_at', b.latest_detected_at,
                'status', 'Pendiente'
            ) ORDER BY b.scanned_code
        )
    END
    INTO v_barcodes
    FROM (
        SELECT pbp.scanned_code,
               pg_catalog.count(*) AS occurrence_count,
               pg_catalog.count(DISTINCT ce.snapshot_location_id) AS location_count,
               pg_catalog.min(ce.captured_at) AS first_detected_at,
               pg_catalog.max(ce.captured_at) AS latest_detected_at
        FROM inventarios.product_barcode_proposals pbp
        JOIN inventarios.count_entries ce ON ce.company_id = pbp.company_id AND ce.id = pbp.count_entry_id
        JOIN inventarios.sessions s ON s.company_id = pbp.company_id AND s.id = pbp.session_id
        WHERE pbp.company_id = p_company_id
          AND pbp.status = 'PENDING_REVIEW'
          AND s.campaign_id = p_campaign_id
          AND ce.bsale_variant_id = p_bsale_variant_id
        GROUP BY pbp.scanned_code
    ) b;

    -- Occurrences (todas las proposals PENDING del producto)
    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'proposal_id', pbp.id,
                'session_id', s.id,
                'bodega', coalesce(is2.name, s.name),
                'zone_code', sz.zone_code,
                'location_code', coalesce(NULLIF(pg_catalog.btrim(sl.code), ''), '—'),
                'counted_by', ce.counted_by,
                'counted_by_name', inventarios.user_display_name(ce.counted_by),
                'captured_at', ce.captured_at,
                'physical_quantity', ce.physical_quantity,
                'identification_method', ce.identification_method,
                'scanned_code', pbp.scanned_code,
                'evidence_available', (
                    EXISTS (SELECT 1 FROM inventarios.evidence_files ef
                            WHERE ef.company_id = pbp.company_id
                              AND (ef.proposal_id = pbp.id
                                   OR (ef.proposal_id IS NULL AND ef.count_entry_id = pbp.count_entry_id)))
                )
            ) ORDER BY pbp.scanned_code, ce.captured_at
        )
    END
    INTO v_occurrences
    FROM inventarios.product_barcode_proposals pbp
    JOIN inventarios.count_entries ce ON ce.company_id = pbp.company_id AND ce.id = pbp.count_entry_id
    JOIN inventarios.sessions s ON s.company_id = pbp.company_id AND s.id = pbp.session_id
    LEFT JOIN inventarios.inventory_sites is2 ON is2.company_id = s.company_id AND is2.id = s.inventory_site_id
    LEFT JOIN inventarios.session_zones sz ON sz.company_id = ce.company_id AND sz.session_id = ce.session_id AND sz.id = ce.session_zone_id
    LEFT JOIN inventarios.snapshot_locations sl ON sl.company_id = ce.company_id AND sl.snapshot_id = ce.snapshot_id AND sl.id = ce.snapshot_location_id
    WHERE pbp.company_id = p_company_id
      AND pbp.status = 'PENDING_REVIEW'
      AND s.campaign_id = p_campaign_id
      AND ce.bsale_variant_id = p_bsale_variant_id;

    RETURN pg_catalog.jsonb_build_object(
        'campaign_id', p_campaign_id,
        'product', v_product,
        'barcodes', CASE WHEN v_barcodes IS NULL THEN '[]'::jsonb ELSE v_barcodes END,
        'occurrences', CASE WHEN v_occurrences IS NULL THEN '[]'::jsonb ELSE v_occurrences END
    );
END;
$function$;

GRANT EXECUTE ON FUNCTION inventarios.get_inventory_barcode_incident_detail(uuid, uuid, integer) TO authenticated, service_role;

COMMIT;
