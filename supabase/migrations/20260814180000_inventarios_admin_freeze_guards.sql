-- Congelamiento del Inventario APPROVED/CANCELLED en flujos administrativos agregados.
--
-- Agrega guards de estado de campaña a las mutaciones de:
--   * Revisar diferencias / asignar auditorías: create_inventory_audit.
--   * Incidencias de códigos: approve_inventory_barcode, reject_inventory_barcode,
--     admin_correct_barcode_incident_product, admin_invalidate_barcode_incident_count.
--   * get_inventory_barcode_incident_detail expone campaign_status para que el ERP
--     ponga la UI en solo lectura sin depender solo del permiso.
--
-- Esquema afectado EXCLUSIVAMENTE: inventarios.
--
BEGIN;

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
    IF v_campaign_status = 'APPROVED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_ALREADY_APPROVED',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario ya fue cerrado y no admite nuevas auditorias.','retryable',false,'status',v_campaign_status)::text;
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
$function$;;
GRANT EXECUTE ON FUNCTION inventarios.create_inventory_audit(uuid, uuid, uuid, bigint[], uuid, jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION inventarios.approve_inventory_barcode(
    p_company_id uuid,
    p_campaign_id uuid,
    p_scanned_code text,
    p_bsale_variant_id integer,
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_role_name text;
    v_is_super boolean := false;
    v_is_campaign_admin boolean := false;
    v_barcode text;
    v_operation jsonb;
    v_operation_id uuid;
    v_payload jsonb;
    v_occurred_at timestamptz := pg_catalog.now();
    v_existing_alias uuid;
    v_other_product jsonb;
    v_alias_id uuid;
    v_proposals_updated bigint := 0;
    v_orig jsonb;
    v_orig_barcode text;
    v_orig_source text;
    v_campaign_status text;
    v_response jsonb;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_scanned_code IS NULL
       OR p_bsale_variant_id IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_barcode := pg_catalog.btrim(p_scanned_code);
    IF v_barcode = '' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','El código de barras no es válido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_company_access(p_company_id);

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.barcode_decision'),
        pg_catalog.hashtext(p_company_id::text || ':' || v_barcode));

    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.barcode.approve','company_id',p_company_id,
        'campaign_id',p_campaign_id,'scanned_code',v_barcode,'bsale_variant_id',p_bsale_variant_id);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.barcode.approve',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

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
    IF NOT (v_is_super OR v_is_campaign_admin) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PERMISSION_REQUIRED',
            DETAIL=pg_catalog.jsonb_build_object('message','No tienes permisos para autorizar códigos.','retryable',false)::text;
    END IF;
    -- Guard de congelamiento: campaña APPROVED/CANCELLED no admite decidir códigos.
    SELECT ic.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id;
    IF v_campaign_status = 'APPROVED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_ALREADY_APPROVED',
            DETAIL=pg_catalog.jsonb_build_object('message','El Inventario ya fue cerrado y no admite la revisión de códigos.','retryable',false,'status',v_campaign_status)::text;
    END IF;
    IF v_campaign_status = 'CANCELLED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_CANCELLED',
            DETAIL=pg_catalog.jsonb_build_object('message','El Inventario está cancelado y no admite la revisión de códigos.','retryable',false,'status',v_campaign_status)::text;
    END IF;

    -- Bloqueador duro: barcode asociado a otro producto
    v_other_product := inventarios._barcode_official_other_product(p_company_id, v_barcode, p_bsale_variant_id);
    IF (v_other_product ->> 'found')::boolean = true THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_BARCODE_ALREADY_ASSOCIATED',
            DETAIL=pg_catalog.jsonb_build_object(
                'message','El código de barras ya está asociado a otro producto.',
                'barcode',v_barcode,
                'current_sku',v_other_product ->> 'sku',
                'current_product_name',v_other_product ->> 'product_name',
                'retryable',false)::text;
    END IF;

    -- Alias existente del MISMO producto: idempotente
    SELECT pba.id INTO v_existing_alias
    FROM inventarios.product_barcode_aliases pba
    WHERE pba.company_id = p_company_id AND pba.barcode = v_barcode AND pba.is_active = true
      AND pba.bsale_variant_id = p_bsale_variant_id
    LIMIT 1;

    IF v_existing_alias IS NULL THEN
        -- Provenance del barcode anterior congelado al momento de aprobar.
        v_orig := inventarios.inventory_campaign_product_original_barcode(p_company_id, p_campaign_id, p_bsale_variant_id);
        v_orig_barcode := v_orig ->> 'barcode';
        v_orig_source := v_orig ->> 'source';

        INSERT INTO inventarios.product_barcode_aliases (
            company_id, barcode, bsale_variant_id, product_id, source, is_active,
            original_barcode_at_review, original_barcode_source,
            created_at, created_by, reviewed_at, reviewed_by
        )
        VALUES (
            p_company_id, v_barcode, p_bsale_variant_id,
            (
                SELECT coalesce(
                    (SELECT csp2.product_id FROM inventarios.inventory_campaign_snapshot_products csp2
                     WHERE csp2.company_id = p_company_id
                       AND csp2.bsale_variant_id = p_bsale_variant_id
                       AND csp2.campaign_snapshot_id = (
                           SELECT cs2.id FROM inventarios.inventory_campaign_snapshots cs2
                           WHERE cs2.company_id = p_company_id
                           ORDER BY cs2.created_at DESC LIMIT 1)
                     LIMIT 1),
                    (SELECT sp2.product_id FROM inventarios.snapshot_products sp2
                     WHERE sp2.bsale_variant_id = p_bsale_variant_id
                     ORDER BY sp2.sku NULLS LAST LIMIT 1)
                )
            ),
            'ADMIN_REVIEW', true,
            NULLIF(v_orig_barcode, ''), CASE WHEN NULLIF(v_orig_barcode, '') IS NULL THEN NULL ELSE v_orig_source END,
            v_occurred_at, v_actor_id, v_occurred_at, v_actor_id
        )
        RETURNING id INTO v_alias_id;
    ELSE
        UPDATE inventarios.product_barcode_aliases
        SET reviewed_at = v_occurred_at, reviewed_by = v_actor_id
        WHERE id = v_existing_alias;
        v_alias_id := v_existing_alias;
    END IF;

    -- Resolver todas las proposals PENDING_REVIEW compatibles barcode+producto
    UPDATE inventarios.product_barcode_proposals pbp
    SET status = 'APPROVED',
        reviewed_at = v_occurred_at,
        reviewed_by = v_actor_id,
        review_notes = 'Autorizado en revisión de incidencias de códigos.',
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    FROM inventarios.count_entries ce
    JOIN inventarios.sessions s ON s.company_id = ce.company_id AND s.id = ce.session_id
    WHERE pbp.company_id = p_company_id
      AND pbp.count_entry_id = ce.id
      AND ce.bsale_variant_id = p_bsale_variant_id
      AND s.campaign_id = p_campaign_id
      AND pbp.status = 'PENDING_REVIEW'
      AND pbp.scanned_code = v_barcode;
    GET DIAGNOSTICS v_proposals_updated = ROW_COUNT;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.barcode.approve','entity_id',coalesce(v_alias_id, v_existing_alias),
        'state','APPROVED','version',NULL::integer,'cycle_number',NULL::integer,
        'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object(
            'barcode',v_barcode,
            'bsale_variant_id',p_bsale_variant_id,
            'alias_id',v_alias_id,
            'original_barcode_at_review',v_orig_barcode,
            'original_barcode_source',v_orig_source,
            'association_created',(v_existing_alias IS NULL),
            'association_already_existed',(v_existing_alias IS NOT NULL),
            'proposals_resolved',v_proposals_updated
        )
    );
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, coalesce(v_alias_id, v_existing_alias), v_response);
END;
$function$;;
GRANT EXECUTE ON FUNCTION inventarios.approve_inventory_barcode(uuid, uuid, text, integer, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION inventarios.reject_inventory_barcode(
    p_company_id uuid,
    p_campaign_id uuid,
    p_scanned_code text,
    p_bsale_variant_id integer,
    p_reason_code text,
    p_idempotency_key uuid,
    p_review_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_role_name text;
    v_is_super boolean := false;
    v_is_campaign_admin boolean := false;
    v_barcode text;
    v_reason_code text;
    v_notes text;
    v_operation jsonb;
    v_operation_id uuid;
    v_payload jsonb;
    v_occurred_at timestamptz := pg_catalog.now();
    v_campaign_status text;
    v_proposals_updated bigint := 0;
    v_response jsonb;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_scanned_code IS NULL
       OR p_bsale_variant_id IS NULL OR p_reason_code IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_barcode := pg_catalog.btrim(p_scanned_code);
    v_reason_code := pg_catalog.upper(pg_catalog.btrim(p_reason_code));
    IF v_barcode = '' OR v_reason_code NOT IN ('CODE_NOT_MATCH_PRODUCT','PHOTO_INVALID','LABEL_OTHER_PRODUCT','INTERNAL_NOT_REUSABLE','OTHER') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','El código o el motivo no son válidos.','retryable',false)::text;
    END IF;
    v_notes := pg_catalog.btrim(coalesce(p_review_notes, ''));
    IF v_reason_code = 'OTHER' AND v_notes = '' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','El motivo Otro requiere una nota explicativa.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_company_access(p_company_id);

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.barcode_decision'),
        pg_catalog.hashtext(p_company_id::text || ':' || v_barcode));

    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.barcode.reject','company_id',p_company_id,
        'campaign_id',p_campaign_id,'scanned_code',v_barcode,'bsale_variant_id',p_bsale_variant_id,
        'reason_code',v_reason_code,'notes',v_notes);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.barcode.reject',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

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
    IF NOT (v_is_super OR v_is_campaign_admin) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PERMISSION_REQUIRED',
            DETAIL=pg_catalog.jsonb_build_object('message','No tienes permisos para rechazar códigos.','retryable',false)::text;
    END IF;
    -- Guard de congelamiento: campaña APPROVED/CANCELLED no admite decidir códigos.
    SELECT ic.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id;
    IF v_campaign_status = 'APPROVED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_ALREADY_APPROVED',
            DETAIL=pg_catalog.jsonb_build_object('message','El Inventario ya fue cerrado y no admite la revisión de códigos.','retryable',false,'status',v_campaign_status)::text;
    END IF;
    IF v_campaign_status = 'CANCELLED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_CANCELLED',
            DETAIL=pg_catalog.jsonb_build_object('message','El Inventario está cancelado y no admite la revisión de códigos.','retryable',false,'status',v_campaign_status)::text;
    END IF;

    -- Marcar proposals compatibles a REJECTED (no crea alias, no invalida count)
    UPDATE inventarios.product_barcode_proposals pbp
    SET status = 'REJECTED',
        reviewed_at = v_occurred_at,
        reviewed_by = v_actor_id,
        review_reason_code = v_reason_code,
        review_notes = CASE WHEN v_notes = '' THEN NULL ELSE v_notes END,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    FROM inventarios.count_entries ce
    JOIN inventarios.sessions s ON s.company_id = ce.company_id AND s.id = ce.session_id
    WHERE pbp.company_id = p_company_id
      AND pbp.count_entry_id = ce.id
      AND ce.bsale_variant_id = p_bsale_variant_id
      AND s.campaign_id = p_campaign_id
      AND pbp.status = 'PENDING_REVIEW'
      AND pbp.scanned_code = v_barcode;
    GET DIAGNOSTICS v_proposals_updated = ROW_COUNT;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.barcode.reject','entity_id',NULL::uuid,
        'state','REJECTED','version',NULL::integer,'cycle_number',NULL::integer,
        'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object(
            'barcode',v_barcode,
            'bsale_variant_id',p_bsale_variant_id,
            'reason_code',v_reason_code,
            'proposals_resolved',v_proposals_updated,
            'alias_created',false,
            'count_entries_preserved',true
        )
    );
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, NULL::uuid, v_response);
END;
$function$;;
GRANT EXECUTE ON FUNCTION inventarios.reject_inventory_barcode(uuid, uuid, text, integer, text, uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION inventarios.admin_invalidate_barcode_incident_count(
    p_company_id uuid,
    p_campaign_id uuid,
    p_proposal_id uuid,
    p_reason_code text,
    p_reason text,
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_reason_code text;
    v_reason text;
    v_operation jsonb;
    v_operation_id uuid;
    v_payload jsonb;
    v_now timestamptz := pg_catalog.now();
    v_proposal record;
    v_current_count_entry_id uuid;
    v_active_correction_id uuid;
    v_response jsonb;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_proposal_id IS NULL
       OR p_reason_code IS NULL OR p_reason IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_reason_code := pg_catalog.upper(pg_catalog.btrim(p_reason_code));
    v_reason := pg_catalog.btrim(p_reason);
    IF v_reason_code NOT IN ('DUPLICATE_COUNT','ENTRY_ERROR','NOT_PART_OF_INVENTORY','INVALID_EVIDENCE','OTHER')
       OR length(v_reason) < 5 OR length(v_reason) > 500 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','El motivo no es válido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios._require_barcode_physical_admin(p_company_id, p_campaign_id);

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('inventarios.barcode.invalidate_count'), pg_catalog.hashtext(p_company_id::text || ':' || p_proposal_id::text));

    v_payload := pg_catalog.jsonb_build_object('operation','inventarios.barcode.invalidate_count','company_id',p_company_id,'campaign_id',p_campaign_id,'proposal_id',p_proposal_id,'reason_code',v_reason_code,'reason',v_reason);
    v_operation := inventarios.begin_idempotent_operation(p_company_id,'inventarios.barcode.invalidate_count',p_idempotency_key,inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT pbp.*, ce.id AS root_count_entry_id, ce.physical_quantity, ce.bsale_variant_id,
           s.status AS session_status, s.campaign_id, c.status AS campaign_status
    INTO v_proposal
    FROM inventarios.product_barcode_proposals pbp
    JOIN inventarios.count_entries ce ON ce.company_id = pbp.company_id AND ce.id = pbp.count_entry_id
    JOIN inventarios.sessions s ON s.company_id = ce.company_id AND s.id = ce.session_id
    JOIN inventarios.inventory_campaigns c ON c.company_id = s.company_id AND c.id = s.campaign_id
    WHERE pbp.company_id = p_company_id AND pbp.id = p_proposal_id
    FOR UPDATE OF pbp, ce, s, c;
    IF NOT FOUND OR v_proposal.campaign_id IS DISTINCT FROM p_campaign_id THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;
    IF v_proposal.campaign_status = 'APPROVED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_ALREADY_APPROVED',
            DETAIL=pg_catalog.jsonb_build_object('message','El Inventario ya fue cerrado y su resultado físico es definitivo.','retryable',false)::text;
    END IF;
    IF v_proposal.campaign_status = 'CANCELLED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_CANCELLED',
            DETAIL=pg_catalog.jsonb_build_object('message','El Inventario está cancelado y no admite correcciones físicas.','retryable',false,'status',v_proposal.campaign_status)::text;
    END IF;
    IF v_proposal.session_status = 'APPROVED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_ALREADY_APPROVED',
            DETAIL=pg_catalog.jsonb_build_object('message','La sesión ya fue aprobada; V1 bloquea correcciones físicas hasta tener reapertura/versionado administrativo.','retryable',false)::text;
    END IF;
    IF v_proposal.status <> 'PENDING_REVIEW' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La incidencia ya fue resuelta.','retryable',false)::text;
    END IF;

    SELECT cec.id, cec.replacement_count_entry_id
    INTO v_active_correction_id, v_current_count_entry_id
    FROM inventarios.count_entry_corrections cec
    WHERE cec.company_id = p_company_id
      AND cec.root_count_entry_id = v_proposal.root_count_entry_id
      AND cec.superseded_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
        v_current_count_entry_id := v_proposal.root_count_entry_id;
    END IF;

    UPDATE inventarios.count_entries
    SET invalidated_at = v_now,
        invalidated_by = v_actor_id,
        invalidation_reason = v_reason_code || ': ' || v_reason
    WHERE company_id = p_company_id
      AND id = v_current_count_entry_id
      AND invalidated_at IS NULL
      AND invalidated_by IS NULL
      AND invalidation_reason IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_COUNT_ALREADY_INVALIDATED',
            DETAIL=pg_catalog.jsonb_build_object('message','La captura ya fue invalidada.','retryable',false)::text;
    END IF;

    UPDATE inventarios.product_barcode_proposals
    SET status = 'CANCELLED',
        reviewed_at = v_now,
        reviewed_by = v_actor_id,
        review_reason_code = 'ADMIN_COUNT_REMOVED',
        review_notes = v_reason_code || ': ' || v_reason,
        updated_at = v_now,
        updated_by = v_actor_id
    WHERE company_id = p_company_id AND id = p_proposal_id;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.barcode.invalidate_count',
        'entity_id',v_current_count_entry_id,
        'state','CANCELLED',
        'version',NULL::integer,
        'cycle_number',NULL::integer,
        'assignment_id',NULL::uuid,
        'event_id',NULL::uuid,
        'replayed',false,
        'occurred_at',v_now,
        'data',pg_catalog.jsonb_build_object(
            'proposal_id',p_proposal_id,
            'root_count_entry_id',v_proposal.root_count_entry_id,
            'count_entry_id',v_current_count_entry_id,
            'active_correction_id',v_active_correction_id,
            'removed_quantity',v_proposal.physical_quantity,
            'reason_code',v_reason_code,
            'reason',v_reason,
            'proposal_status','CANCELLED',
            'count_invalidated',true
        )
    );
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, v_current_count_entry_id, v_response);
END;
$function$;;
GRANT EXECUTE ON FUNCTION inventarios.admin_invalidate_barcode_incident_count(uuid, uuid, uuid, text, text, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION inventarios.admin_correct_barcode_incident_product(
    p_company_id uuid,
    p_campaign_id uuid,
    p_proposal_id uuid,
    p_target_bsale_variant_id integer,
    p_reason text,
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_reason text;
    v_operation jsonb;
    v_operation_id uuid;
    v_payload jsonb;
    v_now timestamptz := pg_catalog.now();
    v_proposal record;
    v_current record;
    v_target_snapshot_product_id uuid;
    v_target_product_id uuid;
    v_target_sku text;
    v_target_barcode text;
    v_target_name text;
    v_previous_correction_id uuid;
    v_previous_revision integer;
    v_current_count_entry_id uuid;
    v_root_id uuid;
    v_parent_root_id uuid;
    v_root_snapshot_product_id uuid;
    v_revision integer;
    v_replacement_id uuid;
    v_correction_id uuid;
    v_new_proposal_id uuid;
    v_alias_same uuid;
    v_barcode_belongs_target boolean := false;
    v_conflict jsonb;
    v_response jsonb;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_proposal_id IS NULL
       OR p_target_bsale_variant_id IS NULL OR p_reason IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_reason := pg_catalog.btrim(p_reason);
    IF length(v_reason) < 5 OR length(v_reason) > 500 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios._require_barcode_physical_admin(p_company_id, p_campaign_id);

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('inventarios.barcode.correct_product'), pg_catalog.hashtext(p_company_id::text || ':' || p_proposal_id::text));

    v_payload := pg_catalog.jsonb_build_object('operation','inventarios.barcode.correct_product','company_id',p_company_id,'campaign_id',p_campaign_id,'proposal_id',p_proposal_id,'target_bsale_variant_id',p_target_bsale_variant_id,'reason',v_reason);
    v_operation := inventarios.begin_idempotent_operation(p_company_id,'inventarios.barcode.correct_product',p_idempotency_key,inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT pbp.*, ce.id AS root_count_entry_id, ce.bsale_variant_id AS original_bsale_variant_id,
           ce.session_id AS root_session_id, ce.snapshot_id AS root_snapshot_id, ce.session_zone_id AS root_zone_id,
           ce.task_id AS root_task_id, ce.task_cycle AS root_task_cycle, ce.snapshot_location_id AS root_location_id,
           ce.snapshot_product_id AS root_snapshot_product_id, ce.session_participant_id AS original_participant_id,
           ce.counted_by AS original_counted_by, ce.capture_source, ce.device_id, ce.physical_quantity,
           ce.available_quantity, ce.damaged_quantity, ce.expired_quantity, ce.blocked_quantity,
           ce.other_unavailable_quantity, ce.identification_method, ce.scanned_code, ce.recount_request_id,
           s.status AS session_status, s.campaign_id, c.status AS campaign_status
    INTO v_proposal
    FROM inventarios.product_barcode_proposals pbp
    JOIN inventarios.count_entries ce ON ce.company_id = pbp.company_id AND ce.id = pbp.count_entry_id
    JOIN inventarios.sessions s ON s.company_id = ce.company_id AND s.id = ce.session_id
    JOIN inventarios.inventory_campaigns c ON c.company_id = s.company_id AND c.id = s.campaign_id
    WHERE pbp.company_id = p_company_id AND pbp.id = p_proposal_id
    FOR UPDATE OF pbp, ce, s, c;
    IF NOT FOUND OR v_proposal.campaign_id IS DISTINCT FROM p_campaign_id THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;
    IF v_proposal.original_bsale_variant_id IS NOT DISTINCT FROM p_target_bsale_variant_id THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','El producto correcto debe ser distinto al producto registrado.','retryable',false)::text;
    END IF;
    IF v_proposal.campaign_status = 'APPROVED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_ALREADY_APPROVED',
            DETAIL=pg_catalog.jsonb_build_object('message','El Inventario ya fue cerrado y su resultado físico es definitivo.','retryable',false)::text;
    END IF;
    IF v_proposal.campaign_status = 'CANCELLED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_CANCELLED',
            DETAIL=pg_catalog.jsonb_build_object('message','El Inventario está cancelado y no admite correcciones físicas.','retryable',false,'status',v_proposal.campaign_status)::text;
    END IF;
    IF v_proposal.session_status = 'APPROVED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_ALREADY_APPROVED',
            DETAIL=pg_catalog.jsonb_build_object('message','La sesión ya fue aprobada; V1 bloquea correcciones físicas hasta tener reapertura/versionado administrativo.','retryable',false)::text;
    END IF;
    IF v_proposal.status <> 'PENDING_REVIEW' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La incidencia ya fue resuelta.','retryable',false)::text;
    END IF;

    SELECT cec.id, cec.revision_number
    INTO v_previous_correction_id, v_previous_revision
    FROM inventarios.count_entry_corrections cec
    WHERE cec.company_id = p_company_id
      AND cec.root_count_entry_id = v_proposal.root_count_entry_id
      AND cec.superseded_at IS NULL
    FOR UPDATE;

    v_root_id := v_proposal.root_count_entry_id;
    LOOP
        SELECT cec.root_count_entry_id
        INTO v_parent_root_id
        FROM inventarios.count_entry_corrections cec
        WHERE cec.company_id = p_company_id
          AND cec.replacement_count_entry_id = v_root_id
        ORDER BY cec.corrected_at DESC
        LIMIT 1;
        IF v_parent_root_id IS NULL THEN EXIT; END IF;
        v_root_id := v_parent_root_id;
    END LOOP;

    IF v_root_id IS DISTINCT FROM v_proposal.root_count_entry_id THEN
        SELECT cec.id, cec.revision_number, cec.replacement_count_entry_id
        INTO v_previous_correction_id, v_previous_revision, v_current_count_entry_id
        FROM inventarios.count_entry_corrections cec
        WHERE cec.company_id = p_company_id
          AND cec.root_count_entry_id = v_root_id
          AND cec.superseded_at IS NULL
        ORDER BY cec.corrected_at DESC
        LIMIT 1;
    END IF;

    v_revision := coalesce(v_previous_revision, 0) + 1;

    SELECT sp.snapshot_product_id INTO v_root_snapshot_product_id
    FROM (
        SELECT ce.snapshot_product_id
        FROM inventarios.count_entries ce
        WHERE ce.company_id = p_company_id AND ce.id = v_root_id
        LIMIT 1
    ) sp;

    IF v_previous_correction_id IS NOT NULL THEN
        SELECT cec.replacement_count_entry_id
        INTO v_current_count_entry_id
        FROM inventarios.count_entry_corrections cec
        WHERE cec.company_id = p_company_id AND cec.id = v_previous_correction_id;
    ELSE
        v_current_count_entry_id := v_root_id;
    END IF;

    SELECT ce.*
    INTO v_current
    FROM inventarios.count_entries ce
    WHERE ce.company_id = p_company_id
      AND ce.id = v_current_count_entry_id
    FOR UPDATE;

    IF v_current.invalidated_at IS NOT NULL OR v_current.invalidated_by IS NOT NULL OR v_current.invalidation_reason IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_COUNT_ALREADY_INVALIDATED',
            DETAIL=pg_catalog.jsonb_build_object('message','La captura ya fue invalidada.','retryable',false)::text;
    END IF;

    SELECT sp.id, sp.product_id, sp.sku, sp.barcode, sp.name
    INTO v_target_snapshot_product_id, v_target_product_id, v_target_sku, v_target_barcode, v_target_name
    FROM inventarios.snapshot_products sp
    WHERE sp.company_id = p_company_id
      AND sp.snapshot_id = v_current.snapshot_id
      AND sp.bsale_variant_id = p_target_bsale_variant_id
    LIMIT 1;

    IF v_target_snapshot_product_id IS NULL THEN
        SELECT ap.id, ap.sku, ap.barcode, ap.description
        INTO v_target_product_id, v_target_sku, v_target_barcode, v_target_name
        FROM adquisiciones.products ap
        WHERE ap.company_id = p_company_id AND ap.bsale_variant_id = p_target_bsale_variant_id
        LIMIT 1;

        IF v_target_sku IS NULL THEN
            SELECT NULL::uuid, bv.code, bv.bar_code, coalesce(NULLIF(pg_catalog.btrim(bp.name), ''), bv.description)
            INTO v_target_product_id, v_target_sku, v_target_barcode, v_target_name
            FROM integraciones.bsale_variants bv
            LEFT JOIN integraciones.bsale_products bp
              ON bp.company_id = bv.company_id AND bp.bsale_id = bv.bsale_product_id
            WHERE bv.company_id = p_company_id AND bv.bsale_id = p_target_bsale_variant_id
            LIMIT 1;
        END IF;

        IF v_target_sku IS NULL OR v_target_name IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
                DETAIL=pg_catalog.jsonb_build_object('message','No se encontró el producto correcto en la maestra.','retryable',false)::text;
        END IF;

        INSERT INTO inventarios.snapshot_products (
            company_id, snapshot_id, product_id, bsale_variant_id, sku, barcode, name,
            product_metadata, created_at, created_by
        )
        VALUES (
            p_company_id, v_current.snapshot_id, v_target_product_id, p_target_bsale_variant_id,
            v_target_sku, v_target_barcode, v_target_name,
            pg_catalog.jsonb_build_object('source','ADMIN_BARCODE_INCIDENT_CORRECTION','campaign_id',p_campaign_id),
            v_now, v_actor_id
        )
        ON CONFLICT (company_id, snapshot_id, bsale_variant_id) DO UPDATE
        SET product_metadata = coalesce(inventarios.snapshot_products.product_metadata, '{}'::jsonb)
            || pg_catalog.jsonb_build_object('admin_correction_seen_at', v_now)
        RETURNING id INTO v_target_snapshot_product_id;
    END IF;

    INSERT INTO inventarios.count_entries (
        company_id, session_id, snapshot_id, session_zone_id, task_id, task_cycle,
        session_participant_id, counted_by, snapshot_product_id, snapshot_location_id,
        bsale_variant_id, identification_method, scanned_code, capture_source,
        offline_id, device_id, captured_at, server_received_at, synced_at, synced_by,
        physical_quantity, available_quantity, damaged_quantity, expired_quantity,
        blocked_quantity, other_unavailable_quantity, recount_request_id, created_by
    )
    VALUES (
        p_company_id, v_current.session_id, v_current.snapshot_id, v_current.session_zone_id,
        v_current.task_id, v_current.task_cycle, v_current.session_participant_id,
        v_current.counted_by, v_target_snapshot_product_id, v_current.snapshot_location_id,
        p_target_bsale_variant_id, v_current.identification_method, v_current.scanned_code,
        'WEB', NULL, NULL, v_current.captured_at, v_now, v_now, v_actor_id,
        v_current.physical_quantity, v_current.available_quantity, v_current.damaged_quantity,
        v_current.expired_quantity, v_current.blocked_quantity, v_current.other_unavailable_quantity,
        v_current.recount_request_id, v_actor_id
    )
    RETURNING id INTO v_replacement_id;

    IF v_previous_correction_id IS NOT NULL THEN
        UPDATE inventarios.count_entry_corrections
        SET superseded_at = v_now
        WHERE company_id = p_company_id AND id = v_previous_correction_id AND superseded_at IS NULL;
    END IF;

    INSERT INTO inventarios.count_entry_corrections (
        company_id, session_id, task_id, snapshot_product_id, previous_snapshot_product_id, replacement_snapshot_product_id,
        root_count_entry_id, previous_count_entry_id, replacement_count_entry_id,
        supersedes_correction_id, revision_number, reason, corrected_by, corrected_at
    )
    VALUES (
        p_company_id, v_current.session_id, v_current.task_id, v_root_snapshot_product_id,
        v_current.snapshot_product_id, v_target_snapshot_product_id, v_root_id, v_current.id,
        v_replacement_id, v_previous_correction_id, v_revision,
        'WRONG_PRODUCT_SELECTED: ' || v_reason, v_actor_id, v_now
    )
    RETURNING id INTO v_correction_id;

    UPDATE inventarios.product_barcode_proposals
    SET status = 'REJECTED',
        reviewed_at = v_now,
        reviewed_by = v_actor_id,
        review_reason_code = 'WRONG_PRODUCT_SELECTED',
        review_notes = 'Producto corregido. ' || v_reason,
        updated_at = v_now,
        updated_by = v_actor_id
    WHERE company_id = p_company_id AND id = p_proposal_id;

    SELECT pba.id INTO v_alias_same
    FROM inventarios.product_barcode_aliases pba
    WHERE pba.company_id = p_company_id
      AND pba.barcode = v_proposal.scanned_code
      AND pba.bsale_variant_id = p_target_bsale_variant_id
      AND pba.is_active = true
    LIMIT 1;

    SELECT EXISTS (
        SELECT 1 FROM integraciones.bsale_variants bv
        WHERE bv.company_id = p_company_id AND bv.bsale_id = p_target_bsale_variant_id
          AND bv.bar_code = v_proposal.scanned_code
    ) OR EXISTS (
        SELECT 1 FROM inventarios.snapshot_products sp
        WHERE sp.company_id = p_company_id
          AND sp.bsale_variant_id = p_target_bsale_variant_id
          AND sp.barcode = v_proposal.scanned_code
    ) OR EXISTS (
        SELECT 1 FROM inventarios.inventory_campaign_snapshot_products csp
        WHERE csp.company_id = p_company_id
          AND csp.bsale_variant_id = p_target_bsale_variant_id
          AND csp.barcode = v_proposal.scanned_code
    ) INTO v_barcode_belongs_target;

    v_conflict := inventarios._barcode_official_other_product(p_company_id, v_proposal.scanned_code, p_target_bsale_variant_id);

    IF v_alias_same IS NULL AND v_barcode_belongs_target IS NOT TRUE THEN
        INSERT INTO inventarios.product_barcode_proposals (
            company_id, session_id, count_entry_id, scanned_code, status,
            proposed_by, proposed_at, review_notes, created_at, created_by, updated_at, updated_by
        )
        VALUES (
            p_company_id, v_current.session_id, v_replacement_id, v_proposal.scanned_code,
            'PENDING_REVIEW', v_actor_id, v_now,
            CASE WHEN (v_conflict ->> 'found')::boolean
                THEN 'Producto corregido; código con conflicto administrativo pendiente.'
                ELSE 'Producto corregido; código pendiente de revisión para el producto correcto.'
            END,
            v_now, v_actor_id, v_now, v_actor_id
        )
        ON CONFLICT (company_id, count_entry_id) DO NOTHING
        RETURNING id INTO v_new_proposal_id;
    END IF;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.barcode.correct_product',
        'entity_id',v_replacement_id,
        'state','CORRECTED',
        'version',NULL::integer,
        'cycle_number',NULL::integer,
        'assignment_id',NULL::uuid,
        'event_id',NULL::uuid,
        'replayed',false,
        'occurred_at',v_now,
        'data',pg_catalog.jsonb_build_object(
            'proposal_id',p_proposal_id,
            'original_bsale_variant_id',v_proposal.original_bsale_variant_id,
            'target_bsale_variant_id',p_target_bsale_variant_id,
            'root_count_entry_id',v_root_id,
            'previous_count_entry_id',v_current.id,
            'replacement_count_entry_id',v_replacement_id,
            'correction_id',v_correction_id,
            'physical_quantity',v_current.physical_quantity,
            'original_proposal_status','REJECTED',
            'original_reason_code','WRONG_PRODUCT_SELECTED',
            'target_alias_already_approved',(v_alias_same IS NOT NULL),
            'target_own_barcode',v_barcode_belongs_target,
            'target_proposal_id',v_new_proposal_id,
            'barcode_conflict',v_conflict
        )
    );
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, v_replacement_id, v_response);
END;
$function$;;
GRANT EXECUTE ON FUNCTION inventarios.admin_correct_barcode_incident_product(uuid, uuid, uuid, integer, text, uuid) TO authenticated, service_role;

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
    v_campaign_status text;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_bsale_variant_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');
    v_can_review := inventarios._can_review_barcodes(p_company_id, p_campaign_id);
    SELECT ic.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id;

    v_ident := inventarios.barcode_product_identity(p_company_id, p_bsale_variant_id);
    v_product := pg_catalog.jsonb_build_object(
        'bsale_variant_id', p_bsale_variant_id,
        'product_id', v_ident ->> 'product_id',
        'sku', v_ident ->> 'sku',
        'product_name', v_ident ->> 'product_name',
        'bsale_barcode', v_ident ->> 'bsale_barcode'
    );

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

    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'proposal_id', pbp.id,
                'count_entry_id', ce.id,
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
                'evidence_id', inventarios._barcode_incident_evidence_id(pbp.company_id, pbp.id, pbp.count_entry_id),
                'evidence_available', inventarios._barcode_incident_evidence_id(pbp.company_id, pbp.id, pbp.count_entry_id) IS NOT NULL
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
        'campaign_status', v_campaign_status,
        'can_review_barcodes_authorized', v_can_review,
        'product', v_product,
        'barcodes', CASE WHEN v_barcodes IS NULL THEN '[]'::jsonb ELSE v_barcodes END,
        'occurrences', CASE WHEN v_occurrences IS NULL THEN '[]'::jsonb ELSE v_occurrences END
    );
END;
$function$;;
GRANT EXECUTE ON FUNCTION inventarios.get_inventory_barcode_incident_detail(uuid, uuid, integer) TO authenticated, service_role;

COMMIT;
