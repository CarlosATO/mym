-- Inventory Engine phase 04B.0b: structural operation idempotency only.

CREATE TABLE inventarios.operation_idempotency (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    operation_code text NOT NULL,
    idempotency_key uuid NOT NULL,
    actor_id uuid NOT NULL,
    request_hash text NOT NULL,
    status text NOT NULL DEFAULT 'IN_PROGRESS',
    entity_id uuid,
    response_payload jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    CONSTRAINT fk_inventarios_operation_idempotency_company
        FOREIGN KEY (company_id)
        REFERENCES core.companies(id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_operation_idempotency_actor
        FOREIGN KEY (actor_id)
        REFERENCES portal.users(id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_operation_idempotency_company_id
        UNIQUE (company_id, id),
    CONSTRAINT uq_inventarios_operation_idempotency_replay
        UNIQUE (company_id, operation_code, idempotency_key),
    CONSTRAINT chk_inventarios_operation_idempotency_operation_code
        CHECK (length(trim(operation_code)) > 0),
    CONSTRAINT chk_inventarios_operation_idempotency_request_hash
        CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chk_inventarios_operation_idempotency_status
        CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
    CONSTRAINT chk_inventarios_operation_idempotency_result
        CHECK (
            (status = 'IN_PROGRESS' AND response_payload IS NULL AND completed_at IS NULL)
            OR (status = 'COMPLETED' AND response_payload IS NOT NULL AND completed_at IS NOT NULL)
        )
);

CREATE INDEX idx_inventarios_operation_idempotency_actor_created
    ON inventarios.operation_idempotency(company_id, actor_id, created_at DESC);
CREATE INDEX idx_inventarios_operation_idempotency_pending
    ON inventarios.operation_idempotency(company_id, status, created_at)
    WHERE status = 'IN_PROGRESS';

ALTER TABLE inventarios.operation_idempotency ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE inventarios.operation_idempotency FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE inventarios.operation_idempotency TO service_role;
