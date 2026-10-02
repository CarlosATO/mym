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
    document_number: movementValue.documentNumber,
    ...overrides,
  }
}

test('definitive parser accepts the semicolon export and requires exact reconciliation', () => {
  const parsed = parseDefinitiveBankStatement(fixture)
  assert.equal(parsed.sourceFormat, 'HISTORICAL_SEMICOLON')
  assert.equal(parsed.validations.globalDifference, 0)
  assert.equal(parsed.validations.rowDifference, 0)
})

test('cross-format match ignores metadata and balance ordering', () => {
  const current = movement(0, { documentNumber: 'DOC-A', branch: 'CANAL A', transactionNumber: null })
  const definitive = { ...current, documentNumber: 'DOC-B', branch: 'SUCURSAL B', transactionNumber: 'TRN-B', cashier: 'CAJA B', balance: 999999 }
  const existing = existingFrom(current, 0)
  const result = compareFinalCloseMovements(accountId, [definitive], [existing])
  assert.equal(result.matchedExisting, 1)
  assert.deepEqual(result.newIndexes, [])
  assert.deepEqual(result.existingMissingIndexes, [])
  assert.equal(result.matchedByFile.get(0)?.movement_identity, existing.movement_identity)
  assert.equal(result.matchedByFile.get(0)?.movement_content_hash, existing.movement_content_hash)
})

test('normalizes accents, colon spacing, truncation and trailing stars', () => {
  const existing = existingFrom(movement(0, { description: 'Traspaso De: Jorge Ignacio Abarzua Poblete' }), 0)
  const file = movement(0, { description: 'TRASPASO DE:JORGE IGNACIO ABARZUA' })
  const starExisting = existingFrom(movement(1, { description: 'Giro Cajero Automático             *' }), 1)
  const starFile = movement(1, { description: 'GIRO CAJERO AUTOMATICO' })
  const result = compareFinalCloseMovements(accountId, [file, starFile], [existing, starExisting])
  assert.equal(result.matchedExisting, 2)
  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(result.ambiguous, [])
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

test('matches identical duplicate movements as a multiset', () => {
  const first = movement(0)
  const second = { ...first, sourceRowNumber: 3 }
  const existing = [existingFrom(first, 0), existingFrom(second, 1, { movement_identity: 'existing-identity-duplicate' })]
  const result = compareFinalCloseMovements(accountId, [first, second], existing)
  assert.equal(result.matchedExisting, 2)
  assert.deepEqual(result.ambiguous, [])
  assert.deepEqual(result.existingMissing, [])
})

test('matches repeated amount buckets by description', () => {
  const existing = Array.from({ length: 7 }, (_, index) => existingFrom(
    movement(index, { date: '2026-09-01', description: `PAGO CONTRAPARTE ${index}`, debit: 20000, credit: 0 }),
    index,
  ))
  const file = [...existing].reverse().map((row, index) => movement(index, {
    description: row.operation_description,
    date: row.transaction_date,
    debit: Number(row.debit_amount),
    credit: Number(row.credit_amount),
    balance: 700000 + index,
  }))
  const result = compareFinalCloseMovements(accountId, file, existing)
  assert.equal(result.matchedExisting, 7)
  assert.deepEqual(result.conflicts, [])
})

test('handles cardinality changes and blocks real economic changes', () => {
  const original = movement(0)
  const existing = existingFrom(original, 0)
  const extra = movement(1)
  const surplus = compareFinalCloseMovements(accountId, [original, extra], [existing])
  const missing = compareFinalCloseMovements(accountId, [original], [existing, existingFrom(extra, 1)])
  const amountChanged = compareFinalCloseMovements(accountId, [{ ...original, debit: 999 }], [existing])
  const descriptionChanged = compareFinalCloseMovements(accountId, [{ ...original, description: 'OTRO MOVIMIENTO' }], [existing])
  assert.equal(surplus.matchedExisting, 1)
  assert.deepEqual(surplus.newRows, [1])
  assert.deepEqual(missing.existingMissing, [1])
  assert.deepEqual(amountChanged.newRows, [0])
  assert.deepEqual(amountChanged.conflicts, [])
  assert.deepEqual(descriptionChanged.conflicts, [0])
  assert.equal(amountChanged.existingMissingIndexes.length, 1)
  assert.equal(descriptionChanged.existingMissingIndexes.length, 1)
})

test('finalization migration remains atomic, strict and service-role restricted', () => {
  assert.match(migration, /BANK_STATEMENT_FINAL_CLOSE/)
  assert.match(migration, /status <> 'OPEN'/)
  assert.match(migration, /omite movimientos ya confirmados/)
  assert.match(migration, /status = 'CLOSED'/)
  assert.match(migration, /revoke all on function comercial\.finalize_financial_bank_statement_open[\s\S]*grant execute[\s\S]*to service_role/)
})
