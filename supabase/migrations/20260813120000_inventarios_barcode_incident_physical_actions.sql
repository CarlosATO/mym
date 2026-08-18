-- Incidencias de códigos: acciones físicas administrativas.
--
-- Mecanismo usado:
--   * Corregir producto contado: replacement auditable en count_entries +
--     count_entry_corrections. El original conserva producto/cantidad/barcode/evidencia.
--   * Eliminar del conteo: invalidación del count efectivo mediante invalidated_at/by/reason.
--
-- Solo DDL/DML en inventarios. Otros schemas se consultan en modo read-only.

BEGIN;

ALTER TABLE inventarios.product_barcode_proposals
    DROP CONSTRAINT IF EXISTS chk_inventarios_barcode_proposals_reason_code;

ALTER TABLE inventarios.product_barcode_proposals
    ADD CONSTRAINT chk_inventarios_barcode_proposals_reason_code
        CHECK (review_reason_code IS NULL OR review_reason_code IN (
            'CODE_NOT_MATCH_PRODUCT','PHOTO_INVALID','LABEL_OTHER_PRODUCT',
            'INTERNAL_NOT_REUSABLE','OTHER','WRONG_PRODUCT_SELECTED',
            'COUNT_INVALIDATED','ADMIN_COUNT_REMOVED'));

ALTER TABLE inventarios.count_entry_corrections
    ADD COLUMN IF NOT EXISTS previous_snapshot_product_id uuid,
    ADD COLUMN IF NOT EXISTS replacement_snapshot_product_id uuid;

UPDATE inventarios.count_entry_corrections
SET previous_snapshot_product_id = snapshot_product_id
WHERE previous_snapshot_product_id IS NULL;

UPDATE inventarios.count_entry_corrections
SET replacement_snapshot_product_id = snapshot_product_id
WHERE replacement_snapshot_product_id IS NULL;

ALTER TABLE inventarios.count_entry_corrections
    DROP CONSTRAINT IF EXISTS fk_inventarios_corrections_previous_count;

ALTER TABLE inventarios.count_entry_corrections
    ADD CONSTRAINT fk_inventarios_corrections_previous_count
        FOREIGN KEY (company_id, session_id, task_id, previous_snapshot_product_id, previous_count_entry_id)
        REFERENCES inventarios.count_entries(company_id, session_id, task_id, snapshot_product_id, id)
        ON DELETE RESTRICT;

ALTER TABLE inventarios.count_entry_corrections
    DROP CONSTRAINT IF EXISTS fk_inventarios_corrections_replacement_count;

ALTER TABLE inventarios.count_entry_corrections
    ADD CONSTRAINT fk_inventarios_corrections_replacement_count
        FOREIGN KEY (company_id, session_id, task_id, replacement_snapshot_product_id, replacement_count_entry_id)
        REFERENCES inventarios.count_entries(company_id, session_id, task_id, snapshot_product_id, id)
        ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION inventarios._require_barcode_physical_admin(
    p_company_id uuid,
    p_campaign_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_role_name text;
    v_is_super boolean := false;
    v_is_campaign_admin boolean := false;
BEGIN
    v_actor_id := inventarios.require_company_access(p_company_id);

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
            DETAIL=pg_catalog.jsonb_build_object('message','No tienes permisos para corregir el conteo físico.','retryable',false)::text;
    END IF;

    RETURN v_actor_id;
END;
$function$;

CREATE OR REPLACE FUNCTION inventarios.search_barcode_incident_target_products(
    p_company_id uuid,
    p_campaign_id uuid,
    p_query text,
    p_exclude_bsale_variant_id integer DEFAULT NULL,
    p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_query text;
    v_limit integer;
    v_items jsonb;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_query IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');
    v_query := pg_catalog.upper(pg_catalog.btrim(p_query));
    v_limit := LEAST(GREATEST(coalesce(p_limit, 20), 1), 30);

    IF length(v_query) < 2 THEN
        RETURN pg_catalog.jsonb_build_object('campaign_id', p_campaign_id, 'items', '[]'::jsonb);
    END IF;

    WITH candidates AS (
        SELECT DISTINCT ON (x.bsale_variant_id)
            x.bsale_variant_id,
            x.product_id,
            x.sku,
            x.product_name,
            x.bsale_code,
            x.rank_order
        FROM (
            SELECT csp.bsale_variant_id, csp.product_id, csp.sku, csp.name AS product_name,
                   csp.sku AS bsale_code, 1 AS rank_order
            FROM inventarios.inventory_campaign_snapshot_products csp
            JOIN inventarios.inventory_campaign_snapshots cs
              ON cs.company_id = csp.company_id AND cs.id = csp.campaign_snapshot_id
            WHERE csp.company_id = p_company_id
              AND cs.campaign_id = p_campaign_id
              AND csp.bsale_variant_id IS NOT NULL
            UNION ALL
            SELECT sp.bsale_variant_id, sp.product_id, sp.sku, sp.name AS product_name,
                   sp.sku AS bsale_code, 2 AS rank_order
            FROM inventarios.snapshot_products sp
            JOIN inventarios.operational_snapshots os
              ON os.company_id = sp.company_id AND os.id = sp.snapshot_id
            JOIN inventarios.sessions s
              ON s.company_id = os.company_id AND s.id = os.session_id
            WHERE sp.company_id = p_company_id
              AND s.campaign_id = p_campaign_id
              AND sp.bsale_variant_id IS NOT NULL
            UNION ALL
            SELECT ap.bsale_variant_id, ap.id AS product_id, ap.sku, ap.description AS product_name,
                   ap.sku AS bsale_code, 3 AS rank_order
            FROM adquisiciones.products ap
            WHERE ap.company_id = p_company_id
              AND ap.bsale_variant_id IS NOT NULL
            UNION ALL
            SELECT bv.bsale_id AS bsale_variant_id, NULL::uuid AS product_id, bv.code AS sku,
                   coalesce(NULLIF(pg_catalog.btrim(bp.name), ''), bv.description) AS product_name,
                   bv.code AS bsale_code, 4 AS rank_order
            FROM integraciones.bsale_variants bv
            LEFT JOIN integraciones.bsale_products bp
              ON bp.company_id = bv.company_id AND bp.bsale_id = bv.bsale_product_id
            WHERE bv.company_id = p_company_id
              AND bv.bsale_id IS NOT NULL
        ) x
        WHERE x.bsale_variant_id IS DISTINCT FROM p_exclude_bsale_variant_id
          AND (
              pg_catalog.upper(coalesce(x.sku, '')) LIKE '%' || v_query || '%'
              OR pg_catalog.upper(coalesce(x.product_name, '')) LIKE '%' || v_query || '%'
              OR x.bsale_variant_id::text = v_query
          )
        ORDER BY x.bsale_variant_id, x.rank_order
    )
    SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'bsale_variant_id', c.bsale_variant_id,
        'product_id', c.product_id,
        'sku', c.sku,
        'product_name', c.product_name,
        'bsale_code', c.bsale_code
    ) ORDER BY c.rank_order, c.sku NULLS LAST, c.bsale_variant_id), '[]'::jsonb)
    INTO v_items
    FROM (SELECT * FROM candidates LIMIT v_limit) c;

    RETURN pg_catalog.jsonb_build_object('campaign_id', p_campaign_id, 'items', v_items);
