-- =========================================================================================
-- MIGRATION: M1.5F.2 - Scope administrativo de busqueda para auditorias sin ubicacion
-- =========================================================================================
-- Objetivo:
--   Completar el contrato backend de auditorias para productos con
--   scope_status = 'NO_PREVIOUS_LOCATION'. Un producto sin ubicaciones conocidas solo puede
--   asignarse como tarea ejecutable cuando el administrador define explicitamente un ambito
--   de busqueda (bodega/seccion + una o varias zonas reales del mismo Inventario).
--
--   NO_PREVIOUS_LOCATION no es error ni blocker: el administrador decide si audita; si decide
--   auditarlo debe definir el ambito de busqueda. No se fabrica ninguna ubicacion.
--
-- Alcance de este bloque:
--   * Nueva tabla inventarios.inventory_audit_search_scopes (persistencia auditable del scope:
--     producto, seccion/bodega, zona(s), quien y cuando). Separada de
--     inventory_audit_locations (que representan ubicaciones concretas conocidas).
--   * RPC read-only list_inventory_audit_search_scopes: secciones (sessions) del Inventario
--     con sus zonas habilitadas, para que el ERP las ofrezca al asignar.
--   * create_inventory_audit extendido con p_search_scopes (por producto cuando corresponda).
--     Rechaza con INV_AUDIT_SEARCH_SCOPE_REQUIRED un NO_PREVIOUS_LOCATION sin scope y con
--     INV_AUDIT_SEARCH_SCOPE_INVALID un scope que no pertenece al Inventario.
--     Sigue soportando una sola tarea con varios productos (mixta: ubicaciones + scope).
--   * list_my_inventory_audits (contrato ciego Mobile) distingue ambos casos entregando
--     search_scope (seccion + zonas) para NO_PREVIOUS_LOCATION sin exponer teorico, fisico
--     previo ni diferencia.
--   * list_inventory_audit_candidates expone scope_status por candidato para que el ERP
--     sepa que productos exigen ambito de busqueda.
--
-- NO se implementa aun: captura Mobile, declaracion "no encontrado", resultado de auditoria.
--
-- Esquema afectado EXCLUSIVAMENTE: inventarios.
-- =========================================================================================

BEGIN;

