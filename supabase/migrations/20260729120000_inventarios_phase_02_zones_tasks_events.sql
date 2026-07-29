-- Inventory Engine phase 02: operational zones, assignments, tasks, and events.
-- Counts, incidents, evidence, recounts, consolidation, exports, and RLS policies remain out of scope.

CREATE SCHEMA IF NOT EXISTS inventarios;
GRANT USAGE ON SCHEMA inventarios TO authenticated, service_role;

-- Additional candidate keys allow tenant-safe relationships introduced in this phase.
ALTER TABLE inventarios.operational_snapshots
    ADD CONSTRAINT uq_inventarios_snapshots_company_session_id
    UNIQUE (company_id, session_id, id);

ALTER TABLE inventarios.snapshot_locations
    ADD CONSTRAINT uq_inventarios_snapshot_locations_context
    UNIQUE (company_id, snapshot_id, id, location_id);

ALTER TABLE inventarios.session_participants
    ADD CONSTRAINT uq_inventarios_participants_company_session_id
    UNIQUE (company_id, session_id, id);

ALTER TABLE inventarios.session_location_scopes
    ADD CONSTRAINT uq_inventarios_location_scopes_company_session_id
    UNIQUE (company_id, session_id, id);

-- A zone is session-owned operational organization, never a master location.
CREATE TABLE inventarios.session_zones (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    session_id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    zone_code text NOT NULL,
    scan_code text NOT NULL,
    display_name text NOT NULL,
    priority integer NOT NULL DEFAULT 0,
    is_enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_zones_session_company
        FOREIGN KEY (company_id, session_id)
        REFERENCES inventarios.sessions(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_zones_snapshot_session_company
        FOREIGN KEY (company_id, session_id, snapshot_id)
        REFERENCES inventarios.operational_snapshots(company_id, session_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_zones_company_session_id
        UNIQUE (company_id, session_id, id),
    CONSTRAINT uq_inventarios_zones_company_session_snapshot_id
        UNIQUE (company_id, session_id, snapshot_id, id),
    CONSTRAINT uq_inventarios_zones_code
        UNIQUE (company_id, session_id, zone_code),
    CONSTRAINT uq_inventarios_zones_scan_code
        UNIQUE (company_id, session_id, scan_code),
    CONSTRAINT chk_inventarios_zones_priority
        CHECK (priority >= 0)
);

COMMENT ON TABLE inventarios.session_zones IS
    'Operational organization of a session. It is not a reusable location catalog and does not use layout_group.';
COMMENT ON COLUMN inventarios.session_zones.snapshot_id IS
    'Snapshot that owns the frozen location context used by this zone.';

CREATE INDEX idx_inventarios_zones_session_enabled_priority
    ON inventarios.session_zones(company_id, session_id, is_enabled, priority, zone_code);

-- Membership is present from V1 so future phases can group locations. The V1
-- unique constraint permits at most one membership; future RPC creates zone and membership atomically.
CREATE TABLE inventarios.session_zone_locations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    session_id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    session_zone_id uuid NOT NULL,
    session_location_scope_id uuid NOT NULL,
    snapshot_location_id uuid NOT NULL,
    location_id uuid NOT NULL REFERENCES logistica.locations(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_zone_locations_zone_company
        FOREIGN KEY (company_id, session_id, snapshot_id, session_zone_id)
        REFERENCES inventarios.session_zones(company_id, session_id, snapshot_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_zone_locations_snapshot_location
        FOREIGN KEY (company_id, snapshot_id, snapshot_location_id, location_id)
        REFERENCES inventarios.snapshot_locations(company_id, snapshot_id, id, location_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_zone_locations_scope_company
        FOREIGN KEY (company_id, session_id, session_location_scope_id)
        REFERENCES inventarios.session_location_scopes(company_id, session_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_zone_locations_company_zone
        UNIQUE (company_id, session_zone_id),
    CONSTRAINT uq_inventarios_zone_locations_session_location
        UNIQUE (company_id, session_id, location_id),
    CONSTRAINT uq_inventarios_zone_locations_company_session_id
        UNIQUE (company_id, session_id, id)
);

COMMENT ON TABLE inventarios.session_zone_locations IS
    'Frozen-location membership of an operational zone. V1 allows one location per zone; a later phase may remove only the zone membership unique constraint.';
COMMENT ON COLUMN inventarios.session_zone_locations.session_location_scope_id IS
    'Declared scope row for this membership. Future RPCs verify it is INCLUDED and references the same live location.';

CREATE INDEX idx_inventarios_zone_locations_snapshot_location
    ON inventarios.session_zone_locations(company_id, snapshot_id, snapshot_location_id);

-- Tasks persist only four operational states. Lifecycle decisions are recorded as events.
CREATE TABLE inventarios.tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    session_id uuid NOT NULL,
    session_zone_id uuid NOT NULL,
    task_kind text NOT NULL DEFAULT 'PRIMARY',
    status text NOT NULL DEFAULT 'ASSIGNED',
    current_assignment_id uuid,
    active_user_id uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    current_validation_event_id uuid,
    version integer NOT NULL DEFAULT 1,
    validation_cycle integer NOT NULL DEFAULT 0,
    opened_at timestamptz,
    paused_at timestamptz,
    completed_at timestamptz,
    validated_at timestamptz,
    validated_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    invalidated_at timestamptz,
    invalidated_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    cancelled_at timestamptz,
    cancelled_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    superseded_at timestamptz,
    superseded_by_task_id uuid,
    creation_idempotency_key uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_tasks_zone_company
        FOREIGN KEY (company_id, session_id, session_zone_id)
        REFERENCES inventarios.session_zones(company_id, session_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_tasks_company_session_id
        UNIQUE (company_id, session_id, id),
    CONSTRAINT uq_inventarios_tasks_company_session_zone_id
        UNIQUE (company_id, session_id, session_zone_id, id),
    CONSTRAINT fk_inventarios_tasks_superseded_by_company
        FOREIGN KEY (company_id, session_id, superseded_by_task_id)
        REFERENCES inventarios.tasks(company_id, session_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT chk_inventarios_tasks_kind
        CHECK (task_kind IN ('PRIMARY', 'RECOUNT')),
    CONSTRAINT chk_inventarios_tasks_status
        CHECK (status IN ('ASSIGNED', 'IN_PROGRESS', 'PAUSED', 'COMPLETED')),
    CONSTRAINT chk_inventarios_tasks_version
        CHECK (version > 0 AND validation_cycle >= 0),
    CONSTRAINT chk_inventarios_tasks_active_user
        CHECK (
            (status = 'IN_PROGRESS' AND active_user_id IS NOT NULL)
            OR (status <> 'IN_PROGRESS' AND active_user_id IS NULL)
        ),
    CONSTRAINT chk_inventarios_tasks_not_self_superseded
        CHECK (superseded_by_task_id IS NULL OR superseded_by_task_id <> id)
);

COMMENT ON TABLE inventarios.tasks IS
    'Current operational task state. Reopen, reassignment, validation, invalidation, and cancellation are append-only events, not task states.';

CREATE UNIQUE INDEX uq_inventarios_tasks_current_primary_zone
    ON inventarios.tasks(company_id, session_id, session_zone_id)
    WHERE task_kind = 'PRIMARY' AND superseded_at IS NULL AND cancelled_at IS NULL AND invalidated_at IS NULL;
CREATE UNIQUE INDEX uq_inventarios_tasks_active_user
    ON inventarios.tasks(company_id, active_user_id)
    WHERE status = 'IN_PROGRESS' AND active_user_id IS NOT NULL AND superseded_at IS NULL AND cancelled_at IS NULL AND invalidated_at IS NULL;
CREATE UNIQUE INDEX uq_inventarios_tasks_creation_idempotency
    ON inventarios.tasks(company_id, creation_idempotency_key)
    WHERE creation_idempotency_key IS NOT NULL;
CREATE INDEX idx_inventarios_tasks_session_status
    ON inventarios.tasks(company_id, session_id, status);

-- Assignment history is separate from the task's current assignment reference.
CREATE TABLE inventarios.task_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    session_id uuid NOT NULL,
    task_id uuid NOT NULL,
    session_participant_id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    assigned_at timestamptz NOT NULL DEFAULT now(),
    assigned_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    released_at timestamptz,
    released_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    release_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_assignments_task_company
        FOREIGN KEY (company_id, session_id, task_id)
        REFERENCES inventarios.tasks(company_id, session_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_assignments_participant_company
        FOREIGN KEY (company_id, session_id, session_participant_id)
        REFERENCES inventarios.session_participants(company_id, session_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_assignments_company_session_task_id
        UNIQUE (company_id, session_id, task_id, id),
    CONSTRAINT chk_inventarios_assignments_release
        CHECK ((released_at IS NULL AND released_by IS NULL) OR (released_at IS NOT NULL AND released_by IS NOT NULL))
);

COMMENT ON TABLE inventarios.task_assignments IS
    'Append-only assignment history. Future RPCs validate that participant, user, role, and active company access match.';

CREATE UNIQUE INDEX uq_inventarios_assignments_current_task
    ON inventarios.task_assignments(company_id, task_id)
    WHERE released_at IS NULL;
CREATE INDEX idx_inventarios_assignments_participant
    ON inventarios.task_assignments(company_id, session_participant_id, released_at);

-- Event history is append-only. It does not replace the persistent task status.
CREATE TABLE inventarios.task_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    session_id uuid NOT NULL,
    session_zone_id uuid NOT NULL,
    task_id uuid NOT NULL,
    event_type text NOT NULL,
    previous_status text,
    next_status text,
    actor_id uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    previous_user_id uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    next_user_id uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    related_task_id uuid,
    cycle integer NOT NULL DEFAULT 0,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    reason text,
    idempotency_key uuid,
    source text NOT NULL DEFAULT 'WEB',
    technical_metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_events_task_zone_company
        FOREIGN KEY (company_id, session_id, session_zone_id, task_id)
        REFERENCES inventarios.tasks(company_id, session_id, session_zone_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_events_related_task_company
        FOREIGN KEY (company_id, session_id, related_task_id)
        REFERENCES inventarios.tasks(company_id, session_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_events_company_session_zone_task_id
        UNIQUE (company_id, session_id, session_zone_id, task_id, id),
    CONSTRAINT chk_inventarios_events_type
        CHECK (event_type IN ('STARTED', 'RESUMED', 'REOPENED', 'REASSIGNED', 'VALIDATED', 'INVALIDATED', 'CANCELLED')),
    CONSTRAINT chk_inventarios_events_statuses
        CHECK (
            (previous_status IS NULL OR previous_status IN ('ASSIGNED', 'IN_PROGRESS', 'PAUSED', 'COMPLETED'))
            AND (next_status IS NULL OR next_status IN ('ASSIGNED', 'IN_PROGRESS', 'PAUSED', 'COMPLETED'))
        ),
    CONSTRAINT chk_inventarios_events_cycle
        CHECK (cycle >= 0),
    CONSTRAINT chk_inventarios_events_source
        CHECK (source IN ('WEB', 'ANDROID', 'SYSTEM')),
    CONSTRAINT chk_inventarios_events_reason
        CHECK (
            event_type NOT IN ('REOPENED', 'REASSIGNED', 'INVALIDATED', 'CANCELLED')
            OR (reason IS NOT NULL AND btrim(reason) <> '')
        )
);

COMMENT ON TABLE inventarios.task_events IS
    'Immutable task lifecycle facts. Future triggers/RPCs enforce event-to-task state transitions and participant eligibility.';
COMMENT ON COLUMN inventarios.task_events.technical_metadata IS
    'Variable transport or retry context only; task, actor, statuses, users, cycle, and event type are structured columns.';

CREATE UNIQUE INDEX uq_inventarios_events_idempotency
    ON inventarios.task_events(company_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_inventarios_events_task_occurred
    ON inventarios.task_events(company_id, task_id, occurred_at DESC);
CREATE INDEX idx_inventarios_events_session_type_occurred
    ON inventarios.task_events(company_id, session_id, event_type, occurred_at DESC);
CREATE INDEX idx_inventarios_events_actor_occurred
    ON inventarios.task_events(company_id, actor_id, occurred_at DESC);
CREATE INDEX idx_inventarios_events_related_task
    ON inventarios.task_events(company_id, session_id, related_task_id)
    WHERE related_task_id IS NOT NULL;

-- Resolve task-to-assignment and task-to-validation-event circular references.
ALTER TABLE inventarios.tasks
    ADD CONSTRAINT fk_inventarios_tasks_current_assignment_company
    FOREIGN KEY (company_id, session_id, id, current_assignment_id)
    REFERENCES inventarios.task_assignments(company_id, session_id, task_id, id)
    ON DELETE RESTRICT;

ALTER TABLE inventarios.tasks
    ADD CONSTRAINT fk_inventarios_tasks_validation_event_company
    FOREIGN KEY (company_id, session_id, session_zone_id, id, current_validation_event_id)
    REFERENCES inventarios.task_events(company_id, session_id, session_zone_id, task_id, id)
    ON DELETE RESTRICT;

ALTER TABLE inventarios.session_zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventarios.session_zone_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventarios.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventarios.task_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventarios.task_events ENABLE ROW LEVEL SECURITY;

GRANT ALL ON ALL TABLES IN SCHEMA inventarios TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA inventarios TO authenticated;

-- Functional RLS policies, lifecycle RPCs, participant eligibility checks, and
-- immutable event/snapshot triggers are intentionally added in later phases.
