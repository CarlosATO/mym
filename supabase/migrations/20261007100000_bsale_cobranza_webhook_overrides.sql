-- Directed Bsale signals for current collection state. Snapshots remain immutable.

CREATE TABLE IF NOT EXISTS integraciones.bsale_webhook_company_map (
  cpn_id text PRIMARY KEY,
  company_id uuid NOT NULL UNIQUE REFERENCES core.companies(id),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS comercial.collection_customer_live_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  client_id bigint NOT NULL,
  bsale_document_id bigint NOT NULL,
  pending_amount numeric(14,2) NOT NULL CHECK (pending_amount >= 0),
  source text NOT NULL CHECK (source IN ('BSALE_WEBHOOK', 'BSALE_DIRECTED')),
  source_event_id uuid NULL REFERENCES integraciones.bsale_webhook_events(id),
  observed_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (company_id, bsale_document_id)
);

CREATE INDEX IF NOT EXISTS collection_customer_live_overrides_client_idx
  ON comercial.collection_customer_live_overrides (company_id, client_id, observed_at DESC);

ALTER TABLE integraciones.bsale_webhook_events
  DROP CONSTRAINT IF EXISTS bsale_webhook_events_status_check;

ALTER TABLE integraciones.bsale_webhook_events
  ADD CONSTRAINT bsale_webhook_events_status_check
  CHECK (status IN ('RECEIVED', 'PROCESSING', 'UNMAPPED', 'PROCESSED', 'RETRYABLE', 'ERROR', 'FAILED'));

ALTER TABLE integraciones.bsale_webhook_events
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS lease_until timestamptz NULL;

CREATE INDEX IF NOT EXISTS bsale_webhook_events_queue_idx
  ON integraciones.bsale_webhook_events (status, next_retry_at, received_at);

CREATE INDEX IF NOT EXISTS bsale_webhook_events_lease_idx
  ON integraciones.bsale_webhook_events (status, lease_until);

ALTER TABLE comercial.collection_customer_events
  DROP CONSTRAINT IF EXISTS collection_customer_events_event_type_check;

ALTER TABLE comercial.collection_customer_events
  ADD CONSTRAINT collection_customer_events_event_type_check
  CHECK (event_type IN (
    'NOTE', 'CALL', 'EMAIL', 'COMMITMENT', 'STAGE_CHANGED',
    'PAYMENT_CLOSED', 'REOPENED_BY_NEW_DEBT',
    'BSALE_PAYMENT_DETECTED', 'BSALE_DEBT_UPDATED', 'COLLECTION_CLOSED_FROM_BSALE'
  ));

ALTER TABLE integraciones.bsale_webhook_company_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE comercial.collection_customer_live_overrides ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE integraciones.bsale_webhook_company_map, comercial.collection_customer_live_overrides FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE integraciones.bsale_webhook_company_map TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE comercial.collection_customer_live_overrides TO service_role;
