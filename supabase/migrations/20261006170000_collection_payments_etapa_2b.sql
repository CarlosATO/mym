-- Etapa 2B: real Bsale payments, reconciliation and customer closure.
-- This migration does not execute any Bsale request.

CREATE TABLE comercial.collection_payment_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  client_id bigint NOT NULL,
  payment_type_id integer NOT NULL,
  record_date date NOT NULL,
  expected_total numeric(14,2) NOT NULL CHECK (expected_total > 0),
  confirmed_total numeric(14,2) NOT NULL DEFAULT 0 CHECK (confirmed_total >= 0),
  status text NOT NULL DEFAULT 'CREATED'
    CHECK (status IN ('CREATED', 'PROCESSING', 'COMPLETED', 'PARTIAL', 'UNKNOWN', 'FAILED')),
  created_by uuid NULL REFERENCES auth.users(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL
);

ALTER TABLE comercial.collection_customer_workflow
  DROP CONSTRAINT collection_customer_workflow_stage_check;

ALTER TABLE comercial.collection_customer_workflow
  ADD CONSTRAINT collection_customer_workflow_stage_check
  CHECK (stage IN ('TO_MANAGE', 'IN_PROGRESS', 'PAYMENT_COMMITMENT', 'FOLLOW_UP', 'CLOSED'));

ALTER TABLE comercial.collection_customer_events
  DROP CONSTRAINT collection_customer_events_event_type_check;

ALTER TABLE comercial.collection_customer_events
  ADD CONSTRAINT collection_customer_events_event_type_check
  CHECK (event_type IN (
    'NOTE', 'CALL', 'EMAIL', 'COMMITMENT', 'STAGE_CHANGED',
    'PAYMENT_CLOSED', 'REOPENED_BY_NEW_DEBT'
  ));

ALTER TABLE comercial.collection_payment_attempts
  ADD COLUMN batch_id uuid NULL REFERENCES comercial.collection_payment_batches(id),
  ADD COLUMN preflight_balance numeric(14,2) NULL CHECK (preflight_balance IS NULL OR preflight_balance >= 0),
  ADD COLUMN post_balance numeric(14,2) NULL CHECK (post_balance IS NULL OR post_balance >= 0),
  ADD COLUMN bsale_payment_id bigint NULL,
  ADD COLUMN confirmed_at timestamptz NULL,
  ADD COLUMN payment_response jsonb NULL;

DROP INDEX IF EXISTS comercial.collection_payment_attempts_active_document_idx;
CREATE UNIQUE INDEX collection_payment_attempts_active_document_idx
  ON comercial.collection_payment_attempts (company_id, bsale_document_id)
  WHERE status IN ('CREATED', 'SUBMITTING', 'UNKNOWN', 'REQUIRES_REVIEW');

ALTER TABLE comercial.collection_payment_attempts
  DROP CONSTRAINT collection_payment_attempts_status_check;

ALTER TABLE comercial.collection_payment_attempts
  ADD CONSTRAINT collection_payment_attempts_status_check
  CHECK (status IN ('CREATED', 'SUBMITTING', 'CONFIRMED', 'UNKNOWN', 'REQUIRES_REVIEW', 'FAILED', 'CANCELLED'));

CREATE INDEX collection_payment_batches_client_idx
  ON comercial.collection_payment_batches (company_id, client_id, created_at DESC);

CREATE INDEX collection_payment_attempts_batch_idx
  ON comercial.collection_payment_attempts (company_id, batch_id, created_at);

ALTER TABLE comercial.collection_payment_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE comercial.collection_payment_batches FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE comercial.collection_payment_batches TO service_role;
