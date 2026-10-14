import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { evaluateOpenReconciliation } from '../src/lib/control-financiero/open-bank-statement.ts'

const fixture = JSON.parse(fs.readFileSync('scripts/fixtures/financial-open-restatement.json', 'utf8'))

test('OPEN fixture is self-contained and represents the Banco de Chile contract', () => {
  assert.equal(fixture.rowsInFile, 162)
  assert.equal(fixture.exactMatched + fixture.balanceRestatements + fixture.new, fixture.rowsInFile)
  assert.equal(fixture.trueConflicts, 0)
  assert.equal(fixture.existingMissing, 0)
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
