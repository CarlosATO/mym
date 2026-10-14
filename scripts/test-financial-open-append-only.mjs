import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { compareOpenMovements, ensureOpenInsertKeys, evaluateOpenReconciliation } from '../src/lib/control-financiero/open-bank-statement.ts'

function movement(index, overrides = {}) {
  return {
    date: `2026-10-${String(index + 1).padStart(2, '0')}`,
    description: `MOVIMIENTO ${index}`,
    debit: 0,
    credit: 1000,
    balance: 100000 + index,
    documentNumber: `DOC-${index}`,
    transactionNumber: `TRN-${index}`,
    cashier: 'CAJA A',
    branch: 'SUCURSAL A',
    sourceRowNumber: index + 2,
    sequenceNumber: index + 1,
    raw: {},
    ...overrides,
  }
}

function existing(row, index, overrides = {}) {
  return {
    movement_identity: `existing-${index}`,
    movement_content_hash: `hash-${index}`,
    transaction_date: row.date,
    operation_description: row.description,
    credit_amount: row.credit,
    debit_amount: row.debit,
    balance_after: row.balance,
    source_row_number: row.sourceRowNumber,
    document_number: row.documentNumber,
    transaction_number: row.transactionNumber,
    branch: row.branch,
    cashier: row.cashier,
    ...overrides,
  }
}

test('exact, restatement, amount conflict, description conflict and missing are distinct', () => {
  const row = movement(0)
  const exact = compareOpenMovements([row], [existing(row, 0)])
  assert.equal(exact.exactMatched, 1)
  assert.equal(exact.balanceRestatements.length, 0)

  const restated = compareOpenMovements([movement(0, { balance: 99000 })], [existing(row, 0)])
  assert.equal(restated.exactMatched, 0)
  assert.equal(restated.balanceRestatements.length, 1)
  assert.equal(restated.new, 0)
  assert.equal(restated.conflicts, 0)

  const amountConflict = compareOpenMovements([movement(0, { credit: 2000 })], [existing(row, 0)])
  assert.deepEqual(amountConflict.conflictIndexes, [0])
  assert.deepEqual(amountConflict.existingMissing, [0])

  const descriptionConflict = compareOpenMovements([movement(0, { description: 'OTRA OPERACION' })], [existing(row, 0)])
  assert.deepEqual(descriptionConflict.conflictIndexes, [0])
  assert.deepEqual(descriptionConflict.existingMissing, [0])

  const missing = compareOpenMovements([], [existing(row, 0)])
  assert.deepEqual(missing.existingMissing, [0])
  assert.equal(missing.conflicts, 0)
})

test('new movement is not absorbed by a prior movement', () => {
  const row = movement(0, { credit: 362715 })
  const result = compareOpenMovements([row], [])
  assert.deepEqual(result.newIndexes, [0])
  assert.equal(result.new, 1)
})

test('identity collision protection changes only the new insert key', () => {
  const keys = [
    { movement_identity: 'existing-id', movement_content_hash: 'old' },
    { movement_identity: 'new-id', movement_content_hash: 'new' },
  ]
  const result = ensureOpenInsertKeys(keys, [1], [{ movement_identity: 'new-id', movement_content_hash: 'old' }])
  assert.equal(result[0].movement_identity, 'existing-id')
  assert.notEqual(result[1].movement_identity, 'new-id')
})

test('85 exact plus 18 restated plus 59 new partitions 162 rows', () => {
  const file = Array.from({ length: 162 }, (_, index) => movement(index))
  const prior = [
    ...file.slice(0, 85).map((row, index) => existing(row, index)),
    ...file.slice(85, 103).map((row, index) => existing(row, index + 85, { balance_after: row.balance - 362715 })),
  ]
  const result = compareOpenMovements(file, prior)
  assert.equal(result.exactMatched, 85)
  assert.equal(result.balanceRestatements.length, 18)
  assert.equal(result.new, 59)
  assert.equal(result.conflicts, 0)
  assert.equal(result.existingMissing.length, 0)
})

