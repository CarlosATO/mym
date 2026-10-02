import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parseDefinitiveBankStatement } from '../src/lib/control-financiero/bank-statement-parser.ts'
import { compareFinalCloseMovements } from '../src/lib/control-financiero/open-bank-statement.ts'

const migration = fs.readFileSync('supabase/migrations/20261003220000_financial_finalize_open_bank_statement.sql', 'utf8')
const accountId = 'account-caylo'

const fixture = `CAYLO PREMIUM SpA (077196005-7) cta:002161402707
Fecha;Detalle Movimiento;Cheque o Cargo;Deposito o Abono;Saldo;Docto. Nro.;Trn;Caja;Sucursal
01/05/2026;ABONO CLIENTE;00000000000;+0000000100;+0000001100;00000000000;0000000001;0000000000;INTERNET
02/05/2026;PAGO PROVEEDOR;+0000000200;00000000000;+0000000900;00000000000;0000000002;0000000000;INTERNET`

function movement(index, overrides = {}) {
  return {
    date: `2026-09-${String(index + 1).padStart(2, '0')}`,
    description: `MOVIMIENTO ${index}`,
    debit: index % 2 ? 200 : 0,
    credit: index % 2 ? 0 : 100,
    balance: 100000 + index,
    documentNumber: null,
    transactionNumber: null,
    cashier: 'A',
    branch: 'CANAL A',
    sourceRowNumber: index + 2,
    sequenceNumber: index + 1,
    raw: {},
    ...overrides,
  }
}

function existingFrom(movementValue, index, overrides = {}) {
  return {
    movement_identity: `existing-identity-${index}`,
    movement_content_hash: `existing-hash-${index}`,
    transaction_date: movementValue.date,
    operation_description: movementValue.description,
    credit_amount: movementValue.credit,
    debit_amount: movementValue.debit,
    balance_after: movementValue.balance,
    source_row_number: index + 10,
    ...overrides,
  }
}

test('definitive parser accepts the semicolon export and requires exact reconciliation', () => {
  const parsed = parseDefinitiveBankStatement(fixture)
  assert.equal(parsed.sourceFormat, 'HISTORICAL_SEMICOLON')
  assert.equal(parsed.validations.globalDifference, 0)
  assert.equal(parsed.validations.rowDifference, 0)
})

test('cross-format match ignores document, transaction, branch and cashier metadata', () => {
  const current = movement(0, { documentNumber: 'DOC-A', branch: 'CANAL A', transactionNumber: null })
  const definitive = { ...current, documentNumber: 'DOC-B', branch: 'SUCURSAL B', transactionNumber: 'TRN-B', cashier: 'CAJA B' }
  const existing = existingFrom(current, 0)
  const result = compareFinalCloseMovements(accountId, [definitive], [existing])
  assert.equal(result.matchedExisting, 1)
  assert.deepEqual(result.newIndexes, [])
  assert.deepEqual(result.existingMissingIndexes, [])
  assert.equal(result.matchedByFile.get(0)?.movement_identity, existing.movement_identity)
  assert.equal(result.matchedByFile.get(0)?.movement_content_hash, existing.movement_content_hash)
})

test('matches 388 equivalent rows and returns only 24 genuinely new rows', () => {
  const current = Array.from({ length: 388 }, (_, index) => movement(index))
  const definitive = current.map((row, index) => ({
    ...row,
    documentNumber: `DOC-${index}`,
    transactionNumber: `TRN-${index}`,
    branch: 'SUCURSAL DEFINITIVA',
    cashier: 'CAJA DEFINITIVA',
  })).concat(Array.from({ length: 24 }, (_, index) => movement(388 + index)))
  const existing = current.map(existingFrom)
  const result = compareFinalCloseMovements(accountId, definitive, existing)
  assert.equal(result.matchedExisting, 388)
  assert.equal(result.newIndexes.length, 24)
  assert.equal(result.existingMissingIndexes.length, 0)
  assert.equal(result.conflictIndexes.length, 0)
  assert.equal(result.ambiguousIndexes.length, 0)
})

test('blocks missing and ambiguous economic matches', () => {
  const first = movement(0)
  const second = movement(1)
  const missing = compareFinalCloseMovements(accountId, [first], [existingFrom(first, 0), existingFrom(second, 1)])
  assert.equal(missing.existingMissingIndexes.length, 1)

  const duplicate = existingFrom(first, 0, { movement_identity: 'existing-identity-duplicate' })
  const ambiguous = compareFinalCloseMovements(accountId, [first], [existingFrom(first, 0), duplicate])
  assert.deepEqual(ambiguous.ambiguousIndexes, [0])
  assert.equal(ambiguous.matchedExisting, 0)
})

test('blocks real economic changes without treating format metadata as a conflict', () => {
  const original = movement(0)
  const existing = existingFrom(original, 0)
  const amountChanged = compareFinalCloseMovements(accountId, [{ ...original, debit: 999 }], [existing])
  const balanceChanged = compareFinalCloseMovements(accountId, [{ ...original, balance: 999999 }], [existing])
  const descriptionChanged = compareFinalCloseMovements(accountId, [{ ...original, description: 'OTRO MOVIMIENTO' }], [existing])
  assert.deepEqual(amountChanged.conflictIndexes, [0])
  assert.deepEqual(balanceChanged.conflictIndexes, [0])
  assert.deepEqual(descriptionChanged.newIndexes, [0])
  assert.equal(amountChanged.existingMissingIndexes.length, 1)
  assert.equal(balanceChanged.existingMissingIndexes.length, 1)
  assert.equal(descriptionChanged.existingMissingIndexes.length, 1)
})

test('finalization migration remains atomic, strict and service-role restricted', () => {
  assert.match(migration, /BANK_STATEMENT_FINAL_CLOSE/)
  assert.match(migration, /status <> 'OPEN'/)
  assert.match(migration, /omite movimientos ya confirmados/)
  assert.match(migration, /status = 'CLOSED'/)
  assert.match(migration, /revoke all on function comercial\.finalize_financial_bank_statement_open[\s\S]*grant execute[\s\S]*to service_role/)
})
