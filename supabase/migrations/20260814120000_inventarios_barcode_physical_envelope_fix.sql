-- Fix forward: respuestas de acciones físicas de incidencias de códigos.
--
-- complete_idempotent_operation valida el sobre de respuesta (requiere las claves
-- operation, entity_id, state, version, cycle_number, assignment_id, event_id,
-- replayed, occurred_at, data). Las RPCs admin_correct_barcode_incident_product y
-- admin_invalidate_barcode_incident_count omitían version/cycle_number/
-- assignment_id/event_id, por lo que fallaban con INV_INVALID_RESPONSE_ENVELOPE.
--
-- Solo DDL/DML en inventarios.

BEGIN;

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
$function$;

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
$function$;

GRANT EXECUTE ON FUNCTION inventarios.admin_correct_barcode_incident_product(uuid, uuid, uuid, integer, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.admin_invalidate_barcode_incident_count(uuid, uuid, uuid, text, text, uuid) TO authenticated, service_role;

COMMIT;
