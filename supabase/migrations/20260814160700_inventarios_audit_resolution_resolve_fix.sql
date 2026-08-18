-- =========================================================================================
-- MIGRATION: M1.5H fix - resolve_inventory_audit_product: sintetico cumple chk quantities
-- =========================================================================================
-- El count sintetico AUDIT registraba physical_quantity = cantidad auditada con
-- desagregaciones 0; el CHECK exige physical = available + damaged + expired + blocked + other.
-- Se deposita la cantidad integra en available_quantity (physical = available).
-- Esquema afectado EXCLUSIVAMENTE: inventarios.
-- =========================================================================================

BEGIN;

CREATE OR REPLACE FUNCTION inventarios.resolve_inventory_audit_product(
    p_company_id uuid,
    p_audit_id uuid,
    p_audit_product_id uuid,
    p_decision text,
    p_reason text DEFAULT NULL,
    p_idempotency_key uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_decision text;
    v_reason text;
    v_operation jsonb;
    v_operation_id uuid;
    v_payload jsonb;
    v_occurred_at timestamptz := pg_catalog.now();
    v_campaign_id uuid;
    v_campaign_status text;
    v_product_status text;
    v_scope_status text;
    v_variant integer;
    v_resolution_id uuid;
    v_event_id uuid;
    v_item_count integer := 0;
    v_synthetic_count integer := 0;
    v_total_audited numeric := 0;
    v_loc record;
    v_result record;
    v_scope jsonb;
    v_anchor jsonb;
    v_error text;
    v_count_entry_id uuid;
    v_item_id uuid;
    v_replaced_physical numeric;
    v_many jsonb;
    v_sess_status text;
    v_affected_official_id uuid;
    v_sessions uuid[] := '{}'::uuid[];
    v_session uuid;
    v_response jsonb;
    v_new_version jsonb := NULL;
BEGIN
    v_decision := pg_catalog.upper(pg_catalog.btrim(coalesce(p_decision, '')));
    v_reason := pg_catalog.btrim(coalesce(p_reason, ''));
    IF p_company_id IS NULL OR p_audit_id IS NULL OR p_audit_product_id IS NULL
       OR p_idempotency_key IS NULL OR v_decision NOT IN ('APPROVE','REJECT') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    IF v_decision = 'REJECT' AND (pg_catalog.char_length(v_reason) < 5 OR pg_catalog.char_length(v_reason) > 1000) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','El motivo del rechazo debe tener entre 5 y 1000 caracteres.','retryable',false)::text;
    END IF;

    SELECT a.campaign_id INTO v_campaign_id
    FROM inventarios.inventory_audits a
    WHERE a.company_id = p_company_id AND a.id = p_audit_id;
    IF v_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La auditoría no existe.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios._inventarios_require_audit_resolver(p_company_id, v_campaign_id);

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.resolve_inventory_audit_product.idempotency'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_idempotency_key::text));
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.audit.resolve','company_id',p_company_id,
        'audit_id',p_audit_id,'audit_product_id',p_audit_product_id,
        'decision',v_decision,'reason',v_reason);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.audit.resolve',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.resolve_inventory_audit_product'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_audit_product_id::text));

    SELECT c.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns c
    WHERE c.company_id = p_company_id AND c.id = v_campaign_id
    FOR UPDATE;
    IF v_campaign_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario no existe.','retryable',false)::text;
    END IF;
    IF v_campaign_status NOT IN ('IN_PROGRESS','UNDER_REVIEW') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario no admite la resolución de auditorías en su estado actual.','retryable',false,'status',v_campaign_status)::text;
    END IF;

    SELECT ap.status, ap.scope_status, ap.bsale_variant_id
    INTO v_product_status, v_scope_status, v_variant
    FROM inventarios.inventory_audit_products ap
    WHERE ap.company_id = p_company_id AND ap.audit_id = p_audit_id AND ap.id = p_audit_product_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_PRODUCT_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El producto no pertenece a la auditoría.','retryable',false)::text;
    END IF;
    IF v_product_status <> 'SUBMITTED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_PRODUCT_ALREADY_RESOLVED',
            DETAIL=pg_catalog.jsonb_build_object('message','El producto auditado no está pendiente de decisión.','retryable',false,'status',v_product_status)::text;
    END IF;
    IF v_scope_status <> 'LOCATIONS_RESOLVED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_PRODUCT_SCOPE_UNSUPPORTED',
            DETAIL=pg_catalog.jsonb_build_object('message','Este producto sin ubicación previa aún no admite resolución administrativa.','retryable',false)::text;
    END IF;

    -- ---------- REJECT ----------
    IF v_decision = 'REJECT' THEN
        INSERT INTO inventarios.inventory_audit_resolutions (
            company_id, campaign_id, audit_id, audit_product_id, decision, reason,
            resolved_by, resolved_at, item_count, created_by, updated_at, updated_by
        )
        VALUES (
            p_company_id, v_campaign_id, p_audit_id, p_audit_product_id, 'REJECTED', v_reason,
            v_actor_id, v_occurred_at, 0, v_actor_id, v_occurred_at, v_actor_id
        )
        RETURNING id INTO v_resolution_id;

        INSERT INTO inventarios.inventory_audit_resolution_events (
            company_id, campaign_id, audit_id, audit_product_id, decision, reason,
            previous_status, next_status, resolution_id, idempotency_key,
            resolved_by, resolved_at, created_by
        )
        VALUES (
            p_company_id, v_campaign_id, p_audit_id, p_audit_product_id, 'REJECT', v_reason,
            v_product_status, 'REJECTED', v_resolution_id, p_idempotency_key,
            v_actor_id, v_occurred_at, v_actor_id
        )
        RETURNING id INTO v_event_id;

        UPDATE inventarios.inventory_audit_products
        SET status = 'REJECTED', updated_at = v_occurred_at, updated_by = v_actor_id
        WHERE company_id = p_company_id AND id = p_audit_product_id;

        PERFORM inventarios._inventarios_audit_refresh_parent_status(p_company_id, p_audit_id, v_actor_id);

        v_response := pg_catalog.jsonb_build_object(
            'operation','inventarios.audit.resolve',
            'entity_id', v_resolution_id,
            'state','REJECTED',
            'version', NULL::integer,
            'cycle_number', NULL::integer,
            'assignment_id', NULL::uuid,
            'event_id', v_event_id,
            'replayed', false,
            'occurred_at', v_occurred_at,
            'data', pg_catalog.jsonb_build_object(
                'audit_id', p_audit_id,
                'audit_product_id', p_audit_product_id,
                'decision', 'REJECTED',
                'reason', v_reason,
                'resolved_by', v_actor_id,
                'resolved_at', v_occurred_at,
                'physical_unchanged', true,
                'affected_official_versions', '[]'::jsonb
            )
        );
        RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, v_resolution_id, v_response);
    END IF;

    -- ---------- APPROVE ----------
    INSERT INTO inventarios.inventory_audit_resolutions (
        company_id, campaign_id, audit_id, audit_product_id, decision, reason,
        resolved_by, resolved_at, total_audited, item_count, synthetic_count_entry_count,
        created_by, updated_at, updated_by
    )
    VALUES (
        p_company_id, v_campaign_id, p_audit_id, p_audit_product_id, 'APPROVED', v_reason,
        v_actor_id, v_occurred_at, 0, 0, 0, v_actor_id, v_occurred_at, v_actor_id
    )
    RETURNING id INTO v_resolution_id;

    FOR v_loc IN
        SELECT l.id
        FROM inventarios.inventory_audit_locations l
        WHERE l.company_id = p_company_id AND l.audit_id = p_audit_id
          AND l.audit_product_id = p_audit_product_id
        ORDER BY l.location_code, l.id
    LOOP
        SELECT r.id, r.physical_quantity, r.audited_by, r.captured_at,
               r.identification_method, r.scanned_code
        INTO v_result
        FROM inventarios.inventory_audit_results r
        WHERE r.company_id = p_company_id
          AND r.audit_product_id = p_audit_product_id
          AND r.audit_location_id = v_loc.id;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_RESOLUTION_INCOMPLETE',
                DETAIL=pg_catalog.jsonb_build_object('message','Faltan resultados auditados para resolver el producto.','retryable',false,'audit_location_id',v_loc.id)::text;
        END IF;

        v_scope := inventarios._inventarios_audit_resolution_scope(p_company_id, v_loc.id, v_variant);
        v_error := v_scope ->> 'error';
        IF v_error = 'NO_CONTEXT' OR v_error = 'AMBIGUOUS_CONTEXT' THEN
            RAISE EXCEPTION USING ERRCODE='P0001',
                MESSAGE=CASE WHEN v_error = 'NO_CONTEXT' THEN 'INV_AUDIT_RESOLUTION_NO_CONTEXT'
                             ELSE 'INV_AUDIT_RESOLUTION_AMBIGUOUS_CONTEXT' END,
                DETAIL=pg_catalog.jsonb_build_object(
                    'message', coalesce(v_scope ->> 'error_detail', 'No se puede resolver el contexto del conteo sintético.'),
                    'retryable', false,
                    'audit_location_id', v_loc.id)::text;
        END IF;
        v_anchor := v_scope -> 'anchor';
        v_replaced_physical := (v_scope ->> 'replaced_physical')::numeric;

        INSERT INTO inventarios.count_entries (
            company_id, session_id, snapshot_id, session_zone_id, task_id, task_cycle,
            session_participant_id, counted_by, snapshot_product_id, snapshot_location_id,
            bsale_variant_id, identification_method, scanned_code, capture_source,
            offline_id, device_id, captured_at, server_received_at, synced_at, synced_by,
            physical_quantity, available_quantity, damaged_quantity, expired_quantity,
            blocked_quantity, other_unavailable_quantity, recount_request_id,
            audit_result_id, created_by
        )
        VALUES (
            p_company_id, (v_anchor->>'session_id')::uuid, (v_anchor->>'snapshot_id')::uuid,
            (v_anchor->>'session_zone_id')::uuid, (v_anchor->>'task_id')::uuid,
            (v_anchor->>'task_cycle')::integer, NULL, v_result.audited_by,
            (v_anchor->>'snapshot_product_id')::uuid, (v_anchor->>'snapshot_location_id')::uuid,
            v_variant, v_result.identification_method, v_result.scanned_code, 'AUDIT',
            NULL, NULL, v_result.captured_at, v_occurred_at, NULL, NULL,
            v_result.physical_quantity, v_result.physical_quantity, 0, 0, 0, 0, NULL,
            v_result.id, v_actor_id
        )
        RETURNING id INTO v_count_entry_id;

        INSERT INTO inventarios.inventory_audit_resolution_items (
            company_id, resolution_id, audit_id, audit_product_id, audit_location_id,
            audit_result_id, session_id, snapshot_id, session_zone_id, task_id, task_cycle,
            snapshot_location_id, synthetic_count_entry_id, audited_quantity,
            replaced_physical_quantity, delta, created_by
        )
        VALUES (
            p_company_id, v_resolution_id, p_audit_id, p_audit_product_id, v_loc.id,
            v_result.id, (v_anchor->>'session_id')::uuid, (v_anchor->>'snapshot_id')::uuid,
            (v_anchor->>'session_zone_id')::uuid, (v_anchor->>'task_id')::uuid,
            (v_anchor->>'task_cycle')::integer, (v_anchor->>'snapshot_location_id')::uuid,
            v_count_entry_id, v_result.physical_quantity, v_replaced_physical,
            v_result.physical_quantity - v_replaced_physical, v_actor_id
        )
        RETURNING id INTO v_item_id;

        FOR v_many IN SELECT el.value FROM pg_catalog.jsonb_array_elements(v_scope -> 'manifest') el LOOP
            INSERT INTO inventarios.inventory_audit_resolution_replaced_contributions (
                company_id, resolution_id, item_id, audit_product_id, replaced_count_entry_id,
                replaced_source, root_count_entry_id, recount_request_id, recount_decision_id,
                session_zone_id, task_id, task_cycle, created_by
            )
            VALUES (
                p_company_id, v_resolution_id, v_item_id, p_audit_product_id,
                (v_many->>'contribution_count_entry_id')::uuid, v_many->>'source',
                (v_many->>'root_count_entry_id')::uuid,
                (v_many->>'recount_request_id')::uuid,
                (v_many->>'recount_decision_id')::uuid,
                (v_many->>'session_zone_id')::uuid,
                (v_many->>'task_id')::uuid,
                (v_many->>'task_cycle')::integer,
                v_actor_id
            );
        END LOOP;

        v_item_count := v_item_count + 1;
        v_synthetic_count := v_synthetic_count + 1;
        v_total_audited := v_total_audited + v_result.physical_quantity;

        v_session := (v_anchor->>'session_id')::uuid;
        IF v_session IS NOT NULL AND NOT (v_session = ANY(v_sessions)) THEN
            v_sessions := array_append(v_sessions, v_session);
        END IF;
    END LOOP;

    UPDATE inventarios.inventory_audit_resolutions
    SET total_audited = v_total_audited,
        item_count = v_item_count,
        synthetic_count_entry_count = v_synthetic_count,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE id = v_resolution_id;

    INSERT INTO inventarios.inventory_audit_resolution_events (
        company_id, campaign_id, audit_id, audit_product_id, decision, reason,
        previous_status, next_status, resolution_id, idempotency_key,
        resolved_by, resolved_at, created_by
    )
    VALUES (
        p_company_id, v_campaign_id, p_audit_id, p_audit_product_id, 'APPROVE', v_reason,
        v_product_status, 'APPROVED', v_resolution_id, p_idempotency_key,
        v_actor_id, v_occurred_at, v_actor_id
    )
    RETURNING id INTO v_event_id;

    UPDATE inventarios.inventory_audit_products
    SET status = 'APPROVED', updated_at = v_occurred_at, updated_by = v_actor_id
    WHERE company_id = p_company_id AND id = p_audit_product_id;

    PERFORM inventarios._inventarios_audit_refresh_parent_status(p_company_id, p_audit_id, v_actor_id);

    FOREACH v_session IN ARRAY v_sessions LOOP
        SELECT s.status INTO v_sess_status
        FROM inventarios.sessions s
        WHERE s.company_id = p_company_id AND s.id = v_session;
        IF v_sess_status = 'APPROVED' THEN
            v_affected_official_id := inventarios._consolidate_session_official(p_company_id, v_session, v_actor_id);
            IF v_affected_official_id IS NOT NULL THEN
                v_new_version := coalesce(v_new_version, '[]'::jsonb) || pg_catalog.jsonb_build_object(
                    'session_id', v_session,
                    'official_version_id', v_affected_official_id);
            END IF;
        END IF;
    END LOOP;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.audit.resolve',
        'entity_id', v_resolution_id,
        'state','APPROVED',
        'version', NULL::integer,
        'cycle_number', NULL::integer,
        'assignment_id', NULL::uuid,
        'event_id', v_event_id,
        'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object(
            'audit_id', p_audit_id,
            'audit_product_id', p_audit_product_id,
            'decision', 'APPROVED',
            'reason', v_reason,
            'resolution_id', v_resolution_id,
            'item_count', v_item_count,
            'synthetic_count_entry_count', v_synthetic_count,
            'total_audited', v_total_audited,
            'resolved_by', v_actor_id,
            'resolved_at', v_occurred_at,
            'affected_official_versions', coalesce(v_new_version, '[]'::jsonb)
        )
    );
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, v_resolution_id, v_response);
END;
$function$;
COMMIT;
