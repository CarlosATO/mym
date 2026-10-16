import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { evaluateOpenReconciliation } from '../src/lib/control-financiero/open-bank-statement.ts'

const fixture = JSON.parse(fs.readFileSync('scripts/fixtures/financial-open-restatement.json', 'utf8'))
const resolvedFixture = JSON.parse(fs.readFileSync('scripts/fixtures/financial-open-resolved-restatement.json', 'utf8'))

function uniformRestatements(count, { date, oldBalance, newBalance }) {
  return Array.from({ length: count }, (_, index) => ({
    fileIndex: index,
    existingIndex: index,
    movement_identity: `restated-${index}`,
    oldBalance,
    newBalance,
    sourceRowNumber: index + 2,
    date,
  }))
}

function resolvedEvidence(overrides = {}) {
  const evidence = resolvedFixture.historicalResolvedEvidence
  return {
    id: evidence.id,
    financial_date: evidence.financial_date,
    amount_signed: evidence.amount_signed,
    expected_balance: evidence.expected_balance,
    reported_balance: evidence.reported_balance,
    ...overrides,
  }
}

function evaluateResolvedScenario(overrides = {}) {
  return evaluateOpenReconciliation({
    openingDifference: 0,
    fileGlobalDifference: 0,
    rowBalancesValid: true,
    existingMissing: 0,
    trueConflicts: 0,
    legacyIncrementalDifference: resolvedFixture.legacyIncrementalDifference,
    restatements: uniformRestatements(resolvedFixture.balanceRestatements, {
      date: resolvedFixture.historicalResolvedEvidence.financial_date,
      oldBalance: 5143078,
      newBalance: 4780363,
    }),
    resolvedRestatementEvidence: [resolvedEvidence()],
    ...overrides,
  })
}

test('OPEN fixture is self-contained and represents the Banco de Chile contract', () => {
  assert.equal(fixture.rowsInFile, 162)
  assert.equal(fixture.exactMatched + fixture.balanceRestatements + fixture.new, fixture.rowsInFile)
  assert.equal(fixture.trueConflicts, 0)
  assert.equal(fixture.existingMissing, 0)
})

test('resolved restatement fixture reproduces the current production case', () => {
  assert.equal(resolvedFixture.existing + resolvedFixture.new, resolvedFixture.rowsInFile)
  assert.equal(resolvedFixture.exactMatched + resolvedFixture.balanceRestatements, resolvedFixture.existing)
  assert.equal(resolvedFixture.legacyIncrementalDifference, 0)
  assert.equal(resolvedFixture.restatementAdjustment, -362715)
  assert.equal(resolvedFixture.historicalResolvedEvidence.amount_signed, 362715)
  assert.equal(resolvedFixture.historicalResolvedEvidence.financial_date, '2026-10-08')
  assert.equal(resolvedFixture.historicalResolvedEvidence.status, 'RESOLVED')
})


test('OPEN fixture explains the legacy incremental difference', () => {
  const result = evaluateOpenReconciliation({
    openingDifference: 0,
    fileGlobalDifference: 0,
    rowBalancesValid: true,
    existingMissing: fixture.existingMissing,
    trueConflicts: fixture.trueConflicts,
    legacyIncrementalDifference: fixture.legacyIncrementalDifference,
    restatements: Array.from({ length: fixture.balanceRestatements }, (_, index) => ({
      fileIndex: index,
      existingIndex: index,
      movement_identity: `restated-${index}`,
      oldBalance: 1000000,
      newBalance: 637285,
      sourceRowNumber: index + 2,
      date: '2026-10-08',
    })),
  })
  assert.equal(result.restatementAdjustment, fixture.restatementAdjustment)
  assert.equal(result.unexplainedDifference, fixture.unexplainedDifference)
  assert.equal(result.restatementExplained, true)
  assert.equal(result.canConfirm, true)
})

test('CASO 1 - resolved historical restatement unblocks a fully reconciled OPEN file', () => {
  const result = evaluateResolvedScenario()
  assert.equal(result.legacyIncrementalDifference, 0)
  assert.equal(result.restatementAdjustment, -362715)
  assert.equal(result.unexplainedDifference, 0)
  assert.equal(result.restatementDeltasUniform, true)
  assert.equal(result.restatementExplained, true)
  assert.equal(result.historicalRestatementRecognized, true)
  assert.equal(result.historicalRestatementDifferenceId, resolvedFixture.historicalResolvedEvidence.id)
  assert.equal(result.canConfirm, true)
})

