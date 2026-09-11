-- Canonical ERP operation for synchronizing supplemental findings.
-- The called RPCs remain the only writers of lifecycle/counting state.

CREATE OR REPLACE FUNCTION inventarios.sync_inventory_campaign_supplemental_findings(
    p_company_id uuid,
    p_campaign_id uuid,
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_campaign_status text;
    v_operation jsonb;
    v_operation_id uuid;
    v_payload jsonb;
    v_occurred_at timestamptz;
    v_site record;
    v_batch record;
    v_resp jsonb;
    v_session_id uuid;
    v_initial_state text;
    v_pending bigint;
    v_total bigint;
    v_initial_batches jsonb := '[]'::jsonb;
    v_batches jsonb := '[]'::jsonb;
    v_processed_batch_count bigint := 0;
    v_under_review_batch_count bigint := 0;
    v_draft_eligible_processed bigint := 0;
    v_blocked_draft_remaining bigint := 0;
    v_count_entry_count bigint := 0;
    v_physical_quantity_sum numeric(14,3) := 0;
    v_response jsonb;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_supplemental_findings_super_user(p_company_id);

    SELECT c.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns c
    WHERE c.company_id = p_company_id AND c.id = p_campaign_id;
    IF v_campaign_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
            DETAIL = pg_catalog.jsonb_build_object('message','El inventario no existe.','retryable',false)::text;
    END IF;
    IF v_campaign_status <> 'IN_PROGRESS' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_SESSION_INVALID_STATE',
            DETAIL = pg_catalog.jsonb_build_object('message','La campaña debe estar en IN_PROGRESS.','retryable',false,'status',v_campaign_status)::text;
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.supplemental.sync'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_campaign_id::text));

    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.supplemental.sync',
        'company_id',p_company_id,
        'campaign_id',p_campaign_id);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id, 'inventarios.supplemental.sync', p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN
        RETURN v_operation -> 'response_payload';
    END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    v_occurred_at := pg_catalog.now();

    -- Consolidate every site with at least one currently eligible DRAFT. Blocked
    -- DRAFT rows are deliberately excluded by the same classifier as the official RPC.
    FOR v_site IN
        SELECT f.inventory_site_id
        FROM inventarios.inventory_campaign_supplemental_findings f
        JOIN adquisiciones.products p
          ON p.company_id = f.company_id AND p.id = f.product_id
        CROSS JOIN LATERAL inventarios.classify_supplemental_finding(
            p_company_id, p_campaign_id, f.product_id, p.bsale_variant_id) c
        WHERE f.company_id = p_company_id
          AND f.campaign_id = p_campaign_id
          AND f.status = 'DRAFT'
          AND c.classification IN ('ELIGIBLE_CANONICAL','ELIGIBLE_OUT_OF_THEORETICAL')
        GROUP BY f.inventory_site_id
        ORDER BY f.inventory_site_id
    LOOP
        v_resp := inventarios.consolidate_inventory_campaign_supplemental_findings(
            p_company_id, p_campaign_id, v_site.inventory_site_id,
            inventarios.supplemental_web_record_internal_key(
                p_idempotency_key, 'site:' || v_site.inventory_site_id::text || ':consolidate'));
        IF v_resp ->> 'state' <> 'PREPARED' THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_SUPPLEMENTAL_SYNC_STATE',
                DETAIL = pg_catalog.jsonb_build_object('message','La consolidación no dejó el lote en PREPARED.','retryable',true,'site_id',v_site.inventory_site_id,'state',v_resp ->> 'state')::text;
        END IF;
        v_session_id := (v_resp -> 'data' ->> 'supplemental_session_id')::uuid;
        v_initial_batches := v_initial_batches || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('supplemental_session_id',v_session_id,'initial_state','DRAFT'));
        v_draft_eligible_processed := v_draft_eligible_processed + (v_resp -> 'data' ->> 'consolidated_count')::bigint;
    END LOOP;

    -- Resume each real batch exactly from its persisted session state.
    FOR v_batch IN
        SELECT s.id AS session_id, s.status AS session_status
        FROM inventarios.sessions s
        WHERE s.company_id = p_company_id
          AND s.campaign_id = p_campaign_id
          AND s.session_purpose = 'SUPPLEMENTAL_FINDINGS'
        ORDER BY s.id
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_array_elements(v_initial_batches) x
            WHERE x ->> 'supplemental_session_id' = v_batch.session_id::text
        ) THEN
            v_initial_batches := v_initial_batches || pg_catalog.jsonb_build_array(
                pg_catalog.jsonb_build_object('supplemental_session_id',v_batch.session_id,'initial_state',v_batch.session_status));
        END IF;

        SELECT count(*) FILTER (WHERE f.status = 'CONSOLIDATED'),
               count(*) FILTER (WHERE f.status = 'CONSOLIDATED' AND f.count_entry_id IS NULL)
        INTO v_total, v_pending
        FROM inventarios.inventory_campaign_supplemental_findings f
        WHERE f.company_id = p_company_id AND f.supplemental_session_id = v_batch.session_id;

        IF v_batch.session_status = 'PREPARED' THEN
            IF v_total < 1 OR v_pending < 1 THEN
                RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_SUPPLEMENTAL_SYNC_STATE',
                    DETAIL = pg_catalog.jsonb_build_object('message','El lote PREPARED no tiene exactamente hallazgos pendientes de conteo.','retryable',false,'session_id',v_batch.session_id,'consolidated_count',v_total,'pending_count',v_pending)::text;
            END IF;
            v_resp := inventarios.record_inventory_campaign_supplemental_findings_counts(
                p_company_id, v_batch.session_id,
                inventarios.supplemental_web_record_internal_key(
                    p_idempotency_key, 'session:' || v_batch.session_id::text || ':record'));
            IF v_resp ->> 'state' <> 'COUNTING' THEN
                RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_SUPPLEMENTAL_SYNC_STATE',
                    DETAIL = pg_catalog.jsonb_build_object('message','El registro no dejó el lote en COUNTING.','retryable',true,'session_id',v_batch.session_id,'state',v_resp ->> 'state')::text;
            END IF;
        ELSIF v_batch.session_status = 'COUNTING' THEN
            IF v_total < 1 OR v_pending <> 0 THEN
                RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_SUPPLEMENTAL_COUNTS_INCOMPLETE',
                    DETAIL = pg_catalog.jsonb_build_object('message','El lote COUNTING tiene conteos parciales; no se inventa una transición.','retryable',false,'session_id',v_batch.session_id,'consolidated_count',v_total,'pending_count',v_pending)::text;
            END IF;
        ELSIF v_batch.session_status = 'UNDER_REVIEW' THEN
            CONTINUE;
        ELSE
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_SUPPLEMENTAL_SYNC_STATE',
                DETAIL = pg_catalog.jsonb_build_object('message','Estado de lote supplemental no soportado por la sincronización.','retryable',false,'session_id',v_batch.session_id,'state',v_batch.session_status)::text;
        END IF;

        IF v_batch.session_status IN ('PREPARED','COUNTING') THEN
            v_resp := inventarios.finalize_inventory_campaign_supplemental_findings_counting(
                p_company_id, v_batch.session_id,
                inventarios.supplemental_web_record_internal_key(
                    p_idempotency_key, 'session:' || v_batch.session_id::text || ':finalize'));
            IF v_resp ->> 'state' <> 'UNDER_REVIEW' THEN
                RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_SUPPLEMENTAL_SYNC_STATE',
                    DETAIL = pg_catalog.jsonb_build_object('message','El cierre no dejó el lote en UNDER_REVIEW.','retryable',true,'session_id',v_batch.session_id,'state',v_resp ->> 'state')::text;
            END IF;
            v_processed_batch_count := v_processed_batch_count + 1;
        END IF;
    END LOOP;

    SELECT count(*) FILTER (WHERE f.status = 'DRAFT' AND NOT c.can_consolidate)
    INTO v_blocked_draft_remaining
    FROM inventarios.inventory_campaign_supplemental_findings f
    CROSS JOIN LATERAL inventarios.classify_supplemental_finding(
        p_company_id, p_campaign_id, f.product_id, f.bsale_variant_id) c
    WHERE f.company_id = p_company_id AND f.campaign_id = p_campaign_id;
    SELECT count(*), coalesce(sum(ce.physical_quantity),0)
    INTO v_count_entry_count, v_physical_quantity_sum
    FROM inventarios.count_entries ce
    JOIN inventarios.sessions s ON s.company_id = ce.company_id AND s.id = ce.session_id
    WHERE ce.company_id = p_company_id AND s.campaign_id = p_campaign_id
      AND s.session_purpose = 'SUPPLEMENTAL_FINDINGS';

    SELECT count(*) FILTER (WHERE s.status = 'UNDER_REVIEW')
    INTO v_under_review_batch_count
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id
      AND s.session_purpose = 'SUPPLEMENTAL_FINDINGS';

    SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'supplemental_session_id', b.session_id,
        'inventory_site_id', b.inventory_site_id,
        'site_name', b.site_name,
        'initial_state', b.initial_state,
        'final_state', b.final_state,
        'finding_count', b.finding_count,
        'count_entry_count', b.count_entry_count,
        'physical_quantity_sum', b.physical_quantity_sum
    ) ORDER BY b.site_name, b.session_id), '[]'::jsonb)
    INTO v_batches
    FROM (
        SELECT s.id AS session_id,
               s.inventory_site_id,
               site.name AS site_name,
               coalesce((SELECT x ->> 'initial_state'
                         FROM pg_catalog.jsonb_array_elements(v_initial_batches) x
                         WHERE x ->> 'supplemental_session_id' = s.id::text
                         LIMIT 1), s.status) AS initial_state,
               s.status AS final_state,
               count(f.id) AS finding_count,
               count(f.count_entry_id) AS count_entry_count,
               coalesce(sum(f.quantity),0) AS physical_quantity_sum
        FROM inventarios.sessions s
        JOIN inventarios.inventory_sites site
          ON site.company_id = s.company_id AND site.id = s.inventory_site_id
        LEFT JOIN inventarios.inventory_campaign_supplemental_findings f
          ON f.company_id = s.company_id
         AND f.supplemental_session_id = s.id
         AND f.status = 'CONSOLIDATED'
        WHERE s.company_id = p_company_id
          AND s.campaign_id = p_campaign_id
          AND s.session_purpose = 'SUPPLEMENTAL_FINDINGS'
        GROUP BY s.id, s.inventory_site_id, site.name, s.status
    ) b;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.supplemental.sync',
        'entity_id',p_campaign_id,
        'state','SYNCED',
        'version',1,
        'cycle_number',NULL::integer,
        'assignment_id',NULL::uuid,
        'event_id',NULL::uuid,
        'replayed',false,
        'occurred_at',v_occurred_at,
        'campaign_id',p_campaign_id,
        'processed_batch_count',v_processed_batch_count,
        'under_review_batch_count',v_under_review_batch_count,
        'draft_eligible_processed',v_draft_eligible_processed,
        'blocked_draft_remaining',v_blocked_draft_remaining,
        'count_entry_count',v_count_entry_count,
        'physical_quantity_sum',v_physical_quantity_sum,
        'batches',v_batches,
        'data',pg_catalog.jsonb_build_object(
            'campaign_id',p_campaign_id,
            'processed_batch_count',v_processed_batch_count,
            'under_review_batch_count',v_under_review_batch_count,
            'draft_eligible_processed',v_draft_eligible_processed,
            'blocked_draft_remaining',v_blocked_draft_remaining,
            'count_entry_count',v_count_entry_count,
            'physical_quantity_sum',v_physical_quantity_sum,
            'batches',v_batches));

    RETURN inventarios.complete_idempotent_operation(
        p_company_id, v_operation_id, p_campaign_id, v_response);
END;
$function$;

ALTER FUNCTION inventarios.sync_inventory_campaign_supplemental_findings(uuid, uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.sync_inventory_campaign_supplemental_findings(uuid, uuid, uuid)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.sync_inventory_campaign_supplemental_findings(uuid, uuid, uuid)
    TO authenticated, service_role;
