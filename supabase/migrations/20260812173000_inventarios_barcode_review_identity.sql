-- Revisión de incidencias de códigos (V2) — identidad canónica + autorización de review.
--
-- Problemas corregidos:
--   1. list_inventory_barcode_incident_summary / get_inventory_barcode_incident_detail
--      resolvían identidad SOLO desde el snapshot de campaña, dejando sin SKU a
--      productos agregados manualmente desde la maestra (no presentes en el
--      snapshot). Ahora se resuelve identidad canónica con precedencia:
--      adquisiciones.products → integraciones.bsale_variants → snapshot campaña →
--      snapshot sesión. Solo lectura de integraciones/adquisiciones.
--   2. Exponen bsale_barcode (bar_code de integraciones.bsale_variants, READ ONLY)
--      para mostrar el "Código registrado en Bsale" original.
--   3. Exponen can_review_barcodes_authorized: autorización propia de revisión
--      (SUPER_USUARIO OR ADMINISTRATOR activo), semánticamente desacoplada de
--      can_close_authorized (aunque hoy compartan la misma regla de rol).
--
-- Esquema afectado EXCLUSIVAMENTE: inventarios (DDL). integraciones/adquisiciones RO.

BEGIN;

-- Helper: identidad canónica de un producto por bsale_variant_id.
-- Preferencia: adquisiciones.products (maestra) → integraciones.bsale_variants →
-- snapshot de campaña → snapshot de sesión. Todo solo lectura.
CREATE OR REPLACE FUNCTION inventarios.barcode_product_identity(
    p_company_id uuid,
    p_bsale_variant_id integer
)
RETURNS jsonb
LANGUAGE sql
STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
    SELECT pg_catalog.jsonb_build_object(
        'product_id', coalesce(ap.id, csp.product_id, sp.product_id),
        'sku', coalesce(
            NULLIF(pg_catalog.btrim(ap.sku), ''),
            NULLIF(pg_catalog.btrim(bv.code), ''),
            NULLIF(pg_catalog.btrim(csp.sku), ''),
            NULLIF(pg_catalog.btrim(sp.sku), '')
        ),
        'product_name', coalesce(
            NULLIF(inventarios.campaign_product_display_name(p_bsale_variant_id), ''),
            NULLIF(pg_catalog.btrim(ap.description), ''),
            NULLIF(pg_catalog.btrim(csp.name), ''),
            NULLIF(pg_catalog.btrim(sp.name), ''),
            NULLIF(pg_catalog.btrim(bp.name), '')
        ),
        'bsale_barcode', coalesce(
            NULLIF(pg_catalog.btrim(bv.bar_code), ''),
            NULLIF(pg_catalog.btrim(ap.barcode), '')
        )
    )
    FROM (SELECT 1 AS x) dummy
    LEFT JOIN adquisiciones.products ap
      ON ap.company_id = p_company_id AND ap.bsale_variant_id = p_bsale_variant_id
    LEFT JOIN integraciones.bsale_variants bv
      ON bv.company_id = p_company_id AND bv.bsale_id = p_bsale_variant_id
    LEFT JOIN integraciones.bsale_products bp
      ON bp.company_id = bv.company_id AND bp.bsale_id = bv.bsale_product_id
    LEFT JOIN LATERAL (
        SELECT csp.product_id, csp.sku, csp.name
        FROM inventarios.inventory_campaign_snapshot_products csp
        WHERE csp.company_id = p_company_id AND csp.bsale_variant_id = p_bsale_variant_id
        ORDER BY csp.created_at DESC
        LIMIT 1
    ) csp ON true
    LEFT JOIN LATERAL (
        SELECT sp.product_id, sp.sku, sp.name
        FROM inventarios.snapshot_products sp
        WHERE sp.bsale_variant_id = p_bsale_variant_id
        ORDER BY sp.sku NULLS LAST
        LIMIT 1
    ) sp ON true
    LIMIT 1;
$function$;

-- Helper: ¿el actor actual puede revisar/decidir incidencias de códigos?
-- Regla actual: SUPER_USUARIO OR ADMINISTRATOR activo del campaign.
-- Independiente del status de la campaña (se permite post-cierre).
CREATE OR REPLACE FUNCTION inventarios._can_review_barcodes(
    p_company_id uuid,
    p_campaign_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_role_name text;
    v_is_super boolean := false;
    v_is_campaign_admin boolean := false;
BEGIN
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');
    SELECT r.name INTO v_role_name
    FROM portal.users u JOIN portal.roles r ON r.id = u.role_id
    WHERE u.id = v_actor_id AND u.is_active = true;
    v_is_super := coalesce(v_role_name = 'SUPER_USUARIO', false);

    SELECT EXISTS (
        SELECT 1 FROM inventarios.inventory_campaign_participants icp
        WHERE icp.company_id = p_company_id
          AND icp.campaign_id = p_campaign_id
          AND icp.user_id = v_actor_id
          AND icp.participant_role = 'ADMINISTRATOR'
          AND icp.active_from <= pg_catalog.now() AND icp.revoked_at IS NULL
    ) INTO v_is_campaign_admin;

    RETURN (v_is_super OR v_is_campaign_admin);
END;
$function$;

-- ============================================================
-- Resumen por producto (identidad canónica + bsale_barcode + review auth)
-- ============================================================
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
        ORDER BY row_data ->> 'sku' NULLS LAST, a.bsale_variant_id
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

-- ============================================================
-- Detalle de producto: identidad canónica + bsale_barcode + review auth
-- ============================================================
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
    v_ident jsonb;
    v_product jsonb;
    v_barcodes jsonb;
    v_occurrences jsonb;
    v_can_review boolean;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_bsale_variant_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');
    v_can_review := inventarios._can_review_barcodes(p_company_id, p_campaign_id);

    v_ident := inventarios.barcode_product_identity(p_company_id, p_bsale_variant_id);
    v_product := pg_catalog.jsonb_build_object(
        'bsale_variant_id', p_bsale_variant_id,
        'product_id', v_ident ->> 'product_id',
        'sku', v_ident ->> 'sku',
        'product_name', v_ident ->> 'product_name',
        'bsale_barcode', v_ident ->> 'bsale_barcode'
    );

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
                'evidence_id', (
                    SELECT ef.id FROM inventarios.evidence_files ef
                    WHERE ef.company_id = pbp.company_id
                      AND (ef.proposal_id = pbp.id
                           OR (ef.proposal_id IS NULL AND ef.count_entry_id = pbp.count_entry_id))
                    ORDER BY ef.captured_at NULLS LAST
                    LIMIT 1
                ),
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
        'can_review_barcodes_authorized', v_can_review,
        'product', v_product,
        'barcodes', CASE WHEN v_barcodes IS NULL THEN '[]'::jsonb ELSE v_barcodes END,
        'occurrences', CASE WHEN v_occurrences IS NULL THEN '[]'::jsonb ELSE v_occurrences END
    );
END;
$function$;

GRANT EXECUTE ON FUNCTION inventarios.get_inventory_barcode_incident_detail(uuid, uuid, integer) TO authenticated, service_role;

COMMIT;
