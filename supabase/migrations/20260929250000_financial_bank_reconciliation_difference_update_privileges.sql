-- The server action updates only the workflow fields of a reconciliation difference.
grant update (status, reason_type, counterparty, note)
  on table comercial.financial_bank_reconciliation_differences to service_role;
