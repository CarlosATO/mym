-- Contrato read-only de detalle del readiness del Inventario (V1).
--
-- get_inventory_campaign_readiness_detail(p_company_id, p_campaign_id, p_detail_type)
--
-- Fuente única de verdad para los drill-down de "Elementos pendientes".
-- Devuelve exactamente las filas que explican cada contador del readiness, con
-- columnas específicas por tipo. La UI únicamente presenta.
--
-- Whitelist contractual de detail_type:
--   PENDING_SESSIONS           → sesiones DRAFT/PREPARED (secciones pendientes)
--   COUNTING_SESSIONS          → sesiones COUNTING/UNDER_REVIEW (en conteo/revisión)
--   OPEN_LOCATIONS             → task_locations OPEN
--   NEVER_VISITED_LOCATIONS    → session_zone_locations sin task_locations
--   IN_PROGRESS_ZONES          → zonas con tarea IN_PROGRESS/PAUSED
--   PENDING_BARCODES           → product_barcode_proposals PENDING_REVIEW
--   OUT_OF_SNAPSHOT_PRODUCTS   → teórico de campaña sin snapshot en ninguna sesión
--
-- Definiciones coherentes con get_inventory_campaign_close_readiness:
--   never_visited = session_zone_locations - (session_zone_locations con task_locations)
--   open = task_locations.status='OPEN'
--   pending_barcodes = proposals.status='PENDING_REVIEW'
--   out_of_snapshot = teórico TOTAL_CAMPAIGN sin snapshot_products en sesiones
--   in_progress_zones = zonas con task IN_PROGRESS/PAUSED no cancelada
--   pending_sessions = status IN ('DRAFT','PREPARED')
--   counting_sessions = status IN ('COUNTING','UNDER_REVIEW')
--
-- Esquema afectado EXCLUSIVAMENTE: inventarios (DDL). Catálogo read-only.

BEGIN;

