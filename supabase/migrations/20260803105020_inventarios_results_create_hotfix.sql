-- Migration: 20260803105020_inventarios_results_create_hotfix.sql
-- Description: Corrige sp2.barcode (no bar_code) en get_inventory_session_results
--              y elimina bo.is_active inexistente en create_inventory_session.
-- Author: Assistant

-- ===== get_inventory_session_results =====
CREATE OR REPLACE FUNCTION inventarios.get_inventory_session_results(
    p_company_id uuid,
    p_session_id uuid,
    p_search text,
    p_difference_type text,
    p_page integer,
    p_page_size integer
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_search text;
    v_diff_type text;
    v_page integer; v_page_size integer; v_offset integer;
    v_session jsonb;
    v_version jsonb;
    v_total bigint;
    v_items jsonb;
    v_missing bigint;
    v_surplus bigint;
    v_no_diff bigint;
    v_product_count bigint;
    v_abs_diff numeric;
    v_office_id integer;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');
    v_search := pg_catalog.btrim(coalesce(p_search, ''));
    v_diff_type := pg_catalog.upper(pg_catalog.btrim(coalesce(p_difference_type, '')));
    v_page := coalesce(p_page, 1);
    v_page_size := coalesce(p_page_size, 50);
    IF v_page < 1 THEN v_page := 1; END IF;
    IF v_page_size < 1 THEN v_page_size := 50; END IF;
    IF v_page_size > 100 THEN v_page_size := 100; END IF;
    v_offset := (v_page - 1) * v_page_size;

    SELECT s.bsale_office_id INTO v_office_id
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.id = p_session_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;

    SELECT pg_catalog.jsonb_build_object(
        'id', s.id, 'session_number', s.session_number, 'name', s.name,
        'inventory_type', s.inventory_type, 'status', s.status,
        'scope_mode', s.scope_mode, 'warehouse_name', w.name,
        'responsible_user_id', s.responsible_user_id,
        'responsible_name', inventarios.user_display_name(s.responsible_user_id),
        'approved_at', s.approved_at, 'approved_by_name', inventarios.user_display_name(s.approved_by),
        'exported_at', s.exported_at, 'reconciled_at', s.reconciled_at,
        'cancelled_at', s.cancelled_at, 'cancelled_by_name', inventarios.user_display_name(s.cancelled_by),
        'cancellation_reason', s.cancellation_reason,
        'created_at', s.created_at
    )
    INTO v_session
    FROM inventarios.sessions s
    LEFT JOIN adquisiciones.warehouses w ON w.id = s.warehouse_id
    WHERE s.company_id = p_company_id AND s.id = p_session_id;

    SELECT pg_catalog.jsonb_build_object(
        'version_number', ov.version_number,
        'task_count', ov.task_count,
        'contribution_count', ov.contribution_count,
        'normal_contribution_count', ov.normal_contribution_count,
        'recount_contribution_count', ov.recount_contribution_count,
        'item_count', ov.item_count,
        'approved_at', ov.approved_at,
        'approved_by_name', inventarios.user_display_name(ov.approved_by)
    )
    INTO v_version
    FROM inventarios.official_versions ov
    WHERE ov.company_id = p_company_id AND ov.session_id = p_session_id
    ORDER BY (ov.superseded_at IS NULL) DESC, ov.version_number DESC
    LIMIT 1;

    -- Resumen de diferencias
    SELECT
        pg_catalog.count(*),
        pg_catalog.count(*) FILTER (WHERE (coalesce(ss.theoretical_quantity, 0) - ovi.physical_quantity) = 0),
        pg_catalog.count(*) FILTER (WHERE (coalesce(ss.theoretical_quantity, 0) - ovi.physical_quantity) > 0),
        pg_catalog.count(*) FILTER (WHERE (coalesce(ss.theoretical_quantity, 0) - ovi.physical_quantity) < 0),
        pg_catalog.sum(pg_catalog.abs(coalesce(ss.theoretical_quantity, 0) - ovi.physical_quantity))
    INTO v_product_count, v_no_diff, v_missing, v_surplus, v_abs_diff
    FROM inventarios.official_version_items ovi
    JOIN inventarios.snapshot_products sp ON sp.company_id = ovi.company_id
      AND sp.snapshot_id = ovi.snapshot_id AND sp.id = ovi.snapshot_product_id
    LEFT JOIN inventarios.snapshot_stocks ss ON ss.company_id = ovi.company_id
      AND ss.snapshot_id = ovi.snapshot_id AND ss.snapshot_product_id = ovi.snapshot_product_id
      AND ss.office_id = v_office_id
    WHERE ovi.company_id = p_company_id AND ovi.session_id = p_session_id
      AND ovi.official_version_id = (SELECT ov.id FROM inventarios.official_versions ov
          WHERE ov.company_id = p_company_id AND ov.session_id = p_session_id
          ORDER BY (ov.superseded_at IS NULL) DESC, ov.version_number DESC LIMIT 1);

    SELECT pg_catalog.count(*) INTO v_total
    FROM inventarios.official_version_items ovi
    JOIN inventarios.snapshot_products sp ON sp.company_id = ovi.company_id
      AND sp.snapshot_id = ovi.snapshot_id AND sp.id = ovi.snapshot_product_id
    LEFT JOIN inventarios.snapshot_stocks ss ON ss.company_id = ovi.company_id
      AND ss.snapshot_id = ovi.snapshot_id AND ss.snapshot_product_id = ovi.snapshot_product_id
      AND ss.office_id = v_office_id
    WHERE ovi.company_id = p_company_id AND ovi.session_id = p_session_id
      AND ovi.official_version_id = (SELECT ov.id FROM inventarios.official_versions ov
          WHERE ov.company_id = p_company_id AND ov.session_id = p_session_id
          ORDER BY (ov.superseded_at IS NULL) DESC, ov.version_number DESC LIMIT 1)
      AND (v_search = '' OR sp.sku ILIKE '%' || v_search || '%' OR sp.name ILIKE '%' || v_search || '%')
      AND (v_diff_type = '' OR
           (v_diff_type = 'FALTANTE' AND ovi.physical_quantity - coalesce(ss.theoretical_quantity,0) < 0)
           OR (v_diff_type = 'SOBRANTE' AND ovi.physical_quantity - coalesce(ss.theoretical_quantity,0) > 0)
           OR (v_diff_type = 'SIN_DIFERENCIA' AND ovi.physical_quantity - coalesce(ss.theoretical_quantity,0) = 0));

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'sku', x.sku,
                'product', x.name,
                'barcode', x.barcode,
                'theoretical', coalesce(x.theoretical, 0),
                'physical', x.physical_quantity,
                 'difference', x.physical_quantity - coalesce(x.theoretical,0),
                'difference_type', CASE
                     WHEN x.physical_quantity - coalesce(x.theoretical,0) < 0 THEN 'FALTANTE'
                     WHEN x.physical_quantity - coalesce(x.theoretical,0) > 0 THEN 'SOBRANTE'
                    ELSE 'SIN_DIFERENCIA'
                END,
                'provenance', CASE WHEN x.recount_contribution_count > 0 THEN 'RECUENTO' ELSE 'NORMAL' END
            )
            ORDER BY x.sku
        )
    END
    INTO v_items
    FROM (
        SELECT ovi.snapshot_product_id, ovi.physical_quantity, ovi.recount_contribution_count,
               ovi.snapshot_id, sp2.sku, sp2.name, sp2.barcode,
               (SELECT ss2.theoretical_quantity FROM inventarios.snapshot_stocks ss2
                WHERE ss2.company_id = ovi.company_id AND ss2.snapshot_id = ovi.snapshot_id
                  AND ss2.snapshot_product_id = ovi.snapshot_product_id AND ss2.office_id = v_office_id) AS theoretical
        FROM inventarios.official_version_items ovi
        JOIN inventarios.snapshot_products sp2
          ON sp2.company_id = ovi.company_id AND sp2.snapshot_id = ovi.snapshot_id
          AND sp2.id = ovi.snapshot_product_id
        WHERE ovi.company_id = p_company_id AND ovi.session_id = p_session_id
          AND ovi.official_version_id = (SELECT ov.id FROM inventarios.official_versions ov
              WHERE ov.company_id = p_company_id AND ov.session_id = p_session_id
              ORDER BY (ov.superseded_at IS NULL) DESC, ov.version_number DESC LIMIT 1)
    ) x
    WHERE (v_search = '' OR x.sku ILIKE '%' || v_search || '%' OR x.name ILIKE '%' || v_search || '%')
      AND (v_diff_type = '' OR
           (v_diff_type = 'FALTANTE' AND x.physical_quantity - coalesce(x.theoretical,0) < 0)
           OR (v_diff_type = 'SOBRANTE' AND x.physical_quantity - coalesce(x.theoretical,0) > 0)
           OR (v_diff_type = 'SIN_DIFERENCIA' AND x.physical_quantity - coalesce(x.theoretical,0) = 0))
    LIMIT v_page_size OFFSET v_offset;

    RETURN pg_catalog.jsonb_build_object(
        'session', v_session,
        'official_version', v_version,
        'summary', pg_catalog.jsonb_build_object(
            'product_count', v_product_count,
            'no_difference', v_no_diff,
            'missing', v_missing,
            'surplus', v_surplus,
            'absolute_difference_total', coalesce(v_abs_diff, 0)
        ),
        'total', v_total,
        'page', v_page,
        'page_size', v_page_size,
        'has_more', v_offset + pg_catalog.jsonb_array_length(CASE WHEN v_items IS NULL THEN '[]'::jsonb ELSE v_items END) < v_total,
        'items', CASE WHEN v_items IS NULL THEN '[]'::jsonb ELSE v_items END
    );
