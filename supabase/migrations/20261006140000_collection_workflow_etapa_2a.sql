-- Persistent collection workflow for Etapa 2A. Debt remains sourced from the
-- official Bsale receivable snapshot; these tables only store local workflow.

CREATE TABLE comercial.collection_customer_workflow (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  client_id bigint NOT NULL,
  stage text NOT NULL DEFAULT 'TO_MANAGE'
    CHECK (stage IN ('TO_MANAGE', 'IN_PROGRESS', 'PAYMENT_COMMITMENT', 'FOLLOW_UP')),
  next_action_at timestamptz NULL,
  commitment_at timestamptz NULL,
  commitment_amount numeric(14,2) NULL CHECK (commitment_amount IS NULL OR commitment_amount > 0),
  assigned_to uuid NULL REFERENCES auth.users(id),
  last_contact_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, client_id)
);

CREATE TABLE comercial.collection_customer_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  client_id bigint NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('NOTE', 'CALL', 'EMAIL', 'COMMITMENT', 'STAGE_CHANGED')),
  body text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE comercial.collection_payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  client_id bigint NOT NULL,
  bsale_document_id bigint NOT NULL,
  idempotency_key text NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  payment_type_id integer NOT NULL,
  record_date date NOT NULL,
  status text NOT NULL DEFAULT 'CREATED'
    CHECK (status IN ('CREATED', 'SUBMITTING', 'CONFIRMED', 'UNKNOWN', 'FAILED', 'CANCELLED')),
  request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_payload jsonb NULL,
  error_message text NULL,
  created_by uuid NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, idempotency_key)
);

CREATE TABLE comercial.collection_payment_type_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  bsale_payment_type_id integer NOT NULL,
  label text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  dynamic_attributes jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, bsale_payment_type_id)
);

CREATE UNIQUE INDEX collection_payment_attempts_active_document_idx
  ON comercial.collection_payment_attempts (company_id, bsale_document_id)
  WHERE status IN ('CREATED', 'SUBMITTING', 'UNKNOWN');

CREATE INDEX collection_customer_events_lookup_idx
  ON comercial.collection_customer_events (company_id, client_id, created_at DESC);

CREATE INDEX collection_payment_attempts_client_idx
  ON comercial.collection_payment_attempts (company_id, client_id, created_at DESC);

ALTER TABLE comercial.collection_customer_workflow ENABLE ROW LEVEL SECURITY;
ALTER TABLE comercial.collection_customer_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE comercial.collection_payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE comercial.collection_payment_type_config ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE comercial.collection_customer_workflow,
  comercial.collection_customer_events,
  comercial.collection_payment_attempts,
  comercial.collection_payment_type_config FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON TABLE comercial.collection_customer_workflow,
  comercial.collection_payment_attempts,
  comercial.collection_payment_type_config TO service_role;
GRANT SELECT, INSERT ON TABLE comercial.collection_customer_events TO service_role;

INSERT INTO portal.permissions (code, name, description, module_id, is_active)
SELECT 'analisis_comercial.cobranza.register_payment', 'Registrar pagos de cobranza',
       'Permite preparar y registrar pagos desde Cobranza.', id, true
FROM portal.modules WHERE code = 'analisis-comercial'
ON CONFLICT (code) DO UPDATE SET name = excluded.name, description = excluded.description, is_active = true;

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM portal.roles r CROSS JOIN portal.permissions p
WHERE r.name IN ('FINANZAS', 'GERENCIA', 'SUPER_USUARIO')
  AND p.code = 'analisis_comercial.cobranza.register_payment'
ON CONFLICT DO NOTHING;

-- Payment types are explicitly configured per company. Only bank transfer is
-- enabled for CAYLO in Etapa 2A; other Bsale types remain unavailable.
INSERT INTO comercial.collection_payment_type_config
  (company_id, bsale_payment_type_id, label, enabled)
VALUES
  ('d1000000-0000-0000-0000-000000000001', 8, 'TRANSFERENCIA', true)
ON CONFLICT (company_id, bsale_payment_type_id)
DO UPDATE SET label = excluded.label, enabled = excluded.enabled, updated_at = now();
