-- Corrección del contrato de exportación (20260812161500): task_locations no
-- tiene snapshot_id; se resuelve vía session_zone_locations.snapshot_id en los
-- joins de ubicaciones.
--
-- Esquema afectado EXCLUSIVAMENTE: inventarios.

BEGIN;

CREATE OR REPLACE FUNCTION inventarios.get_inventory_campaign_export(
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
    v_campaign_status text;
    v_contributions jsonb;
    v_operational jsonb;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL THEN
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

    -- Contribuciones efectivas con contexto.
    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'sku', sp.sku,
                'name', coalesce(NULLIF(pg_catalog.btrim(sp.name), ''), 'PRODUCTO ' || ce.bsale_variant_id::text),
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
                'contribution_source', g.contribution_source
            ) ORDER BY s.name, sz.zone_code, sl.code, ce.captured_at
        )
    END
    INTO v_contributions
    FROM (
        SELECT t.id AS task_id, t.session_id
        FROM inventarios.tasks t
        JOIN inventarios.sessions s ON s.company_id = t.company_id AND s.id = t.session_id
        WHERE s.campaign_id = p_campaign_id AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
    ) ct
    CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id) g
    JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
    JOIN inventarios.sessions s ON s.company_id = ce.company_id AND s.id = ce.session_id
    LEFT JOIN inventarios.snapshot_products sp ON sp.company_id = ce.company_id AND sp.snapshot_id = ce.snapshot_id AND sp.id = ce.snapshot_product_id
    LEFT JOIN inventarios.session_zones sz ON sz.company_id = ce.company_id AND sz.session_id = ce.session_id AND sz.id = ce.session_zone_id
    LEFT JOIN inventarios.snapshot_locations sl ON sl.company_id = ce.company_id AND sl.snapshot_id = ce.snapshot_id AND sl.id = ce.snapshot_location_id;

    -- Filas de auditoría del estado operacional.
    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'tipo', r.tipo,
                'seccion', r.seccion,
                'zona', r.zona,
                'ubicacion', r.ubicacion,
                'estado', r.estado,
                'detalle', r.detalle
            ) ORDER BY r.tipo, r.seccion, r.zona, r.ubicacion
        )
    END
    INTO v_operational
    FROM (
        -- Secciones por estado
        SELECT 'Sección' AS tipo, s.name AS seccion, NULL::text AS zona, NULL::text AS ubicacion,
               CASE s.status
                   WHEN 'DRAFT' THEN 'Pendiente'
                   WHEN 'PREPARED' THEN 'Preparada'
                   WHEN 'COUNTING' THEN 'En conteo'
                   WHEN 'UNDER_REVIEW' THEN 'En revisión'
                   WHEN 'APPROVED' THEN 'Terminada'
                   ELSE s.status
               END AS estado,
               'Sección de conteo' AS detalle
        FROM inventarios.sessions s
        WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id

        UNION ALL
        -- Zonas por estado de su tarea activa
        SELECT 'Zona', s.name, sz.zone_code, NULL,
               CASE coalesce(max(t.status), 'ASSIGNED')
                   WHEN 'COMPLETED' THEN 'Completada'
                   WHEN 'IN_PROGRESS' THEN 'En curso'
                   WHEN 'PAUSED' THEN 'En pausa'
                   WHEN 'ASSIGNED' THEN 'No iniciada'
                   ELSE coalesce(max(t.status), 'ASSIGNED')
               END,
               sz.display_name
        FROM inventarios.session_zones sz
        JOIN inventarios.sessions s ON s.company_id = sz.company_id AND s.id = sz.session_id
        LEFT JOIN inventarios.tasks t ON t.company_id = sz.company_id AND t.session_id = sz.session_id
            AND t.session_zone_id = sz.id AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
        WHERE s.campaign_id = p_campaign_id
        GROUP BY sz.id, s.name, sz.zone_code, sz.display_name

        UNION ALL
        -- Tareas pendientes
        SELECT 'Tarea', s.name, NULL, NULL,
               CASE t.status
                   WHEN 'IN_PROGRESS' THEN 'En curso'
                   WHEN 'PAUSED' THEN 'En pausa'
                   ELSE t.status
               END,
               'Tarea de conteo'
        FROM inventarios.tasks t
        JOIN inventarios.sessions s ON s.company_id = t.company_id AND s.id = t.session_id
        WHERE s.campaign_id = p_campaign_id AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
          AND t.status IN ('IN_PROGRESS','PAUSED')

        UNION ALL
        -- Ubicaciones abiertas
        SELECT 'Ubicación', s.name, sz.zone_code, sl.code, 'Abierta', 'Ubicación con tarea abierta'
        FROM inventarios.task_locations tl
        JOIN inventarios.sessions s ON s.company_id = tl.company_id AND s.id = tl.session_id
        LEFT JOIN inventarios.session_zones sz ON sz.company_id = tl.company_id AND sz.session_id = tl.session_id AND sz.id = tl.session_zone_id
        LEFT JOIN inventarios.session_zone_locations szl ON szl.company_id = tl.company_id AND szl.session_id = tl.session_id AND szl.id = tl.session_zone_location_id
        LEFT JOIN inventarios.snapshot_locations sl ON sl.company_id = tl.company_id AND sl.snapshot_id = szl.snapshot_id AND sl.id = szl.snapshot_location_id
        WHERE s.campaign_id = p_campaign_id AND tl.status = 'OPEN'

        UNION ALL
        -- Ubicaciones visitadas sin registros
        SELECT 'Ubicación', s.name, sz.zone_code, sl.code, 'Sin registros', 'Visitada sin conteos efectivos'
        FROM inventarios.task_locations tl
        JOIN inventarios.sessions s ON s.company_id = tl.company_id AND s.id = tl.session_id
        LEFT JOIN inventarios.session_zones sz ON sz.company_id = tl.company_id AND sz.session_id = tl.session_id AND sz.id = tl.session_zone_id
        LEFT JOIN inventarios.session_zone_locations szl ON szl.company_id = tl.company_id AND szl.session_id = tl.session_id AND szl.id = tl.session_zone_location_id
        LEFT JOIN inventarios.snapshot_locations sl ON sl.company_id = tl.company_id AND sl.snapshot_id = szl.snapshot_id AND sl.id = szl.snapshot_location_id
        WHERE s.campaign_id = p_campaign_id
          AND NOT EXISTS (
              SELECT 1
              FROM inventarios.count_entries ce
              JOIN inventarios.session_zone_locations szl2
                ON szl2.company_id = ce.company_id AND szl2.session_id = ce.session_id
               AND szl2.session_zone_id = ce.session_zone_id AND szl2.snapshot_location_id = ce.snapshot_location_id
              WHERE ce.company_id = tl.company_id AND ce.session_id = tl.session_id
                AND szl2.id = tl.session_zone_location_id
                AND ce.invalidated_at IS NULL AND ce.invalidated_by IS NULL AND ce.invalidation_reason IS NULL
          )

        UNION ALL
        -- Productos no incluidos para conteo
        SELECT 'Producto', NULL, NULL, NULL, 'No incluido para conteo',
               csp.sku || ' · ' || coalesce(NULLIF(pg_catalog.btrim(csp.name), ''), 'PRODUCTO ' || csp.bsale_variant_id::text)
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
          )

        UNION ALL
        -- Códigos pendientes de revisión
        SELECT 'Código pendiente', s.name, NULL, NULL, 'Pendiente de revisión',
               pbp.scanned_code
        FROM inventarios.product_barcode_proposals pbp
        JOIN inventarios.sessions s ON s.company_id = pbp.company_id AND s.id = pbp.session_id
        WHERE s.campaign_id = p_campaign_id AND pbp.status = 'PENDING_REVIEW'
    ) r;

    RETURN pg_catalog.jsonb_build_object(
        'campaign_id', p_campaign_id,
        'campaign_status', v_campaign_status,
        'contributions', CASE WHEN v_contributions IS NULL THEN '[]'::jsonb ELSE v_contributions END,
        'operational_rows', CASE WHEN v_operational IS NULL THEN '[]'::jsonb ELSE v_operational END
    );
END;
$function$;

GRANT EXECUTE ON FUNCTION inventarios.get_inventory_campaign_export(uuid, uuid) TO authenticated, service_role;

COMMIT;
