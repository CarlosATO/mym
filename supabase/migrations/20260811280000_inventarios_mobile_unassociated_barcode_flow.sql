-- =========================================================================================
-- MIGRATION: M1.5E.10 - Flujo movil de barcode no asociado (Caso A) y descubrimiento (Caso B)
-- =========================================================================================
-- Alcance:
--  A) search_master_products: autorizacion COUNTER contextual + fix coalesce.
--  B) submit_mobile_manual_match_count (NUEVA): producto en snapshot, barcode fisico
--     no asociado -> conteo normal SEARCH_MANUAL + propuesta PENDING_REVIEW + evidencia
--     opcional + eventos COUNT_RECORDED y BARCODE_PROPOSED. Atomo e idempotente.
--  C) submit_mobile_discovery_count: solo Caso B -> autorizacion COUNTER contextual,
--     evidencia opcional (todo o nada), sin cambio de semantica (snapshot teorico cero,
--     propuesta PENDING_REVIEW, DISCOVERY_RECORDED).
-- No se otorgan permisos administrativos. No se crean productos/SKU ni se ajusta stock.

-- 1) Ampliar tipos de evento de task_events con BARCODE_PROPOSED
ALTER TABLE inventarios.task_events DROP CONSTRAINT chk_inventarios_events_type;
ALTER TABLE inventarios.task_events ADD CONSTRAINT chk_inventarios_events_type
CHECK (event_type IN ('STARTED', 'RESUMED', 'REOPENED', 'REASSIGNED', 'VALIDATED', 'INVALIDATED', 'CANCELLED', 'LOCATION_OPENED', 'COUNT_RECORDED', 'DISCOVERY_RECORDED', 'BARCODE_PROPOSED'));


-- 2) search_master_products: autorizacion COUNTER contextual + fix coalesce
CREATE OR REPLACE FUNCTION inventarios.search_master_products(p_zone_id uuid, p_location_id uuid, p_query text, p_limit integer DEFAULT 20)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_company_id uuid;
    v_session_id uuid;
    v_snapshot_id uuid;
    v_task_id uuid;
    v_is_authorized boolean := false;
    v_is_open boolean := false;
    v_clean_query text;
    v_limit integer;
    v_results jsonb;
