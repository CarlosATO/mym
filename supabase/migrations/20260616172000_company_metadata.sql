-- Migration: Add extra company configuration fields to core.companies
ALTER TABLE core.companies ADD COLUMN IF NOT EXISTS giro text;
ALTER TABLE core.companies ADD COLUMN IF NOT EXISTS region text;
ALTER TABLE core.companies ADD COLUMN IF NOT EXISTS comuna text;
ALTER TABLE core.companies ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE core.companies ADD COLUMN IF NOT EXISTS purchase_email text;
ALTER TABLE core.companies ADD COLUMN IF NOT EXISTS finance_email text;
ALTER TABLE core.companies ADD COLUMN IF NOT EXISTS website text;
ALTER TABLE core.companies ADD COLUMN IF NOT EXISTS admin_contact_name text;
ALTER TABLE core.companies ADD COLUMN IF NOT EXISTS observations text;
ALTER TABLE core.companies ADD COLUMN IF NOT EXISTS document_footer text;
ALTER TABLE core.companies ADD COLUMN IF NOT EXISTS purchase_terms text;
ALTER TABLE core.companies ADD COLUMN IF NOT EXISTS legal_text text;
ALTER TABLE core.companies ADD COLUMN IF NOT EXISTS default_po_prefix text DEFAULT 'OC';
ALTER TABLE core.companies ADD COLUMN IF NOT EXISTS default_currency text DEFAULT 'CLP';
ALTER TABLE core.companies ADD COLUMN IF NOT EXISTS default_tax_rate numeric DEFAULT 19;
ALTER TABLE core.companies ADD COLUMN IF NOT EXISTS default_payment_days integer DEFAULT 30;
