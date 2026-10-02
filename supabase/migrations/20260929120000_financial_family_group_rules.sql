-- Persistent managerial grouping rules for the financial family matrix.
-- BSale product type names and family keys remain source data; this table only
-- stores the presentation/grouping layer above them.
CREATE TABLE comercial.financial_family_group_rules (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    source_prefix   text NOT NULL CHECK (btrim(source_prefix) <> ''),
    normalized_name text NOT NULL CHECK (btrim(normalized_name) <> ''),
    active          boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (company_id, source_prefix)
);

COMMENT ON TABLE comercial.financial_family_group_rules IS
    'Gerencial grouping layer for financial sales families. It never changes BSale family classification.';

CREATE INDEX financial_family_group_rules_company_active_idx
    ON comercial.financial_family_group_rules(company_id, active);

ALTER TABLE comercial.financial_family_group_rules ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON comercial.financial_family_group_rules FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON comercial.financial_family_group_rules TO service_role;

CREATE OR REPLACE FUNCTION comercial.set_financial_family_group_rule_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER financial_family_group_rules_updated_at
    BEFORE UPDATE ON comercial.financial_family_group_rules
    FOR EACH ROW
    EXECUTE FUNCTION comercial.set_financial_family_group_rule_updated_at();
