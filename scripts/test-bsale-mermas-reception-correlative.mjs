import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20261001170000_mermas_bsale_reception_numeric_correlative.sql', import.meta.url), 'utf8')

test('reception correlatives are scoped by company and year', () => {
  assert.match(migration, /PRIMARY KEY \(company_id, reception_year\)/)
  assert.match(migration, /ON CONFLICT \(company_id, reception_year\)/)
  assert.match(migration, /next_value = mermas\.bsale_reception_correlatives\.next_value \+ 1/)
  assert.match(migration, /REG-' \|\| v_year::text \|\| '-'/)
})

test('document number is numeric and bounded to six digits per year', () => {
  assert.match(migration, /document_number bigint/)
  assert.match(migration, /v_document_number := v_year::bigint \* 1000000 \+ v_sequence/)
  assert.match(migration, /v_sequence > 999999/)
})

test('reconciliation transition is guarded and does not create a reception', () => {
  assert.match(migration, /confirm_reconciled_bsale_reception/)
  assert.match(migration, /status <> 'RECONCILIATION_REQUIRED'/)
  assert.doesNotMatch(migration.slice(migration.indexOf('confirm_reconciled_bsale_reception')), /stocks\/receptions\.json/)
})
