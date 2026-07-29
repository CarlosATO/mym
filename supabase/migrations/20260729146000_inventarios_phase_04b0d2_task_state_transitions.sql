CREATE TABLE inventarios.task_state_transitions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    session_id uuid NOT NULL,
    session_zone_id uuid NOT NULL,
    task_id uuid NOT NULL,
    assignment_id uuid,
    operation_idempotency_id uuid NOT NULL,
    transition_type text NOT NULL,
    previous_status text NOT NULL,
    next_status text NOT NULL,
    previous_version integer NOT NULL,
    next_version integer NOT NULL,
    previous_cycle integer NOT NULL,
    next_cycle integer NOT NULL,
    actor_id uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    reason text,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT fk_inventarios_task_state_transitions_task
        FOREIGN KEY (company_id, session_id, session_zone_id, task_id)
        REFERENCES inventarios.tasks(company_id, session_id, session_zone_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_task_state_transitions_assignment
        FOREIGN KEY (company_id, session_id, task_id, assignment_id)
        REFERENCES inventarios.task_assignments(company_id, session_id, task_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_task_state_transitions_operation
        FOREIGN KEY (company_id, operation_idempotency_id)
        REFERENCES inventarios.operation_idempotency(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_task_state_transitions_operation
        UNIQUE (company_id, operation_idempotency_id),
    CONSTRAINT chk_inventarios_task_state_transitions_type
        CHECK (transition_type IN ('STARTED', 'PAUSED', 'RESUMED', 'COMPLETED', 'REOPENED')),
    CONSTRAINT chk_inventarios_task_state_transitions_statuses
        CHECK (
            previous_status IN ('ASSIGNED', 'IN_PROGRESS', 'PAUSED', 'COMPLETED')
            AND next_status IN ('ASSIGNED', 'IN_PROGRESS', 'PAUSED', 'COMPLETED')
            AND previous_status <> next_status
        ),
    CONSTRAINT chk_inventarios_task_state_transitions_versions
        CHECK (
            previous_version > 0
            AND next_version = previous_version + 1
        ),
    CONSTRAINT chk_inventarios_task_state_transitions_cycles
        CHECK (previous_cycle > 0 AND next_cycle > 0),
    CONSTRAINT chk_inventarios_task_state_transitions_matrix
        CHECK (
            (transition_type = 'STARTED'
                AND previous_status = 'ASSIGNED'
                AND next_status = 'IN_PROGRESS'
                AND next_cycle = previous_cycle)
            OR (transition_type = 'PAUSED'
                AND previous_status = 'IN_PROGRESS'
                AND next_status = 'PAUSED'
                AND next_cycle = previous_cycle)
            OR (transition_type = 'RESUMED'
                AND previous_status = 'PAUSED'
                AND next_status = 'IN_PROGRESS'
                AND next_cycle = previous_cycle)
            OR (transition_type = 'COMPLETED'
                AND previous_status = 'IN_PROGRESS'
                AND next_status = 'COMPLETED'
                AND next_cycle = previous_cycle)
            OR (transition_type = 'REOPENED'
                AND previous_status = 'COMPLETED'
                AND next_status = 'IN_PROGRESS'
                AND next_cycle = previous_cycle + 1
                AND reason IS NOT NULL
                AND btrim(reason) <> '')
        )
);

CREATE INDEX idx_inventarios_task_state_transitions_task_occurred
    ON inventarios.task_state_transitions(company_id, session_id, task_id, occurred_at DESC);
CREATE INDEX idx_inventarios_task_state_transitions_zone_occurred
    ON inventarios.task_state_transitions(company_id, session_id, session_zone_id, occurred_at DESC);
CREATE INDEX idx_inventarios_task_state_transitions_actor_occurred
    ON inventarios.task_state_transitions(company_id, actor_id, occurred_at DESC);

ALTER TABLE inventarios.task_state_transitions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE inventarios.task_state_transitions
FROM PUBLIC, anon, authenticated, service_role;