END;
$function$;

CREATE OR REPLACE FUNCTION inventarios.get_effective_count_entries(
    p_company_id uuid,
    p_session_id uuid,
    p_task_id uuid,
    p_recount_request_id uuid
)
RETURNS TABLE (
    root_count_entry_id uuid,
    effective_count_entry_id uuid,
    company_id uuid,
    session_id uuid,
    snapshot_id uuid,
    session_zone_id uuid,
    snapshot_location_id uuid,
    snapshot_product_id uuid,
    task_id uuid,
    task_cycle integer,
    recount_request_id uuid
)
LANGUAGE plpgsql
STABLE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    PERFORM 1 FROM inventarios.sessions s WHERE s.company_id = p_company_id AND s.id = p_session_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;
    IF p_task_id IS NOT NULL THEN
        PERFORM 1 FROM inventarios.tasks t WHERE t.company_id = p_company_id AND t.session_id = p_session_id AND t.id = p_task_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
                DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
        END IF;
    END IF;
    IF p_recount_request_id IS NOT NULL THEN
        PERFORM 1 FROM inventarios.recount_requests rr
        WHERE rr.company_id = p_company_id AND rr.session_id = p_session_id AND rr.id = p_recount_request_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
                DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
        END IF;
        IF p_task_id IS NOT NULL THEN
            PERFORM 1 FROM inventarios.recount_requests rr
            WHERE rr.id = p_recount_request_id AND rr.source_task_id = p_task_id;
            IF NOT FOUND THEN
                RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
                    DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
            END IF;
        END IF;
    END IF;

    RETURN QUERY
    WITH scope_entries AS (
        SELECT ce.id, ce.company_id, ce.session_id, ce.snapshot_id, ce.session_zone_id,
               ce.snapshot_location_id, ce.snapshot_product_id, ce.task_id, ce.task_cycle,
               ce.recount_request_id
        FROM inventarios.count_entries ce
        WHERE ce.company_id = p_company_id
          AND ce.session_id = p_session_id
          AND (p_task_id IS NULL OR ce.task_id = p_task_id)
          AND (
              (p_recount_request_id IS NULL AND ce.recount_request_id IS NULL)
              OR (p_recount_request_id IS NOT NULL AND ce.recount_request_id = p_recount_request_id)
          )
    ),
    roots AS (
        SELECT se.*
        FROM scope_entries se
        WHERE NOT EXISTS (
            SELECT 1 FROM inventarios.count_entry_corrections cec
            WHERE cec.company_id = p_company_id AND cec.replacement_count_entry_id = se.id
        )
    ),
    active_corrections AS (
        SELECT cec.root_count_entry_id, cec.replacement_count_entry_id
        FROM inventarios.count_entry_corrections cec
        WHERE cec.company_id = p_company_id
          AND cec.superseded_at IS NULL
          AND cec.root_count_entry_id IN (SELECT r.id FROM roots r)
    ),
    candidates AS (
        SELECT r.id AS root_id,
               r.company_id, r.session_id, r.snapshot_id, r.session_zone_id,
               r.snapshot_location_id, r.task_id, r.task_cycle, r.recount_request_id,
               COALESCE(ac.replacement_count_entry_id, r.id) AS candidate_id
        FROM roots r
        LEFT JOIN active_corrections ac ON ac.root_count_entry_id = r.id
    ),
    validated AS (
        SELECT c.root_id, c.candidate_id, c.company_id, c.session_id, c.snapshot_id,
               c.session_zone_id, c.snapshot_location_id, ce.snapshot_product_id,
               c.task_id, c.task_cycle, c.recount_request_id
        FROM candidates c
        JOIN inventarios.count_entries ce
          ON ce.company_id = p_company_id AND ce.id = c.candidate_id
        WHERE ce.invalidated_at IS NULL
          AND ce.invalidated_by IS NULL
          AND ce.invalidation_reason IS NULL
          AND ce.session_id = c.session_id
          AND ce.snapshot_id = c.snapshot_id
          AND ce.session_zone_id = c.session_zone_id
          AND ce.snapshot_location_id = c.snapshot_location_id
          AND ce.task_id = c.task_id
          AND ce.task_cycle = c.task_cycle
          AND ce.recount_request_id IS NOT DISTINCT FROM c.recount_request_id
          AND ce.physical_quantity = ce.available_quantity + ce.damaged_quantity
              + ce.expired_quantity + ce.blocked_quantity + ce.other_unavailable_quantity
    )
    SELECT v.root_id, v.candidate_id, v.company_id, v.session_id, v.snapshot_id,
           v.session_zone_id, v.snapshot_location_id, v.snapshot_product_id,
           v.task_id, v.task_cycle, v.recount_request_id
    FROM validated v
    ORDER BY v.task_id, v.task_cycle, v.session_zone_id, v.snapshot_product_id, v.root_id;
