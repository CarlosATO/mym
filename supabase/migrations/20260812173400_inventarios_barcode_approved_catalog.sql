-- Corrección forward (V6) — Catálogo de códigos aprobados del campaign.
--
-- Contrato read-only para el Informe y el Excel:
--   list_inventory_campaign_approved_barcodes(p_company_id, p_campaign_id)
--
-- Devuelve, por cada proposal APPROVED perteneciente al campaign (trazabilidad
-- directa vía sessions), una fila con:
--   bsale_variant_id, sku, product_name (identidad canónica),
--   original_barcode + original_barcode_source (código anterior congelado),
--   approved_barcode (scanned_code), occurrence_count, location_count,
--   first_detected_at, latest_detected_at, reviewed_by, reviewed_at.
--
-- Solo status='APPROVED': excluye PENDING_REVIEW, REJECTED, CANCELLED.
-- No mezcla aliases históricos de otros campaigns: filtra por campaign.
-- No modifica count_entries ni physical_quantity.
--
-- Esquema afectado EXCLUSIVAMENTE: inventarios.

BEGIN;

CREATE OR REPLACE FUNCTION inventarios.list_inventory_campaign_approved_barcodes(
    p_company_id uuid,
    p_campaign_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_items jsonb;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');

    WITH agg AS (
        SELECT ce.bsale_variant_id,
               pbp.scanned_code,
               pg_catalog.count(*) AS occurrence_count,
               pg_catalog.count(DISTINCT ce.snapshot_location_id) AS location_count,
               pg_catalog.min(ce.captured_at) AS first_detected_at,
               pg_catalog.max(ce.captured_at) AS latest_detected_at,
               pg_catalog.max(pbp.reviewed_at) AS reviewed_at,
               (pg_catalog.array_agg(pbp.reviewed_by ORDER BY pbp.reviewed_at DESC NULLS LAST))[1] AS reviewed_by
        FROM inventarios.product_barcode_proposals pbp
        JOIN inventarios.count_entries ce ON ce.company_id = pbp.company_id AND ce.id = pbp.count_entry_id
        JOIN inventarios.sessions s ON s.company_id = pbp.company_id AND s.id = pbp.session_id
        WHERE pbp.company_id = p_company_id
          AND pbp.status = 'APPROVED'
          AND s.campaign_id = p_campaign_id
        GROUP BY ce.bsale_variant_id, pbp.scanned_code
    )
    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'bsale_variant_id', a.bsale_variant_id,
                'sku', ident ->> 'sku',
                'product_name', ident ->> 'product_name',
                'original_barcode', orig ->> 'barcode',
                'original_barcode_source', orig ->> 'source',
                'approved_barcode', a.scanned_code,
                'occurrence_count', a.occurrence_count,
                'location_count', a.location_count,
                'first_detected_at', a.first_detected_at,
                'latest_detected_at', a.latest_detected_at,
                'reviewed_by', a.reviewed_by,
                'reviewed_at', a.reviewed_at,
                'status', 'Autorizado'
            ) ORDER BY ident ->> 'sku', a.scanned_code
        )
    END
    INTO v_items
    FROM agg a
    CROSS JOIN LATERAL (
        SELECT inventarios.barcode_product_identity(p_company_id, a.bsale_variant_id) AS ident
    ) idn
    CROSS JOIN LATERAL (
        SELECT inventarios.inventory_campaign_product_original_barcode(p_company_id, p_campaign_id, a.bsale_variant_id) AS orig
    ) og;

    RETURN pg_catalog.jsonb_build_object(
        'campaign_id', p_campaign_id,
        'items', CASE WHEN v_items IS NULL THEN '[]'::jsonb ELSE v_items END
    );
END;
$function$;

GRANT EXECUTE ON FUNCTION inventarios.list_inventory_campaign_approved_barcodes(uuid, uuid) TO authenticated, service_role;

COMMIT;
