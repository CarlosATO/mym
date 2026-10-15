import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const parser = fs.readFileSync(new URL('../src/lib/control-financiero/bank-statement-parser.ts', import.meta.url), 'utf8')
const actions = fs.readFileSync(new URL('../src/app/actions/control-financiero/bank-statements.ts', import.meta.url), 'utf8')
const currentParser = parser.slice(
  parser.indexOf('export function parseItauCurrentStatementText'),
  parser.indexOf('export async function extractItauPdfText'),
)
const preview = actions.slice(
  actions.indexOf('export async function previewFinancialBankStatement'),
  actions.indexOf('export async function confirmOpenFinancialBankStatement'),
)
const confirmOpen = actions.slice(
  actions.indexOf('export async function confirmOpenFinancialBankStatement'),
  actions.indexOf('export async function confirmFinalFinancialBankStatement'),
)
const finalClose = preview.slice(
  preview.indexOf('if (mode === "FINAL_CLOSE")'),
  preview.indexOf('const currentDate = todayInSantiago()'),
)

test('el parser detecta señales robustas de Itaú de mes abierto', () => {
  assert.match(currentParser, /isItauCurrentPdfText\(text\)/)
  assert.match(currentParser, /sourceFormat: 'ITAU_CURRENT_PDF'/)
})

test('OPEN acepta ITAU_CURRENT_PDF y FINAL_CLOSE exige formatos definitivos', () => {
  assert.match(preview, /mode === "OPEN"/)
  assert.match(preview, /parsed\.sourceFormat !== "CURRENT_XLS"[\s\S]*parsed\.sourceFormat !== "ITAU_CURRENT_PDF"/)
  assert.match(finalClose, /parsed\.sourceFormat === "ITAU_CURRENT_PDF"/)
  assert.match(finalClose, /parsed\.sourceFormat !== "HISTORICAL_SEMICOLON"[\s\S]*parsed\.sourceFormat !== "ITAU_PDF"/)
})

test('el contrato Itaú conserva cuenta, período, saldo inicial y matching legacy', () => {
  assert.match(preview, /normalizeAccount\(parsed\.accountNumber\)/)
  assert.match(preview, /parsed\.year !== currentYear \|\| parsed\.month !== currentMonth/)
  assert.match(preview, /const openingDifference = parsed\.openingBalance - previousClosingBalance/)
  assert.match(confirmOpen, /normalizeAccount\(input\.parsed\.accountNumber\)/)
  assert.match(confirmOpen, /input\.parsed\.openingBalance !== Number\(context\.previous\.closing_balance\)/)
  assert.match(preview, /parsed\.sourceFormat === "CURRENT_XLS"\s*\n\s*\? compareOpenMovements\(parsed\.movements, context\.existingRows\)\s*\n\s*:\s*compareOpenMovementsLegacy\(keys, context\.existingRows\)/)
  assert.doesNotMatch(
    preview,
    /parsed\.sourceFormat === "ITAU_CURRENT_PDF"\s*\n\s*\? compareOpenMovements\(/,
  )
})

test('los conflictos OPEN bloquean la confirmación', () => {
  assert.match(confirmOpen, /if \(diff\.conflicts\)\s*return \{[\s\S]*?ok: false/)
})