-- ============================================================
-- 1. MODELO: SCOPE ADMINISTRATIVO DE BUSQUEDA
-- ============================================================
-- Una fila por (producto auditado, zona autorizada). La seccion/bodega se congela por fila
-- para permitir reconstruir posteriormente: que producto, en que seccion debia buscarse,
-- que zonas debia recorrer, quien y cuando. Es un AMBITO donde buscar, jamas una ubicacion
-- concreta (inventory_audit_locations sigue representando ubicaciones reales conocidas).
CREATE TABLE inventarios.inventory_audit_search_scopes (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    campaign_id uuid NOT NULL,
    audit_id uuid NOT NULL,
    audit_product_id uuid NOT NULL,
    -- Seccion de conteo = jornada (session) del Inventario donde se buscara.
    session_id uuid NOT NULL,
    -- Unidad/bodega del Inventario (descriptivo congelado; derivable de la session).
    inventory_site_id uuid,
    -- Zona operacional (session_zone) dentro de la seccion que el auditor debe recorrer.
    session_zone_id uuid NOT NULL,
    session_name text,
    site_name text,
    zone_code text,
    zone_name text,
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT fk_inventarios_audit_search_scopes_audit
        FOREIGN KEY (audit_id)
        REFERENCES inventarios.inventory_audits(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_inventarios_audit_search_scopes_product
        FOREIGN KEY (audit_product_id)
        REFERENCES inventarios.inventory_audit_products(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_inventarios_audit_search_scopes_campaign
        FOREIGN KEY (company_id, campaign_id)
        REFERENCES inventarios.inventory_campaigns(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_audit_search_scopes_session
        FOREIGN KEY (company_id, session_id)
        REFERENCES inventarios.sessions(company_id, id)
        ON DELETE RESTRICT,
    -- Garantiza a nivel de base de datos que la zona pertenece a la seccion declarada.
    CONSTRAINT fk_inventarios_audit_search_scopes_zone
        FOREIGN KEY (company_id, session_id, session_zone_id)
        REFERENCES inventarios.session_zones(company_id, session_id, id)
        ON DELETE RESTRICT,
    -- La misma zona no puede repetirse para el mismo producto auditado.
    CONSTRAINT uq_inventarios_audit_search_scopes_zone
        UNIQUE (company_id, audit_product_id, session_zone_id)
);

COMMENT ON TABLE inventarios.inventory_audit_search_scopes IS
    'Ambito administrativo de busqueda declarado por el administrador para un producto auditado sin ubicacion previa (scope_status = NO_PREVIOUS_LOCATION). Representa donde buscar (seccion/bodega y zonas), no una ubicacion concreta conocida.';

CREATE INDEX idx_inventarios_audit_search_scopes_product
    ON inventarios.inventory_audit_search_scopes (audit_product_id);

CREATE INDEX idx_inventarios_audit_search_scopes_audit
    ON inventarios.inventory_audit_search_scopes (audit_id);

ALTER TABLE inventarios.inventory_audit_search_scopes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inventarios.inventory_audit_search_scopes FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE inventarios.inventory_audit_search_scopes TO service_role;

-- ============================================================
-- 2. RPC READ-ONLY: SECCIONES/ZONAS DISPONIBLES PARA SCOPE
--    Entrega unicamente sessions del Inventario (campana) con sus zonas habilitadas y datos
--    descriptivos suficientes para que la UI muestre algo como:
--      Bodega Principal
--        - Zona 1
--        - Zona 2
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.list_inventory_audit_search_scopes(
    p_company_id uuid,
    p_campaign_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_sections jsonb;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');

    IF NOT EXISTS (
        SELECT 1 FROM inventarios.inventory_campaigns c
        WHERE c.company_id = p_company_id AND c.id = p_campaign_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario no existe.','retryable',false)::text;
    END IF;

    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'session_id', s.id,
                'session_number', s.session_number,
                'session_name', s.name,
                'inventory_site_id', s.inventory_site_id,
                'site_name', is2.name,
                'zones', (
                    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
                        ELSE pg_catalog.jsonb_agg(
                            pg_catalog.jsonb_build_object(
                                'zone_id', z.id,
                                'zone_code', z.zone_code,
                                'zone_name', z.display_name
                            ) ORDER BY z.priority, z.zone_code
                        )
                    END
                    FROM inventarios.session_zones z
                    WHERE z.company_id = s.company_id AND z.session_id = s.id
                      AND z.is_enabled = true
                )
            ) ORDER BY s.name, s.session_number
        )
    END
    INTO v_sections
    FROM inventarios.sessions s
    LEFT JOIN inventarios.inventory_sites is2
      ON is2.company_id = s.company_id AND is2.id = s.inventory_site_id
    WHERE s.company_id = p_company_id
      AND s.campaign_id = p_campaign_id
      AND s.status <> 'CANCELLED';

    RETURN pg_catalog.jsonb_build_object(
        'campaign_id', p_campaign_id,
        'sections', coalesce(v_sections, '[]'::jsonb)
    );
END;
$function$;

ALTER FUNCTION inventarios.list_inventory_audit_search_scopes(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.list_inventory_audit_search_scopes(uuid, uuid)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.list_inventory_audit_search_scopes(uuid, uuid) TO authenticated, service_role;

-- ============================================================
-- 3. RPC: CREAR AUDITORIA (EXTENDIDA CON SCOPE DE BUSQUEDA)
--    Nuevo parametro p_search_scopes jsonb (array de objetos):
--      [{ "bsale_variant_id": 4877,
--         "session_id": "<uuid de la seccion/jornada>",
--         "zone_ids": ["<uuid zona 1>", "<uuid zona 2>"] }]
--    Reglas por producto:
--      * Si resuelve ubicaciones conocidas (conteos efectivos o teorico BY_LOCATION) se
--        mantiene el comportamiento actual (LOCATIONS_RESOLVED) y NO exige scope.
--      * Si queda NO_PREVIOUS_LOCATION y no se entrega scope -> INV_AUDIT_SEARCH_SCOPE_REQUIRED.
--      * El scope debe pertenecer al mismo Inventario: session.campaign_id = p_campaign_id
--        y cada zona debe pertenecer a esa seccion y estar habilitada.
--      * No se fabrica ninguna ubicacion.
-- ============================================================
DROP FUNCTION IF EXISTS inventarios.create_inventory_audit(uuid, uuid, uuid, bigint[], uuid);

CREATE OR REPLACE FUNCTION inventarios.create_inventory_audit(
    p_company_id uuid,
    p_campaign_id uuid,
    p_assigned_participant_id uuid,
    p_bsale_variant_ids bigint[],
    p_idempotency_key uuid,
    p_search_scopes jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_operation jsonb;
    v_operation_id uuid;
    v_campaign_status text;
    v_participant_user_id uuid;
    v_audit_number integer;
    v_audit_id uuid;
    v_payload jsonb;
    v_variant bigint;
    v_product_id uuid;
    v_sku text;
    v_name text;
    v_barcode text;
    v_theo numeric;
    v_phys numeric;
    v_diff numeric;
    v_unit_cost numeric;
    v_var text;
    v_scope_status text;
    v_audit_product_id uuid;
    v_location_count integer;
    v_products jsonb := '[]'::jsonb;
    v_product_meta jsonb;
    -- Scope administrativo de busqueda (por producto NO_PREVIOUS_LOCATION).
    v_scope_session_id uuid;
    v_scope_zone_ids uuid[];
    v_scope_session_name text;
    v_scope_site_id uuid;
    v_scope_site_name text;
    v_scope_zone uuid;
    v_scope_zone_code text;
    v_scope_zone_name text;
    v_scope_count integer := 0;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL
       OR p_assigned_participant_id IS NULL OR p_idempotency_key IS NULL
       OR p_bsale_variant_ids IS NULL OR pg_catalog.array_length(p_bsale_variant_ids, 1) = 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    -- Validacion estructural del scope administrativo (si viene).
    IF p_search_scopes IS NOT NULL AND pg_catalog.jsonb_typeof(p_search_scopes) <> 'array' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    IF p_search_scopes IS NOT NULL AND pg_catalog.jsonb_array_length(p_search_scopes) > 0 THEN
        IF EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(p_search_scopes) el
            WHERE pg_catalog.jsonb_typeof(el) <> 'object'
               OR NOT (el ? 'bsale_variant_id') OR pg_catalog.jsonb_typeof(el->'bsale_variant_id') <> 'number'
               OR NOT (el ? 'session_id') OR pg_catalog.jsonb_typeof(el->'session_id') <> 'string'
               OR NOT (el ? 'zone_ids') OR pg_catalog.jsonb_typeof(el->'zone_ids') <> 'array'
        ) THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
                DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
        END IF;
        IF EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(p_search_scopes) el
            GROUP BY (el->>'bsale_variant_id')
            HAVING pg_catalog.count(*) > 1
        ) THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
                DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
        END IF;
        IF EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(p_search_scopes) el
            WHERE (el->>'session_id') !~ '(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               OR EXISTS (
                   SELECT 1
                   FROM pg_catalog.jsonb_array_elements_text(el->'zone_ids') zt
                   WHERE zt !~ '(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               )
        ) THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_SEARCH_SCOPE_INVALID',
                DETAIL=pg_catalog.jsonb_build_object('message','El ambito de busqueda declarado no tiene un formato valido.','retryable',false)::text;
        END IF;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.manage');

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('inventarios.create_inventory_audit.idempotency'), pg_catalog.hashtext(p_company_id::text || ':' || p_idempotency_key::text));
    v_payload := pg_catalog.jsonb_build_object('operation','inventarios.audit.create','company_id',p_company_id,'campaign_id',p_campaign_id,'assigned_participant_id',p_assigned_participant_id,'bsale_variant_ids',p_bsale_variant_ids,'search_scopes',coalesce(p_search_scopes,'[]'::jsonb));
    v_operation := inventarios.begin_idempotent_operation(p_company_id,'inventarios.audit.create',p_idempotency_key,inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    -- Serializa la creacion por campana (protege audit_number y la unicidad de auditorias activas).
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('inventarios.create_inventory_audit'), pg_catalog.hashtext(p_company_id::text || ':' || p_campaign_id::text));

    SELECT ic.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id
    FOR UPDATE;
    IF v_campaign_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario no existe.','retryable',false)::text;
    END IF;
    IF v_campaign_status = 'CANCELLED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_CANCELLED',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario esta cancelado y no admite nuevas auditorias.','retryable',false)::text;
    END IF;

    -- Participante apto: COUNTER activo de la campana (regla de conteo operativa actual).
    SELECT p.user_id INTO v_participant_user_id
    FROM inventarios.inventory_campaign_participants p
    LEFT JOIN portal.users u ON u.id = p.user_id
    WHERE p.company_id = p_company_id
      AND p.campaign_id = p_campaign_id
      AND p.id = p_assigned_participant_id
      AND p.participant_role = 'COUNTER'
      AND p.revoked_at IS NULL
      AND p.active_from <= pg_catalog.now()
      AND (u.is_active IS NOT NULL AND u.is_active = true)
      AND u.deleted_at IS NULL
    FOR SHARE;
    IF v_participant_user_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_PARTICIPANT_NOT_ELIGIBLE',
            DETAIL=pg_catalog.jsonb_build_object('message','El participante seleccionado no esta activo o no es apto para realizar el conteo.','retryable',false)::text;
    END IF;

    -- Numero de auditoria correlativo por campana.
    SELECT coalesce(pg_catalog.max(audit_number), 0) + 1
    INTO v_audit_number
    FROM inventarios.inventory_audits
    WHERE company_id = p_company_id AND campaign_id = p_campaign_id;

    -- Prevencion de auditorias activas duplicadas: ningun producto del conjunto puede
    -- tener una auditoria activa (PENDING/ASSIGNED/IN_PROGRESS/SUBMITTED).
    SELECT ap.bsale_variant_id
    INTO v_variant
    FROM inventarios.inventory_audit_products ap
    JOIN inventarios.inventory_audits a ON a.id = ap.audit_id
    WHERE ap.company_id = p_company_id AND ap.campaign_id = p_campaign_id
      AND ap.bsale_variant_id = ANY(p_bsale_variant_ids)
      AND a.status IN ('PENDING','ASSIGNED','IN_PROGRESS','SUBMITTED')
    LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_PRODUCT_ALREADY_ASSIGNED',
            DETAIL=pg_catalog.jsonb_build_object('message','Uno de los productos seleccionados ya tiene una auditoria activa.','retryable',false,'bsale_variant_id',v_variant)::text;
    END IF;

    INSERT INTO inventarios.inventory_audits (
        company_id, campaign_id, audit_number, status,
        assigned_participant_id, assigned_user_id, created_by
    )
    VALUES (
        p_company_id, p_campaign_id, v_audit_number, 'ASSIGNED',
        p_assigned_participant_id, v_participant_user_id, v_actor_id
    )
    RETURNING id INTO v_audit_id;

    -- Por cada producto seleccionado.
    FOR v_variant IN SELECT DISTINCT v FROM pg_catalog.unnest(p_bsale_variant_ids) AS t(v) LOOP
        SELECT d.product_id, d.sku, d.name, d.theoretical_quantity, d.physical_quantity,
               d.difference_quantity, d.unit_cost, d.variance_status
        INTO v_product_id, v_sku, v_name, v_theo, v_phys, v_diff, v_unit_cost, v_var
        FROM inventarios._inventarios_campaign_effective_snapshot(p_company_id, p_campaign_id) d
        WHERE d.bsale_variant_id = v_variant::integer;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_PRODUCT_NOT_FOUND',
                DETAIL=pg_catalog.jsonb_build_object('message','Uno de los productos seleccionados no existe en el resultado del inventario.','retryable',false,'bsale_variant_id',v_variant)::text;
        END IF;
        IF v_diff = 0 THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_PRODUCT_NO_DIFFERENCE',
                DETAIL=pg_catalog.jsonb_build_object('message','Uno de los productos seleccionados no tiene diferencia y no puede auditarse.','retryable',false,'bsale_variant_id',v_variant)::text;
        END IF;

        -- Barcode congelado del snapshot de campana para resolucion Mobile.
        SELECT csp.barcode INTO v_barcode
        FROM inventarios.inventory_campaign_snapshot_products csp
        JOIN inventarios.inventory_campaign_snapshots cs
          ON cs.id = csp.campaign_snapshot_id AND cs.company_id = csp.company_id
         AND cs.campaign_id = p_campaign_id
        WHERE csp.company_id = p_company_id AND csp.bsale_variant_id = v_variant::integer
        LIMIT 1;

        INSERT INTO inventarios.inventory_audit_products (
            company_id, campaign_id, audit_id, bsale_variant_id, product_id, sku, name, barcode,
            theoretical_quantity, physical_quantity, difference_quantity, variance_status,
            unit_cost, difference_value, scope_status, status
        )
        VALUES (
            p_company_id, p_campaign_id, v_audit_id, v_variant::integer, v_product_id, v_sku, v_name, v_barcode,
            v_theo, v_phys, v_diff, v_var, v_unit_cost,
            coalesce(v_diff, 0::numeric) * coalesce(v_unit_cost, 0::numeric),
            'LOCATIONS_RESOLVED', 'ASSIGNED'
        )
        RETURNING id INTO v_audit_product_id;

        -- Alcance de ubicaciones: 1) conteos efectivos previos del producto.
        WITH campaign_tasks AS (
            SELECT t.id AS task_id, t.session_id
            FROM inventarios.tasks t
            JOIN inventarios.sessions s ON s.company_id = t.company_id AND s.id = t.session_id
            WHERE t.company_id = p_company_id AND s.campaign_id = p_campaign_id
              AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
        ),
        counted_locs AS (
            SELECT DISTINCT ce.snapshot_location_id, ce.session_id
            FROM campaign_tasks ct
            CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id) g
            JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
            WHERE ce.bsale_variant_id = v_variant::integer AND ce.snapshot_location_id IS NOT NULL
        )
        INSERT INTO inventarios.inventory_audit_locations (
            company_id, audit_id, audit_product_id, session_id, snapshot_location_id,
            location_id, location_code, location_name
        )
        SELECT p_company_id, v_audit_id, v_audit_product_id,
               cl.session_id, cl.snapshot_location_id,
               sl.location_id, sl.code, sl.name
        FROM counted_locs cl
        JOIN inventarios.snapshot_locations sl
          ON sl.company_id = p_company_id AND sl.id = cl.snapshot_location_id;

        GET DIAGNOSTICS v_location_count = ROW_COUNT;

        -- 2) Si no hay conteos previos: stock teorico por ubicacion (BY_LOCATION) del snapshot.
        IF v_location_count = 0 THEN
            WITH theoretical_locs AS (
                SELECT DISTINCT isl.source_logistics_location_id AS location_id,
                       isl.code AS location_code, isl.name AS location_name
                FROM inventarios.inventory_campaign_theoretical_stocks icts
                JOIN inventarios.inventory_campaign_snapshots cs
                  ON cs.id = icts.campaign_snapshot_id AND cs.company_id = icts.company_id
                 AND cs.campaign_id = p_campaign_id
                JOIN inventarios.inventory_campaign_snapshot_products csp
                  ON csp.id = icts.snapshot_product_id AND csp.company_id = icts.company_id
                 AND csp.bsale_variant_id = v_variant::integer
                JOIN inventarios.inventory_site_locations isl
                  ON isl.id = icts.inventory_site_location_id AND isl.company_id = icts.company_id
                WHERE icts.company_id = p_company_id
                  AND icts.scope_level = 'BY_LOCATION'
                  AND icts.theoretical_quantity > 0
            )
            INSERT INTO inventarios.inventory_audit_locations (
                company_id, audit_id, audit_product_id, session_id, snapshot_location_id,
                location_id, location_code, location_name
            )
            SELECT p_company_id, v_audit_id, v_audit_product_id,
                   NULL::uuid, NULL::uuid,
                   tl.location_id, tl.location_code, tl.location_name
            FROM theoretical_locs tl;

            GET DIAGNOSTICS v_location_count = ROW_COUNT;
        END IF;

        -- 3) Sin ubicacion previa fiable: exige ambito administrativo de busqueda.
        v_scope_count := 0;
        IF v_location_count = 0 THEN
            UPDATE inventarios.inventory_audit_products
            SET scope_status = 'NO_PREVIOUS_LOCATION'
            WHERE id = v_audit_product_id;
            v_scope_status := 'NO_PREVIOUS_LOCATION';

            -- Extraer el ambito declarado para este producto (si existe).
            v_scope_session_id := NULL;
            v_scope_zone_ids := NULL;
            SELECT (el->>'session_id')::uuid,
                   pg_catalog.array_agg(z.zone_id ORDER BY z.ord)
            INTO v_scope_session_id, v_scope_zone_ids
            FROM pg_catalog.jsonb_array_elements(coalesce(p_search_scopes, '[]'::jsonb)) el
            CROSS JOIN LATERAL (
                SELECT (zt.zone_text)::uuid AS zone_id, zt.ord
                FROM pg_catalog.jsonb_array_elements_text(el->'zone_ids') WITH ORDINALITY AS zt(zone_text, ord)
            ) z
            WHERE (el->>'bsale_variant_id')::bigint = v_variant
            GROUP BY el->>'session_id'
            LIMIT 1;

            IF v_scope_session_id IS NULL OR v_scope_zone_ids IS NULL OR pg_catalog.cardinality(v_scope_zone_ids) = 0 THEN
                RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_SEARCH_SCOPE_REQUIRED',
                    DETAIL=pg_catalog.jsonb_build_object('message','El producto sin ubicacion previa requiere definir un ambito de busqueda (seccion y zona).','retryable',false,'bsale_variant_id',v_variant)::text;
            END IF;
            IF pg_catalog.cardinality(v_scope_zone_ids) <> pg_catalog.cardinality(
                (SELECT pg_catalog.array_agg(DISTINCT z) FROM pg_catalog.unnest(v_scope_zone_ids) AS z)
            ) THEN
                RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_SEARCH_SCOPE_INVALID',
                    DETAIL=pg_catalog.jsonb_build_object('message','Las zonas del ambito de busqueda no pueden repetirse.','retryable',false,'bsale_variant_id',v_variant)::text;
            END IF;

            -- La seccion debe pertenecer realmente al mismo Inventario.
            SELECT s.name, s.inventory_site_id, is2.name
            INTO v_scope_session_name, v_scope_site_id, v_scope_site_name
            FROM inventarios.sessions s
            LEFT JOIN inventarios.inventory_sites is2
              ON is2.company_id = s.company_id AND is2.id = s.inventory_site_id
            WHERE s.company_id = p_company_id AND s.id = v_scope_session_id
              AND s.campaign_id = p_campaign_id
              AND s.status <> 'CANCELLED';
            IF NOT FOUND THEN
                RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_SEARCH_SCOPE_INVALID',
                    DETAIL=pg_catalog.jsonb_build_object('message','El ambito de busqueda seleccionado no pertenece al inventario.','retryable',false,'bsale_variant_id',v_variant,'session_id',v_scope_session_id)::text;
            END IF;

            -- Cada zona debe pertenecer a esa seccion y estar habilitada.
            FOR v_scope_zone IN SELECT z FROM pg_catalog.unnest(v_scope_zone_ids) AS z LOOP
                SELECT zz.zone_code, zz.display_name
                INTO v_scope_zone_code, v_scope_zone_name
                FROM inventarios.session_zones zz
                WHERE zz.company_id = p_company_id AND zz.session_id = v_scope_session_id
                  AND zz.id = v_scope_zone AND zz.is_enabled = true;
                IF NOT FOUND THEN
                    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_SEARCH_SCOPE_INVALID',
                        DETAIL=pg_catalog.jsonb_build_object('message','Una de las zonas del ambito de busqueda no pertenece a la seccion o no esta habilitada.','retryable',false,'bsale_variant_id',v_variant,'zone_id',v_scope_zone)::text;
                END IF;

                INSERT INTO inventarios.inventory_audit_search_scopes (
                    company_id, campaign_id, audit_id, audit_product_id,
                    session_id, inventory_site_id, session_zone_id,
                    session_name, site_name, zone_code, zone_name,
                    created_by, created_at
                )
                VALUES (
                    p_company_id, p_campaign_id, v_audit_id, v_audit_product_id,
                    v_scope_session_id, v_scope_site_id, v_scope_zone,
                    v_scope_session_name, v_scope_site_name, v_scope_zone_code, v_scope_zone_name,
                    v_actor_id, pg_catalog.now()
                );
                v_scope_count := v_scope_count + 1;
            END LOOP;
        ELSE
            v_scope_status := 'LOCATIONS_RESOLVED';
        END IF;

        v_product_meta := pg_catalog.jsonb_build_object(
            'bsale_variant_id', v_variant,
            'variance_status', v_var,
            'difference_quantity', v_diff,
            'scope_status', v_scope_status,
            'location_count', v_location_count,
            'search_scope_count', v_scope_count
        );
        v_products := v_products || v_product_meta;
    END LOOP;

    RETURN inventarios.complete_idempotent_operation(
        p_company_id,
        v_operation_id,
        v_audit_id,
        pg_catalog.jsonb_build_object(
            'operation','inventarios.audit.create',
            'entity_id', v_audit_id,
            'state','ASSIGNED',
            'version', NULL::integer,
            'cycle_number', NULL::integer,
            'assignment_id', NULL::uuid,
            'event_id', NULL::uuid,
            'replayed', false,
            'occurred_at', pg_catalog.now(),
            'data', pg_catalog.jsonb_build_object(
                'audit_id', v_audit_id,
                'audit_number', v_audit_number,
                'campaign_id', p_campaign_id,
                'assigned_participant_id', p_assigned_participant_id,
                'assigned_user_id', v_participant_user_id,
                'products', v_products
            )
        )
    );
