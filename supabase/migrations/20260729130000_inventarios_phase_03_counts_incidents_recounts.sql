-- Inventory Engine phase 03: counts, incidents, evidence, and recount decisions.
-- Lifecycle RPCs, immutability triggers, functional RLS policies, and Storage remain out of scope.

CREATE SCHEMA IF NOT EXISTS inventarios;
GRANT USAGE ON SCHEMA inventarios TO authenticated, service_role;

-- Candidate keys required for contextual relationships introduced in this phase.
ALTER TABLE inventarios.snapshot_products
    ADD CONSTRAINT uq_inventarios_snapshot_products_context_variant
    UNIQUE (company_id, snapshot_id, id, bsale_variant_id);

ALTER TABLE inventarios.session_zone_locations
    ADD CONSTRAINT uq_inventarios_zone_locations_snapshot_context
    UNIQUE (company_id, session_id, snapshot_id, session_zone_id, snapshot_location_id);

CREATE TABLE inventarios.count_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    session_id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    session_zone_id uuid NOT NULL,
    task_id uuid NOT NULL,
    task_cycle integer NOT NULL,
    session_participant_id uuid NOT NULL,
    counted_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    snapshot_product_id uuid NOT NULL,
    snapshot_location_id uuid NOT NULL,
    recount_request_id uuid,
    bsale_variant_id integer NOT NULL,
    identification_method text NOT NULL,
    scanned_code text,
    capture_source text NOT NULL,
    offline_id uuid,
    device_id text,
    captured_at timestamptz NOT NULL,
    server_received_at timestamptz NOT NULL DEFAULT now(),
    synced_at timestamptz,
    synced_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    invalidated_at timestamptz,
    invalidated_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    invalidation_reason text,
    physical_quantity numeric(14,3) NOT NULL DEFAULT 0,
    available_quantity numeric(14,3) NOT NULL DEFAULT 0,
    damaged_quantity numeric(14,3) NOT NULL DEFAULT 0,
    expired_quantity numeric(14,3) NOT NULL DEFAULT 0,
    blocked_quantity numeric(14,3) NOT NULL DEFAULT 0,
    other_unavailable_quantity numeric(14,3) NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_counts_task_context
        FOREIGN KEY (company_id, session_id, session_zone_id, task_id)
        REFERENCES inventarios.tasks(company_id, session_id, session_zone_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_counts_zone_snapshot_context
        FOREIGN KEY (company_id, session_id, snapshot_id, session_zone_id)
        REFERENCES inventarios.session_zones(company_id, session_id, snapshot_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_counts_participant_context
        FOREIGN KEY (company_id, session_id, session_participant_id)
        REFERENCES inventarios.session_participants(company_id, session_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_counts_product_context
        FOREIGN KEY (company_id, snapshot_id, snapshot_product_id, bsale_variant_id)
        REFERENCES inventarios.snapshot_products(company_id, snapshot_id, id, bsale_variant_id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_counts_location_context
        FOREIGN KEY (company_id, session_id, snapshot_id, session_zone_id, snapshot_location_id)
        REFERENCES inventarios.session_zone_locations(company_id, session_id, snapshot_id, session_zone_id, snapshot_location_id) ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_counts_company_session_id UNIQUE (company_id, session_id, id),
    CONSTRAINT uq_inventarios_counts_correction_context UNIQUE (company_id, session_id, task_id, snapshot_product_id, id),
    CONSTRAINT uq_inventarios_counts_recount_context UNIQUE (company_id, session_id, session_zone_id, snapshot_product_id, id),
    CONSTRAINT chk_inventarios_counts_cycle CHECK (task_cycle > 0),
    CONSTRAINT chk_inventarios_counts_capture_source CHECK (capture_source IN ('MOBILE', 'WEB')),
    CONSTRAINT chk_inventarios_counts_mobile_capture CHECK (
        capture_source <> 'MOBILE' OR (offline_id IS NOT NULL AND device_id IS NOT NULL)
    ),
    CONSTRAINT chk_inventarios_counts_quantities CHECK (
        physical_quantity >= 0 AND available_quantity >= 0 AND damaged_quantity >= 0
        AND expired_quantity >= 0 AND blocked_quantity >= 0 AND other_unavailable_quantity >= 0
        AND physical_quantity = available_quantity + damaged_quantity + expired_quantity
            + blocked_quantity + other_unavailable_quantity
    ),
    CONSTRAINT chk_inventarios_counts_invalidation CHECK (
        (invalidated_at IS NULL AND invalidated_by IS NULL AND invalidation_reason IS NULL)
        OR (invalidated_at IS NOT NULL AND invalidated_by IS NOT NULL
            AND invalidation_reason IS NOT NULL AND length(btrim(invalidation_reason)) > 0)
    )
);

CREATE TABLE inventarios.recount_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    session_id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    session_zone_id uuid NOT NULL,
    snapshot_product_id uuid NOT NULL,
    source_task_id uuid NOT NULL,
    source_count_entry_id uuid,
    reason text NOT NULL,
    ordinal integer NOT NULL,
    cycle_number integer NOT NULL,
    requested_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    requested_at timestamptz NOT NULL DEFAULT now(),
    assigned_participant_id uuid,
    assigned_user_id uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    assigned_at timestamptz,
    started_at timestamptz,
    completed_at timestamptz,
    cancelled_at timestamptz,
    cancelled_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    cancellation_reason text,
    status text NOT NULL DEFAULT 'REQUESTED',
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_recounts_zone_snapshot_context
        FOREIGN KEY (company_id, session_id, snapshot_id, session_zone_id)
        REFERENCES inventarios.session_zones(company_id, session_id, snapshot_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_recounts_product_context
        FOREIGN KEY (company_id, snapshot_id, snapshot_product_id)
        REFERENCES inventarios.snapshot_products(company_id, snapshot_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_recounts_source_task_context
        FOREIGN KEY (company_id, session_id, session_zone_id, source_task_id)
        REFERENCES inventarios.tasks(company_id, session_id, session_zone_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_recounts_source_count_context
        FOREIGN KEY (company_id, session_id, source_task_id, snapshot_product_id, source_count_entry_id)
        REFERENCES inventarios.count_entries(company_id, session_id, task_id, snapshot_product_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_recounts_assigned_participant
        FOREIGN KEY (company_id, session_id, assigned_participant_id)
        REFERENCES inventarios.session_participants(company_id, session_id, id) ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_recounts_ordinal UNIQUE (company_id, session_id, session_zone_id, snapshot_product_id, ordinal),
    CONSTRAINT uq_inventarios_recounts_context_id UNIQUE (company_id, session_id, session_zone_id, snapshot_product_id, id),
    CONSTRAINT uq_inventarios_recounts_zone_id UNIQUE (company_id, session_id, session_zone_id, id),
    CONSTRAINT uq_inventarios_recounts_session_id UNIQUE (company_id, session_id, id),
    CONSTRAINT chk_inventarios_recounts_ordinal CHECK (ordinal > 0 AND cycle_number > 0),
    CONSTRAINT chk_inventarios_recounts_reason CHECK (length(btrim(reason)) > 0),
    CONSTRAINT chk_inventarios_recounts_status CHECK (status IN ('REQUESTED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
    CONSTRAINT chk_inventarios_recounts_cancellation CHECK (
        (cancelled_at IS NULL AND cancelled_by IS NULL AND cancellation_reason IS NULL)
        OR (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL
            AND cancellation_reason IS NOT NULL AND length(btrim(cancellation_reason)) > 0)
    )
);

ALTER TABLE inventarios.count_entries
    ADD CONSTRAINT fk_inventarios_counts_recount_context
    FOREIGN KEY (company_id, session_id, session_zone_id, snapshot_product_id, recount_request_id)
    REFERENCES inventarios.recount_requests(company_id, session_id, session_zone_id, snapshot_product_id, id)
    ON DELETE RESTRICT;

CREATE TABLE inventarios.count_entry_corrections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    session_id uuid NOT NULL,
    task_id uuid NOT NULL,
    snapshot_product_id uuid NOT NULL,
    root_count_entry_id uuid NOT NULL,
    previous_count_entry_id uuid NOT NULL,
    replacement_count_entry_id uuid NOT NULL,
    supersedes_correction_id uuid,
    revision_number integer NOT NULL,
    reason text NOT NULL,
    corrected_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    corrected_at timestamptz NOT NULL DEFAULT now(),
    superseded_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_inventarios_corrections_root_count
        FOREIGN KEY (company_id, session_id, task_id, snapshot_product_id, root_count_entry_id)
        REFERENCES inventarios.count_entries(company_id, session_id, task_id, snapshot_product_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_corrections_previous_count
        FOREIGN KEY (company_id, session_id, task_id, snapshot_product_id, previous_count_entry_id)
        REFERENCES inventarios.count_entries(company_id, session_id, task_id, snapshot_product_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_corrections_replacement_count
        FOREIGN KEY (company_id, session_id, task_id, snapshot_product_id, replacement_count_entry_id)
        REFERENCES inventarios.count_entries(company_id, session_id, task_id, snapshot_product_id, id) ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_corrections_root_id UNIQUE (company_id, root_count_entry_id, id),
    CONSTRAINT uq_inventarios_corrections_replacement UNIQUE (company_id, replacement_count_entry_id),
    CONSTRAINT uq_inventarios_corrections_revision UNIQUE (company_id, root_count_entry_id, revision_number),
    CONSTRAINT chk_inventarios_corrections_revision CHECK (revision_number > 0),
    CONSTRAINT chk_inventarios_corrections_entries CHECK (
        previous_count_entry_id <> replacement_count_entry_id
        AND root_count_entry_id <> replacement_count_entry_id
    ),
    CONSTRAINT chk_inventarios_corrections_reason CHECK (length(btrim(reason)) > 0)
);

ALTER TABLE inventarios.count_entry_corrections
    ADD CONSTRAINT fk_inventarios_corrections_supersedes_context
    FOREIGN KEY (company_id, root_count_entry_id, supersedes_correction_id)
    REFERENCES inventarios.count_entry_corrections(company_id, root_count_entry_id, id)
    ON DELETE RESTRICT;

CREATE TABLE inventarios.incidents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    session_id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    session_zone_id uuid,
    task_id uuid,
    count_entry_id uuid,
    snapshot_product_id uuid,
    recount_request_id uuid,
    responsible_user_id uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    category_code text NOT NULL,
    severity text NOT NULL,
    status text NOT NULL,
    affected_quantity numeric(14,3),
    description text NOT NULL,
    is_blocking boolean NOT NULL DEFAULT false,
    reported_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    reported_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_incidents_snapshot_context
        FOREIGN KEY (company_id, session_id, snapshot_id)
        REFERENCES inventarios.operational_snapshots(company_id, session_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_incidents_zone_context
        FOREIGN KEY (company_id, session_id, snapshot_id, session_zone_id)
        REFERENCES inventarios.session_zones(company_id, session_id, snapshot_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_incidents_task_context
        FOREIGN KEY (company_id, session_id, session_zone_id, task_id)
        REFERENCES inventarios.tasks(company_id, session_id, session_zone_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_incidents_count_context
        FOREIGN KEY (company_id, session_id, session_zone_id, snapshot_product_id, count_entry_id)
        REFERENCES inventarios.count_entries(company_id, session_id, session_zone_id, snapshot_product_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_incidents_product_context
        FOREIGN KEY (company_id, snapshot_id, snapshot_product_id)
        REFERENCES inventarios.snapshot_products(company_id, snapshot_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_incidents_recount_context
        FOREIGN KEY (company_id, session_id, session_zone_id, snapshot_product_id, recount_request_id)
        REFERENCES inventarios.recount_requests(company_id, session_id, session_zone_id, snapshot_product_id, id) ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_incidents_company_session_id UNIQUE (company_id, session_id, id),
    CONSTRAINT chk_inventarios_incidents_severity CHECK (severity IN ('INFORMATIONAL', 'OPERATIONAL', 'CRITICAL', 'BLOCKING')),
    CONSTRAINT chk_inventarios_incidents_status CHECK (status IN ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'CLOSED')),
    CONSTRAINT chk_inventarios_incidents_quantity CHECK (affected_quantity IS NULL OR affected_quantity >= 0),
    CONSTRAINT chk_inventarios_incidents_task_context CHECK (task_id IS NULL OR session_zone_id IS NOT NULL),
    CONSTRAINT chk_inventarios_incidents_count_context CHECK (
        count_entry_id IS NULL OR (session_zone_id IS NOT NULL AND snapshot_product_id IS NOT NULL)
    ),
    CONSTRAINT chk_inventarios_incidents_recount_context CHECK (
        recount_request_id IS NULL OR (session_zone_id IS NOT NULL AND snapshot_product_id IS NOT NULL)
    )
);

CREATE TABLE inventarios.incident_resolutions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    session_id uuid NOT NULL,
    incident_id uuid NOT NULL,
    resolution_type text NOT NULL,
    previous_status text NOT NULL,
    next_status text NOT NULL,
    description text NOT NULL,
    resolved_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    resolved_at timestamptz NOT NULL DEFAULT now(),
    supersedes_resolution_id uuid,
    superseded_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_inventarios_resolutions_incident_context
        FOREIGN KEY (company_id, session_id, incident_id)
        REFERENCES inventarios.incidents(company_id, session_id, id) ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_resolutions_context_id UNIQUE (company_id, session_id, incident_id, id),
    CONSTRAINT chk_inventarios_resolutions_statuses CHECK (
        previous_status IN ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'CLOSED')
        AND next_status IN ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'CLOSED')
        AND previous_status <> next_status
    ),
    CONSTRAINT chk_inventarios_resolutions_description CHECK (length(btrim(description)) > 0),
    CONSTRAINT chk_inventarios_resolutions_not_self CHECK (
        supersedes_resolution_id IS NULL OR supersedes_resolution_id <> id
    )
);

ALTER TABLE inventarios.incident_resolutions
    ADD CONSTRAINT fk_inventarios_resolutions_supersedes_context
    FOREIGN KEY (company_id, session_id, incident_id, supersedes_resolution_id)
    REFERENCES inventarios.incident_resolutions(company_id, session_id, incident_id, id)
    ON DELETE RESTRICT;

CREATE TABLE inventarios.evidence_files (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    session_id uuid NOT NULL,
    incident_id uuid,
    task_id uuid,
    count_entry_id uuid,
    recount_request_id uuid,
    storage_bucket text NOT NULL DEFAULT 'inventory-evidence',
    storage_path text NOT NULL,
    original_name text NOT NULL,
    mime_type text NOT NULL,
    file_size_bytes bigint NOT NULL,
    sha256 char(64) NOT NULL,
    captured_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    captured_at timestamptz NOT NULL,
    uploaded_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    uploaded_at timestamptz,
    device_id text,
    offline_idempotency_key uuid,
    source text NOT NULL,
    sync_status text NOT NULL,
    invalidated_at timestamptz,
    invalidated_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    invalidation_reason text,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_evidence_incident_context
        FOREIGN KEY (company_id, session_id, incident_id)
        REFERENCES inventarios.incidents(company_id, session_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_evidence_task_context
        FOREIGN KEY (company_id, session_id, task_id)
        REFERENCES inventarios.tasks(company_id, session_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_evidence_count_context
        FOREIGN KEY (company_id, session_id, count_entry_id)
        REFERENCES inventarios.count_entries(company_id, session_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_evidence_recount_context
        FOREIGN KEY (company_id, session_id, recount_request_id)
        REFERENCES inventarios.recount_requests(company_id, session_id, id) ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_evidence_storage_path UNIQUE (storage_bucket, storage_path),
    CONSTRAINT chk_inventarios_evidence_context CHECK (
        num_nonnulls(incident_id, task_id, count_entry_id, recount_request_id) = 1
    ),
    CONSTRAINT chk_inventarios_evidence_mime CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
    CONSTRAINT chk_inventarios_evidence_size CHECK (file_size_bytes >= 0 AND file_size_bytes <= 20971520),
    CONSTRAINT chk_inventarios_evidence_hash CHECK (sha256 ~ '^[0-9A-Fa-f]{64}$'),
    CONSTRAINT chk_inventarios_evidence_sync CHECK (sync_status IN ('PENDING', 'SYNCED', 'FAILED', 'INVALIDATED'))
);

CREATE TABLE inventarios.recount_decisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    session_id uuid NOT NULL,
    session_zone_id uuid NOT NULL,
    snapshot_product_id uuid NOT NULL,
    recount_request_id uuid NOT NULL,
    selected_count_entry_id uuid NOT NULL,
    supersedes_decision_id uuid,
    superseded_at timestamptz,
    cycle_number integer NOT NULL,
    decided_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    decided_at timestamptz NOT NULL DEFAULT now(),
    justification text NOT NULL,
    confidence_score numeric(5,2),
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_decisions_recount_context
        FOREIGN KEY (company_id, session_id, session_zone_id, snapshot_product_id, recount_request_id)
        REFERENCES inventarios.recount_requests(company_id, session_id, session_zone_id, snapshot_product_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_decisions_selected_count_context
        FOREIGN KEY (company_id, session_id, session_zone_id, snapshot_product_id, selected_count_entry_id)
        REFERENCES inventarios.count_entries(company_id, session_id, session_zone_id, snapshot_product_id, id) ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_decisions_recount_id UNIQUE (company_id, recount_request_id, id),
    CONSTRAINT chk_inventarios_decisions_cycle CHECK (cycle_number > 0),
    CONSTRAINT chk_inventarios_decisions_justification CHECK (length(btrim(justification)) > 0),
    CONSTRAINT chk_inventarios_decisions_not_self CHECK (
        supersedes_decision_id IS NULL OR supersedes_decision_id <> id
    ),
    CONSTRAINT chk_inventarios_decisions_confidence CHECK (
        confidence_score IS NULL OR confidence_score BETWEEN 0 AND 100
    )
);

ALTER TABLE inventarios.recount_decisions
    ADD CONSTRAINT fk_inventarios_decisions_supersedes_context
    FOREIGN KEY (company_id, recount_request_id, supersedes_decision_id)
    REFERENCES inventarios.recount_decisions(company_id, recount_request_id, id)
    ON DELETE RESTRICT;

CREATE UNIQUE INDEX uq_inventarios_counts_offline_id
    ON inventarios.count_entries(company_id, offline_id) WHERE offline_id IS NOT NULL;
CREATE INDEX idx_inventarios_counts_session_captured
    ON inventarios.count_entries(company_id, session_id, captured_at);
CREATE INDEX idx_inventarios_counts_task_captured
    ON inventarios.count_entries(company_id, task_id, captured_at);
CREATE INDEX idx_inventarios_counts_zone
    ON inventarios.count_entries(company_id, session_id, session_zone_id);
CREATE INDEX idx_inventarios_counts_snapshot_variant
    ON inventarios.count_entries(company_id, snapshot_id, bsale_variant_id);
CREATE INDEX idx_inventarios_counts_recount
    ON inventarios.count_entries(company_id, recount_request_id) WHERE recount_request_id IS NOT NULL;
CREATE UNIQUE INDEX uq_inventarios_corrections_current_root
    ON inventarios.count_entry_corrections(company_id, root_count_entry_id) WHERE superseded_at IS NULL;
CREATE INDEX idx_inventarios_incidents_session_severity_status
    ON inventarios.incidents(company_id, session_id, severity, status);
CREATE INDEX idx_inventarios_incidents_product
    ON inventarios.incidents(company_id, snapshot_id, snapshot_product_id) WHERE snapshot_product_id IS NOT NULL;
CREATE UNIQUE INDEX uq_inventarios_resolutions_current_incident
    ON inventarios.incident_resolutions(company_id, incident_id) WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX uq_inventarios_evidence_offline_id
    ON inventarios.evidence_files(company_id, offline_idempotency_key) WHERE offline_idempotency_key IS NOT NULL;
CREATE INDEX idx_inventarios_evidence_files_session
    ON inventarios.evidence_files(company_id, session_id);
CREATE INDEX idx_inventarios_evidence_incident ON inventarios.evidence_files(company_id, incident_id) WHERE incident_id IS NOT NULL;
CREATE INDEX idx_inventarios_evidence_task ON inventarios.evidence_files(company_id, task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_inventarios_evidence_count ON inventarios.evidence_files(company_id, count_entry_id) WHERE count_entry_id IS NOT NULL;
CREATE INDEX idx_inventarios_evidence_recount ON inventarios.evidence_files(company_id, recount_request_id) WHERE recount_request_id IS NOT NULL;
CREATE INDEX idx_inventarios_recounts_status ON inventarios.recount_requests(company_id, session_id, status);
CREATE INDEX idx_inventarios_recounts_product ON inventarios.recount_requests(company_id, snapshot_id, snapshot_product_id);
CREATE INDEX idx_inventarios_recounts_assigned ON inventarios.recount_requests(company_id, assigned_user_id) WHERE assigned_user_id IS NOT NULL;
CREATE INDEX idx_inventarios_decisions_request ON inventarios.recount_decisions(company_id, recount_request_id, decided_at);
CREATE INDEX idx_inventarios_decisions_selected_count ON inventarios.recount_decisions(company_id, selected_count_entry_id);
CREATE UNIQUE INDEX uq_inventarios_decisions_current_request
    ON inventarios.recount_decisions(company_id, recount_request_id) WHERE superseded_at IS NULL;

ALTER TABLE inventarios.count_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventarios.count_entry_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventarios.incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventarios.incident_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventarios.evidence_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventarios.recount_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventarios.recount_decisions ENABLE ROW LEVEL SECURITY;

GRANT ALL ON ALL TABLES IN SCHEMA inventarios TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA inventarios TO authenticated;

-- Functional RLS policies, lifecycle RPCs, immutable-history triggers, and
-- transactional validation of participant, assignment, cycle, and state remain later work.
