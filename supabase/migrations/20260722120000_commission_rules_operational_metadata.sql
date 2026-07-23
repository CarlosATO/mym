ALTER TABLE comercial.commission_rules
  ADD COLUMN IF NOT EXISTS rule_name text,
  ADD COLUMN IF NOT EXISTS rule_description text,
  ADD COLUMN IF NOT EXISTS rule_batch_id uuid,
  ADD COLUMN IF NOT EXISTS source_workflow text,
  ADD COLUMN IF NOT EXISTS selection_summary jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_commission_rules_company_batch
  ON comercial.commission_rules(company_id, rule_batch_id)
  WHERE rule_batch_id IS NOT NULL;