END;
$function$;

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

    -- Resolver la raíz última de la cadena de corrección: si la proposal ya
    -- referencia un reemplazo (corrección previa), se debe corregir la cadena
    -- completa desde la raíz original para que el motor efectivo la contemple.
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

    -- §15: si el código ya es el barcode oficial del producto correcto (Bsale o
    -- snapshot), la corrección física completa sin crear incidencia artificial.
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

CREATE OR REPLACE FUNCTION inventarios._barcode_incident_evidence_id(
    p_company_id uuid,
    p_proposal_id uuid,
    p_count_entry_id uuid
)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
    SELECT ef.id
    FROM inventarios.evidence_files ef
    WHERE ef.company_id = p_company_id
      AND (
          ef.proposal_id = p_proposal_id
          OR (ef.proposal_id IS NULL AND ef.count_entry_id = p_count_entry_id)
          OR ef.proposal_id IN (
              SELECT pbp.id
              FROM inventarios.count_entry_corrections cec
              JOIN inventarios.product_barcode_proposals pbp
                ON pbp.company_id = cec.company_id
               AND pbp.count_entry_id = cec.root_count_entry_id
              WHERE cec.company_id = p_company_id
                AND cec.replacement_count_entry_id = p_count_entry_id
              ORDER BY cec.corrected_at DESC, pbp.proposed_at DESC
              LIMIT 1
          )
          OR (ef.proposal_id IS NULL AND ef.count_entry_id IN (
              SELECT cec.root_count_entry_id
              FROM inventarios.count_entry_corrections cec
              WHERE cec.company_id = p_company_id
                AND cec.replacement_count_entry_id = p_count_entry_id
              ORDER BY cec.corrected_at DESC
              LIMIT 1
          ))
      )
    ORDER BY ef.captured_at NULLS LAST
    LIMIT 1;
$function$;

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
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_bsale_variant_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');
    v_can_review := inventarios._can_review_barcodes(p_company_id, p_campaign_id);

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
        'can_review_barcodes_authorized', v_can_review,
        'product', v_product,
        'barcodes', CASE WHEN v_barcodes IS NULL THEN '[]'::jsonb ELSE v_barcodes END,
        'occurrences', CASE WHEN v_occurrences IS NULL THEN '[]'::jsonb ELSE v_occurrences END
    );
END;
$function$;

GRANT EXECUTE ON FUNCTION inventarios.search_barcode_incident_target_products(uuid, uuid, text, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.admin_correct_barcode_incident_product(uuid, uuid, uuid, integer, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.admin_invalidate_barcode_incident_count(uuid, uuid, uuid, text, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.get_inventory_barcode_incident_detail(uuid, uuid, integer) TO authenticated, service_role;

-- get_effective_count_entries es un motor interno SECURITY DEFINER; se mantiene revocado
-- como en el contrato original (20260731050000). Ningún consumidor directo lo invoca.
REVOKE ALL PRIVILEGES ON FUNCTION inventarios.get_effective_count_entries(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
