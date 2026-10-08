import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = async (path) => readFile(new URL(path, root), "utf8");
const migration = await read(
  "supabase/migrations/20261007181000_financial_loan_payment_bank_allocation_lock.sql",
);
const loanBody = migration.slice(
  migration.indexOf(
    "create or replace function comercial.create_financial_loan_payment",
  ),
  migration.indexOf("revoke all on function"),
);

test("loan payment preserves the public function security contract", () => {
  assert.match(
    migration,
    /create or replace function comercial\.create_financial_loan_payment\(\s*p_company_id uuid, p_loan_id uuid, p_payment_date date, p_total_amount numeric,\s*p_principal_amount numeric, p_interest_amount numeric, p_fee_amount numeric,\s*p_notes text, p_metadata jsonb, p_idempotency_key text, p_actor uuid, p_bank_movement_id uuid default null\s*\) returns uuid language plpgsql security definer/,
  );
  assert.match(migration, /set search_path = pg_catalog, comercial/);
  assert.match(migration, /revoke all on function[\s\S]*create_financial_loan_payment/);
  assert.match(migration, /grant execute on function[\s\S]*create_financial_loan_payment[\s\S]*to service_role/);
});

test("loan payment locks the movement before reading allocation totals", () => {
  const lock = loanBody.indexOf("from comercial.financial_bank_movements m");
  const allocation = loanBody.indexOf("from comercial.financial_expense_bank_links l");
  const payment = loanBody.indexOf("insert into comercial.financial_loan_payments");
  assert.ok(lock >= 0);
  assert.ok(loanBody.indexOf("for update", lock) > lock);
  assert.ok(allocation > lock);
  assert.ok(payment > allocation);
  assert.match(loanBody, /v_linked_amount \+ p_interest_amount \+ p_fee_amount > v_bank_amount/);
  assert.match(loanBody, /Las asignaciones exceden el monto DEBE disponible/);
});

test("loan accounting semantics remain unchanged", () => {
  assert.equal((loanBody.match(/'LOAN'/g) ?? []).length, 2);
  assert.match(loanBody, /p_principal_amount \+ p_interest_amount \+ p_fee_amount <> p_total_amount/);
  assert.match(loanBody, /p_principal_amount > v_original - v_paid/);
  assert.match(loanBody, /p_interest_amount > 0/);
  assert.match(loanBody, /p_fee_amount > 0/);
  assert.doesNotMatch(loanBody, /set source_type\s*=\s*'MANUAL'/);
});

test("only interest and fees consume bank-link allocation", () => {
  assert.match(loanBody, /v_linked_amount \+ p_interest_amount \+ p_fee_amount/);
  assert.match(loanBody, /allocated_amount, created_by\)\s*values \([^;]*p_interest_amount/);
  assert.match(loanBody, /allocated_amount, created_by\)\s*values \([^;]*p_fee_amount/);
});