CREATE OR REPLACE FUNCTION inventarios.get_inventory_campaign_readiness_detail(
    p_company_id uuid,
    p_campaign_id uuid,
    p_detail_type text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_detail_type text;
    v_campaign_status text;
    v_rows jsonb;
    v_count bigint := 0;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_detail_type IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');
    v_detail_type := pg_catalog.upper(pg_catalog.btrim(p_detail_type));
    IF v_detail_type NOT IN ('PENDING_SESSIONS','COUNTING_SESSIONS','OPEN_LOCATIONS','NEVER_VISITED_LOCATIONS','IN_PROGRESS_ZONES','PENDING_BARCODES','OUT_OF_SNAPSHOT_PRODUCTS') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','El tipo de detalle no es valido.','retryable',false)::text;
    END IF;

    SELECT ic.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id;
    IF v_campaign_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario no existe.','retryable',false)::text;
    END IF;

    IF v_detail_type = 'PENDING_SESSIONS' THEN
        SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
            ELSE pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'bodega', coalesce(is2.name, s.name),
                    'estado', CASE s.status WHEN 'DRAFT' THEN 'Pendiente' WHEN 'PREPARED' THEN 'Preparada' ELSE s.status END,
                    'situacion', 'Sección aún no iniciada'
                ) ORDER BY is2.name NULLS LAST, s.name
            )
        END
        INTO v_rows
        FROM inventarios.sessions s
        LEFT JOIN inventarios.inventory_sites is2 ON is2.company_id = s.company_id AND is2.id = s.inventory_site_id
        WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id
          AND s.status IN ('DRAFT','PREPARED');
        SELECT pg_catalog.count(*) INTO v_count
        FROM inventarios.sessions s
        WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id
          AND s.status IN ('DRAFT','PREPARED');
    END IF;

    IF v_detail_type = 'COUNTING_SESSIONS' THEN
        WITH sess AS (
            SELECT s.id, s.status, s.name,
                   coalesce(is2.name, s.name) AS bodega
            FROM inventarios.sessions s
            LEFT JOIN inventarios.inventory_sites is2 ON is2.company_id = s.company_id AND is2.id = s.inventory_site_id
            WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id
              AND s.status IN ('COUNTING','UNDER_REVIEW')
        ),
        zona_stats AS (
            SELECT sz.session_id,
                   pg_catalog.count(DISTINCT sz.id) AS zonas_total,
                   pg_catalog.count(DISTINCT sz.id) FILTER (WHERE t.status = 'COMPLETED') AS zonas_completadas,
                   pg_catalog.count(DISTINCT sz.id) FILTER (WHERE t.status IN ('IN_PROGRESS','PAUSED')) AS zonas_en_curso
            FROM inventarios.session_zones sz
            LEFT JOIN inventarios.tasks t ON t.company_id = sz.company_id AND t.session_id = sz.session_id
                AND t.session_zone_id = sz.id AND t.cancelled_at IS NULL
            WHERE sz.company_id = p_company_id AND sz.session_id IN (SELECT id FROM sess)
            GROUP BY sz.session_id
        ),
        loc_stats AS (
            SELECT szl.session_id,
                   pg_catalog.count(DISTINCT szl.id) AS locs_total,
                   pg_catalog.count(DISTINCT tl.id) AS locs_visitadas
            FROM inventarios.session_zone_locations szl
            LEFT JOIN inventarios.task_locations tl ON tl.company_id = szl.company_id
                AND tl.session_id = szl.session_id AND tl.session_zone_location_id = szl.id
            WHERE szl.company_id = p_company_id AND szl.session_id IN (SELECT id FROM sess)
            GROUP BY szl.session_id
        )
        SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
            ELSE pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'bodega', s.bodega,
                    'estado', CASE s.status WHEN 'COUNTING' THEN 'En conteo' WHEN 'UNDER_REVIEW' THEN 'En revisión' ELSE s.status END,
                    'zonas_total', coalesce(z.zonas_total, 0),
                    'zonas_completadas', coalesce(z.zonas_completadas, 0),
                    'zonas_en_curso', coalesce(z.zonas_en_curso, 0),
                    'ubicaciones_visitadas', coalesce(l.locs_visitadas, 0),
                    'ubicaciones_total', coalesce(l.locs_total, 0)
                ) ORDER BY s.bodega
            )
        END
        INTO v_rows
        FROM sess s
        LEFT JOIN zona_stats z ON z.session_id = s.id
        LEFT JOIN loc_stats l ON l.session_id = s.id;
        SELECT pg_catalog.count(*) INTO v_count
        FROM (
            SELECT s.id
            FROM inventarios.sessions s
            LEFT JOIN inventarios.inventory_sites is2 ON is2.company_id = s.company_id AND is2.id = s.inventory_site_id
            WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id
              AND s.status IN ('COUNTING','UNDER_REVIEW')
        ) sess;
    END IF;

    IF v_detail_type = 'OPEN_LOCATIONS' THEN
        SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
            ELSE pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'bodega', coalesce(is2.name, s.name),
                    'zona', sz.zone_code,
                    'ubicacion', coalesce(NULLIF(pg_catalog.btrim(sl.code), ''), '—'),
                    'responsable', inventarios.user_display_name(tl.opened_by),
                    'abierta_desde', tl.opened_at,
                    'situacion', 'Abierta'
                ) ORDER BY is2.name NULLS LAST, sz.zone_code, sl.code
            )
        END
        INTO v_rows
        FROM inventarios.task_locations tl
        JOIN inventarios.sessions s ON s.company_id = tl.company_id AND s.id = tl.session_id
        LEFT JOIN inventarios.inventory_sites is2 ON is2.company_id = s.company_id AND is2.id = s.inventory_site_id
        LEFT JOIN inventarios.session_zones sz ON sz.company_id = tl.company_id AND sz.session_id = tl.session_id AND sz.id = tl.session_zone_id
        LEFT JOIN inventarios.session_zone_locations szl ON szl.company_id = tl.company_id AND szl.session_id = tl.session_id AND szl.id = tl.session_zone_location_id
        LEFT JOIN inventarios.snapshot_locations sl ON sl.company_id = tl.company_id AND sl.snapshot_id = szl.snapshot_id AND sl.id = szl.snapshot_location_id
        WHERE tl.company_id = p_company_id AND s.campaign_id = p_campaign_id AND tl.status = 'OPEN';
        SELECT pg_catalog.count(*) INTO v_count
        FROM inventarios.task_locations tl
        JOIN inventarios.sessions s ON s.company_id = tl.company_id AND s.id = tl.session_id
        WHERE tl.company_id = p_company_id AND s.campaign_id = p_campaign_id AND tl.status = 'OPEN';
    END IF;

    IF v_detail_type = 'NEVER_VISITED_LOCATIONS' THEN
        SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
            ELSE pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'bodega', coalesce(is2.name, s.name),
                    'zona', sz.zone_code,
                    'ubicacion', coalesce(NULLIF(pg_catalog.btrim(sl.code), ''), '—'),
                    'situacion', 'Nunca visitada'
                ) ORDER BY is2.name NULLS LAST, sz.zone_code, sl.code
            )
        END
        INTO v_rows
        FROM inventarios.session_zone_locations szl
        JOIN inventarios.sessions s ON s.company_id = szl.company_id AND s.id = szl.session_id
        LEFT JOIN inventarios.inventory_sites is2 ON is2.company_id = s.company_id AND is2.id = s.inventory_site_id
        LEFT JOIN inventarios.session_zones sz ON sz.company_id = szl.company_id AND sz.session_id = szl.session_id AND sz.id = szl.session_zone_id
        LEFT JOIN inventarios.snapshot_locations sl ON sl.company_id = szl.company_id AND sl.snapshot_id = szl.snapshot_id AND sl.id = szl.snapshot_location_id
        WHERE szl.company_id = p_company_id AND s.campaign_id = p_campaign_id
          AND NOT EXISTS (
              SELECT 1 FROM inventarios.task_locations tl
              WHERE tl.company_id = szl.company_id AND tl.session_zone_location_id = szl.id
          );
        SELECT pg_catalog.count(*) INTO v_count
        FROM inventarios.session_zone_locations szl
        JOIN inventarios.sessions s ON s.company_id = szl.company_id AND s.id = szl.session_id
        WHERE szl.company_id = p_company_id AND s.campaign_id = p_campaign_id
          AND NOT EXISTS (
              SELECT 1 FROM inventarios.task_locations tl
              WHERE tl.company_id = szl.company_id AND tl.session_zone_location_id = szl.id
          );
    END IF;

    IF v_detail_type = 'IN_PROGRESS_ZONES' THEN
        SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
            ELSE pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'bodega', coalesce(is2.name, s.name),
                    'zona', sz.zone_code,
                    'responsable', inventarios.user_display_name(t.active_user_id),
                    'ubicaciones_visitadas', z.visitadas,
                    'ubicaciones_total', z.total,
                    'situacion', CASE t.status WHEN 'IN_PROGRESS' THEN 'En curso' WHEN 'PAUSED' THEN 'En pausa' ELSE t.status END
                ) ORDER BY is2.name NULLS LAST, sz.zone_code
            )
        END
        INTO v_rows
        FROM inventarios.session_zones sz
        JOIN inventarios.sessions s ON s.company_id = sz.company_id AND s.id = sz.session_id
        LEFT JOIN inventarios.inventory_sites is2 ON is2.company_id = s.company_id AND is2.id = s.inventory_site_id
        JOIN inventarios.tasks t ON t.company_id = sz.company_id AND t.session_id = sz.session_id AND t.session_zone_id = sz.id
            AND t.cancelled_at IS NULL
        LEFT JOIN LATERAL (
            SELECT pg_catalog.count(*) FILTER (WHERE tl.id IS NOT NULL) AS visitadas,
                   pg_catalog.count(*) AS total
            FROM inventarios.session_zone_locations szl
            LEFT JOIN inventarios.task_locations tl ON tl.company_id = szl.company_id
                AND tl.session_zone_location_id = szl.id
            WHERE szl.company_id = sz.company_id AND szl.session_zone_id = sz.id
        ) z ON true
        WHERE s.campaign_id = p_campaign_id AND t.status IN ('IN_PROGRESS','PAUSED');
        SELECT pg_catalog.count(*) INTO v_count
        FROM inventarios.session_zones sz
        JOIN inventarios.sessions s ON s.company_id = sz.company_id AND s.id = sz.session_id
        JOIN inventarios.tasks t ON t.company_id = sz.company_id AND t.session_id = sz.session_id AND t.session_zone_id = sz.id
            AND t.cancelled_at IS NULL
        WHERE s.campaign_id = p_campaign_id AND t.status IN ('IN_PROGRESS','PAUSED');
    END IF;

    IF v_detail_type = 'PENDING_BARCODES' THEN
        SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
            ELSE pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'codigo_escaneado', pbp.scanned_code,
                    'producto', coalesce(NULLIF(inventarios.campaign_product_display_name(ce.bsale_variant_id), ''), 'Sin producto asociado'),
                    'bodega', coalesce(is2.name, s.name),
                    'zona', sz.zone_code,
                    'ubicacion', coalesce(NULLIF(pg_catalog.btrim(sl.code), ''), '—'),
                    'estado', 'Pendiente de revisión'
                ) ORDER BY pbp.scanned_code
            )
        END
        INTO v_rows
        FROM inventarios.product_barcode_proposals pbp
        JOIN inventarios.sessions s ON s.company_id = pbp.company_id AND s.id = pbp.session_id
        LEFT JOIN inventarios.inventory_sites is2 ON is2.company_id = s.company_id AND is2.id = s.inventory_site_id
        LEFT JOIN inventarios.count_entries ce ON ce.company_id = pbp.company_id AND ce.id = pbp.count_entry_id
        LEFT JOIN inventarios.session_zones sz ON sz.company_id = ce.company_id AND sz.session_id = ce.session_id AND sz.id = ce.session_zone_id
        LEFT JOIN inventarios.snapshot_locations sl ON sl.company_id = ce.company_id AND sl.snapshot_id = ce.snapshot_id AND sl.id = ce.snapshot_location_id
        WHERE pbp.company_id = p_company_id AND s.campaign_id = p_campaign_id AND pbp.status = 'PENDING_REVIEW';
        SELECT pg_catalog.count(*) INTO v_count
        FROM inventarios.product_barcode_proposals pbp
        JOIN inventarios.sessions s ON s.company_id = pbp.company_id AND s.id = pbp.session_id
        WHERE pbp.company_id = p_company_id AND s.campaign_id = p_campaign_id AND pbp.status = 'PENDING_REVIEW';
    END IF;

    IF v_detail_type = 'OUT_OF_SNAPSHOT_PRODUCTS' THEN
        SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
            ELSE pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'sku', csp.sku,
                    'producto', coalesce(NULLIF(inventarios.campaign_product_display_name(csp.bsale_variant_id), ''), csp.name),
                    'stock_teorico', icts.theoretical_quantity,
                    'costo_unitario', icts.unit_cost,
                    'situacion', 'No incluido para conteo'
                ) ORDER BY csp.sku
            )
        END
        INTO v_rows
        FROM inventarios.inventory_campaign_theoretical_stocks icts
        JOIN inventarios.inventory_campaign_snapshots cs
          ON cs.company_id = icts.company_id AND cs.id = icts.campaign_snapshot_id AND cs.campaign_id = p_campaign_id
        JOIN inventarios.inventory_campaign_snapshot_products csp
          ON csp.company_id = icts.company_id AND csp.campaign_snapshot_id = icts.campaign_snapshot_id AND csp.id = icts.snapshot_product_id
        WHERE icts.company_id = p_company_id AND icts.scope_level = 'TOTAL_CAMPAIGN'
          AND NOT EXISTS (
              SELECT 1 FROM inventarios.snapshot_products sp
              JOIN inventarios.operational_snapshots os ON os.id = sp.snapshot_id AND os.company_id = sp.company_id
              JOIN inventarios.sessions s ON s.company_id = os.company_id AND s.id = os.session_id
              WHERE s.campaign_id = p_campaign_id AND sp.bsale_variant_id = csp.bsale_variant_id
          );
        SELECT pg_catalog.count(*) INTO v_count
        FROM inventarios.inventory_campaign_theoretical_stocks icts
        JOIN inventarios.inventory_campaign_snapshots cs
          ON cs.company_id = icts.company_id AND cs.id = icts.campaign_snapshot_id AND cs.campaign_id = p_campaign_id
        JOIN inventarios.inventory_campaign_snapshot_products csp
          ON csp.company_id = icts.company_id AND csp.campaign_snapshot_id = icts.campaign_snapshot_id AND csp.id = icts.snapshot_product_id
        WHERE icts.company_id = p_company_id AND icts.scope_level = 'TOTAL_CAMPAIGN'
          AND NOT EXISTS (
              SELECT 1 FROM inventarios.snapshot_products sp
              JOIN inventarios.operational_snapshots os ON os.id = sp.snapshot_id AND os.company_id = sp.company_id
              JOIN inventarios.sessions s ON s.company_id = os.company_id AND s.id = os.session_id
              WHERE s.campaign_id = p_campaign_id AND sp.bsale_variant_id = csp.bsale_variant_id
          );
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'campaign_id', p_campaign_id,
        'campaign_status', v_campaign_status,
        'detail_type', v_detail_type,
        'count', v_count,
        'rows', CASE WHEN v_rows IS NULL THEN '[]'::jsonb ELSE v_rows END
    );
END;
$function$;

GRANT EXECUTE ON FUNCTION inventarios.get_inventory_campaign_readiness_detail(uuid, uuid, text) TO authenticated, service_role;

COMMIT;