BEGIN
    v_clean_query := pg_catalog.btrim(p_query);
    IF v_clean_query IS NULL OR pg_catalog.length(v_clean_query) < 2 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La búsqueda debe tener al menos 2 caracteres.', 'retryable', false)::text;
    END IF;
    v_limit := COALESCE(p_limit, 20);
    v_limit := LEAST(20, GREATEST(1, v_limit));
    v_actor_id := inventarios.require_actor();

    SELECT z.company_id, t.id, z.session_id, z.snapshot_id, true
    INTO v_company_id, v_task_id, v_session_id, v_snapshot_id, v_is_authorized
    FROM inventarios.task_assignments a
    JOIN inventarios.tasks t ON t.id = a.task_id
    JOIN inventarios.session_zones z ON z.id = t.session_zone_id
    JOIN inventarios.sessions s ON s.id = z.session_id
    JOIN inventarios.session_participants p ON p.id = a.session_participant_id
    WHERE z.id = p_zone_id AND a.user_id = v_actor_id AND a.released_at IS NULL
      AND p.user_id = v_actor_id AND p.functional_role = 'COUNTER'
      AND p.active_from <= pg_catalog.now() AND p.revoked_at IS NULL
      AND s.status = 'COUNTING' AND z.is_enabled = true AND t.status = 'IN_PROGRESS'
      AND t.active_user_id = v_actor_id
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL AND t.invalidated_at IS NULL;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;
    PERFORM inventarios.require_company_access(v_company_id);

    SELECT true INTO v_is_open
    FROM inventarios.task_locations tl
    JOIN inventarios.session_zone_locations szl ON szl.id = tl.session_zone_location_id
    WHERE tl.company_id = v_company_id AND tl.task_id = v_task_id AND tl.session_zone_id = p_zone_id
      AND szl.session_zone_id = p_zone_id AND szl.location_id = p_location_id
      AND tl.opened_by = v_actor_id AND tl.status = 'OPEN';

    IF v_is_open IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La ubicación no está abierta para esta tarea.', 'retryable', false)::text;
    END IF;

    WITH snapshot_inventory AS (
        SELECT DISTINCT ON (sp.bsale_variant_id) sp.bsale_variant_id, sp.id AS snapshot_product_id
        FROM inventarios.snapshot_products sp
        WHERE sp.company_id = v_company_id AND sp.snapshot_id = v_snapshot_id AND sp.bsale_variant_id IS NOT NULL
        ORDER BY sp.bsale_variant_id, sp.id
    ),
    search_raw AS (
        SELECT p.id AS product_id, bv.bsale_id AS bsale_variant_id, bv.code AS sku, bv.bar_code AS barcode,
               pg_catalog.concat_ws(' - ', bp.name, bv.description) AS name,
               CASE
                   WHEN bv.code ILIKE v_clean_query OR bv.bar_code ILIKE v_clean_query OR bv.description ILIKE v_clean_query OR bp.name ILIKE v_clean_query THEN 1
                   WHEN bv.code ILIKE v_clean_query || '%' OR bv.bar_code ILIKE v_clean_query || '%' OR bv.description ILIKE v_clean_query || '%' OR bp.name ILIKE v_clean_query || '%' THEN 2
                   WHEN bv.code ILIKE '%' || v_clean_query || '%' OR bv.bar_code ILIKE '%' || v_clean_query || '%' OR bv.description ILIKE '%' || v_clean_query || '%' OR bp.name ILIKE '%' || v_clean_query || '%' THEN 3
                   ELSE 4
               END AS match_rank,
               CASE
                   WHEN bv.code ILIKE v_clean_query THEN 1
                   WHEN bv.bar_code ILIKE v_clean_query THEN 2
                   WHEN bv.description ILIKE v_clean_query THEN 3
                   WHEN bp.name ILIKE v_clean_query THEN 4
                   WHEN bv.code ILIKE v_clean_query || '%' THEN 5
                   WHEN bv.bar_code ILIKE v_clean_query || '%' THEN 6
                   WHEN bv.description ILIKE v_clean_query || '%' THEN 7
                   WHEN bp.name ILIKE v_clean_query || '%' THEN 8
                   WHEN bv.code ILIKE '%' || v_clean_query || '%' THEN 9
                   WHEN bv.bar_code ILIKE '%' || v_clean_query || '%' THEN 10
                   WHEN bv.description ILIKE '%' || v_clean_query || '%' THEN 11
                   WHEN bp.name ILIKE '%' || v_clean_query || '%' THEN 12
                   ELSE 13
               END AS match_field_rank
        FROM adquisiciones.products p
        JOIN integraciones.bsale_variants bv ON bv.company_id = p.company_id AND bv.bsale_id = p.bsale_variant_id
        JOIN integraciones.bsale_products bp ON bp.company_id = bv.company_id AND bp.bsale_id = bv.bsale_product_id
        WHERE p.company_id = v_company_id AND p.is_active = true AND bv.state = 0 AND bp.state = 0
          AND (bv.code ILIKE '%' || v_clean_query || '%' OR bv.bar_code ILIKE '%' || v_clean_query || '%' OR bp.name ILIKE '%' || v_clean_query || '%' OR bv.description ILIKE '%' || v_clean_query || '%')
    ),
    search_dedup AS (
        SELECT sr.*, pg_catalog.row_number() OVER (PARTITION BY sr.bsale_variant_id ORDER BY sr.match_rank ASC, sr.match_field_rank ASC, sr.name ASC, sr.product_id ASC, sr.sku ASC, sr.barcode ASC) AS rn
        FROM search_raw sr
    ),
    search_unique AS (
        SELECT product_id, bsale_variant_id, sku, barcode, name, match_rank, match_field_rank
        FROM search_dedup WHERE rn = 1
    ),
    ranked_results AS (
        SELECT su.product_id, su.bsale_variant_id, su.sku, su.barcode, su.name, su.match_rank, su.match_field_rank,
               si.snapshot_product_id,
               CASE WHEN si.snapshot_product_id IS NOT NULL THEN true ELSE false END AS in_snapshot
        FROM search_unique su
        LEFT JOIN snapshot_inventory si ON si.bsale_variant_id = su.bsale_variant_id
        ORDER BY su.match_rank ASC, su.match_field_rank ASC, su.name ASC, su.bsale_variant_id ASC
        LIMIT v_limit
    )
    SELECT coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'product_id', r.product_id,
            'bsale_variant_id', r.bsale_variant_id,
            'sku', r.sku,
            'barcode', r.barcode,
            'name', r.name,
            'snapshot_product_id', r.snapshot_product_id,
            'in_snapshot', r.in_snapshot
        ) ORDER BY r.match_rank ASC, r.match_field_rank ASC, r.name ASC, r.bsale_variant_id ASC
    ), '[]'::jsonb)
    INTO v_results
    FROM ranked_results r;

    RETURN v_results;
END;
$function$;

