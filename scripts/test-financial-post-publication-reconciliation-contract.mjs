import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = async (path) => readFile(new URL(path, root), "utf8");
const migration = await read(
  "supabase/migrations/20261007180000_financial_expense_posted_bank_reconciliation.sql",
);
const expensesApi = await read(
  "services/finance-api/app/financial/expenses.py",
);

const linkBody = migration.slice(
  migration.indexOf(
    "create or replace function comercial.link_financial_expense_bank_movement",
  ),
  migration.indexOf(
    "create or replace function comercial.unlink_financial_expense_bank_movement",
  ),
);
const unlinkBody = migration.slice(
  migration.indexOf(
    "create or replace function comercial.unlink_financial_expense_bank_movement",
  ),
);

test("posted expenses can be linked without changing lifecycle state", () => {
  assert.match(linkBody, /v_status not in \('DRAFT', 'POSTED'\)/);
  assert.match(
    linkBody,
    /v_status = 'POSTED' and v_source_type not in \('MANUAL', 'BANK_LINKED'\)/,
  );
  assert.match(linkBody, /set source_type = 'BANK_LINKED'/);
  assert.doesNotMatch(linkBody, /set status\s*=/);
  assert.match(unlinkBody, /v_status not in \('DRAFT', 'POSTED'\)/);
  assert.match(
    unlinkBody,
    /v_status = 'POSTED' and v_source_type <> 'BANK_LINKED'/,
  );
  assert.doesNotMatch(unlinkBody, /set status\s*=/);
});

test("link and unlink preserve economic fields and derive posted source type", () => {
  assert.match(
    linkBody,
    /where e\.company_id = p_company_id and e\.id = p_expense_entry_id\s+for update/,
  );
  assert.match(
    linkBody,
    /where m\.company_id = p_company_id[\s\S]*?for update of m/,
  );
  assert.doesNotMatch(linkBody, /left join[\s\S]*for update;/);
  assert.match(
    linkBody,
    /if v_status = 'POSTED' and v_source_type <> 'BANK_LINKED'/,
  );
  assert.match(unlinkBody, /set source_type = case when exists/);
  assert.match(unlinkBody, /else 'MANUAL' end/);
  assert.doesNotMatch(
    linkBody,
    /set (period_year|period_month|category_id|recognized_amount|description|counterparty_name|document_date|document_number|notes)\s*=/,
  );
  assert.doesNotMatch(
    unlinkBody,
    /set (period_year|period_month|category_id|recognized_amount|description|counterparty_name|document_date|document_number|notes)\s*=/,
  );
});

test("allocation, duplicate, company and classification safeguards remain transactional", () => {
  assert.match(linkBody, /m\.company_id = p_company_id/);
  assert.match(linkBody, /m\.direction = 'DEBE'/);
  assert.match(linkBody, /coalesce\(v_amount, 0\) <= 0/);
  assert.match(
    linkBody,
    /El gasto ya esta vinculado a ese movimiento bancario/,
  );
  assert.match(linkBody, /Las asignaciones exceden el monto DEBE disponible/);
  assert.match(linkBody, /Las asignaciones exceden el monto reconocido/);
  assert.match(linkBody, /if v_direct then/);
  assert.match(linkBody, /for update/);
});

test("link lifecycle and source changes use the existing audit log", () => {
  assert.match(migration, /'financial_expense_bank_links', v_id, 'BANK_LINK'/);
  assert.match(
    migration,
    /'financial_expense_bank_links', p_link_id, 'BANK_UNLINK'/,
  );
  assert.match(
    migration,
    /'financial_expense_entries', p_expense_entry_id, 'BANK_SOURCE_CHANGE'/,
  );
  assert.match(
    migration,
    /'financial_expense_entries', v_expense, 'BANK_SOURCE_CHANGE'/,
  );
  for (const action of ["BANK_LINK", "BANK_UNLINK", "BANK_SOURCE_CHANGE"]) {
    assert.ok(action.length <= 20);
    assert.match(migration, new RegExp(`'${action}'`));
  }
  assert.doesNotMatch(migration, /BANK_RECONCILIATION_SOURCE/);
});

test("posted source types outside manual reconciliation are rejected", () => {
  assert.match(
    linkBody,
    /Solo se pueden conciliar partidas POSTED MANUAL o BANK_LINKED/,
  );
  assert.match(
    unlinkBody,
    /Solo se pueden quitar vinculos de partidas POSTED BANK_LINKED/,
  );
  for (const sourceType of ["IMPORT", "PETTY_CASH", "LOAN"]) {
    assert.match(linkBody, new RegExp(sourceType));
  }
  assert.match(linkBody, /ya tiene vinculos bancarios inconsistentes/);
});

test("voided expenses are explicitly blocked for both operations", () => {
  assert.match(linkBody, /v_status not in \('DRAFT', 'POSTED'\)/);
  assert.match(unlinkBody, /v_status not in \('DRAFT', 'POSTED'\)/);
  assert.match(linkBody, /Solo se pueden vincular partidas DRAFT o POSTED/);
  assert.match(
    unlinkBody,
    /Solo se pueden quitar vinculos de partidas DRAFT o POSTED/,
  );
});

test("posted linked allocations are deducted before recognized expenses are added", () => {
  assert.match(expensesApi, /linked_expense\.status = 'POSTED'/);
  assert.match(expensesApi, /movement\.debit_amount - COALESCE\(\(/);
  assert.match(expensesApi, /SUM\(link\.allocated_amount\)/);
  assert.match(expensesApi, /recognized_movements/);
  assert.match(expensesApi, /expense\.status = 'POSTED'/);
});

test("full and multiple allocations leave the expected bank residual", () => {
  const residual = (movementAmount, allocations) =>
    Math.max(
      0,
      movementAmount - allocations.reduce((sum, amount) => sum + amount, 0),
    );

  assert.equal(residual(45_000, [45_000]), 0);
  assert.equal(residual(100_000, [40_000, 60_000]), 0);
  assert.equal(residual(100_000, [40_000]), 60_000);
});