END;
$function$;

ALTER FUNCTION inventarios.create_inventory_audit(uuid, uuid, uuid, bigint[], uuid, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.create_inventory_audit(uuid, uuid, uuid, bigint[], uuid, jsonb)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.create_inventory_audit(uuid, uuid, uuid, bigint[], uuid, jsonb) TO authenticated, service_role;

-- ============================================================
-- 4. RPC: CONTRATO CIEGO MOBILE (ACTUALIZADO)
--    Distingue explicitamente los dos casos por producto:
--      A) LOCATIONS_RESOLVED    -> 'locations' con las ubicaciones concretas a recorrer.
--      B) NO_PREVIOUS_LOCATION  -> 'search_scope' con seccion (id/nombre) y zonas autorizadas.
--    Sigue siendo ciego: NO expone stock teorico, fisico previo ni diferencia.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.list_my_inventory_audits()
RETURNS jsonb
LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_audits jsonb;
BEGIN
    v_actor_id := inventarios.require_actor();

    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'audit_id', t.id,
                'audit_number', t.audit_number,
                'status', t.status,
                'campaign_id', t.campaign_id,
                'campaign_name', t.campaign_name,
                'assigned_at', t.created_at,
                'product_count', t.product_count,
                'products', t.products
            ) ORDER BY t.audit_number
        )
    END
    INTO v_audits
    FROM (
        SELECT a.id, a.audit_number, a.status, a.campaign_id,
               ic.name AS campaign_name, a.created_at,
               (SELECT pg_catalog.count(*) FROM inventarios.inventory_audit_products ap WHERE ap.audit_id = a.id) AS product_count,
               (SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
                    ELSE pg_catalog.jsonb_agg(
                        pg_catalog.jsonb_build_object(
                            'audit_product_id', ap.id,
                            'bsale_variant_id', ap.bsale_variant_id,
                            'product_id', ap.product_id,
                            'sku', ap.sku,
                            'name', ap.name,
                            'barcode', ap.barcode,
                            'scope_status', ap.scope_status,
                            'locations', CASE WHEN ap.scope_status <> 'LOCATIONS_RESOLVED' THEN '[]'::jsonb
                                           ELSE (SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
                                                   ELSE pg_catalog.jsonb_agg(
                                                        pg_catalog.jsonb_build_object(
                                                            'location_id', l.location_id,
                                                            'location_code', l.location_code,
                                                            'location_name', l.location_name
                                                        )
                                                   )
                                                 END
                                                 FROM inventarios.inventory_audit_locations l WHERE l.audit_product_id = ap.id)
                                          END,
                            'search_scope', CASE WHEN ap.scope_status <> 'NO_PREVIOUS_LOCATION' THEN NULL::jsonb
                                             ELSE (SELECT pg_catalog.jsonb_build_object(
                                                        'session_id', pg_catalog.min(sc.session_id),
                                                        'session_name', pg_catalog.min(sc.session_name),
                                                        'inventory_site_id', pg_catalog.min(sc.inventory_site_id),
                                                        'site_name', pg_catalog.min(sc.site_name),
                                                        'zones', pg_catalog.jsonb_agg(
                                                            pg_catalog.jsonb_build_object(
                                                                'zone_id', sc.session_zone_id,
                                                                'zone_code', sc.zone_code,
                                                                'zone_name', sc.zone_name
                                                            ) ORDER BY sc.zone_code
                                                        )
                                                    )
                                                   FROM inventarios.inventory_audit_search_scopes sc
                                                   WHERE sc.audit_product_id = ap.id)
                                              END
                        ) ORDER BY ap.bsale_variant_id
                    )
                END
                FROM inventarios.inventory_audit_products ap WHERE ap.audit_id = a.id) AS products
        FROM inventarios.inventory_audits a
        JOIN inventarios.inventory_campaigns ic ON ic.id = a.campaign_id AND ic.company_id = a.company_id
        WHERE a.assigned_user_id = v_actor_id
          AND a.status IN ('ASSIGNED','IN_PROGRESS','SUBMITTED')
          AND EXISTS (
              SELECT 1 FROM core.user_company_access uca
              WHERE uca.user_id = v_actor_id AND uca.company_id = a.company_id AND uca.is_active = true
          )
        ORDER BY a.created_at
    ) t;

    RETURN pg_catalog.jsonb_build_object(
        'actor_user_id', v_actor_id,
        'audits', coalesce(v_audits, '[]'::jsonb)
    );
