-- Migration: 20260907153000_inventarios_campaign_supplemental_findings_session.sql
-- Description: Soporte mínimo de sesión SUPPLEMENTAL_FINDINGS para inventarios
--              activos (campañas IN_PROGRESS).
--
-- Alcance mínimo aprobado:
--   * las sesiones NORMAL permanecen igual y conservan exactamente su unicidad
--     campaña + inventory_site;
--   * se permite como máximo 1 sesión SUPPLEMENTAL_FINDINGS por campaña + site;
--   * las sesiones operativas existentes y sus snapshots COMPLETED no se tocan.
--
-- No se crean snapshots, conteos, zonas, tareas ni participantes suplementarios.
-- No se consume ni modifica la importación teórica.
-- Author: Assistant

-- ============================================================================
-- 1. SESSIONS: atributo session_purpose
--    NORMAL = valor por defecto (todo lo existente queda NORMAL).
--    SUPPLEMENTAL_FINDINGS = sesión separada de hallazgos complementarios.
-- ============================================================================
ALTER TABLE inventarios.sessions
    ADD COLUMN session_purpose text NOT NULL DEFAULT 'NORMAL';

ALTER TABLE inventarios.sessions
    ADD CONSTRAINT chk_inventarios_sessions_purpose
    CHECK (session_purpose IN ('NORMAL', 'SUPPLEMENTAL_FINDINGS'));

-- ============================================================================
-- 2. UNICIDAD campaña + inventory_site
--    Reemplaza uq_inventarios_sessions_campaign_site (que impedía cualquier
--    segunda sesión de la misma campaña+site) por dos índices parciales:
--      * NORMAL: conserva exactamente el comportamiento previo (1 por campaña+site);
--      * SUPPLEMENTAL_FINDINGS: permite como máximo 1 por campaña+site.
--    Como son índices parciales dispares por session_purpose, una sesión
--    NORMAL y una SUPPLEMENTAL_FINDINGS pueden coexistir para el mismo par.
-- ============================================================================
DROP INDEX IF EXISTS inventarios.uq_inventarios_sessions_campaign_site;

CREATE UNIQUE INDEX uq_inventarios_sessions_campaign_site
    ON inventarios.sessions (company_id, campaign_id, inventory_site_id)
    WHERE campaign_id IS NOT NULL
      AND inventory_site_id IS NOT NULL
      AND session_purpose = 'NORMAL';

CREATE UNIQUE INDEX uq_inventarios_sessions_campaign_site_supplemental
    ON inventarios.sessions (company_id, campaign_id, inventory_site_id)
    WHERE campaign_id IS NOT NULL
      AND inventory_site_id IS NOT NULL
      AND session_purpose = 'SUPPLEMENTAL_FINDINGS';