test('uniform restatement explains legacy incremental difference and permits confirmation', () => {
  const restatements = Array.from({ length: 18 }, (_, index) => ({
    fileIndex: index,
    existingIndex: index,
    movement_identity: `restated-${index}`,
    oldBalance: 5143078,
    newBalance: 4780363,
    sourceRowNumber: index + 2,
    date: '2026-10-08',
  }))
  const result = evaluateOpenReconciliation({
    openingDifference: 0,
    fileGlobalDifference: 0,
    rowBalancesValid: true,
    existingMissing: 0,
    trueConflicts: 0,
    legacyIncrementalDifference: -362715,
    restatements,
  })
  assert.equal(result.restatementAdjustment, -362715)
  assert.equal(result.unexplainedDifference, 0)
  assert.equal(result.restatementExplained, true)
  assert.equal(result.canConfirm, true)
})

test('non-uniform restatements and invalid file conditions block confirmation', () => {
  const restatements = [
    { fileIndex: 0, existingIndex: 0, movement_identity: 'a', oldBalance: 100, newBalance: 90, sourceRowNumber: 2, date: '2026-10-08' },
    { fileIndex: 1, existingIndex: 1, movement_identity: 'b', oldBalance: 200, newBalance: 180, sourceRowNumber: 3, date: '2026-10-08' },
  ]
  const nonUniform = evaluateOpenReconciliation({
    openingDifference: 0, fileGlobalDifference: 0, rowBalancesValid: true,
    existingMissing: 0, trueConflicts: 0, legacyIncrementalDifference: -30, restatements,
  })
  assert.equal(nonUniform.restatementDeltasUniform, false)
  assert.equal(nonUniform.canConfirm, false)
  for (const invalid of [
    { fileGlobalDifference: 1, existingMissing: 0, trueConflicts: 0 },
    { fileGlobalDifference: 0, existingMissing: 1, trueConflicts: 0 },
    { fileGlobalDifference: 0, existingMissing: 0, trueConflicts: 1 },
  ]) {
    const result = evaluateOpenReconciliation({
      openingDifference: 0, rowBalancesValid: true, legacyIncrementalDifference: 0,
      restatements: [], ...invalid,
    })
    assert.equal(result.canConfirm, false)
  }
})

test('classification fields are not touched by in-memory matching', () => {
  const row = movement(0, { description: 'TRASPASO A: MAYORISTA PETS SPA', debit: 1000000, credit: 0 })
  const prior = existing(row, 0, { category_id: 'providers', review_status: 'REVIEWED', counterparty: 'Mayorista Pets Spa' })
  const result = compareOpenMovements([row], [prior])
  assert.equal(result.exactMatched, 1)
  assert.equal(prior.category_id, 'providers')
  assert.equal(prior.review_status, 'REVIEWED')
  assert.equal(prior.counterparty, 'Mayorista Pets Spa')
})

test('OPEN RPC and final close are append-only with stale protection', () => {
  const openRpc = fs.readFileSync('supabase/migrations/20261014220000_financial_open_append_only_restatements.sql', 'utf8')
  const finalRpc = fs.readFileSync('supabase/migrations/20261003220000_financial_finalize_open_bank_statement.sql', 'utf8')
  assert.doesNotMatch(openRpc, /(?:update|delete)\s+comercial\.financial_bank_movements/i)
  assert.doesNotMatch(finalRpc, /(?:update|delete)\s+comercial\.financial_bank_movements/i)
  assert.match(openRpc, /El período cambió desde el análisis\. Vuelve a analizar la cartola\./)
  assert.match(openRpc, /jsonb_array_length\(p_movements\)/)
  assert.match(openRpc, /resolve_previous_compatible/)
  assert.match(openRpc, /balance_restatement_count/)
  assert.match(openRpc, /La importación OPEN tiene una diferencia inexplicada y no puede confirmarse/)
})

test('auto classification is restricted to NEW identities', () => {
  const action = fs.readFileSync('src/app/actions/control-financiero/bank-statements.ts', 'utf8')
  assert.match(action, /newRows\.map\(\(\{ key \}\) => key\.movement_identity\)/)
  assert.match(action, /diff\.newIndexes\.map\(\(index\) => generatedKeys\[index\]\.movement_identity\)/)
})