ALTER FUNCTION inventarios.search_master_products(uuid, uuid, text, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.search_master_products(uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.search_master_products(uuid, uuid, text, integer) TO authenticated;


-- 3) Caso A: submit_mobile_manual_match_count (NUEVA RPC)
CREATE OR REPLACE FUNCTION inventarios.submit_mobile_manual_match_count(p_zone_id uuid, p_location_id uuid, p_snapshot_product_id uuid, p_physical_quantity numeric, p_scanned_code text, p_idempotency_key uuid, p_captured_at timestamp with time zone, p_device_id text, p_evidence_storage_path text, p_evidence_mime_type text, p_evidence_file_size bigint, p_evidence_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_company_id uuid;
    v_session_id uuid;
    v_snapshot_id uuid;
    v_session_zone_id uuid;
    v_task_id uuid;
    v_task_cycle integer;
    v_assignment_id uuid;
    v_is_authorized boolean := false;
    v_is_open boolean := false;
    v_snapshot_location_id uuid;
    v_clean_scanned_code text;
    v_clean_device_id text;
    v_clean_storage_path text;
    v_clean_mime_type text;
    v_clean_sha256 text;
    v_has_evidence boolean := false;
    v_extension text;
    v_expected_storage_path text;
    v_storage_meta jsonb;
    v_count_idempotency_key uuid;
    v_count_event_key uuid;
    v_proposal_event_key uuid;
    v_quantities_payload jsonb;
    v_count_result jsonb;
    v_count_entry_id uuid;
    v_count_occurred_at timestamptz;
    v_count_event_id uuid;
    v_proposal_id uuid;
    v_proposal_event_id uuid;
    v_evidence_id uuid;
    v_occurred_at timestamptz;
    v_captured_at timestamptz;
    v_request_payload jsonb;
    v_request_hash text;
    v_operation jsonb;
    v_operation_id uuid;
    v_replay_payload jsonb;
    v_response jsonb;
BEGIN
    IF p_snapshot_product_id IS NULL OR p_physical_quantity IS NULL OR p_physical_quantity < 0 OR p_idempotency_key IS NULL OR p_captured_at IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;
    v_clean_scanned_code := pg_catalog.btrim(p_scanned_code);
    v_clean_device_id := pg_catalog.btrim(p_device_id);
    IF v_clean_scanned_code IS NULL OR v_clean_scanned_code = '' OR v_clean_device_id IS NULL OR v_clean_device_id = '' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;

    v_clean_storage_path := pg_catalog.btrim(p_evidence_storage_path);
    v_clean_mime_type := pg_catalog.btrim(p_evidence_mime_type);
    v_clean_sha256 := pg_catalog.btrim(p_evidence_sha256);
    v_has_evidence := v_clean_storage_path IS NOT NULL OR v_clean_mime_type IS NOT NULL OR p_evidence_file_size IS NOT NULL OR v_clean_sha256 IS NOT NULL;
    IF v_has_evidence AND (v_clean_storage_path IS NULL OR v_clean_mime_type IS NULL OR p_evidence_file_size IS NULL OR v_clean_sha256 IS NULL) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;
    IF v_has_evidence THEN
        IF p_evidence_file_size < 1 OR p_evidence_file_size > 10485760 OR v_clean_sha256 !~ '^[0-9A-Fa-f]{64}$' THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
        END IF;
        CASE v_clean_mime_type
            WHEN 'image/jpeg' THEN v_extension := '.jpg';
            WHEN 'image/png' THEN v_extension := '.png';
            WHEN 'image/webp' THEN v_extension := '.webp';
            ELSE
                RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
        END CASE;
    END IF;

    v_actor_id := inventarios.require_actor();

    SELECT z.company_id, z.session_id, z.snapshot_id, z.id, t.id, t.validation_cycle, a.id, true
    INTO v_company_id, v_session_id, v_snapshot_id, v_session_zone_id, v_task_id, v_task_cycle, v_assignment_id, v_is_authorized
    FROM inventarios.task_assignments a
    JOIN inventarios.tasks t ON t.id = a.task_id
    JOIN inventarios.session_zones z ON z.id = t.session_zone_id
    JOIN inventarios.sessions s ON s.id = z.session_id
    JOIN inventarios.session_participants p ON p.id = a.session_participant_id
    WHERE z.id = p_zone_id AND a.user_id = v_actor_id AND a.released_at IS NULL
      AND p.user_id = v_actor_id AND p.functional_role = 'COUNTER'
      AND p.active_from <= pg_catalog.now() AND p.revoked_at IS NULL
      AND s.status = 'COUNTING' AND z.is_enabled = true AND t.status = 'IN_PROGRESS'
      AND t.active_user_id = v_actor_id
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL AND t.invalidated_at IS NULL;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED', DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;
    PERFORM inventarios.require_company_access(v_company_id);

    SELECT true, szl.snapshot_location_id INTO v_is_open, v_snapshot_location_id
    FROM inventarios.task_locations tl
    JOIN inventarios.session_zone_locations szl ON szl.id = tl.session_zone_location_id
    WHERE tl.company_id = v_company_id AND tl.task_id = v_task_id AND tl.session_zone_id = p_zone_id
      AND szl.session_zone_id = p_zone_id AND szl.location_id = p_location_id
      AND tl.opened_by = v_actor_id AND tl.status = 'OPEN';
    IF v_is_open IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED', DETAIL = pg_catalog.jsonb_build_object('message', 'La ubicación no está abierta para esta tarea.', 'retryable', false)::text;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM inventarios.snapshot_products sp
        WHERE sp.company_id = v_company_id AND sp.snapshot_id = v_snapshot_id AND sp.id = p_snapshot_product_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_PRODUCT', DETAIL = pg_catalog.jsonb_build_object('message', 'El producto no pertenece al inventario activo.', 'retryable', false)::text;
    END IF;

    -- Revalidacion: el scanned_code NO debe estar asociado oficialmente a otro producto
    IF EXISTS (
        SELECT 1 FROM integraciones.bsale_variants bv
        WHERE bv.company_id = v_company_id AND bv.state = 0 AND bv.bar_code = v_clean_scanned_code
    ) OR EXISTS (
        SELECT 1 FROM inventarios.snapshot_products sp
        WHERE sp.company_id = v_company_id AND sp.snapshot_id = v_snapshot_id
          AND sp.barcode = v_clean_scanned_code AND sp.id IS DISTINCT FROM p_snapshot_product_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_BARCODE_ALREADY_ASSOCIATED', DETAIL = pg_catalog.jsonb_build_object('message', 'El código de barras ya está asociado a un producto de la maestra.', 'retryable', false)::text;
    END IF;

    -- No debe existir propuesta PENDING_REVIEW para el mismo barcode ligada a OTRO producto
    IF EXISTS (
        SELECT 1
        FROM inventarios.product_barcode_proposals pbp
        JOIN inventarios.count_entries ce ON ce.id = pbp.count_entry_id
        WHERE pbp.company_id = v_company_id
          AND pbp.session_id = v_session_id
          AND pbp.status = 'PENDING_REVIEW'
          AND pbp.scanned_code = v_clean_scanned_code
          AND ce.snapshot_product_id IS DISTINCT FROM p_snapshot_product_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_BARCODE_ALREADY_PROPOSED', DETAIL = pg_catalog.jsonb_build_object('message', 'El código de barras ya fue propuesto para otro producto y está pendiente de revisión.', 'retryable', false)::text;
    END IF;

    IF v_has_evidence THEN
        v_expected_storage_path := v_company_id::text || '/' || v_session_id::text || '/' || v_actor_id::text || '/' || p_idempotency_key::text || v_extension;
        IF v_clean_storage_path <> v_expected_storage_path THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
        END IF;
    END IF;

    v_count_idempotency_key := (pg_catalog.md5(p_idempotency_key::text || ':COUNT'))::uuid;
    v_count_event_key := (pg_catalog.md5(v_count_idempotency_key::text || ':COUNT_RECORDED'))::uuid;
    v_proposal_event_key := (pg_catalog.md5(p_idempotency_key::text || ':BARCODE_PROPOSED'))::uuid;

    v_request_payload := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.mobile.manual_match.submit',
        'zone_id', p_zone_id,
        'location_id', p_location_id,
        'snapshot_product_id', p_snapshot_product_id,
        'physical_quantity', p_physical_quantity,
        'scanned_code', v_clean_scanned_code,
        'captured_at', p_captured_at,
        'device_id', v_clean_device_id,
        'has_evidence', v_has_evidence
    );
    v_request_hash := inventarios.compute_request_hash(v_request_payload);
    v_operation := inventarios.begin_idempotent_operation(v_company_id, 'inventarios.mobile.manual_match.submit', p_idempotency_key, v_request_hash);

    IF v_operation ->> 'mode' = 'REPLAY' THEN
        v_replay_payload := v_operation -> 'response_payload';
        v_count_entry_id := (v_replay_payload ->> 'entity_id')::uuid;
        v_count_event_id := (v_replay_payload -> 'data' ->> 'count_event_id')::uuid;
        v_proposal_id := (v_replay_payload -> 'data' ->> 'proposal_id')::uuid;
        v_proposal_event_id := (v_replay_payload -> 'data' ->> 'barcode_proposed_event_id')::uuid;
        v_evidence_id := (v_replay_payload -> 'data' ->> 'evidence_file_id')::uuid;
        IF NOT EXISTS (
            SELECT 1 FROM inventarios.count_entries ce
            WHERE ce.company_id = v_company_id AND ce.session_id = v_session_id AND ce.task_id = v_task_id
              AND ce.snapshot_product_id = p_snapshot_product_id AND ce.snapshot_location_id = v_snapshot_location_id
              AND ce.id = v_count_entry_id AND ce.offline_id = v_count_idempotency_key
        ) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM inventarios.product_barcode_proposals pbp
            WHERE pbp.company_id = v_company_id AND pbp.session_id = v_session_id
              AND pbp.id = v_proposal_id AND pbp.count_entry_id = v_count_entry_id
              AND pbp.status = 'PENDING_REVIEW'
        ) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM inventarios.task_events te
            WHERE te.company_id = v_company_id AND te.session_id = v_session_id AND te.session_zone_id = v_session_zone_id
              AND te.task_id = v_task_id AND te.id = v_count_event_id
              AND te.event_type = 'COUNT_RECORDED' AND te.idempotency_key = v_count_event_key
              AND te.technical_metadata ->> 'count_entry_id' = v_count_entry_id::text
        ) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM inventarios.task_events te
            WHERE te.company_id = v_company_id AND te.session_id = v_session_id AND te.session_zone_id = v_session_zone_id
              AND te.task_id = v_task_id AND te.id = v_proposal_event_id
              AND te.event_type = 'BARCODE_PROPOSED' AND te.idempotency_key = v_proposal_event_key
              AND te.technical_metadata ->> 'proposal_id' = v_proposal_id::text
        ) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;
        RETURN v_replay_payload;
    END IF;

    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    v_occurred_at := pg_catalog.now();
    IF p_captured_at > v_occurred_at THEN v_captured_at := v_occurred_at; ELSE v_captured_at := p_captured_at; END IF;

    IF v_has_evidence THEN
        SELECT so.metadata INTO v_storage_meta FROM storage.objects so
        WHERE so.bucket_id = 'inventory-evidence' AND so.name = v_expected_storage_path AND so.owner = v_actor_id;
        IF v_storage_meta IS NULL THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;
        IF COALESCE((v_storage_meta ->> 'size')::bigint, 0) <> p_evidence_file_size
           OR COALESCE(v_storage_meta ->> 'mimetype', '') <> v_clean_mime_type THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
        END IF;
        IF EXISTS (
            SELECT 1 FROM inventarios.evidence_files ef
            WHERE ef.storage_bucket = 'inventory-evidence' AND ef.storage_path = v_expected_storage_path
        ) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
        END IF;
    END IF;

    v_quantities_payload := pg_catalog.jsonb_build_object(
        'available_quantity', p_physical_quantity,
        'blocked_quantity', 0,
        'damaged_quantity', 0,
        'expired_quantity', 0,
        'other_unavailable_quantity', 0
    );

    v_count_result := inventarios.record_inventory_count(
        v_company_id,
        v_task_id,
        v_task_cycle,
        p_snapshot_product_id,
        v_snapshot_location_id,
        v_quantities_payload,
        'SEARCH_MANUAL',
        v_clean_scanned_code,
        'MOBILE',
        v_count_idempotency_key,
        v_clean_device_id,
        v_captured_at,
        v_count_idempotency_key
    );
    v_count_entry_id := (v_count_result ->> 'entity_id')::uuid;
    v_count_occurred_at := COALESCE((v_count_result ->> 'occurred_at')::timestamptz, v_occurred_at);

    INSERT INTO inventarios.product_barcode_proposals (
        company_id, session_id, count_entry_id, scanned_code, status,
        proposed_by, proposed_at, created_by, updated_by
    ) VALUES (
        v_company_id, v_session_id, v_count_entry_id, v_clean_scanned_code, 'PENDING_REVIEW',
        v_actor_id, v_count_occurred_at, v_actor_id, v_actor_id
    ) RETURNING id INTO v_proposal_id;

    INSERT INTO inventarios.task_events (
        company_id, session_id, session_zone_id, task_id, event_type,
        previous_status, next_status, actor_id, cycle, occurred_at,
        idempotency_key, source, technical_metadata, created_at, created_by
    ) VALUES (
        v_company_id, v_session_id, v_session_zone_id, v_task_id, 'COUNT_RECORDED',
        'IN_PROGRESS', 'IN_PROGRESS', v_actor_id, v_task_cycle, v_count_occurred_at,
        v_count_event_key, 'ANDROID',
        pg_catalog.jsonb_build_object('count_entry_id', v_count_entry_id, 'snapshot_product_id', p_snapshot_product_id),
        v_count_occurred_at, v_actor_id
    ) ON CONFLICT (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;

    INSERT INTO inventarios.task_events (
        company_id, session_id, session_zone_id, task_id, event_type,
        previous_status, next_status, actor_id, cycle, occurred_at,
        idempotency_key, source, technical_metadata, created_at, created_by
    ) VALUES (
        v_company_id, v_session_id, v_session_zone_id, v_task_id, 'BARCODE_PROPOSED',
        'IN_PROGRESS', 'IN_PROGRESS', v_actor_id, v_task_cycle, v_count_occurred_at,
        v_proposal_event_key, 'ANDROID',
        pg_catalog.jsonb_build_object('proposal_id', v_proposal_id, 'count_entry_id', v_count_entry_id, 'scanned_code', v_clean_scanned_code, 'snapshot_product_id', p_snapshot_product_id),
        v_count_occurred_at, v_actor_id
    ) ON CONFLICT (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING id INTO v_proposal_event_id;

    SELECT te.id INTO v_count_event_id
    FROM inventarios.task_events te
    WHERE te.company_id = v_company_id AND te.task_id = v_task_id AND te.idempotency_key = v_count_event_key;

    IF v_count_event_id IS NULL OR v_proposal_event_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
    END IF;

    IF v_has_evidence THEN
        INSERT INTO inventarios.evidence_files (
            company_id, session_id, proposal_id, storage_bucket, storage_path,
            original_name, mime_type, file_size_bytes, sha256,
            captured_by, captured_at, uploaded_by, uploaded_at,
            device_id, offline_idempotency_key, source, sync_status,
            created_by, updated_by
        ) VALUES (
            v_company_id, v_session_id, v_proposal_id, 'inventory-evidence', v_expected_storage_path,
            p_idempotency_key::text || v_extension, v_clean_mime_type, p_evidence_file_size, v_clean_sha256,
            v_actor_id, v_captured_at, v_actor_id, v_occurred_at,
            v_clean_device_id, p_idempotency_key, 'ANDROID', 'PENDING',
            v_actor_id, v_actor_id
        ) RETURNING id INTO v_evidence_id;
    END IF;

    v_response := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.mobile.manual_match.submit',
        'entity_id', v_count_entry_id,
        'state', 'IN_PROGRESS',
        'version', NULL::integer,
        'cycle_number', v_task_cycle,
        'assignment_id', v_assignment_id,
        'event_id', v_proposal_event_id,
        'replayed', false,
        'occurred_at', v_count_occurred_at,
        'data', pg_catalog.jsonb_build_object(
            'snapshot_product_id', p_snapshot_product_id,
            'count_entry_id', v_count_entry_id,
            'count_event_id', v_count_event_id,
            'proposal_id', v_proposal_id,
            'barcode_proposed_event_id', v_proposal_event_id,
            'evidence_file_id', v_evidence_id,
            'scanned_code', v_clean_scanned_code,
            'status', 'PENDING_REVIEW'
        )
    );

    RETURN inventarios.complete_idempotent_operation(v_company_id, v_operation_id, v_count_entry_id, v_response);
END;
$function$;

ALTER FUNCTION inventarios.submit_mobile_manual_match_count(uuid, uuid, uuid, numeric, text, uuid, timestamp with time zone, text, text, text, bigint, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.submit_mobile_manual_match_count(uuid, uuid, uuid, numeric, text, uuid, timestamp with time zone, text, text, text, bigint, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.submit_mobile_manual_match_count(uuid, uuid, uuid, numeric, text, uuid, timestamp with time zone, text, text, text, bigint, text) TO authenticated;


-- 4) Caso B: submit_mobile_discovery_count -> autorizacion COUNTER contextual + evidencia opcional
CREATE OR REPLACE FUNCTION inventarios.submit_mobile_discovery_count(p_zone_id uuid, p_location_id uuid, p_bsale_variant_id integer, p_physical_quantity numeric, p_scanned_code text, p_evidence_storage_path text, p_evidence_mime_type text, p_evidence_file_size bigint, p_evidence_sha256 text, p_idempotency_key uuid, p_captured_at timestamp with time zone, p_device_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_company_id uuid;
    v_task_id uuid;
    v_session_id uuid;
    v_session_zone_id uuid;
    v_snapshot_id uuid;
    v_task_cycle integer;
    v_assignment_id uuid;
    v_is_authorized boolean := false;
    v_is_open boolean := false;
    v_snapshot_location_id uuid;
    v_snapshot_product_id uuid;
    v_master_product_id uuid;
    v_master_sku text;
    v_master_barcode text;
    v_master_name text;
    v_clean_scanned_code text;
    v_clean_storage_path text;
    v_clean_mime_type text;
    v_clean_sha256 text;
    v_clean_device_id text;
    v_has_evidence boolean := false;
    v_extension text;
    v_expected_storage_path text;
    v_storage_meta jsonb;
    v_request_payload jsonb;
    v_request_hash text;
    v_operation jsonb;
    v_operation_id uuid;
    v_count_result jsonb;
    v_count_entry_id uuid;
    v_count_event_id uuid;
    v_count_idempotency_key uuid;
    v_count_event_key uuid;
    v_proposal_id uuid;
    v_evidence_id uuid;
    v_discovery_event_id uuid;
    v_discovery_event_key uuid;
    v_response jsonb;
    v_occurred_at timestamptz;
    v_captured_at timestamptz;
    v_replay_payload jsonb;
BEGIN
    IF p_zone_id IS NULL OR p_location_id IS NULL OR p_bsale_variant_id IS NULL OR p_physical_quantity IS NULL OR p_physical_quantity < 0 OR p_idempotency_key IS NULL OR p_captured_at IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;
    v_clean_scanned_code := pg_catalog.btrim(p_scanned_code);
    v_clean_storage_path := pg_catalog.btrim(p_evidence_storage_path);
    v_clean_mime_type := pg_catalog.btrim(p_evidence_mime_type);
    v_clean_sha256 := pg_catalog.btrim(p_evidence_sha256);
    v_clean_device_id := pg_catalog.btrim(p_device_id);
    IF v_clean_scanned_code IS NULL OR v_clean_scanned_code = '' OR v_clean_device_id IS NULL OR v_clean_device_id = '' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;
    v_has_evidence := v_clean_storage_path IS NOT NULL OR v_clean_mime_type IS NOT NULL OR p_evidence_file_size IS NOT NULL OR v_clean_sha256 IS NOT NULL;
    IF v_has_evidence AND (v_clean_storage_path IS NULL OR v_clean_mime_type IS NULL OR p_evidence_file_size IS NULL OR v_clean_sha256 IS NULL) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;
    IF v_has_evidence THEN
        IF p_evidence_file_size < 1 OR p_evidence_file_size > 10485760 OR v_clean_sha256 !~ '^[0-9A-Fa-f]{64}$' THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
        END IF;
        CASE v_clean_mime_type
            WHEN 'image/jpeg' THEN v_extension := '.jpg';
            WHEN 'image/png' THEN v_extension := '.png';
            WHEN 'image/webp' THEN v_extension := '.webp';
            ELSE
                RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
        END CASE;
    END IF;
    v_actor_id := inventarios.require_actor();

    SELECT z.company_id, t.id, z.session_id, z.snapshot_id, z.id, t.validation_cycle, a.id, true
    INTO v_company_id, v_task_id, v_session_id, v_snapshot_id, v_session_zone_id, v_task_cycle, v_assignment_id, v_is_authorized
    FROM inventarios.task_assignments a
    JOIN inventarios.tasks t ON t.id = a.task_id
    JOIN inventarios.session_zones z ON z.id = t.session_zone_id
    JOIN inventarios.sessions s ON s.id = z.session_id
    JOIN inventarios.session_participants p ON p.id = a.session_participant_id
    WHERE z.id = p_zone_id AND a.user_id = v_actor_id AND a.released_at IS NULL
      AND p.user_id = v_actor_id AND p.functional_role = 'COUNTER'
      AND p.active_from <= pg_catalog.now() AND p.revoked_at IS NULL
      AND s.status = 'COUNTING' AND z.is_enabled = true AND t.status = 'IN_PROGRESS'
      AND t.active_user_id = v_actor_id
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL AND t.invalidated_at IS NULL;
    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED', DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;
    PERFORM inventarios.require_company_access(v_company_id);

    SELECT true, szl.snapshot_location_id INTO v_is_open, v_snapshot_location_id
    FROM inventarios.task_locations tl
    JOIN inventarios.session_zone_locations szl ON szl.id = tl.session_zone_location_id
    WHERE tl.company_id = v_company_id AND tl.task_id = v_task_id AND tl.session_zone_id = p_zone_id
      AND szl.session_zone_id = p_zone_id AND szl.location_id = p_location_id
      AND tl.opened_by = v_actor_id AND tl.status = 'OPEN';
    IF v_is_open IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED', DETAIL = pg_catalog.jsonb_build_object('message', 'La ubicación no está abierta para esta tarea.', 'retryable', false)::text;
    END IF;

    IF v_has_evidence THEN
        v_expected_storage_path := v_company_id::text || '/' || v_session_id::text || '/' || v_actor_id::text || '/' || p_idempotency_key::text || v_extension;
        IF v_clean_storage_path <> v_expected_storage_path THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
        END IF;
    END IF;

    SELECT p.id, bv.code, bv.bar_code, pg_catalog.concat_ws(' - ', bp.name, bv.description)
    INTO v_master_product_id, v_master_sku, v_master_barcode, v_master_name
    FROM adquisiciones.products p
    JOIN integraciones.bsale_variants bv ON bv.company_id = p.company_id AND bv.bsale_id = p.bsale_variant_id
    JOIN integraciones.bsale_products bp ON bp.company_id = bv.company_id AND bp.bsale_id = bv.bsale_product_id
    WHERE p.company_id = v_company_id AND p.is_active = true AND bv.state = 0 AND bp.state = 0 AND bv.bsale_id = p_bsale_variant_id AND bv.code IS NOT NULL AND pg_catalog.btrim(bv.code) <> ''
    ORDER BY p.updated_at DESC NULLS LAST, p.id, bv.id, bp.id LIMIT 1;
    IF v_master_sku IS NULL OR v_master_name IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_PRODUCT', DETAIL = pg_catalog.jsonb_build_object('message', 'El producto no pertenece al inventario activo.', 'retryable', false)::text;
    END IF;

    v_count_idempotency_key := (pg_catalog.md5(p_idempotency_key::text || ':COUNT'))::uuid;
    v_count_event_key := (pg_catalog.md5(v_count_idempotency_key::text || ':COUNT_RECORDED'))::uuid;
    v_discovery_event_key := (pg_catalog.md5(p_idempotency_key::text || ':DISCOVERY_RECORDED'))::uuid;

    v_request_payload := pg_catalog.jsonb_build_object('operation', 'inventarios.mobile.discovery.submit', 'zone_id', p_zone_id, 'location_id', p_location_id, 'bsale_variant_id', p_bsale_variant_id, 'physical_quantity', p_physical_quantity, 'scanned_code', v_clean_scanned_code, 'evidence_storage_path', v_clean_storage_path, 'evidence_mime_type', v_clean_mime_type, 'evidence_file_size', p_evidence_file_size, 'evidence_sha256', v_clean_sha256, 'captured_at', p_captured_at, 'device_id', v_clean_device_id);
    v_request_hash := inventarios.compute_request_hash(v_request_payload);
    v_operation := inventarios.begin_idempotent_operation(v_company_id, 'inventarios.mobile.discovery.submit', p_idempotency_key, v_request_hash);
    IF v_operation ->> 'mode' = 'REPLAY' THEN
        v_replay_payload := v_operation -> 'response_payload';
        v_count_entry_id := (v_replay_payload ->> 'entity_id')::uuid;
        v_count_event_id := (v_replay_payload -> 'data' ->> 'count_event_id')::uuid;
        v_snapshot_product_id := (v_replay_payload -> 'data' ->> 'snapshot_product_id')::uuid;
        v_proposal_id := (v_replay_payload -> 'data' ->> 'proposal_id')::uuid;
        v_evidence_id := (v_replay_payload -> 'data' ->> 'evidence_file_id')::uuid;
        v_discovery_event_id := (v_replay_payload -> 'data' ->> 'discovery_event_id')::uuid;
        IF NOT EXISTS (SELECT 1 FROM inventarios.snapshot_products sp WHERE sp.company_id = v_company_id AND sp.snapshot_id = v_snapshot_id AND sp.id = v_snapshot_product_id AND sp.bsale_variant_id = p_bsale_variant_id) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM inventarios.count_entries ce WHERE ce.company_id = v_company_id AND ce.session_id = v_session_id AND ce.task_id = v_task_id AND ce.snapshot_location_id = v_snapshot_location_id AND ce.snapshot_product_id = v_snapshot_product_id AND ce.id = v_count_entry_id AND ce.offline_id = v_count_idempotency_key) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM inventarios.product_barcode_proposals pbp WHERE pbp.company_id = v_company_id AND pbp.session_id = v_session_id AND pbp.id = v_proposal_id AND pbp.count_entry_id = v_count_entry_id) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;
        IF v_evidence_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM inventarios.evidence_files ef WHERE ef.company_id = v_company_id AND ef.session_id = v_session_id AND ef.id = v_evidence_id AND ef.proposal_id = v_proposal_id AND ef.storage_bucket = 'inventory-evidence' AND ef.storage_path = v_expected_storage_path) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM inventarios.task_events te WHERE te.company_id = v_company_id AND te.session_id = v_session_id AND te.session_zone_id = v_session_zone_id AND te.task_id = v_task_id AND te.id = v_count_event_id AND te.event_type = 'COUNT_RECORDED' AND te.idempotency_key = v_count_event_key AND te.technical_metadata ->> 'count_entry_id' = v_count_entry_id::text AND te.technical_metadata ->> 'snapshot_product_id' = v_snapshot_product_id::text) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM inventarios.task_events te WHERE te.company_id = v_company_id AND te.session_id = v_session_id AND te.task_id = v_task_id AND te.id = v_discovery_event_id AND te.event_type = 'DISCOVERY_RECORDED' AND te.idempotency_key = v_discovery_event_key AND te.technical_metadata ->> 'count_entry_id' = v_count_entry_id::text AND te.technical_metadata ->> 'proposal_id' = v_proposal_id::text AND te.technical_metadata ->> 'evidence_id' = v_evidence_id::text) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;
        RETURN v_replay_payload;
    END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    v_occurred_at := pg_catalog.now();
    v_captured_at := p_captured_at;
    IF v_captured_at > v_occurred_at THEN v_captured_at := v_occurred_at; END IF;

    IF v_has_evidence THEN
        SELECT so.metadata INTO v_storage_meta FROM storage.objects so WHERE so.bucket_id = 'inventory-evidence' AND so.name = v_expected_storage_path AND so.owner = v_actor_id;
        IF v_storage_meta IS NULL THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text; END IF;
        IF COALESCE((v_storage_meta ->> 'size')::bigint, 0) <> p_evidence_file_size OR p_evidence_file_size < 1 OR p_evidence_file_size > 10485760 THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text; END IF;
        IF COALESCE(v_storage_meta ->> 'mimetype', '') <> v_clean_mime_type THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text; END IF;
        IF EXISTS (SELECT 1 FROM inventarios.evidence_files ef WHERE ef.storage_bucket = 'inventory-evidence' AND ef.storage_path = v_expected_storage_path) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text; END IF;
    END IF;

    INSERT INTO inventarios.snapshot_products (company_id, snapshot_id, product_id, bsale_variant_id, sku, barcode, name, product_metadata, created_by)
    VALUES (v_company_id, v_snapshot_id, v_master_product_id, p_bsale_variant_id, v_master_sku, v_master_barcode, v_master_name, NULL::jsonb, v_actor_id)
    ON CONFLICT (company_id, snapshot_id, bsale_variant_id) DO NOTHING;
    SELECT sp.id INTO v_snapshot_product_id FROM inventarios.snapshot_products sp WHERE sp.company_id = v_company_id AND sp.snapshot_id = v_snapshot_id AND sp.bsale_variant_id = p_bsale_variant_id ORDER BY sp.id LIMIT 1;
    IF v_snapshot_product_id IS NULL THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text; END IF;
    v_count_result := inventarios.submit_my_mobile_count(p_zone_id, p_location_id, v_snapshot_product_id, p_physical_quantity, 'SEARCH_MANUAL', v_clean_scanned_code, v_count_idempotency_key, v_captured_at, v_clean_device_id);
    v_count_entry_id := (v_count_result ->> 'entity_id')::uuid;
    v_count_event_id := (v_count_result -> 'data' ->> 'count_event_id')::uuid;
    INSERT INTO inventarios.product_barcode_proposals (company_id, session_id, count_entry_id, scanned_code, status, proposed_by, proposed_at, created_by, updated_by)
    VALUES (v_company_id, v_session_id, v_count_entry_id, v_clean_scanned_code, 'PENDING_REVIEW', v_actor_id, v_captured_at, v_actor_id, v_actor_id) RETURNING id INTO v_proposal_id;
    IF v_has_evidence THEN
        INSERT INTO inventarios.evidence_files (company_id, session_id, proposal_id, storage_bucket, storage_path, original_name, mime_type, file_size_bytes, sha256, captured_by, captured_at, uploaded_by, uploaded_at, device_id, offline_idempotency_key, source, sync_status, created_by, updated_by)
        VALUES (v_company_id, v_session_id, v_proposal_id, 'inventory-evidence', v_expected_storage_path, p_idempotency_key::text || v_extension, v_clean_mime_type, p_evidence_file_size, v_clean_sha256, v_actor_id, v_captured_at, v_actor_id, v_occurred_at, v_clean_device_id, p_idempotency_key, 'ANDROID', 'PENDING', v_actor_id, v_actor_id) RETURNING id INTO v_evidence_id;
    END IF;
    IF v_count_event_id IS NULL THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text; END IF;
    INSERT INTO inventarios.task_events (company_id, session_id, session_zone_id, task_id, event_type, previous_status, next_status, actor_id, cycle, occurred_at, idempotency_key, source, technical_metadata, created_at, created_by)
    VALUES (v_company_id, v_session_id, v_session_zone_id, v_task_id, 'DISCOVERY_RECORDED', 'IN_PROGRESS', 'IN_PROGRESS', v_actor_id, v_task_cycle, v_occurred_at, v_discovery_event_key, 'ANDROID', pg_catalog.jsonb_build_object('count_entry_id', v_count_entry_id, 'proposal_id', v_proposal_id, 'evidence_id', v_evidence_id), v_occurred_at, v_actor_id)
    RETURNING id INTO v_discovery_event_id;
    v_response := pg_catalog.jsonb_build_object('operation', 'inventarios.mobile.discovery.submit', 'entity_id', v_count_entry_id, 'state', 'IN_PROGRESS', 'version', NULL::integer, 'cycle_number', v_task_cycle, 'assignment_id', v_assignment_id, 'event_id', v_discovery_event_id, 'replayed', false, 'occurred_at', v_occurred_at, 'data', pg_catalog.jsonb_build_object('snapshot_product_id', v_snapshot_product_id, 'count_entry_id', v_count_entry_id, 'count_event_id', v_count_event_id, 'proposal_id', v_proposal_id, 'evidence_file_id', v_evidence_id, 'discovery_event_id', v_discovery_event_id, 'bsale_variant_id', p_bsale_variant_id, 'storage_bucket', 'inventory-evidence', 'storage_path', v_expected_storage_path));
    RETURN inventarios.complete_idempotent_operation(v_company_id, v_operation_id, v_count_entry_id, v_response);
END;
$function$;

ALTER FUNCTION inventarios.submit_mobile_discovery_count(uuid, uuid, integer, numeric, text, text, text, bigint, text, uuid, timestamp with time zone, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.submit_mobile_discovery_count(uuid, uuid, integer, numeric, text, text, text, bigint, text, uuid, timestamp with time zone, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.submit_mobile_discovery_count(uuid, uuid, integer, numeric, text, text, text, bigint, text, uuid, timestamp with time zone, text) TO authenticated;
