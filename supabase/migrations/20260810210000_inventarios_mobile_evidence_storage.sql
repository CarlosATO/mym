-- =========================================================================================
-- MIGRATION: M1.5D-ERP - Storage de Evidencia Fotográfica
-- =========================================================================================

ALTER TABLE inventarios.task_events DROP CONSTRAINT IF EXISTS chk_inventarios_events_type;
ALTER TABLE inventarios.task_events ADD CONSTRAINT chk_inventarios_events_type
CHECK (event_type IN ('STARTED', 'RESUMED', 'REOPENED', 'REASSIGNED', 'VALIDATED', 'INVALIDATED', 'CANCELLED', 'LOCATION_OPENED', 'COUNT_RECORDED', 'DISCOVERY_RECORDED'));

-- 1. Bucket privado para evidencia móvil de inventario.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'inventory-evidence',
    'inventory-evidence',
    false,
    10485760,
    ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
)
ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- 2. Modelo mínimo de propuesta de barcode descubierto.
CREATE TABLE IF NOT EXISTS inventarios.product_barcode_proposals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    session_id uuid NOT NULL,
    count_entry_id uuid NOT NULL,
    scanned_code text NOT NULL,
    status text NOT NULL DEFAULT 'PENDING_REVIEW',
    proposed_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    proposed_at timestamptz NOT NULL DEFAULT now(),
    review_notes text,
    reviewed_at timestamptz,
    reviewed_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_barcode_proposals_count_context
        FOREIGN KEY (company_id, session_id, count_entry_id)
        REFERENCES inventarios.count_entries(company_id, session_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_barcode_proposals_company_session_id
        UNIQUE (company_id, session_id, id),
    CONSTRAINT uq_inventarios_barcode_proposals_count_entry
        UNIQUE (company_id, count_entry_id),
    CONSTRAINT chk_inventarios_barcode_proposals_scanned_code
        CHECK (length(btrim(scanned_code)) > 0),
    CONSTRAINT chk_inventarios_barcode_proposals_status
        CHECK (status IN ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED')),
    CONSTRAINT chk_inventarios_barcode_proposals_review_state
        CHECK (
            (status = 'PENDING_REVIEW' AND reviewed_at IS NULL AND reviewed_by IS NULL)
            OR (status <> 'PENDING_REVIEW' AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)
        )
);

CREATE INDEX IF NOT EXISTS idx_inventarios_barcode_proposals_session
    ON inventarios.product_barcode_proposals(company_id, session_id, proposed_at DESC);

ALTER TABLE inventarios.product_barcode_proposals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inventarios.product_barcode_proposals FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE inventarios.product_barcode_proposals TO service_role;

-- 3. Ajustes del modelo de evidencia para soportar propuestas.
ALTER TABLE inventarios.evidence_files
    ADD COLUMN IF NOT EXISTS proposal_id uuid;

DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint
        WHERE conrelid = 'inventarios.evidence_files'::pg_catalog.regclass
          AND conname = 'fk_inventarios_evidence_proposal_context'
    ) THEN
        ALTER TABLE inventarios.evidence_files
            ADD CONSTRAINT fk_inventarios_evidence_proposal_context
            FOREIGN KEY (company_id, session_id, proposal_id)
            REFERENCES inventarios.product_barcode_proposals(company_id, session_id, id)
            ON DELETE RESTRICT;
    END IF;
END;
$do$;

