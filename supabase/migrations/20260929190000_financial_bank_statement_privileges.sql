-- Keep the bank-statement model behind the Next.js Server Actions/BFF.
-- The current flow uses service_role through createAdminClient(); it does not
-- expose these tables or the confirmation RPC to browser roles.

revoke all on table
    comercial.financial_bank_accounts,
    comercial.financial_imports,
    comercial.financial_statement_periods,
    comercial.financial_bank_movements
from public, anon, authenticated, service_role;

revoke all on function comercial.confirm_financial_bank_statement(
    uuid, uuid, jsonb, jsonb, jsonb, uuid
) from public, anon, authenticated, service_role;

grant usage on schema comercial to service_role;

-- Server Actions read the account catalog and create accounts from the UI.
grant select, insert on table comercial.financial_bank_accounts to service_role;

-- Dashboard reads these two tables directly. Imports are written only by the
-- SECURITY DEFINER confirmation function below.
grant select on table
    comercial.financial_statement_periods,
    comercial.financial_bank_movements
to service_role;

grant execute on function comercial.confirm_financial_bank_statement(
    uuid, uuid, jsonb, jsonb, jsonb, uuid
) to service_role;
