-- Enable Caylo's already-classified reimbursement movements in the P&L.
-- No bank movements or recognized expense entries are changed.

UPDATE comercial.financial_categories
SET affects_pnl_directly = true,
    affects_cash_flow = true,
    classification_group = 'OPERATING',
    semantic_type = 'EXPENSE_REIMBURSEMENT',
    cash_direction = 'DEBIT',
    direction = 'EXPENSE',
    is_active = true
WHERE company_id = 'd1000000-0000-0000-0000-000000000001'
  AND code = 'EXPENSE_REIMBURSEMENTS';

CREATE OR REPLACE FUNCTION comercial.financial_expense_recognition_allowed_codes()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'EXPENSE_EXTERNAL_SERVICES',
    'EXPENSE_INSURANCE',
    'EXPENSE_TELECOM',
    'EXPENSE_REIMBURSEMENTS'
  ]::text[];
$$;
