-- Migración de infraestructura para recepción de webhooks de Bsale
-- Archivo: 20260917120443_integraciones_bsale_webhook_events.sql

CREATE TABLE IF NOT EXISTS integraciones.bsale_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NULL REFERENCES core.companies(id) ON DELETE SET NULL,
  provider text NOT NULL DEFAULT 'BSALE' CHECK (provider = 'BSALE'),
  cpn_id text NOT NULL,
  topic text NOT NULL CHECK (topic IN ('payment')),
  action text NOT NULL CHECK (action IN ('POST', 'PUT')),
  resource text NOT NULL,
  resource_id bigint NOT NULL CHECK (resource_id > 0),
  send_epoch bigint NOT NULL CHECK (send_epoch > 0),
  sent_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  event_fingerprint text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('RECEIVED', 'UNMAPPED', 'PROCESSED', 'ERROR')),
  processed_at timestamptz NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Índices de consulta frecuente
CREATE INDEX IF NOT EXISTS idx_bsale_webhook_events_status ON integraciones.bsale_webhook_events (status);
CREATE INDEX IF NOT EXISTS idx_bsale_webhook_events_company_id ON integraciones.bsale_webhook_events (company_id);
CREATE INDEX IF NOT EXISTS idx_bsale_webhook_events_resource_id ON integraciones.bsale_webhook_events (resource_id);
CREATE INDEX IF NOT EXISTS idx_bsale_webhook_events_received_at ON integraciones.bsale_webhook_events (received_at);

-- Seguridad RLS y Grants
ALTER TABLE integraciones.bsale_webhook_events ENABLE ROW LEVEL SECURITY;

-- Revocación de permisos genéricos si fuera necesario
-- (Usualmente no necesario si RLS está habilitado, pero por seguridad explícita)
REVOKE ALL ON integraciones.bsale_webhook_events FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.bsale_webhook_events TO service_role;

-- Políticas de Seguridad
-- 1. Anon y Authenticated bloqueados por completo de toda acción
-- (El rechazo es por defecto en RLS al no haber políticas, pero lo hacemos explícito para mayor seguridad semántica si existieran configuraciones globales)
CREATE POLICY "Block anon" ON integraciones.bsale_webhook_events FOR ALL TO anon USING (false);
CREATE POLICY "Block authenticated" ON integraciones.bsale_webhook_events FOR ALL TO authenticated USING (false);

-- API server-side usa service_role, el cual sobrepasa (bypasses) el RLS por definición, por lo que no requiere políticas explícitas.
