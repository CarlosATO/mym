ALTER TABLE comercial.commission_rules
  ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS archived_by uuid NULL,
  ADD COLUMN IF NOT EXISTS archive_reason text NULL;

CREATE INDEX IF NOT EXISTS idx_commission_rules_company_archived
  ON comercial.commission_rules(company_id, is_archived, is_active);
