-- Keep every non-operating category under its non-operating branch.
-- This changes catalog hierarchy only; no bank movements are modified.

update comercial.financial_categories category
set parent_id = parent.id
from comercial.financial_categories parent
where category.company_id = parent.company_id
  and category.code in (
    'INCOME_FINANCING', 'INCOME_INTERNAL_TRANSFER', 'INCOME_INTERCOMPANY'
  )
  and parent.code = 'INCOME_NON_OPERATING';

update comercial.financial_categories category
set parent_id = parent.id
from comercial.financial_categories parent
where category.company_id = parent.company_id
  and category.code in (
    'EXPENSE_FINANCING', 'EXPENSE_ASSETS', 'EXPENSE_INTERNAL_TRANSFER', 'EXPENSE_INTERCOMPANY'
  )
  and parent.code = 'EXPENSE_NON_OPERATING';