ALTER TABLE inventarios.evidence_files DROP CONSTRAINT IF EXISTS chk_inventarios_evidence_context;
ALTER TABLE inventarios.evidence_files ADD CONSTRAINT chk_inventarios_evidence_context CHECK (
    pg_catalog.num_nonnulls(incident_id, task_id, count_entry_id, recount_request_id, proposal_id) = 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventarios_evidence_proposal
    ON inventarios.evidence_files(company_id, proposal_id)
    WHERE proposal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventarios_evidence_proposal
    ON inventarios.evidence_files(company_id, proposal_id)
    WHERE proposal_id IS NOT NULL;

-- 4. Helper mínimo para autorizar paths de Storage sin depender de RLS de inventarios.
CREATE OR REPLACE FUNCTION inventarios.is_mobile_evidence_path_allowed(p_object_name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_company_id uuid;
    v_session_id uuid;
BEGIN
    v_actor_id := auth.uid();

    IF v_actor_id IS NULL OR p_object_name IS NULL OR pg_catalog.btrim(p_object_name) = '' THEN
        RETURN false;
    END IF;

    IF p_object_name !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(jpg|png|webp)$' THEN
        RETURN false;
    END IF;

    BEGIN
        v_company_id := pg_catalog.split_part(p_object_name, '/', 1)::uuid;
        v_session_id := pg_catalog.split_part(p_object_name, '/', 2)::uuid;
    EXCEPTION WHEN OTHERS THEN
        RETURN false;
    END;

    IF pg_catalog.split_part(p_object_name, '/', 3)::uuid IS DISTINCT FROM v_actor_id THEN
        RETURN false;
    END IF;

    IF NOT core.has_company_access(v_actor_id, v_company_id) THEN
        RETURN false;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM inventarios.sessions s
        JOIN inventarios.session_participants sp
          ON sp.company_id = s.company_id
         AND sp.session_id = s.id
         AND sp.user_id = v_actor_id
         AND sp.functional_role = 'COUNTER'
         AND sp.revoked_at IS NULL
        WHERE s.company_id = v_company_id
          AND s.id = v_session_id
          AND s.status = 'COUNTING'
    ) THEN
        RETURN false;
    END IF;

    RETURN true;
EXCEPTION WHEN OTHERS THEN
    RETURN false;
END;
$function$;

ALTER FUNCTION inventarios.is_mobile_evidence_path_allowed(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.is_mobile_evidence_path_allowed(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.is_mobile_evidence_path_allowed(text) TO authenticated;

-- 5. Policies de Storage para uploads móviles con path determinista.
DROP POLICY IF EXISTS "Evidencia_INSERT_Mobile" ON storage.objects;
CREATE POLICY "Evidencia_INSERT_Mobile"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
    bucket_id = 'inventory-evidence'
    AND owner = auth.uid()
    AND inventarios.is_mobile_evidence_path_allowed(name)
);

DROP POLICY IF EXISTS "Evidencia_SELECT_Owner_Or_Admin" ON storage.objects;
CREATE POLICY "Evidencia_SELECT_Owner_Or_Admin"
ON storage.objects FOR SELECT TO authenticated
USING (
    bucket_id = 'inventory-evidence'
    AND owner = auth.uid()
    AND inventarios.is_mobile_evidence_path_allowed(name)
);

-- 6. RPC para conteo de descubrimiento móvil con evidencia obligatoria.
CREATE OR REPLACE FUNCTION inventarios.submit_mobile_discovery_count(
    p_zone_id uuid,
    p_location_id uuid,
    p_bsale_variant_id integer,
    p_physical_quantity numeric,
    p_scanned_code text,
    p_evidence_storage_path text,
    p_evidence_mime_type text,
    p_evidence_file_size bigint,
    p_evidence_sha256 text,
    p_idempotency_key uuid,
    p_captured_at timestamptz,
    p_device_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
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
    IF p_zone_id IS NULL OR p_location_id IS NULL OR p_bsale_variant_id IS NULL
       OR p_physical_quantity IS NULL OR p_physical_quantity < 0
       OR p_idempotency_key IS NULL OR p_captured_at IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;

    v_clean_scanned_code := pg_catalog.btrim(p_scanned_code);
    v_clean_storage_path := pg_catalog.btrim(p_evidence_storage_path);
    v_clean_mime_type := pg_catalog.btrim(p_evidence_mime_type);
    v_clean_sha256 := pg_catalog.btrim(p_evidence_sha256);
    v_clean_device_id := pg_catalog.btrim(p_device_id);

    IF v_clean_scanned_code IS NULL OR v_clean_scanned_code = ''
       OR v_clean_storage_path IS NULL OR v_clean_storage_path = ''
       OR v_clean_mime_type IS NULL OR v_clean_mime_type = ''
       OR v_clean_sha256 IS NULL OR v_clean_sha256 = ''
       OR v_clean_device_id IS NULL OR v_clean_device_id = '' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;

    IF p_evidence_file_size IS NULL OR p_evidence_file_size < 1 OR p_evidence_file_size > 10485760 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;

    IF v_clean_sha256 !~ '^[0-9A-Fa-f]{64}$' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;

    CASE v_clean_mime_type
        WHEN 'image/jpeg' THEN v_extension := '.jpg';
        WHEN 'image/png' THEN v_extension := '.png';
        WHEN 'image/webp' THEN v_extension := '.webp';
        ELSE
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
                DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END CASE;

    v_actor_id := inventarios.require_actor();

    SELECT
        z.company_id,
        t.id,
        z.session_id,
        z.snapshot_id,
        z.id,
        t.validation_cycle,
        a.id,
        true
    INTO
        v_company_id,
        v_task_id,
        v_session_id,
        v_snapshot_id,
        v_session_zone_id,
        v_task_cycle,
        v_assignment_id,
        v_is_authorized
    FROM inventarios.task_assignments a
    JOIN inventarios.tasks t ON t.id = a.task_id
    JOIN inventarios.session_zones z ON z.id = t.session_zone_id
    JOIN inventarios.sessions s ON s.id = z.session_id
    JOIN inventarios.session_participants p ON p.id = a.session_participant_id
    WHERE z.id = p_zone_id
      AND a.user_id = v_actor_id
      AND a.released_at IS NULL
      AND p.user_id = v_actor_id
      AND p.functional_role = 'COUNTER'
      AND p.revoked_at IS NULL
      AND s.status = 'COUNTING'
      AND z.is_enabled = true
      AND t.status = 'IN_PROGRESS'
      AND t.cancelled_at IS NULL
      AND t.superseded_at IS NULL
      AND t.invalidated_at IS NULL;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;

    SELECT true, szl.snapshot_location_id
    INTO v_is_open, v_snapshot_location_id
    FROM inventarios.task_locations tl
    JOIN inventarios.session_zone_locations szl ON szl.id = tl.session_zone_location_id
    WHERE tl.company_id = v_company_id
      AND tl.task_id = v_task_id
      AND tl.session_zone_id = p_zone_id
      AND szl.session_zone_id = p_zone_id
      AND szl.location_id = p_location_id
      AND tl.opened_by = v_actor_id
      AND tl.status = 'OPEN';

    IF v_is_open IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La ubicación no está abierta para esta tarea.', 'retryable', false)::text;
    END IF;

    v_expected_storage_path := v_company_id::text || '/' || v_session_id::text || '/' || v_actor_id::text || '/' || p_idempotency_key::text || v_extension;
    v_count_idempotency_key := (pg_catalog.md5(p_idempotency_key::text || ':COUNT'))::uuid;
    v_count_event_key := (pg_catalog.md5(v_count_idempotency_key::text || ':COUNT_RECORDED'))::uuid;
    v_discovery_event_key := (pg_catalog.md5(p_idempotency_key::text || ':DISCOVERY_RECORDED'))::uuid;
    IF v_clean_storage_path <> v_expected_storage_path THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;

    SELECT
        p.id,
        bv.code,
        bv.bar_code,
        pg_catalog.concat_ws(' - ', bp.name, bv.description)
    INTO
        v_master_product_id,
        v_master_sku,
        v_master_barcode,
        v_master_name
    FROM adquisiciones.products p
    JOIN integraciones.bsale_variants bv
      ON bv.company_id = p.company_id
     AND bv.bsale_id = p.bsale_variant_id
    JOIN integraciones.bsale_products bp
      ON bp.company_id = bv.company_id
     AND bp.bsale_id = bv.bsale_product_id
    WHERE p.company_id = v_company_id
      AND p.is_active = true
      AND bv.state = 0
      AND bp.state = 0
      AND bv.bsale_id = p_bsale_variant_id
      AND bv.code IS NOT NULL
      AND pg_catalog.btrim(bv.code) <> ''
    ORDER BY p.updated_at DESC NULLS LAST, p.id, bv.id, bp.id
    LIMIT 1;

    IF v_master_sku IS NULL OR v_master_name IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_PRODUCT',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El producto no pertenece al inventario activo.', 'retryable', false)::text;
    END IF;

    v_request_payload := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.mobile.discovery.submit',
        'zone_id', p_zone_id,
        'location_id', p_location_id,
        'bsale_variant_id', p_bsale_variant_id,
        'physical_quantity', p_physical_quantity,
        'scanned_code', v_clean_scanned_code,
        'evidence_storage_path', v_clean_storage_path,
        'evidence_mime_type', v_clean_mime_type,
        'evidence_file_size', p_evidence_file_size,
        'evidence_sha256', v_clean_sha256,
        'captured_at', p_captured_at,
        'device_id', v_clean_device_id
    );
    v_request_hash := inventarios.compute_request_hash(v_request_payload);

    v_operation := inventarios.begin_idempotent_operation(
        v_company_id,
        'inventarios.mobile.discovery.submit',
        p_idempotency_key,
        v_request_hash
    );

    IF v_operation ->> 'mode' = 'REPLAY' THEN
        v_replay_payload := v_operation -> 'response_payload';
        v_count_entry_id := (v_replay_payload ->> 'entity_id')::uuid;
        v_count_event_id := (v_replay_payload -> 'data' ->> 'count_event_id')::uuid;
        v_snapshot_product_id := (v_replay_payload -> 'data' ->> 'snapshot_product_id')::uuid;
        v_proposal_id := (v_replay_payload -> 'data' ->> 'proposal_id')::uuid;
        v_evidence_id := (v_replay_payload -> 'data' ->> 'evidence_file_id')::uuid;
        v_discovery_event_id := (v_replay_payload -> 'data' ->> 'discovery_event_id')::uuid;

        IF NOT EXISTS (
            SELECT 1
            FROM inventarios.snapshot_products sp
            WHERE sp.company_id = v_company_id
              AND sp.snapshot_id = v_snapshot_id
              AND sp.id = v_snapshot_product_id
              AND sp.bsale_variant_id = p_bsale_variant_id
        ) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
                DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;

        IF NOT EXISTS (
            SELECT 1
            FROM inventarios.count_entries ce
            WHERE ce.company_id = v_company_id
              AND ce.session_id = v_session_id
              AND ce.task_id = v_task_id
              AND ce.snapshot_location_id = v_snapshot_location_id
              AND ce.snapshot_product_id = v_snapshot_product_id
              AND ce.id = v_count_entry_id
              AND ce.offline_id = v_count_idempotency_key
        ) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
                DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;

        IF NOT EXISTS (
            SELECT 1
            FROM inventarios.product_barcode_proposals pbp
            WHERE pbp.company_id = v_company_id
              AND pbp.session_id = v_session_id
              AND pbp.id = v_proposal_id
              AND pbp.count_entry_id = v_count_entry_id
        ) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
                DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;

        IF NOT EXISTS (
            SELECT 1
            FROM inventarios.evidence_files ef
            WHERE ef.company_id = v_company_id
              AND ef.session_id = v_session_id
              AND ef.id = v_evidence_id
              AND ef.proposal_id = v_proposal_id
              AND ef.storage_bucket = 'inventory-evidence'
              AND ef.storage_path = v_expected_storage_path
        ) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
                DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;

        IF NOT EXISTS (
            SELECT 1
            FROM inventarios.task_events te
            WHERE te.company_id = v_company_id
              AND te.session_id = v_session_id
              AND te.session_zone_id = v_session_zone_id
              AND te.task_id = v_task_id
              AND te.id = v_count_event_id
              AND te.event_type = 'COUNT_RECORDED'
              AND te.idempotency_key = v_count_event_key
              AND te.technical_metadata ->> 'count_entry_id' = v_count_entry_id::text
              AND te.technical_metadata ->> 'snapshot_product_id' = v_snapshot_product_id::text
        ) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
                DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;

        IF NOT EXISTS (
            SELECT 1
            FROM inventarios.task_events te
            WHERE te.company_id = v_company_id
              AND te.session_id = v_session_id
              AND te.task_id = v_task_id
              AND te.id = v_discovery_event_id
              AND te.event_type = 'DISCOVERY_RECORDED'
              AND te.idempotency_key = v_discovery_event_key
              AND te.technical_metadata ->> 'count_entry_id' = v_count_entry_id::text
              AND te.technical_metadata ->> 'proposal_id' = v_proposal_id::text
              AND te.technical_metadata ->> 'evidence_id' = v_evidence_id::text
        ) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
                DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;

        RETURN v_replay_payload;
    END IF;

    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    v_occurred_at := pg_catalog.now();
    v_captured_at := p_captured_at;
    IF v_captured_at > v_occurred_at THEN
        v_captured_at := v_occurred_at;
    END IF;

    SELECT so.metadata
    INTO v_storage_meta
    FROM storage.objects so
    WHERE so.bucket_id = 'inventory-evidence'
      AND so.name = v_expected_storage_path
      AND so.owner = v_actor_id;

    IF v_storage_meta IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
    END IF;

    IF COALESCE((v_storage_meta ->> 'size')::bigint, 0) <> p_evidence_file_size
       OR p_evidence_file_size < 1 OR p_evidence_file_size > 10485760 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;

    IF COALESCE(v_storage_meta ->> 'mimetype', '') <> v_clean_mime_type THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM inventarios.evidence_files ef
        WHERE ef.storage_bucket = 'inventory-evidence'
          AND ef.storage_path = v_expected_storage_path
    ) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;

    INSERT INTO inventarios.snapshot_products (
        company_id,
        snapshot_id,
        product_id,
        bsale_variant_id,
        sku,
        barcode,
        name,
        product_metadata,
        created_by
    ) VALUES (
        v_company_id,
        v_snapshot_id,
        v_master_product_id,
        p_bsale_variant_id,
        v_master_sku,
        v_master_barcode,
        v_master_name,
        NULL::jsonb,
        v_actor_id
    ) ON CONFLICT (company_id, snapshot_id, bsale_variant_id) DO NOTHING;

    SELECT sp.id
    INTO v_snapshot_product_id
    FROM inventarios.snapshot_products sp
    WHERE sp.company_id = v_company_id
      AND sp.snapshot_id = v_snapshot_id
      AND sp.bsale_variant_id = p_bsale_variant_id
    ORDER BY sp.id
    LIMIT 1;

    IF v_snapshot_product_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
    END IF;

    v_count_result := inventarios.submit_my_mobile_count(
        p_zone_id,
        p_location_id,
        v_snapshot_product_id,
        p_physical_quantity,
        'SEARCH_MANUAL',
        v_clean_scanned_code,
        v_count_idempotency_key,
        v_captured_at,
        v_clean_device_id
    );

    v_count_entry_id := (v_count_result ->> 'entity_id')::uuid;
    v_count_event_id := (v_count_result -> 'data' ->> 'count_event_id')::uuid;

    INSERT INTO inventarios.product_barcode_proposals (
        company_id,
        session_id,
        count_entry_id,
        scanned_code,
        status,
        proposed_by,
        proposed_at,
        created_by,
        updated_by
    ) VALUES (
        v_company_id,
        v_session_id,
        v_count_entry_id,
        v_clean_scanned_code,
        'PENDING_REVIEW',
        v_actor_id,
        v_captured_at,
        v_actor_id,
        v_actor_id
    ) RETURNING id INTO v_proposal_id;

    INSERT INTO inventarios.evidence_files (
        company_id,
        session_id,
        proposal_id,
        storage_bucket,
        storage_path,
        original_name,
        mime_type,
        file_size_bytes,
        sha256,
        captured_by,
        captured_at,
        uploaded_by,
        uploaded_at,
        device_id,
        offline_idempotency_key,
        source,
        sync_status,
        created_by,
        updated_by
    ) VALUES (
        v_company_id,
        v_session_id,
        v_proposal_id,
        'inventory-evidence',
        v_expected_storage_path,
        p_idempotency_key::text || v_extension,
        v_clean_mime_type,
        p_evidence_file_size,
        v_clean_sha256,
        v_actor_id,
        v_captured_at,
        v_actor_id,
        v_occurred_at,
        v_clean_device_id,
        p_idempotency_key,
        'ANDROID',
        'PENDING',
        v_actor_id,
        v_actor_id
    ) RETURNING id INTO v_evidence_id;

    IF v_count_event_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
    END IF;

    INSERT INTO inventarios.task_events (
        company_id,
        session_id,
        session_zone_id,
        task_id,
        event_type,
        previous_status,
        next_status,
        actor_id,
        cycle,
        occurred_at,
        idempotency_key,
        source,
        technical_metadata,
        created_at,
        created_by
    ) VALUES (
        v_company_id,
        v_session_id,
        v_session_zone_id,
        v_task_id,
        'DISCOVERY_RECORDED',
        'IN_PROGRESS',
        'IN_PROGRESS',
        v_actor_id,
        v_task_cycle,
        v_occurred_at,
        v_discovery_event_key,
        'ANDROID',
        pg_catalog.jsonb_build_object(
            'count_entry_id', v_count_entry_id,
            'proposal_id', v_proposal_id,
            'evidence_id', v_evidence_id
        ),
        v_occurred_at,
        v_actor_id
    ) RETURNING id INTO v_discovery_event_id;

    v_response := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.mobile.discovery.submit',
        'entity_id', v_count_entry_id,
        'state', 'IN_PROGRESS',
        'version', NULL::integer,
        'cycle_number', v_task_cycle,
        'assignment_id', v_assignment_id,
        'event_id', v_discovery_event_id,
        'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object(
            'snapshot_product_id', v_snapshot_product_id,
            'count_entry_id', v_count_entry_id,
            'count_event_id', v_count_event_id,
            'proposal_id', v_proposal_id,
            'evidence_file_id', v_evidence_id,
            'discovery_event_id', v_discovery_event_id,
            'bsale_variant_id', p_bsale_variant_id,
            'storage_bucket', 'inventory-evidence',
            'storage_path', v_expected_storage_path
        )
    );

    RETURN inventarios.complete_idempotent_operation(
        v_company_id,
        v_operation_id,
        v_count_entry_id,
        v_response
    );
END;
$function$;

ALTER FUNCTION inventarios.submit_mobile_discovery_count(uuid, uuid, integer, numeric, text, text, text, bigint, text, uuid, timestamptz, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.submit_mobile_discovery_count(uuid, uuid, integer, numeric, text, text, text, bigint, text, uuid, timestamptz, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.submit_mobile_discovery_count(uuid, uuid, integer, numeric, text, text, text, bigint, text, uuid, timestamptz, text) TO authenticated;