test('CASO 2 - same situation without resolved evidence stays blocked', () => {
  const result = evaluateResolvedScenario({ resolvedRestatementEvidence: [] })
  assert.equal(result.unexplainedDifference, 362715)
  assert.equal(result.historicalRestatementRecognized, false)
  assert.equal(result.historicalRestatementDifferenceId, null)
  assert.equal(result.canConfirm, false)
})

test('CASO 3 - ambiguous resolved evidence stays blocked', () => {
  const result = evaluateResolvedScenario({ resolvedRestatementEvidence: [resolvedEvidence(), resolvedEvidence({ id: 'other-id' })] })
  assert.equal(result.historicalRestatementRecognized, false)
  assert.equal(result.canConfirm, false)
})

test('CASO 4 - same amount on a different date stays blocked', () => {
  const result = evaluateResolvedScenario({
    resolvedRestatementEvidence: [resolvedEvidence({ financial_date: '2026-10-07' })],
  })
  assert.equal(result.historicalRestatementRecognized, false)
  assert.equal(result.canConfirm, false)
})

test('CASO 5 - non-uniform restatements stay blocked', () => {
  const result = evaluateOpenReconciliation({
    openingDifference: 0,
    fileGlobalDifference: 0,
    rowBalancesValid: true,
    existingMissing: 0,
    trueConflicts: 0,
    legacyIncrementalDifference: 0,
    restatements: [
      { fileIndex: 0, existingIndex: 0, movement_identity: 'a', oldBalance: 100, newBalance: 90, sourceRowNumber: 2, date: '2026-10-08' },
      { fileIndex: 1, existingIndex: 1, movement_identity: 'b', oldBalance: 200, newBalance: 180, sourceRowNumber: 3, date: '2026-10-08' },
    ],
    resolvedRestatementEvidence: [resolvedEvidence()],
  })
  assert.equal(result.restatementDeltasUniform, false)
  assert.equal(result.historicalRestatementRecognized, false)
  assert.equal(result.canConfirm, false)
})

test('CASO 6 - missing existing movements stay blocked even with resolved evidence', () => {
  const result = evaluateResolvedScenario({ existingMissing: 1 })
  assert.equal(result.historicalRestatementRecognized, false)
  assert.equal(result.canConfirm, false)
})

test('CASO 7 - true content conflicts stay blocked even with resolved evidence', () => {
  const result = evaluateResolvedScenario({ trueConflicts: 1 })
  assert.equal(result.historicalRestatementRecognized, false)
  assert.equal(result.canConfirm, false)
})

test('CASO 8 - a non-zero file global difference stays blocked even with resolved evidence', () => {
  const result = evaluateResolvedScenario({ fileGlobalDifference: 1 })
  assert.equal(result.historicalRestatementRecognized, false)
  assert.equal(result.canConfirm, false)
})

test('CASO 9 - a non-zero opening difference stays blocked even with resolved evidence', () => {
  const result = evaluateResolvedScenario({ openingDifference: 1 })
  assert.equal(result.historicalRestatementRecognized, false)
  assert.equal(result.canConfirm, false)
})

test('CASO 10 - a new restatement explaining the incremental difference still works without historical evidence', () => {
  const result = evaluateOpenReconciliation({
    openingDifference: 0,
    fileGlobalDifference: 0,
    rowBalancesValid: true,
    existingMissing: 0,
    trueConflicts: 0,
    legacyIncrementalDifference: -362715,
    restatements: uniformRestatements(18, { date: '2026-10-08', oldBalance: 5143078, newBalance: 4780363 }),
  })
  assert.equal(result.restatementAdjustment, -362715)
  assert.equal(result.unexplainedDifference, 0)
  assert.equal(result.historicalRestatementRecognized, false)
  assert.equal(result.restatementExplained, true)
  assert.equal(result.canConfirm, true)
})

test('resolved evidence is only ever used read-only and never resolved again', () => {
  const action = fs.readFileSync('src/app/actions/control-financiero/bank-statements.ts', 'utf8')
  const migration = fs.readFileSync('supabase/migrations/20261014220000_financial_open_append_only_restatements.sql', 'utf8')
  assert.match(action, /pendingDifferences = differenceRows\.filter\(\(row\) => row\.status === "PENDING"\)/)
  assert.match(action, /resolvedDifferences = differenceRows\.filter\(\(row\) => row\.status === "RESOLVED"\)/)
  assert.match(action, /context\.pendingDifferences/)
  assert.match(action, /resolvedRestatementEvidence: context\.resolvedDifferences/)
  assert.match(migration, /and statement_period_id = v_period_id and status = 'PENDING'/)
})
