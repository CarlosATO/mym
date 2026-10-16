import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parseItauStatementText } from '../src/lib/control-financiero/bank-statement-parser.ts'
import { buildOpenMovementKeys, compareOpenMovementsLegacy } from '../src/lib/control-financiero/open-bank-statement.ts'

const ACCOUNT_ID = 'itau-open-regression-account'
const currentText = fs.readFileSync(new URL('./fixtures/itau-current-open-2026-10.txt', import.meta.url), 'utf8')
const previousText = fs.readFileSync(new URL('./fixtures/itau-current-open.txt', import.meta.url), 'utf8')
const parsed = parseItauStatementText(currentText)
const previous = parseItauStatementText(previousText)

function keysFor(movements) {
  return buildOpenMovementKeys(ACCOUNT_ID, movements)
}

function reparseOpenFixture(text) {
  return parseItauStatementText(text)
}

test('CASO 1 - "Anticipo Oct 2026" se interpreta como cargo (debe)', () => {
  const anticipo = parsed.movements.find((row) => row.description === 'Anticipo Oct 2026')
  assert.ok(anticipo)
  assert.equal(anticipo.credit, 0)
  assert.equal(anticipo.debit, 2690252)
  assert.equal(anticipo.balance, 0)
})

test('CASO 2 - "Bdp Previred ..." se interpreta como cargo (debe)', () => {
  const previred = parsed.movements.find((row) => row.description === 'Bdp Previred 23083760993')
  assert.ok(previred)
  assert.equal(previred.credit, 0)
  assert.equal(previred.debit, 277742)
  assert.equal(previred.balance, 0)
})

test('CASO 3 - "Transf. De ..." sigue siendo abono (haber) cuando corresponde', () => {
  const transfer = parsed.movements.find((row) => row.documentNumber === '608253181')
  assert.ok(transfer)
  assert.equal(transfer.credit, 3000000)
  assert.equal(transfer.debit, 0)
  const late = parsed.movements.find((row) => row.documentNumber === '607643055')
  assert.equal(late?.credit, 300000)
  assert.equal(late?.debit, 0)
})

test('CASO 4 - mismo día, descripción y monto con documentos distintos conservan identidad distinta', () => {
  const first = parsed.movements.findIndex((row) => row.documentNumber === '603562349')
  const second = parsed.movements.findIndex((row) => row.documentNumber === '603562347')
  assert.ok(first >= 0 && second >= 0)
  for (const index of [first, second]) {
    assert.equal(parsed.movements[index].date, '2026-10-01')
    assert.equal(parsed.movements[index].description, 'Transf. De 77196005-7 Caylo')
    assert.equal(parsed.movements[index].credit, 5000000)
    assert.equal(parsed.movements[index].branch, '1980')
  }
  const keys = keysFor(parsed.movements)
  assert.notEqual(keys[first].movement_identity, keys[second].movement_identity)
  const diff = compareOpenMovementsLegacy(
    keys,
    keysFor(previous.movements).map((key) => ({ ...key })),
  )
  assert.equal(diff.existingMissing.length, 0)
  assert.equal(diff.newIndexes.includes(first), false)
  assert.equal(diff.newIndexes.includes(second), false)
})

test('CASO 5 - un movimiento tras el page break se parsea igual que en la página 1', () => {
  const withoutPageBreak = currentText.replace(/-- 1 of 2 --[\s\S]*?Giros o cargos Saldos\n/, '')
  const singlePage = reparseOpenFixture(withoutPageBreak)
  const fromReal = parsed.movements.find((row) => row.documentNumber === '603562347')
  const fromSingle = singlePage.movements.find((row) => row.documentNumber === '603562347')
  assert.ok(fromReal && fromSingle)
  assert.deepEqual(
    { date: fromReal.date, description: fromReal.description, branch: fromReal.branch, credit: fromReal.credit, debit: fromReal.debit, balance: fromReal.balance },
    { date: fromSingle.date, description: fromSingle.description, branch: fromSingle.branch, credit: fromSingle.credit, debit: fromSingle.debit, balance: fromSingle.balance },
  )
  assert.equal(fromReal.credit, 5000000)
  assert.equal(fromReal.balance, 2396733)
  assert.equal(parsed.rowCount, 20)
})

test('CASO 6 - archivo acumulativo 14 existentes + 6 nuevos sin ausencias ni conflictos', () => {
  const existing = keysFor(previous.movements).map((key) => ({ ...key }))
  const diff = compareOpenMovementsLegacy(keysFor(parsed.movements), existing)
  assert.equal(existing.length, 14)
  assert.equal(parsed.rowCount, 20)
  assert.equal(diff.exactMatched, 14)
  assert.equal(diff.existingMissing.length, 0)
  assert.equal(diff.conflicts, 0)
  assert.equal(diff.new, 6)
})

test('CASO 7 - totales nuevos: haber 3.300.000, debe 3.300.000 y neto 0', () => {
  const existing = keysFor(previous.movements).map((key) => ({ ...key }))
  const diff = compareOpenMovementsLegacy(keysFor(parsed.movements), existing)
  const newRows = diff.newIndexes.map((index) => parsed.movements[index])
  assert.equal(newRows.reduce((sum, row) => sum + row.credit, 0), 3300000)
  assert.equal(newRows.reduce((sum, row) => sum + row.debit, 0), 3300000)
  assert.equal(newRows.reduce((sum, row) => sum + row.credit - row.debit, 0), 0)
  assert.equal(parsed.totalCredits, 18287671)
  assert.equal(parsed.totalDebits, 15684404)
  assert.equal(parsed.openingBalance, -2603267)
  assert.equal(parsed.closingBalance, 0)
  assert.equal(parsed.validations.globalDifference, 0)
  assert.equal(parsed.validations.rowDifference, 0)
})

test('CASO 8 - no rompe los contratos Banco de Chile (CURRENT_XLS, reexpresiones, append-only)', () => {
  const action = fs.readFileSync('src/app/actions/control-financiero/bank-statements.ts', 'utf8')
  const parser = fs.readFileSync('src/lib/control-financiero/bank-statement-parser.ts', 'utf8')
  const openModule = fs.readFileSync('src/lib/control-financiero/open-bank-statement.ts', 'utf8')
  assert.match(action, /parsed\.sourceFormat === "CURRENT_XLS"\s*\n\s*\? compareOpenMovements\(parsed\.movements, context\.existingRows\)/)
  assert.match(action, /resolvedRestatementEvidence: context\.resolvedDifferences/)
  assert.match(parser, /export function parseCurrentBankStatementXls/)
  assert.match(parser, /sourceFormat: 'CURRENT_XLS'/)
  assert.match(openModule, /export function evaluateOpenReconciliation/)
  assert.match(openModule, /export function ensureOpenInsertKeys/)
  assert.match(openModule, /restatementExplained/)
})