-- ============================================================================
-- 3. RPC get_or_create ... SUPPLEMENTAL_FINDINGS
--    Obtiene o crea la sesión SUPPLEMENTAL_FINDINGS de una campaña + site.
--    * solo campañas IN_PROGRESS;
--    * solo un inventory_site que ya participa en esa campaña;
--    * reutiliza warehouse_id del inventory_site;
--    * se crea DRAFT, sin snapshot/zona/tarea/participante/conteo;
--    * idempotente: si ya existe, devuelve la existente;
--    * autorización estricta de SUPER_USUARIO (backend).
--    No usa los RPC normales de creación de sesiones.
-- ============================================================================
CREATE OR REPLACE FUNCTION inventarios.get_or_create_inventory_campaign_supplemental_findings_session(
    p_company_id uuid,
    p_campaign_id uuid,
    p_inventory_site_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_role_name text;
    v_campaign_status text;
    v_campaign_name text;
    v_site_name text;
    v_warehouse_id uuid;
    v_existing_id uuid;
    v_session_id uuid;
    v_session_number integer;
    v_occurred_at timestamptz;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_inventory_site_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    -- ---------- Autorización estricta: SUPER_USUARIO ----------
    v_actor_id := inventarios.require_company_access(p_company_id);
    SELECT r.name INTO v_role_name
    FROM portal.users u
    JOIN portal.roles r ON r.id = u.role_id
    WHERE u.id = v_actor_id AND u.is_active = true;
    IF coalesce(v_role_name, '') <> 'SUPER_USUARIO' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PERMISSION_REQUIRED',
            DETAIL=pg_catalog.jsonb_build_object('message','Solo SUPER_USUARIO puede crear la sesión de hallazgos complementarios.','retryable',false)::text;
    END IF;

    v_occurred_at := pg_catalog.now();

    -- ---------- Campaña debe existir y estar IN_PROGRESS ----------
    SELECT ic.status, ic.name INTO v_campaign_status, v_campaign_name
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id;
    IF v_campaign_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario no existe.','retryable',false)::text;
    END IF;
    IF v_campaign_status <> 'IN_PROGRESS' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La campaña debe estar en IN_PROGRESS.','retryable',false,'status',v_campaign_status)::text;
    END IF;

    -- ---------- El inventory_site debe ser participante de la campaña ----------
    SELECT is2.name, is2.warehouse_id INTO v_site_name, v_warehouse_id
    FROM inventarios.inventory_campaign_sites ics
    JOIN inventarios.inventory_sites is2
      ON is2.company_id = ics.company_id AND is2.id = ics.inventory_site_id
    WHERE ics.company_id = p_company_id
      AND ics.campaign_id = p_campaign_id
      AND ics.inventory_site_id = p_inventory_site_id;
    IF v_site_name IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La unidad no participa en la campaña.','retryable',false)::text;
    END IF;

    -- ---------- Idempotencia: devolver la existente ----------
    SELECT s.id INTO v_existing_id
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id
      AND s.campaign_id = p_campaign_id
      AND s.inventory_site_id = p_inventory_site_id
      AND s.session_purpose = 'SUPPLEMENTAL_FINDINGS';
    IF v_existing_id IS NOT NULL THEN
        RETURN pg_catalog.jsonb_build_object(
            'campaign_id', p_campaign_id,
            'inventory_site_id', p_inventory_site_id,
            'session_id', v_existing_id,
            'session_purpose', 'SUPPLEMENTAL_FINDINGS',
            'created', false,
            'state', (SELECT s.status FROM inventarios.sessions s WHERE s.id = v_existing_id)
        );
    END IF;

    -- ---------- Crear sesión DRAFT ----------
    SELECT coalesce(pg_catalog.max(session_number), 0) + 1
    INTO v_session_number
    FROM inventarios.sessions
    WHERE company_id = p_company_id;

    INSERT INTO inventarios.sessions (
        company_id, session_number, name, inventory_type, status,
        warehouse_id, bsale_office_id, scope_mode, responsible_user_id,
        campaign_id, inventory_site_id, session_purpose,
        created_at, created_by, updated_at, updated_by)
    VALUES (
        p_company_id, v_session_number,
        v_campaign_name || ' - ' || v_site_name || ' - Hallazgos', 'GENERAL', 'DRAFT',
        v_warehouse_id, NULL, 'GENERAL', v_actor_id,
        p_campaign_id, p_inventory_site_id, 'SUPPLEMENTAL_FINDINGS',
        v_occurred_at, v_actor_id, v_occurred_at, v_actor_id)
    RETURNING id INTO v_session_id;

    RETURN pg_catalog.jsonb_build_object(
        'campaign_id', p_campaign_id,
        'inventory_site_id', p_inventory_site_id,
        'session_id', v_session_id,
        'session_purpose', 'SUPPLEMENTAL_FINDINGS',
        'created', true,
        'state', 'DRAFT',
        'session_number', v_session_number,
        'warehouse_id', v_warehouse_id
    );
END;
$function$;

ALTER FUNCTION inventarios.get_or_create_inventory_campaign_supplemental_findings_session(uuid, uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.get_or_create_inventory_campaign_supplemental_findings_session(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.get_or_create_inventory_campaign_supplemental_findings_session(uuid, uuid, uuid) TO authenticated, service_role;

-- ============================================================================
-- 4. get_inventory_campaign_detail
--    La introducción de session_purpose no debe hacer que una sesión
--    SUPPLEMENTAL_FINDINGS sustituya o altere la sesión operacional NORMAL
--    mostrada por el detalle de campaña. Se conserva firma, JSON, permisos,
--    SECURITY DEFINER y search_path; solo se acota a session_purpose = 'NORMAL'
--    en los tres conceptos de sesión operacional (session_count,
--    sessions_pending y la sesión elegida por cada inventory_site).
-- ============================================================================
CREATE OR REPLACE FUNCTION inventarios.get_inventory_campaign_detail(
    p_company_id uuid,
    p_campaign_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_campaign jsonb;
    v_sites jsonb;
    v_products jsonb;
    v_site_count bigint;
    v_session_count bigint;
    v_sessions_pending bigint;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');

    SELECT pg_catalog.jsonb_build_object(
        'id', ic.id,
        'name', ic.name,
        'campaign_type', ic.campaign_type,
        'status', ic.status,
        'site_scope', ic.site_scope,
        'product_scope', ic.product_scope,
        'planned_at', ic.planned_at,
        'created_at', ic.created_at
    )
    INTO v_campaign
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id;
    IF v_campaign IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La campana no existe.','retryable',false)::text;
    END IF;

    SELECT pg_catalog.count(*) INTO v_site_count
    FROM inventarios.inventory_campaign_sites ics
    WHERE ics.company_id = p_company_id AND ics.campaign_id = p_campaign_id;

    SELECT pg_catalog.count(*) INTO v_session_count
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id
      AND s.session_purpose = 'NORMAL';

    SELECT pg_catalog.count(*) INTO v_sessions_pending
    FROM inventarios.inventory_campaign_sites ics
    WHERE ics.company_id = p_company_id AND ics.campaign_id = p_campaign_id
      AND NOT EXISTS (
          SELECT 1 FROM inventarios.sessions s
          WHERE s.company_id = ics.company_id
            AND s.campaign_id = ics.campaign_id
            AND s.inventory_site_id = ics.inventory_site_id
            AND s.session_purpose = 'NORMAL'
      );

    SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'campaign_site_id', ics.id,
            'site_id', ics.inventory_site_id,
            'site_name', is2.name,
            'site_code', is2.code,
            'site_type', is2.site_type,
            'is_required', ics.is_required,
            'display_order', ics.display_order,
            'location_scope', ics.location_scope,
            'location_count', CASE
                WHEN ics.location_scope = 'SELECTED' THEN (
                    SELECT pg_catalog.count(*) FROM inventarios.inventory_campaign_site_locations icl
                    WHERE icl.company_id = ics.company_id AND icl.campaign_site_id = ics.id
                )
                ELSE (
                    SELECT pg_catalog.count(*) FROM inventarios.inventory_site_locations isl
                    WHERE isl.company_id = is2.company_id
                      AND isl.inventory_site_id = is2.id
                      AND isl.is_active = true
                )
            END,
            'session_id', v_session.id,
            'session_number', v_session.session_number,
            'session_status', v_session.status,
            'stock_source', v_session.stock_source,
            'stock_import_id', v_session.stock_import_id,
            'import_status', si.status,
            'import_filename', si.original_filename
        ) ORDER BY ics.display_order
    )
    INTO v_sites
    FROM inventarios.inventory_campaign_sites ics
    JOIN inventarios.inventory_sites is2
      ON is2.company_id = ics.company_id AND is2.id = ics.inventory_site_id
    LEFT JOIN LATERAL (
        SELECT s.id, s.session_number, s.status, s.stock_source, s.stock_import_id
        FROM inventarios.sessions s
        WHERE s.company_id = ics.company_id
          AND s.campaign_id = ics.campaign_id
          AND s.inventory_site_id = ics.inventory_site_id
          AND s.session_purpose = 'NORMAL'
        ORDER BY s.created_at DESC
        LIMIT 1
    ) v_session ON true
    LEFT JOIN inventarios.stock_imports si
      ON si.company_id = p_company_id AND si.id = v_session.stock_import_id
    WHERE ics.company_id = p_company_id AND ics.campaign_id = p_campaign_id;

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'product_id', icp.product_id,
                'sku', icp.sku,
                'display_order', icp.display_order
            ) ORDER BY icp.display_order
        )
    END
    INTO v_products
    FROM inventarios.inventory_campaign_products icp
    WHERE icp.company_id = p_company_id AND icp.campaign_id = p_campaign_id;

    RETURN pg_catalog.jsonb_build_object(
        'campaign', v_campaign,
        'site_count', v_site_count,
        'session_count', v_session_count,
        'sessions_pending', v_sessions_pending,
        'sites', CASE WHEN v_sites IS NULL THEN '[]'::jsonb ELSE v_sites END,
        'products', CASE WHEN v_products IS NULL THEN '[]'::jsonb ELSE v_products END
    );
END;
$$;

ALTER FUNCTION inventarios.get_inventory_campaign_detail(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.get_inventory_campaign_detail(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.get_inventory_campaign_detail(uuid, uuid) TO authenticated;
