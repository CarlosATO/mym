-- =========================================================================================
-- MIGRATION: M1.5F fix - Recrea create_inventory_audit con coalesce sin esquema
-- (coalesce es un constructo del parser, no una funcion pg_catalog; la version
-- inicial fallaba en runtime con 'function pg_catalog.coalesce(integer, integer)
-- does not exist').
-- Esquema afectado EXCLUSIVAMENTE: inventarios.
-- =========================================================================================

BEGIN;

CREATE OR REPLACE FUNCTION inventarios.create_inventory_audit(
    p_company_id uuid,
    p_campaign_id uuid,
    p_assigned_participant_id uuid,
    p_bsale_variant_ids bigint[],
    p_idempotency_key uuid
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
    v_participant_ok boolean;
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
    v_has_locations boolean;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL
       OR p_assigned_participant_id IS NULL OR p_idempotency_key IS NULL
       OR p_bsale_variant_ids IS NULL OR pg_catalog.array_length(p_bsale_variant_ids, 1) = 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.manage');

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('inventarios.create_inventory_audit.idempotency'), pg_catalog.hashtext(p_company_id::text || ':' || p_idempotency_key::text));
    v_payload := pg_catalog.jsonb_build_object('operation','inventarios.audit.create','company_id',p_company_id,'campaign_id',p_campaign_id,'assigned_participant_id',p_assigned_participant_id,'bsale_variant_ids',p_bsale_variant_ids);
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

        -- 3) Sin ubicacion previa fiable: estado contractual seguro, sin fabricar datos.
        IF v_location_count = 0 THEN
            UPDATE inventarios.inventory_audit_products
            SET scope_status = 'NO_PREVIOUS_LOCATION'
            WHERE id = v_audit_product_id;
            v_scope_status := 'NO_PREVIOUS_LOCATION';
        ELSE
            v_scope_status := 'LOCATIONS_RESOLVED';
        END IF;

        v_product_meta := pg_catalog.jsonb_build_object(
            'bsale_variant_id', v_variant,
            'variance_status', v_var,
            'difference_quantity', v_diff,
            'scope_status', v_scope_status,
            'location_count', v_location_count
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
ALTER FUNCTION inventarios.create_inventory_audit(uuid, uuid, uuid, bigint[], uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.create_inventory_audit(uuid, uuid, uuid, bigint[], uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.create_inventory_audit(uuid, uuid, uuid, bigint[], uuid) TO authenticated, service_role;

COMMIT;
