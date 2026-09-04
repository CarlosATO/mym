-- Rechazar una incidencia de codigo retira su captura efectiva del resultado y
-- deja un unico recuento activo por producto/zona. La captura se conserva como
-- historial mediante invalidated_at/by/reason.

BEGIN;

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
VOLATILE SECURITY DEFINER
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
    v_invalidation_reason text;
    v_operation jsonb;
    v_operation_id uuid;
    v_payload jsonb;
    v_occurred_at timestamptz := pg_catalog.now();
    v_campaign_status text;
    v_target record;
    v_current record;
    v_active_recount record;
    v_current_count_entry_id uuid;
    v_active_correction_id uuid;
    v_active_recount_count bigint;
    v_recount_request_id uuid;
    v_recount_ordinal integer;
    v_proposals_updated bigint := 0;
    v_counts_invalidated bigint := 0;
    v_recounts_created bigint := 0;
    v_recounts_reused bigint := 0;
    v_count_entry_ids jsonb := '[]'::jsonb;
    v_recount_request_ids jsonb := '[]'::jsonb;
    v_response jsonb;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_scanned_code IS NULL
       OR p_bsale_variant_id IS NULL OR p_reason_code IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_barcode := pg_catalog.btrim(p_scanned_code);
    v_reason_code := pg_catalog.upper(pg_catalog.btrim(p_reason_code));
    IF v_barcode = '' OR v_reason_code NOT IN (
        'CODE_NOT_MATCH_PRODUCT','PHOTO_INVALID','LABEL_OTHER_PRODUCT','INTERNAL_NOT_REUSABLE','OTHER'
    ) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','El codigo o el motivo no son validos.','retryable',false)::text;
    END IF;

    v_notes := pg_catalog.btrim(coalesce(p_review_notes, ''));
    IF v_reason_code = 'OTHER' AND v_notes = '' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','El motivo Otro requiere una nota explicativa.','retryable',false)::text;
    END IF;
    v_invalidation_reason := pg_catalog.left(
        'BARCODE_REJECTED: ' || v_reason_code
            || CASE WHEN v_notes = '' THEN '' ELSE ' - ' || v_notes END,
        500
    );

    v_actor_id := inventarios.require_company_access(p_company_id);

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.barcode_decision'),
        pg_catalog.hashtext(p_company_id::text || ':' || v_barcode)
    );

    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.barcode.reject','company_id',p_company_id,
        'campaign_id',p_campaign_id,'scanned_code',v_barcode,'bsale_variant_id',p_bsale_variant_id,
        'reason_code',v_reason_code,'notes',v_notes
    );
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.barcode.reject',p_idempotency_key,
        inventarios.compute_request_hash(v_payload)
    );
    IF v_operation ->> 'mode' = 'REPLAY' THEN
        RETURN v_operation -> 'response_payload';
    END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT r.name INTO v_role_name
    FROM portal.users u
    JOIN portal.roles r ON r.id = u.role_id
    WHERE u.id = v_actor_id AND u.is_active = true;
    v_is_super := coalesce(v_role_name = 'SUPER_USUARIO', false);

    SELECT EXISTS (
        SELECT 1
        FROM inventarios.inventory_campaign_participants icp
        WHERE icp.company_id = p_company_id
          AND icp.campaign_id = p_campaign_id
          AND icp.user_id = v_actor_id
          AND icp.participant_role = 'ADMINISTRATOR'
          AND icp.active_from <= pg_catalog.now()
          AND icp.revoked_at IS NULL
    ) INTO v_is_campaign_admin;
    IF NOT (v_is_super OR v_is_campaign_admin) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PERMISSION_REQUIRED',
            DETAIL=pg_catalog.jsonb_build_object('message','No tienes permisos para rechazar codigos.','retryable',false)::text;
    END IF;

    SELECT ic.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;
    IF v_campaign_status = 'APPROVED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_ALREADY_APPROVED',
            DETAIL=pg_catalog.jsonb_build_object('message','El Inventario ya fue cerrado y no admite la revision de codigos.','retryable',false,'status',v_campaign_status)::text;
    END IF;
    IF v_campaign_status = 'CANCELLED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_CANCELLED',
            DETAIL=pg_catalog.jsonb_build_object('message','El Inventario esta cancelado y no admite la revision de codigos.','retryable',false,'status',v_campaign_status)::text;
    END IF;
    IF v_campaign_status NOT IN ('IN_PROGRESS','UNDER_REVIEW') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','El Inventario no esta en una etapa operativa para rechazar codigos.','retryable',false,'status',v_campaign_status)::text;
    END IF;

    -- Bloquea todo el conjunto antes de efectuar cambios fisicos.
    PERFORM 1
    FROM inventarios.product_barcode_proposals pbp
    JOIN inventarios.count_entries ce
      ON ce.company_id = pbp.company_id AND ce.id = pbp.count_entry_id
    JOIN inventarios.sessions s
      ON s.company_id = ce.company_id AND s.id = ce.session_id
    WHERE pbp.company_id = p_company_id
      AND pbp.status = 'PENDING_REVIEW'
      AND pbp.scanned_code = v_barcode
      AND ce.bsale_variant_id = p_bsale_variant_id
      AND s.campaign_id = p_campaign_id
    FOR UPDATE OF pbp, ce, s;

    FOR v_target IN
        SELECT DISTINCT ce.id AS root_count_entry_id
        FROM inventarios.product_barcode_proposals pbp
        JOIN inventarios.count_entries ce
          ON ce.company_id = pbp.company_id AND ce.id = pbp.count_entry_id
        JOIN inventarios.sessions s
          ON s.company_id = ce.company_id AND s.id = ce.session_id
        WHERE pbp.company_id = p_company_id
          AND pbp.status = 'PENDING_REVIEW'
          AND pbp.scanned_code = v_barcode
          AND ce.bsale_variant_id = p_bsale_variant_id
          AND s.campaign_id = p_campaign_id
        ORDER BY ce.id
    LOOP
        SELECT cec.id, cec.replacement_count_entry_id
        INTO v_active_correction_id, v_current_count_entry_id
        FROM inventarios.count_entry_corrections cec
        WHERE cec.company_id = p_company_id
          AND cec.root_count_entry_id = v_target.root_count_entry_id
          AND cec.superseded_at IS NULL
        FOR UPDATE;
        IF NOT FOUND THEN
            v_active_correction_id := NULL;
            v_current_count_entry_id := v_target.root_count_entry_id;
        END IF;

        SELECT ce.session_id, ce.snapshot_id, ce.session_zone_id, ce.snapshot_product_id,
               ce.snapshot_location_id, ce.task_id, ce.task_cycle,
               ce.session_participant_id, ce.counted_by,
               ce.invalidated_at, ce.invalidated_by, ce.invalidation_reason
        INTO v_current
        FROM inventarios.count_entries ce
        WHERE ce.company_id = p_company_id AND ce.id = v_current_count_entry_id
        FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
                DETAIL=pg_catalog.jsonb_build_object('message','La captura asociada ya no existe.','retryable',false)::text;
        END IF;

        PERFORM 1
        FROM inventarios.session_participants sp
        WHERE sp.company_id = p_company_id
          AND sp.session_id = v_current.session_id
          AND sp.id = v_current.session_participant_id
          AND sp.user_id = v_current.counted_by
          AND sp.functional_role = 'COUNTER'
        FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
                DETAIL=pg_catalog.jsonb_build_object('message','La captura no tiene un contador valido para asignar el recuento.','retryable',true)::text;
        END IF;

        IF v_current.invalidated_at IS NULL
           AND v_current.invalidated_by IS NULL
           AND v_current.invalidation_reason IS NULL THEN
            UPDATE inventarios.count_entries
            SET invalidated_at = v_occurred_at,
                invalidated_by = v_actor_id,
                invalidation_reason = v_invalidation_reason
            WHERE company_id = p_company_id
              AND id = v_current_count_entry_id
              AND invalidated_at IS NULL
              AND invalidated_by IS NULL
              AND invalidation_reason IS NULL;
            IF NOT FOUND THEN
                RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
                    DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
            END IF;
            v_counts_invalidated := v_counts_invalidated + 1;
        ELSIF v_current.invalidated_at IS NULL
           OR v_current.invalidated_by IS NULL
           OR v_current.invalidation_reason IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
                DETAIL=pg_catalog.jsonb_build_object('message','La captura tiene una invalidacion inconsistente.','retryable',true)::text;
        END IF;

        v_count_entry_ids := v_count_entry_ids || pg_catalog.jsonb_build_array(v_current_count_entry_id);

        -- Comparte el lock y la granularidad del contrato request_inventory_recount.
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtext('inventarios.recount.request.product_zone'),
            pg_catalog.hashtext(
                p_company_id::text || ':' || v_current.session_id::text || ':'
                || v_current.session_zone_id::text || ':' || v_current.snapshot_product_id::text
            )
        );

        SELECT pg_catalog.count(*) INTO v_active_recount_count
        FROM inventarios.recount_requests rr
        WHERE rr.company_id = p_company_id
          AND rr.session_id = v_current.session_id
          AND rr.session_zone_id = v_current.session_zone_id
          AND rr.snapshot_product_id = v_current.snapshot_product_id
          AND rr.status IN ('REQUESTED','ASSIGNED','IN_PROGRESS');
        IF v_active_recount_count > 1 THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
                DETAIL=pg_catalog.jsonb_build_object('message','Existe mas de un recuento activo para el producto y la zona.','retryable',true)::text;
        END IF;

        IF v_active_recount_count = 1 THEN
            SELECT rr.id, rr.status, rr.assigned_participant_id,
                   rr.assigned_user_id, rr.assigned_at
            INTO v_active_recount
            FROM inventarios.recount_requests rr
            WHERE rr.company_id = p_company_id
              AND rr.session_id = v_current.session_id
              AND rr.session_zone_id = v_current.session_zone_id
              AND rr.snapshot_product_id = v_current.snapshot_product_id
              AND rr.status IN ('REQUESTED','ASSIGNED','IN_PROGRESS')
            FOR UPDATE;
            v_recount_request_id := v_active_recount.id;

            IF v_active_recount.status = 'REQUESTED' THEN
                IF v_active_recount.assigned_participant_id IS NOT NULL
                   OR v_active_recount.assigned_user_id IS NOT NULL
                   OR v_active_recount.assigned_at IS NOT NULL THEN
                    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
                        DETAIL=pg_catalog.jsonb_build_object('message','El recuento activo tiene una asignacion inconsistente.','retryable',true)::text;
                END IF;
                UPDATE inventarios.recount_requests
                SET status = 'ASSIGNED',
                    assigned_participant_id = v_current.session_participant_id,
                    assigned_user_id = v_current.counted_by,
                    assigned_at = v_occurred_at,
                    updated_at = v_occurred_at,
                    updated_by = v_actor_id
                WHERE company_id = p_company_id
                  AND id = v_recount_request_id
                  AND status = 'REQUESTED'
                  AND assigned_participant_id IS NULL
                  AND assigned_user_id IS NULL
                  AND assigned_at IS NULL;
                IF NOT FOUND THEN
                    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
                        DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
                END IF;
            ELSIF v_active_recount.assigned_participant_id IS DISTINCT FROM v_current.session_participant_id
               OR v_active_recount.assigned_user_id IS DISTINCT FROM v_current.counted_by THEN
                RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
                    DETAIL=pg_catalog.jsonb_build_object('message','El recuento activo pertenece a otro contador.','retryable',true)::text;
            END IF;
            v_recounts_reused := v_recounts_reused + 1;
        ELSE
            SELECT coalesce(pg_catalog.max(rr.ordinal), 0) + 1
            INTO v_recount_ordinal
            FROM inventarios.recount_requests rr
            WHERE rr.company_id = p_company_id
              AND rr.session_id = v_current.session_id
              AND rr.session_zone_id = v_current.session_zone_id
              AND rr.snapshot_product_id = v_current.snapshot_product_id;

            INSERT INTO inventarios.recount_requests (
                company_id, session_id, snapshot_id, session_zone_id,
                snapshot_product_id, snapshot_location_id, source_task_id,
                source_count_entry_id, reason, ordinal, cycle_number, status,
                requested_by, requested_at, assigned_participant_id, assigned_user_id,
                assigned_at, created_at, created_by, updated_at, updated_by
            ) VALUES (
                p_company_id, v_current.session_id, v_current.snapshot_id,
                v_current.session_zone_id, v_current.snapshot_product_id,
                v_current.snapshot_location_id, v_current.task_id,
                v_current_count_entry_id, v_invalidation_reason, v_recount_ordinal,
                v_current.task_cycle, 'ASSIGNED', v_actor_id, v_occurred_at,
                v_current.session_participant_id, v_current.counted_by, v_occurred_at,
                v_occurred_at, v_actor_id, v_occurred_at, v_actor_id
            )
            RETURNING id INTO v_recount_request_id;
            v_recounts_created := v_recounts_created + 1;
        END IF;

        v_recount_request_ids := v_recount_request_ids || pg_catalog.jsonb_build_array(v_recount_request_id);
    END LOOP;

    UPDATE inventarios.product_barcode_proposals pbp
    SET status = 'REJECTED',
        reviewed_at = v_occurred_at,
        reviewed_by = v_actor_id,
        review_reason_code = v_reason_code,
        review_notes = CASE WHEN v_notes = '' THEN NULL ELSE v_notes END,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    FROM inventarios.count_entries ce
    JOIN inventarios.sessions s
      ON s.company_id = ce.company_id AND s.id = ce.session_id
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
            'count_entries_preserved',true,
            'count_entries_invalidated',v_counts_invalidated,
            'count_entry_ids',v_count_entry_ids,
            'recount_requests_created',v_recounts_created,
            'recount_requests_reused',v_recounts_reused,
            'recount_request_ids',v_recount_request_ids
        )
    );
    RETURN inventarios.complete_idempotent_operation(
        p_company_id, v_operation_id, NULL::uuid, v_response
    );
END;
$function$;

ALTER FUNCTION inventarios.reject_inventory_barcode(uuid, uuid, text, integer, text, uuid, text) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION inventarios.reject_inventory_barcode(uuid, uuid, text, integer, text, uuid, text) TO authenticated, service_role;

COMMIT;