END;
$function$;

ALTER FUNCTION inventarios.list_my_inventory_audits() OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.list_my_inventory_audits() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.list_my_inventory_audits() TO authenticated, service_role;

-- ============================================================
-- 5. RPC: CANDIDATOS A AUDITORIA (ACTUALIZADO)
--    Expone scope_status por candidato (LOCATIONS_RESOLVED / NO_PREVIOUS_LOCATION) con la
--    misma semantica de resolucion de create_inventory_audit, para que el ERP sepa que
--    productos exigen ambito de busqueda al asignar.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.list_inventory_audit_candidates(
    p_company_id uuid,
    p_campaign_id uuid,
    p_search text DEFAULT NULL,
    p_variance_status text DEFAULT NULL,
    p_page integer DEFAULT 1,
    p_page_size integer DEFAULT 50,
    p_sort_by text DEFAULT NULL,
    p_sort_direction text DEFAULT 'ASC'
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_campaign_status text;
    v_search text;
    v_var text;
    v_sort_by text;
    v_sort_dir text;
    v_page integer;
    v_page_size integer;
    v_offset integer;
    v_total bigint := 0;
    v_faltantes bigint := 0;
    v_sobrantes bigint := 0;
    v_audited bigint := 0;
    v_items jsonb;
    v_audits jsonb;
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

    v_search := pg_catalog.btrim(coalesce(p_search, ''));
    v_var := pg_catalog.upper(pg_catalog.btrim(coalesce(p_variance_status, '')));
    IF v_var <> '' AND v_var NOT IN ('FALTANTE','SOBRANTE') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_sort_by := pg_catalog.upper(pg_catalog.btrim(coalesce(p_sort_by, 'SKU')));
    IF v_sort_by <> '' AND v_sort_by NOT IN ('SKU','NAME','VARIANCE_STATUS','THEORETICAL','PHYSICAL','DIFFERENCE') THEN
        v_sort_by := 'SKU';
    END IF;
    v_sort_dir := pg_catalog.upper(pg_catalog.btrim(coalesce(p_sort_direction, 'ASC')));
    IF v_sort_dir NOT IN ('ASC','DESC') THEN v_sort_dir := 'ASC'; END IF;
    v_page := coalesce(p_page, 1);
    v_page_size := coalesce(p_page_size, 50);
    IF v_page < 1 THEN v_page := 1; END IF;
    IF v_page_size < 1 THEN v_page_size := 50; END IF;
    IF v_page_size > 100 THEN v_page_size := 100; END IF;
    v_offset := (v_page - 1) * v_page_size;

    -- Variantes con ubicacion determinable (conteos efectivos o teorico BY_LOCATION).
    -- Replica exactamente la resolucion de create_inventory_audit.
    DROP TABLE IF EXISTS _inventarios_audit_resolved_variants;
    CREATE TEMP TABLE _inventarios_audit_resolved_variants ON COMMIT DROP AS
    WITH campaign_tasks AS (
        SELECT t.id AS task_id, t.session_id
        FROM inventarios.tasks t
        JOIN inventarios.sessions s ON s.company_id = t.company_id AND s.id = t.session_id
        WHERE t.company_id = p_company_id AND s.campaign_id = p_campaign_id
          AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
    ),
    counted AS (
        SELECT DISTINCT ce.bsale_variant_id
        FROM campaign_tasks ct
        CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id) g
        JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
        WHERE ce.bsale_variant_id IS NOT NULL AND ce.snapshot_location_id IS NOT NULL
    ),
    theoretical AS (
        SELECT DISTINCT csp.bsale_variant_id
        FROM inventarios.inventory_campaign_theoretical_stocks icts
        JOIN inventarios.inventory_campaign_snapshots cs
          ON cs.id = icts.campaign_snapshot_id AND cs.company_id = icts.company_id
         AND cs.campaign_id = p_campaign_id
        JOIN inventarios.inventory_campaign_snapshot_products csp
          ON csp.id = icts.snapshot_product_id AND csp.company_id = icts.company_id
        JOIN inventarios.inventory_site_locations isl
          ON isl.id = icts.inventory_site_location_id AND isl.company_id = icts.company_id
        WHERE icts.company_id = p_company_id
          AND icts.scope_level = 'BY_LOCATION'
          AND icts.theoretical_quantity > 0
    )
    SELECT bsale_variant_id FROM counted
    UNION
    SELECT bsale_variant_id FROM theoretical;

    -- Dataset efectivo filtrado (diferencias <> 0) en tabla temporal para paginar
    -- y resumir sobre una sola evaluacion del snapshot efectivo.
    DROP TABLE IF EXISTS _inventarios_audit_candidates;
    CREATE TEMP TABLE _inventarios_audit_candidates ON COMMIT DROP AS
    SELECT d.bsale_variant_id, d.product_id, d.sku, d.name,
           d.in_theoretical_stock, d.theoretical_quantity, d.physical_quantity,
           d.contribution_count, d.unit_cost, d.difference_quantity,
           d.variance_status, d.coverage_status,
           CASE WHEN EXISTS (
               SELECT 1 FROM _inventarios_audit_resolved_variants rv
               WHERE rv.bsale_variant_id = d.bsale_variant_id
           ) THEN 'LOCATIONS_RESOLVED' ELSE 'NO_PREVIOUS_LOCATION' END AS scope_status
    FROM inventarios._inventarios_campaign_effective_snapshot(p_company_id, p_campaign_id) d
    WHERE d.difference_quantity <> 0
      AND (v_search = '' OR d.sku ILIKE '%' || v_search || '%' OR d.name ILIKE '%' || v_search || '%')
      AND (v_var = '' OR d.variance_status = v_var);

    SELECT pg_catalog.count(*),
           pg_catalog.count(*) FILTER (WHERE variance_status = 'FALTANTE'),
           pg_catalog.count(*) FILTER (WHERE variance_status = 'SOBRANTE')
    INTO v_total, v_faltantes, v_sobrantes
    FROM _inventarios_audit_candidates;

    -- Cantidad de productos con auditoria activa dentro del set candidato.
    SELECT pg_catalog.count(*)
    INTO v_audited
    FROM _inventarios_audit_candidates c
    WHERE EXISTS (
        SELECT 1
        FROM inventarios.inventory_audit_products ap
        JOIN inventarios.inventory_audits a ON a.id = ap.audit_id
        WHERE ap.company_id = p_company_id AND ap.campaign_id = p_campaign_id
          AND ap.bsale_variant_id = c.bsale_variant_id
          AND a.status IN ('PENDING','ASSIGNED','IN_PROGRESS','SUBMITTED')
    );

    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'product_key', c.bsale_variant_id::text,
                'bsale_variant_id', c.bsale_variant_id,
                'product_id', c.product_id,
                'sku', c.sku,
                'name', c.name,
                'theoretical_quantity', c.theoretical_quantity,
                'physical_quantity', c.physical_quantity,
                'difference_quantity', c.difference_quantity,
                'unit_cost', c.unit_cost,
                'difference_value', coalesce(c.difference_quantity, 0::numeric) * coalesce(c.unit_cost, 0::numeric),
                'variance_status', c.variance_status,
                'coverage_status', c.coverage_status,
                'scope_status', c.scope_status,
                'audit_id', aud.audit_id,
                'audit_number', aud.audit_number,
                'audit_status', aud.audit_status,
                'auditor_user_id', aud.auditor_user_id,
                'auditor_name', aud.auditor_name,
                'selectable', (aud.audit_id IS NULL)
            ) ORDER BY
                CASE WHEN v_sort_dir = 'ASC' AND v_sort_by = 'SKU' THEN c.sku END ASC NULLS LAST,
                CASE WHEN v_sort_dir = 'DESC' AND v_sort_by = 'SKU' THEN c.sku END DESC NULLS LAST,
                CASE WHEN v_sort_dir = 'ASC' AND v_sort_by = 'NAME' THEN c.name END ASC NULLS LAST,
                CASE WHEN v_sort_dir = 'DESC' AND v_sort_by = 'NAME' THEN c.name END DESC NULLS LAST,
                CASE WHEN v_sort_dir = 'ASC' AND v_sort_by = 'VARIANCE_STATUS' THEN c.variance_status END ASC NULLS LAST,
                CASE WHEN v_sort_dir = 'DESC' AND v_sort_by = 'VARIANCE_STATUS' THEN c.variance_status END DESC NULLS LAST,
                CASE WHEN v_sort_dir = 'ASC' AND v_sort_by = 'THEORETICAL' THEN c.theoretical_quantity END ASC NULLS LAST,
                CASE WHEN v_sort_dir = 'DESC' AND v_sort_by = 'THEORETICAL' THEN c.theoretical_quantity END DESC NULLS LAST,
                CASE WHEN v_sort_dir = 'ASC' AND v_sort_by = 'PHYSICAL' THEN c.physical_quantity END ASC NULLS LAST,
                CASE WHEN v_sort_dir = 'DESC' AND v_sort_by = 'PHYSICAL' THEN c.physical_quantity END DESC NULLS LAST,
                CASE WHEN v_sort_dir = 'ASC' AND v_sort_by = 'DIFFERENCE' THEN c.difference_quantity END ASC NULLS LAST,
                CASE WHEN v_sort_dir = 'DESC' AND v_sort_by = 'DIFFERENCE' THEN c.difference_quantity END DESC NULLS LAST,
                c.sku, c.bsale_variant_id
        )
    END
    INTO v_items
    FROM _inventarios_audit_candidates c
    LEFT JOIN LATERAL (
        SELECT a.id AS audit_id, a.audit_number, a.status AS audit_status,
               a.assigned_user_id AS auditor_user_id, pu.nombre AS auditor_name
        FROM inventarios.inventory_audit_products ap2
        JOIN inventarios.inventory_audits a ON a.id = ap2.audit_id
        LEFT JOIN portal.users pu ON pu.id = a.assigned_user_id
        WHERE ap2.company_id = p_company_id AND ap2.campaign_id = p_campaign_id
          AND ap2.bsale_variant_id = c.bsale_variant_id
          AND a.status IN ('PENDING','ASSIGNED','IN_PROGRESS','SUBMITTED')
        LIMIT 1
    ) aud ON true
    LIMIT v_page_size OFFSET v_offset;

    -- Resumen de auditorias activas de la campana (para la pantalla ERP).
    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'audit_id', a.id,
                'audit_number', a.audit_number,
                'status', a.status,
                'assigned_user_id', a.assigned_user_id,
                'auditor_name', pu.nombre,
                'product_count', (SELECT pg_catalog.count(*) FROM inventarios.inventory_audit_products ap WHERE ap.audit_id = a.id),
                'location_count', (SELECT pg_catalog.count(*) FROM inventarios.inventory_audit_locations l WHERE l.audit_id = a.id),
                'search_scope_count', (SELECT pg_catalog.count(*) FROM inventarios.inventory_audit_search_scopes sc WHERE sc.audit_id = a.id),
                'created_at', a.created_at,
                'created_by', a.created_by
            ) ORDER BY a.audit_number
        )
    END
    INTO v_audits
    FROM inventarios.inventory_audits a
    LEFT JOIN portal.users pu ON pu.id = a.assigned_user_id
    WHERE a.company_id = p_company_id AND a.campaign_id = p_campaign_id
      AND a.status IN ('PENDING','ASSIGNED','IN_PROGRESS','SUBMITTED');

    RETURN pg_catalog.jsonb_build_object(
        'campaign_id', p_campaign_id,
        'campaign_status', v_campaign_status,
        'summary', pg_catalog.jsonb_build_object(
            'total_differences', v_total,
            'faltantes', v_faltantes,
            'sobrantes', v_sobrantes,
            'audited_products', v_audited
        ),
        'total', v_total,
        'page', v_page,
        'page_size', v_page_size,
        'has_more', v_offset + pg_catalog.jsonb_array_length(CASE WHEN v_items IS NULL THEN '[]'::jsonb ELSE v_items END) < v_total,
        'items', CASE WHEN v_items IS NULL THEN '[]'::jsonb ELSE v_items END,
        'active_audits', coalesce(v_audits, '[]'::jsonb)
    );
END;
$function$;

ALTER FUNCTION inventarios.list_inventory_audit_candidates(uuid, uuid, text, text, integer, integer, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.list_inventory_audit_candidates(uuid, uuid, text, text, integer, integer, text, text)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.list_inventory_audit_candidates(uuid, uuid, text, text, integer, integer, text, text) TO authenticated, service_role;

COMMIT;