END;
$$;


-- ===== create_inventory_session =====
CREATE OR REPLACE FUNCTION inventarios.create_inventory_session(
    p_company_id uuid, p_name text, p_inventory_type text, p_warehouse_id uuid,
    p_bsale_office_id integer, p_scope_mode text, p_responsible_user_id uuid,
    p_notes text, p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid; v_operation jsonb; v_operation_id uuid;
    v_inventory_type text; v_scope_mode text; v_name text; v_notes text;
    v_session_number integer; v_session_id uuid; v_snapshot_id uuid;
    v_participant_id uuid; v_occurred_at timestamptz;
    v_response jsonb; v_payload jsonb;
BEGIN
    v_inventory_type := pg_catalog.upper(pg_catalog.btrim(p_inventory_type));
    v_scope_mode := pg_catalog.upper(pg_catalog.btrim(p_scope_mode));
    v_name := pg_catalog.btrim(p_name);
    v_notes := pg_catalog.btrim(coalesce(p_notes, ''));
    IF p_company_id IS NULL OR v_name = '' OR pg_catalog.char_length(v_name) > 200
       OR v_inventory_type NOT IN ('GENERAL','PARTIAL','CYCLIC','CONTROL','RECOUNT')
       OR p_warehouse_id IS NULL OR p_bsale_office_id IS NULL OR p_bsale_office_id < 1
       OR v_scope_mode NOT IN ('GENERAL','PARTIAL')
       OR NOT ((v_inventory_type = 'GENERAL' AND v_scope_mode = 'GENERAL')
               OR (v_inventory_type = 'PARTIAL' AND v_scope_mode = 'PARTIAL')
               OR v_inventory_type IN ('CYCLIC','CONTROL','RECOUNT'))
       OR p_responsible_user_id IS NULL OR pg_catalog.char_length(v_notes) > 2000
       OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.create');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.create_inventory_session'),
        pg_catalog.hashtext(p_company_id::text));
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.create','company_id',p_company_id,'name',v_name,
        'inventory_type',v_inventory_type,'warehouse_id',p_warehouse_id,
        'bsale_office_id',p_bsale_office_id,'scope_mode',v_scope_mode,
        'responsible_user_id',p_responsible_user_id);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.session.create',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    IF NOT EXISTS (SELECT 1 FROM core.companies c WHERE c.id = p_company_id AND c.is_active = true) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_COMPANY_ACCESS_DENIED',
            DETAIL=pg_catalog.jsonb_build_object('message','No tienes acceso a la empresa solicitada.','retryable',false)::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM adquisiciones.warehouses w
                   WHERE w.id = p_warehouse_id AND w.company_id = p_company_id
                     AND w.is_active = true AND w.status = 'ACTIVE') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La bodega solicitada no existe o no esta activa.','retryable',false)::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM integraciones.bsale_offices bo
                   WHERE bo.company_id = p_company_id AND bo.bsale_id = p_bsale_office_id::bigint) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La oficina Bsale solicitada no existe o no esta activa.','retryable',false)::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM portal.users u
                   JOIN core.user_company_access uca
                     ON uca.user_id = u.id AND uca.company_id = p_company_id AND uca.is_active = true
                   WHERE u.id = p_responsible_user_id AND u.is_active = true AND u.deleted_at IS NULL) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El responsable solicitado no existe o no tiene acceso a la empresa.','retryable',false)::text;
    END IF;
    IF EXISTS (SELECT 1 FROM inventarios.sessions s
               WHERE s.company_id = p_company_id AND s.warehouse_id = p_warehouse_id
                 AND s.inventory_type = v_inventory_type AND s.status IN ('DRAFT','PREPARED')) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_DUPLICATE',
            DETAIL=pg_catalog.jsonb_build_object('message','Ya existe una jornada configurable para la misma bodega y tipo.','retryable',false)::text;
    END IF;
    SELECT coalesce(pg_catalog.max(s.session_number), 0) + 1
    INTO v_session_number
    FROM inventarios.sessions s WHERE s.company_id = p_company_id;
    v_occurred_at := pg_catalog.now();
    INSERT INTO inventarios.sessions AS s (company_id, session_number, name, inventory_type, status,
        warehouse_id, bsale_office_id, scope_mode, responsible_user_id, notes,
        created_at, created_by, updated_at, updated_by)
    VALUES (p_company_id, v_session_number, v_name, v_inventory_type, 'DRAFT',
        p_warehouse_id, p_bsale_office_id, v_scope_mode, p_responsible_user_id,
        CASE WHEN v_notes = '' THEN NULL ELSE v_notes END,
        v_occurred_at, v_actor_id, v_occurred_at, v_actor_id)
    RETURNING s.id INTO v_session_id;
    INSERT INTO inventarios.operational_snapshots AS os (company_id, session_id, snapshot_version,
        completion_status, captured_at, captured_by, created_at, created_by)
    VALUES (p_company_id, v_session_id, 1, 'PENDING', v_occurred_at, v_actor_id, v_occurred_at, v_actor_id)
    RETURNING os.id INTO v_snapshot_id;
    INSERT INTO inventarios.session_participants AS sp (company_id, session_id, user_id, functional_role,
        active_from, created_at, created_by)
    VALUES (p_company_id, v_session_id, p_responsible_user_id, 'ADMINISTRATOR',
        v_occurred_at, v_occurred_at, v_actor_id)
    RETURNING sp.id INTO v_participant_id;
    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.create','entity_id',v_session_id,'state','DRAFT',
        'version',NULL::integer,'cycle_number',NULL::integer,'assignment_id',NULL::uuid,
        'event_id',NULL::uuid,'replayed',false,'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object('session_number',v_session_number,
            'snapshot_id',v_snapshot_id,'responsible_participant_id',v_participant_id,
            'responsible_user_id',p_responsible_user_id,'completion_status','PENDING'));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, v_session_id, v_response);
END;
$$;
