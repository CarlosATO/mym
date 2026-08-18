-- Cierre Global y Definitivo del Inventario (V1) — RPC principal.
--
-- inventarios.admin_close_inventory_campaign(...)
--
-- Unidad de negocio: el Inventario completo (inventory_campaign), no sección por
-- sección. Autorización: SUPER_USUARIO OR participante activo ADMINISTRATOR del
-- campaign. Atómico, idempotente, trazable. Solo DDL/DML en inventarios.
--
-- Efecto post-éxito:
--   0 sesiones operativas · 0 task_locations OPEN · 0 tareas operacionales
--   activas · 0 assignments vigentes · 0 recounts abiertos ·
--   campaign.status='APPROVED' · Mobile bloqueado · resultado final congelado
--   vía official_version_items de las sesiones APPROVED.

BEGIN;

CREATE OR REPLACE FUNCTION inventarios.admin_close_inventory_campaign(
    p_company_id uuid,
    p_campaign_id uuid,
    p_reason text,
    p_idempotency_key uuid,
    p_confirm_incomplete_coverage boolean DEFAULT false
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
    v_operation jsonb;
    v_operation_id uuid;
    v_payload jsonb;
    v_occurred_at timestamptz := pg_catalog.now();
    v_reason text;
    v_campaign_status text;
    v_campaign_started_at timestamptz;
    v_warning_count bigint := 0;
    v_blocker_count bigint := 0;
    v_blocking_incident bigint := 0;
    v_undecided_recount bigint := 0;
    v_open_recount bigint := 0;
    v_open_locations bigint := 0;
    v_sessions_total bigint := 0;
    v_sessions_approved bigint := 0;
    v_sessions_cancelled bigint := 0;
    v_tasks_completed_admin bigint := 0;
    v_tasks_cancelled_unvisited bigint := 0;
    v_locations_closed bigint := 0;
    v_assignments_released bigint := 0;
    v_recounts_cancelled bigint := 0;
    v_partial_zones bigint := 0;
    v_unvisited_zones bigint := 0;
    v_pending_barcodes bigint := 0;
    v_official_result_created boolean := false;
    v_response jsonb;
    v_session_row record;
    v_task_row record;
    v_zone_row record;
    v_contrib_count bigint;
    v_visited_locations bigint;
    v_total_locations bigint;
    v_is_counted boolean;
    v_snapshot_id uuid;
    v_has_official bigint := 0;
    v_approved_at timestamptz;
    v_official_id uuid;
    v_item_id uuid;
    v_prod_key text;
    v_prod jsonb;
    v_products jsonb := '[]'::jsonb;
    v_manifest jsonb;
    v_cc bigint := 0;
    v_nc bigint := 0;
    v_rc bigint := 0;
    v_ic bigint := 0;
    v_task_count bigint := 0;
    v_contrib_row record;
    v_event_id uuid;
    v_rowcount bigint := 0;
BEGIN
    -- ---------- Validación de payload ----------
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_reason := pg_catalog.btrim(coalesce(p_reason, ''));
    IF pg_catalog.char_length(v_reason) < 5 OR pg_catalog.char_length(v_reason) > 1000 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','El motivo del cierre debe tener entre 5 y 1000 caracteres.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_company_access(p_company_id);

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.admin_close_inventory_campaign'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_campaign_id::text));

    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.campaign.admin_close',
        'company_id', p_company_id,
        'campaign_id', p_campaign_id,
        'reason', v_reason,
        'confirm_incomplete_coverage', p_confirm_incomplete_coverage);

    v_operation := inventarios.begin_idempotent_operation(
        p_company_id, 'inventarios.campaign.admin_close', p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN
        RETURN v_operation -> 'response_payload';
    END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    -- ---------- Lock campaign + estado ----------
    SELECT ic.status, ic.started_at
    INTO v_campaign_status, v_campaign_started_at
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id
    FOR UPDATE;
    IF v_campaign_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario no existe.','retryable',false)::text;
    END IF;
    IF v_campaign_status = 'APPROVED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_ALREADY_PREPARED',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario ya se encuentra cerrado.','retryable',false,'status',v_campaign_status)::text;
    END IF;
    IF v_campaign_status = 'CANCELLED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario está cancelado y no puede cerrarse.','retryable',false,'status',v_campaign_status)::text;
    END IF;

    -- ---------- Autorización ----------
    SELECT r.name INTO v_role_name
    FROM portal.users u
    JOIN portal.roles r ON r.id = u.role_id
    WHERE u.id = v_actor_id AND u.is_active = true;
    v_is_super := coalesce(v_role_name = 'SUPER_USUARIO', false);

    SELECT EXISTS (
        SELECT 1 FROM inventarios.inventory_campaign_participants icp
        WHERE icp.company_id = p_company_id
          AND icp.campaign_id = p_campaign_id
          AND icp.user_id = v_actor_id
          AND icp.participant_role = 'ADMINISTRATOR'
          AND icp.active_from <= pg_catalog.now()
          AND icp.revoked_at IS NULL
    ) INTO v_is_campaign_admin;

    IF NOT (v_is_super OR v_is_campaign_admin) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PERMISSION_REQUIRED',
            DETAIL=pg_catalog.jsonb_build_object('message','No tienes permisos para cerrar este inventario.','retryable',false)::text;
    END IF;

    -- ---------- Bloqueadores ----------
    SELECT pg_catalog.count(*) INTO v_blocking_incident
    FROM inventarios.incidents i
    JOIN inventarios.sessions s ON s.company_id = i.company_id AND s.id = i.session_id
    WHERE i.company_id = p_company_id AND s.campaign_id = p_campaign_id
      AND ((i.is_blocking = true AND i.status IN ('OPEN','UNDER_REVIEW'))
           OR (i.severity = 'CRITICAL' AND i.status IN ('OPEN','UNDER_REVIEW')));
    IF v_blocking_incident > 0 THEN v_blocker_count := v_blocker_count + 1; END IF;

    SELECT pg_catalog.count(*) INTO v_undecided_recount
    FROM inventarios.recount_requests rr
    JOIN inventarios.sessions s ON s.company_id = rr.company_id AND s.id = rr.session_id
    WHERE rr.company_id = p_company_id AND s.campaign_id = p_campaign_id
      AND rr.status = 'COMPLETED'
      AND NOT EXISTS (
          SELECT 1 FROM inventarios.recount_decisions rd
          WHERE rd.company_id = rr.company_id AND rd.recount_request_id = rr.id
      );
    IF v_undecided_recount > 0 THEN v_blocker_count := v_blocker_count + 1; END IF;

    IF v_blocker_count > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_BLOCKING_INCIDENTS',
            DETAIL=pg_catalog.jsonb_build_object('message','Existen condiciones que impiden el cierre definitivo.','retryable',false,
                'blocking_incident_count', v_blocking_incident,
                'undecided_recount_count', v_undecided_recount)::text;
    END IF;

    -- ---------- Advertencias (cobertura incompleta) ----------
    SELECT pg_catalog.count(*) INTO v_open_locations
    FROM inventarios.task_locations tl
    JOIN inventarios.sessions s ON s.company_id = tl.company_id AND s.id = tl.session_id
    WHERE tl.company_id = p_company_id AND s.campaign_id = p_campaign_id AND tl.status = 'OPEN';
    IF v_open_locations > 0 THEN v_warning_count := v_warning_count + 1; END IF;

    SELECT pg_catalog.count(*) INTO v_pending_barcodes
    FROM inventarios.product_barcode_proposals pbp
    JOIN inventarios.sessions s ON s.company_id = pbp.company_id AND s.id = pbp.session_id
    WHERE s.campaign_id = p_campaign_id AND pbp.status = 'PENDING_REVIEW';
    IF v_pending_barcodes > 0 THEN v_warning_count := v_warning_count + 1; END IF;

    -- Sesiones DRAFT/PREPARED/COUNTING/UNDER_REVIEW (no APPROVED/CANCELLED)
    SELECT pg_catalog.count(*) INTO v_open_recount
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id
      AND s.status IN ('DRAFT','PREPARED','COUNTING','UNDER_REVIEW');
    IF v_open_recount > 0 THEN v_warning_count := v_warning_count + 1; END IF;

    IF v_warning_count > 0 AND NOT p_confirm_incomplete_coverage THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONFIRM_REQUIRED',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario tiene elementos pendientes. Confirma la cobertura incompleta para cerrarlo.','retryable',false,'warning_count',v_warning_count)::text;
    END IF;

    -- ---------- Cancelar recounts abiertos ----------
    UPDATE inventarios.recount_requests rr
    SET status = 'CANCELLED',
        cancelled_at = v_occurred_at,
        cancelled_by = v_actor_id,
        cancellation_reason = 'CIERRE_ADMIN_GLOBAL',
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    FROM inventarios.sessions s
    WHERE rr.company_id = p_company_id AND s.company_id = rr.company_id
      AND s.id = rr.session_id AND s.campaign_id = p_campaign_id
      AND rr.status IN ('REQUESTED','ASSIGNED','IN_PROGRESS');
    GET DIAGNOSTICS v_recounts_cancelled = ROW_COUNT;

    -- ---------- Cerrar task_locations OPEN ----------
    FOR v_zone_row IN
        SELECT tl.id, tl.session_zone_id, tl.task_id, tl.session_id, t.validation_cycle
        FROM inventarios.task_locations tl
        JOIN inventarios.sessions s ON s.company_id = tl.company_id AND s.id = tl.session_id
        JOIN inventarios.tasks t ON t.company_id = tl.company_id AND t.id = tl.task_id
        WHERE tl.company_id = p_company_id AND s.campaign_id = p_campaign_id AND tl.status = 'OPEN'
        ORDER BY tl.id
        FOR UPDATE OF tl
    LOOP
        UPDATE inventarios.task_locations tl
        SET status = 'CLOSED',
            closed_at = v_occurred_at,
            closed_by = v_actor_id
        WHERE tl.company_id = p_company_id AND tl.id = v_zone_row.id AND tl.status = 'OPEN';
        IF FOUND THEN
            v_locations_closed := v_locations_closed + 1;
            INSERT INTO inventarios.task_events (
                company_id, session_id, session_zone_id, task_id, event_type, actor_id,
                cycle, occurred_at, reason, idempotency_key, source, technical_metadata, created_by
            ) VALUES (
                p_company_id, v_zone_row.session_id, v_zone_row.session_zone_id, v_zone_row.task_id,
                'LOCATION_CLOSED', v_actor_id, v_zone_row.validation_cycle, v_occurred_at,
                'CIERRE_ADMIN_GLOBAL',
                (pg_catalog.md5(p_idempotency_key::text || ':' || v_zone_row.id::text || ':ADMIN_LOCATION_CLOSED'))::uuid,
                'WEB',
                pg_catalog.jsonb_build_object('admin_close', true, 'campaign_id', p_campaign_id),
                v_actor_id
            )
            ON CONFLICT (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
            RETURNING id INTO v_event_id;
        END IF;
    END LOOP;

    -- ---------- Terminalizar tasks ----------
    FOR v_task_row IN
        SELECT t.id, t.session_id, t.session_zone_id, t.status, t.validation_cycle,
               t.current_assignment_id, t.active_user_id
        FROM inventarios.tasks t
        JOIN inventarios.sessions s ON s.company_id = t.company_id AND s.id = t.session_id
        WHERE t.company_id = p_company_id AND s.campaign_id = p_campaign_id
          AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
        ORDER BY t.id
        FOR UPDATE OF t
    LOOP
        SELECT pg_catalog.count(*) INTO v_contrib_count
        FROM inventarios.get_effective_task_contributions(p_company_id, v_task_row.session_id, v_task_row.id);

        SELECT pg_catalog.count(*) INTO v_visited_locations
        FROM inventarios.task_locations tl
        WHERE tl.company_id = p_company_id AND tl.task_id = v_task_row.id;

        SELECT pg_catalog.count(*) INTO v_total_locations
        FROM inventarios.session_zone_locations szl
        JOIN inventarios.session_zones sz ON sz.company_id = szl.company_id AND sz.id = szl.session_zone_id
        WHERE szl.company_id = p_company_id AND szl.session_zone_id = v_task_row.session_zone_id;

        v_is_counted := (v_contrib_count > 0);

        IF v_is_counted THEN
            -- Task realmente trabajada: terminalizar administrativamente.
            UPDATE inventarios.tasks t
            SET status = 'COMPLETED',
                completed_at = v_occurred_at,
                completed_by = v_actor_id,
                active_user_id = NULL,
                version = t.version + 1,
                updated_at = v_occurred_at,
                updated_by = v_actor_id
            WHERE t.company_id = p_company_id AND t.id = v_task_row.id;
            v_tasks_completed_admin := v_tasks_completed_admin + 1;
            IF v_total_locations > 0 AND v_visited_locations < v_total_locations THEN
                v_partial_zones := v_partial_zones + 1;
            END IF;
            INSERT INTO inventarios.task_events (
                company_id, session_id, session_zone_id, task_id, event_type, actor_id,
                cycle, occurred_at, reason, idempotency_key, source, technical_metadata, created_by
            ) VALUES (
                p_company_id, v_task_row.session_id, v_task_row.session_zone_id, v_task_row.id,
                'ZONE_COMPLETED', v_actor_id, v_task_row.validation_cycle, v_occurred_at,
                'CIERRE_ADMIN_GLOBAL',
                (pg_catalog.md5(p_idempotency_key::text || ':' || v_task_row.id::text || ':ADMIN_ZONE_COMPLETED'))::uuid,
                'WEB',
                pg_catalog.jsonb_build_object('admin_close', true, 'campaign_id', p_campaign_id,
                    'coverage', CASE WHEN v_total_locations > 0 AND v_visited_locations < v_total_locations THEN 'PARTIAL' ELSE 'COMPLETE' END,
                    'visited_locations', v_visited_locations,
                    'total_locations', v_total_locations),
                v_actor_id
            )
            ON CONFLICT (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
        ELSE
            -- Task nunca contada: cancelación administrativa (NO COMPLETED).
            UPDATE inventarios.tasks t
            SET cancelled_at = v_occurred_at,
                cancelled_by = v_actor_id,
                cancellation_reason = 'CIERRE_ADMIN_GLOBAL_NO_CONTADA',
                active_user_id = NULL,
                current_assignment_id = NULL,
                version = t.version + 1,
                updated_at = v_occurred_at,
                updated_by = v_actor_id
            WHERE t.company_id = p_company_id AND t.id = v_task_row.id;
            v_tasks_cancelled_unvisited := v_tasks_cancelled_unvisited + 1;
            v_unvisited_zones := v_unvisited_zones + 1;
            INSERT INTO inventarios.task_events (
                company_id, session_id, session_zone_id, task_id, event_type, actor_id,
                cycle, occurred_at, reason, idempotency_key, source, technical_metadata, created_by
            ) VALUES (
                p_company_id, v_task_row.session_id, v_task_row.session_zone_id, v_task_row.id,
                'CANCELLED', v_actor_id, v_task_row.validation_cycle, v_occurred_at,
                'CIERRE_ADMIN_GLOBAL_NO_CONTADA',
                (pg_catalog.md5(p_idempotency_key::text || ':' || v_task_row.id::text || ':ADMIN_TASK_CANCELLED'))::uuid,
                'WEB',
                pg_catalog.jsonb_build_object('admin_close', true, 'campaign_id', p_campaign_id, 'coverage', 'NONE'),
                v_actor_id
            )
            ON CONFLICT (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
        END IF;

        -- Liberar assignment vigente de la task.
        UPDATE inventarios.task_assignments ta
        SET released_at = v_occurred_at, released_by = v_actor_id, release_reason = 'CIERRE_ADMIN_GLOBAL'
        FROM inventarios.sessions s
        WHERE ta.company_id = p_company_id AND s.company_id = ta.company_id
          AND s.id = ta.session_id AND s.campaign_id = p_campaign_id
          AND ta.task_id = v_task_row.id AND ta.released_at IS NULL;
        GET DIAGNOSTICS v_rowcount = ROW_COUNT;
        v_assignments_released := v_assignments_released + v_rowcount;
    END LOOP;

    -- ---------- Sesiones ----------
    SELECT pg_catalog.count(*) INTO v_sessions_total
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id;

    FOR v_session_row IN
        SELECT s.id, s.status
        FROM inventarios.sessions s
        WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id
        ORDER BY s.id
        FOR UPDATE
    LOOP
        IF v_session_row.status IN ('APPROVED','CANCELLED') THEN
            IF v_session_row.status = 'APPROVED' THEN v_sessions_approved := v_sessions_approved + 1; END IF;
            IF v_session_row.status = 'CANCELLED' THEN v_sessions_cancelled := v_sessions_cancelled + 1; END IF;
            CONTINUE;
        END IF;

        -- ¿La sesión tiene contribuciones efectivas?
        SELECT pg_catalog.count(*) INTO v_contrib_count
        FROM (
            SELECT g.contribution_count_entry_id
            FROM inventarios.tasks t
            CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, v_session_row.id, t.id) g
            WHERE t.company_id = p_company_id AND t.session_id = v_session_row.id
              AND t.cancelled_at IS NULL
        ) x;

        IF v_contrib_count = 0 THEN
            -- Sin contribuciones → CANCELLED, sin official_version.
            UPDATE inventarios.sessions s
            SET status = 'CANCELLED',
                cancelled_at = v_occurred_at,
                cancelled_by = v_actor_id,
                cancellation_reason = 'CIERRE_ADMIN_GLOBAL_SIN_CONTEO',
                updated_at = v_occurred_at,
                updated_by = v_actor_id
            WHERE s.company_id = p_company_id AND s.id = v_session_row.id;
            v_sessions_cancelled := v_sessions_cancelled + 1;
            CONTINUE;
        END IF;

        -- ---------- Consolidación oficial de la sección (camino admin) ----------
        SELECT count(*) INTO v_has_official
        FROM inventarios.official_versions ov
        WHERE ov.company_id = p_company_id AND ov.session_id = v_session_row.id;
        IF v_has_official > 0 THEN
            -- Ya consolidada (APROBADA antes): conservar.
            UPDATE inventarios.sessions s
            SET status = 'APPROVED', approved_at = coalesce(s.approved_at, v_occurred_at),
                approved_by = coalesce(s.approved_by, v_actor_id),
                reviewed_at = coalesce(s.reviewed_at, v_occurred_at),
                updated_at = v_occurred_at, updated_by = v_actor_id
            WHERE s.company_id = p_company_id AND s.id = v_session_row.id AND s.status <> 'APPROVED';
            v_sessions_approved := v_sessions_approved + 1;
            CONTINUE;
        END IF;

        SELECT os.id INTO v_snapshot_id
        FROM inventarios.operational_snapshots os
        WHERE os.company_id = p_company_id AND os.session_id = v_session_row.id;

        v_approved_at := v_occurred_at;
        v_products := '[]'::jsonb;
        v_cc := 0; v_nc := 0; v_rc := 0; v_ic := 0; v_task_count := 0;

        FOR v_task_row IN
            SELECT t.id FROM inventarios.tasks t
            WHERE t.company_id = p_company_id AND t.session_id = v_session_row.id
              AND t.cancelled_at IS NULL
            ORDER BY t.id
        LOOP
            v_task_count := v_task_count + 1;
            FOR v_contrib_row IN
                SELECT ec.contribution_count_entry_id, ec.contribution_source,
                       ec.root_count_entry_id, ec.recount_request_id, ec.recount_decision_id,
                       ec.snapshot_product_id, ec.snapshot_id, ec.session_zone_id, ec.task_id, ec.task_cycle,
                       ce.bsale_variant_id,
                       ce.available_quantity, ce.damaged_quantity, ce.expired_quantity,
                       ce.blocked_quantity, ce.other_unavailable_quantity, ce.physical_quantity
                FROM inventarios.get_effective_task_contributions(p_company_id, v_session_row.id, v_task_row.id) ec
                JOIN inventarios.count_entries ce ON ce.id = ec.contribution_count_entry_id
                ORDER BY ec.task_id, ec.task_cycle, ec.session_zone_id, ec.contribution_source, ec.root_count_entry_id, ec.contribution_count_entry_id
            LOOP
                v_prod_key := v_contrib_row.snapshot_product_id::text;
                v_prod := NULL;
                SELECT value INTO v_prod FROM jsonb_array_elements(v_products) WHERE value->>'key' = v_prod_key;
                IF v_prod IS NULL THEN
                    v_prod := pg_catalog.jsonb_build_object('key', v_prod_key, 'snapshot_product_id', v_contrib_row.snapshot_product_id, 'snapshot_id', v_contrib_row.snapshot_id, 'bsale_variant_id', v_contrib_row.bsale_variant_id, 'available_quantity', 0, 'damaged_quantity', 0, 'expired_quantity', 0, 'blocked_quantity', 0, 'other_unavailable_quantity', 0, 'physical_quantity', 0, 'contribution_count', 0, 'normal_contribution_count', 0, 'recount_contribution_count', 0, 'manifest', '[]'::jsonb);
                    v_products := v_products || v_prod;
                END IF;
                SELECT value INTO v_prod FROM jsonb_array_elements(v_products) WHERE value->>'key' = v_prod_key;
                v_prod := v_prod || jsonb_build_object(
                    'available_quantity', (v_prod->>'available_quantity')::numeric + v_contrib_row.available_quantity,
                    'damaged_quantity', (v_prod->>'damaged_quantity')::numeric + v_contrib_row.damaged_quantity,
                    'expired_quantity', (v_prod->>'expired_quantity')::numeric + v_contrib_row.expired_quantity,
                    'blocked_quantity', (v_prod->>'blocked_quantity')::numeric + v_contrib_row.blocked_quantity,
                    'other_unavailable_quantity', (v_prod->>'other_unavailable_quantity')::numeric + v_contrib_row.other_unavailable_quantity,
                    'physical_quantity', (v_prod->>'physical_quantity')::numeric + v_contrib_row.physical_quantity,
                    'contribution_count', (v_prod->>'contribution_count')::integer + 1,
                    'normal_contribution_count', (v_prod->>'normal_contribution_count')::integer + CASE WHEN v_contrib_row.contribution_source = 'NORMAL' THEN 1 ELSE 0 END,
                    'recount_contribution_count', (v_prod->>'recount_contribution_count')::integer + CASE WHEN v_contrib_row.contribution_source = 'RECOUNT' THEN 1 ELSE 0 END
                );
                v_manifest := v_prod->'manifest';
                v_manifest := v_manifest || jsonb_build_object(
                    'contribution_count_entry_id', v_contrib_row.contribution_count_entry_id,
                    'contribution_source', v_contrib_row.contribution_source,
                    'root_count_entry_id', v_contrib_row.root_count_entry_id,
                    'recount_request_id', v_contrib_row.recount_request_id,
                    'recount_decision_id', v_contrib_row.recount_decision_id,
                    'task_id', v_contrib_row.task_id,
                    'task_cycle', v_contrib_row.task_cycle,
                    'session_zone_id', v_contrib_row.session_zone_id
                );
                v_prod := v_prod || jsonb_build_object('manifest', v_manifest);
                v_products := (
                    SELECT jsonb_agg(CASE WHEN elem->>'key' = v_prod_key THEN v_prod ELSE elem END ORDER BY elem->>'key')
                    FROM jsonb_array_elements(v_products) elem
                );
                v_cc := v_cc + 1;
                IF v_contrib_row.contribution_source = 'NORMAL' THEN v_nc := v_nc + 1; END IF;
                IF v_contrib_row.contribution_source = 'RECOUNT' THEN v_rc := v_rc + 1; END IF;
            END LOOP;
        END LOOP;

        IF v_cc > 0 AND v_snapshot_id IS NOT NULL THEN
            SELECT pg_catalog.count(*) INTO v_ic
            FROM pg_catalog.jsonb_array_elements(v_products);
            INSERT INTO inventarios.official_versions (company_id, session_id, snapshot_id, version_number, task_count, contribution_count, normal_contribution_count, recount_contribution_count, item_count, approved_at, approved_by, created_at, created_by)
            VALUES (p_company_id, v_session_row.id, v_snapshot_id, 1, v_task_count, v_cc, v_nc, v_rc, GREATEST(v_ic, 1), v_approved_at, v_actor_id, v_approved_at, v_actor_id)
            RETURNING id INTO v_official_id;
            v_ic := 0;
            FOR v_prod IN SELECT * FROM jsonb_array_elements(v_products) ORDER BY (value->>'key') LOOP
                INSERT INTO inventarios.official_version_items (company_id, official_version_id, session_id, snapshot_id, snapshot_product_id, bsale_variant_id, available_quantity, damaged_quantity, expired_quantity, blocked_quantity, other_unavailable_quantity, physical_quantity, contribution_count, normal_contribution_count, recount_contribution_count, contribution_manifest, created_at, created_by)
                VALUES (p_company_id, v_official_id, v_session_row.id, (v_prod->>'snapshot_id')::uuid, (v_prod->>'snapshot_product_id')::uuid, (v_prod->>'bsale_variant_id')::integer, (v_prod->>'available_quantity')::numeric, (v_prod->>'damaged_quantity')::numeric, (v_prod->>'expired_quantity')::numeric, (v_prod->>'blocked_quantity')::numeric, (v_prod->>'other_unavailable_quantity')::numeric, (v_prod->>'physical_quantity')::numeric, (v_prod->>'contribution_count')::integer, (v_prod->>'normal_contribution_count')::integer, (v_prod->>'recount_contribution_count')::integer, v_prod->'manifest', v_approved_at, v_actor_id)
                RETURNING id INTO v_item_id;
                v_ic := v_ic + 1;
            END LOOP;
            UPDATE inventarios.official_versions SET item_count = v_ic WHERE id = v_official_id;
            v_official_result_created := true;
        END IF;

        UPDATE inventarios.sessions s
        SET status = 'APPROVED', approved_at = v_approved_at, approved_by = v_actor_id,
            reviewed_at = coalesce(s.reviewed_at, v_occurred_at),
            updated_at = v_occurred_at, updated_by = v_actor_id
        WHERE s.company_id = p_company_id AND s.id = v_session_row.id;
        v_sessions_approved := v_sessions_approved + 1;
    END LOOP;

    -- ---------- Backfill started_at (si alguna sesión inició) ----------
    IF v_campaign_started_at IS NULL THEN
        SELECT pg_catalog.min(s.started_at) INTO v_campaign_started_at
        FROM inventarios.sessions s
        WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id
          AND s.started_at IS NOT NULL;
    END IF;

    -- ---------- Cerrar campaign ----------
    UPDATE inventarios.inventory_campaigns ic
    SET status = 'APPROVED',
        approved_at = v_occurred_at,
        approved_by = v_actor_id,
        close_reason = v_reason,
        started_at = coalesce(ic.started_at, v_campaign_started_at),
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
            DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.campaign.admin_close',
        'entity_id', p_campaign_id,
        'state','APPROVED',
        'version', NULL::integer,
        'cycle_number', NULL::integer,
        'assignment_id', NULL::uuid,
        'event_id', NULL::uuid,
        'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object(
            'campaign_id', p_campaign_id,
            'status', 'APPROVED',
            'closed_at', v_occurred_at,
            'closed_by', v_actor_id,
            'sessions_total', v_sessions_total,
            'sessions_approved', v_sessions_approved,
            'sessions_cancelled', v_sessions_cancelled,
            'tasks_completed_admin', v_tasks_completed_admin,
            'tasks_cancelled_unvisited', v_tasks_cancelled_unvisited,
            'locations_closed', v_locations_closed,
            'assignments_released', v_assignments_released,
            'recounts_cancelled', v_recounts_cancelled,
            'partial_zones', v_partial_zones,
            'unvisited_zones', v_unvisited_zones,
            'pending_barcodes', v_pending_barcodes,
            'official_result_created', v_official_result_created
        )
    );

    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_campaign_id, v_response);
END;
$function$;

GRANT EXECUTE ON FUNCTION inventarios.admin_close_inventory_campaign(uuid, uuid, text, uuid, boolean) TO authenticated, service_role;

COMMIT;
