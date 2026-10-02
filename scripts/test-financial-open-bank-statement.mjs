import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parseCurrentBankStatementXls } from '../src/lib/control-financiero/bank-statement-parser.ts'
import { buildOpenMovementKeys, compareOpenMovements } from '../src/lib/control-financiero/open-bank-statement.ts'

const accountId = 'account-caylo'
const parsed = parseCurrentBankStatementXls(new Uint8Array(fs.readFileSync('Informes bsale Excel/Cartolas/septiembre_29.xls')))

test('parses the current XLS as an accumulated open-month statement', () => {
  assert.equal(parsed.sourceFormat, 'CURRENT_XLS')
  assert.equal(parsed.accountNumber, '002161402707')
  assert.equal(parsed.year, 2026)
  assert.equal(parsed.month, 9)
  assert.equal(parsed.rowCount, 388)
  assert.equal(parsed.firstTransactionDate, '2026-09-01')
  assert.equal(parsed.lastTransactionDate, '2026-09-29')
  assert.equal(parsed.openingBalance, 1357916)
  assert.equal(parsed.totalCredits, 138984176)
  assert.equal(parsed.totalDebits, 135207181)
  assert.equal(parsed.closingBalance, 5559468)
  assert.equal(parsed.openingBalance + parsed.totalCredits - parsed.totalDebits, 5134911)
  assert.deepEqual(parsed.validations, { globalDifference: -424557, rowDifference: 424557, rowDifferenceCount: 1, rowDifferenceTotal: -424557, rowBalanceValidated: false })
})

test('keeps legitimate same-day same-amount rows separate', () => {
  const keys = buildOpenMovementKeys(accountId, parsed.movements)
  assert.equal(new Set(keys.map(key => key.movement_identity)).size, keys.length)
})

test('matches overlap, detects content conflicts and returns only new rows', () => {
  const movements = parsed.movements.slice(0, 3)
  const keys = buildOpenMovementKeys(accountId, movements)
  const same = compareOpenMovements(keys, keys.map(key => ({ ...key })))
  assert.deepEqual(same, { existing: 3, new: 0, conflicts: 0, newIndexes: [], conflictIndexes: [] })

  const changed = compareOpenMovements(keys, [{ ...keys[0], movement_content_hash: 'changed' }, keys[1]])
  assert.equal(changed.conflicts, 1)
  assert.equal(changed.new, 1)
  assert.deepEqual(changed.newIndexes, [2])
})

test('same file update is idempotent at movement level', () => {
  const keys = buildOpenMovementKeys(accountId, parsed.movements)
  const result = compareOpenMovements(keys, keys)
  assert.equal(result.new, 0)
  assert.equal(result.conflicts, 0)
  assert.equal(result.existing, parsed.rowCount)
})
