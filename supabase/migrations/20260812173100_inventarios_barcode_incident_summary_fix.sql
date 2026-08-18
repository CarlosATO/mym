-- Corrección forward del resumen de incidencias de códigos (V3):
-- list_inventory_barcode_incident_summary fallaba con
--   ERROR: column "row_data" does not exist (SQLSTATE 42703)
-- al ordenar por el alias de columna de salida del subquery interno:
--   ORDER BY row_data ->> 'sku' NULLS LAST, a.bsale_variant_id
--
-- Un alias de columna de salida (SELECT ... AS row_data) no es una columna
-- de tabla: PostgreSQL no permite usarlo como expresión compleja en ORDER BY
-- dentro del mismo nivel. La versión previa (V1) ordenaba por una columna
-- real (csp.sku); V2 reemplazó la identidad por barcode_product_identity
-- (columna LATERAL "ident") pero mantuvo el ORDER BY apuntando al alias.
--
-- Fix mínimo: ordenar por la columna LATERAL real "ident" (ident ->> 'sku').
-- No cambia el contrato de salida (SKU, producto, occurrence_count,
-- location_count, latest_detected_at, pending_barcode_count, status,
-- can_review_barcodes_authorized) ni reintroduce SKU NULL.
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
    v_can_review boolean;
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

    v_can_review := inventarios._can_review_barcodes(p_company_id, p_campaign_id);

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
            'product_id', ident ->> 'product_id',
            'sku', ident ->> 'sku',
            'product_name', ident ->> 'product_name',
            'bsale_barcode', ident ->> 'bsale_barcode',
            'pending_barcode_count', a.pending_barcode_count,
            'occurrence_count', a.occurrence_count,
            'location_count', a.location_count,
            'latest_detected_at', a.latest_detected_at,
            'status', 'Pendiente'
        ) AS row_data
        FROM agg a
        CROSS JOIN LATERAL (
            SELECT inventarios.barcode_product_identity(p_company_id, a.bsale_variant_id) AS ident
        ) idn
        ORDER BY ident ->> 'sku' NULLS LAST, a.bsale_variant_id
    ) sub
    LIMIT v_page_size OFFSET v_offset;

    RETURN pg_catalog.jsonb_build_object(
        'campaign_id', p_campaign_id,
        'total', v_total,
        'page', v_page,
        'page_size', v_page_size,
        'can_review_barcodes_authorized', v_can_review,
        'items', CASE WHEN v_items IS NULL THEN '[]'::jsonb ELSE v_items END
    );
END;
$function$;

GRANT EXECUTE ON FUNCTION inventarios.list_inventory_barcode_incident_summary(uuid, uuid, integer, integer) TO authenticated, service_role;

COMMIT;
