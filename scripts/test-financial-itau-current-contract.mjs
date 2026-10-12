import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const parser = fs.readFileSync(new URL('../src/lib/control-financiero/bank-statement-parser.ts', import.meta.url), 'utf8')
const actions = fs.readFileSync(new URL('../src/app/actions/control-financiero/bank-statements.ts', import.meta.url), 'utf8')

test('el parser detecta señales robustas de Itaú de mes abierto', () => {
  assert.match(parser, /Consulta Saldos y Últimos movimientos|consulta saldos/)
  assert.match(parser, /ITAU_CURRENT_PDF/)
  assert.match(parser, /Cuenta Corriente|cuenta corriente/)
  assert.match(parser, /documentNumber/)
  assert.match(parser, /branch/)
})

test('OPEN acepta el PDF actual y FINAL_CLOSE sólo acepta formatos definitivos', () => {
  assert.match(actions, /sourceFormat !== "ITAU_CURRENT_PDF"/)
  assert.match(actions, /sourceFormat === "ITAU_CURRENT_PDF"/)
  assert.match(actions, /sourceFormat !== "HISTORICAL_SEMICOLON"[\s\S]*sourceFormat !== "ITAU_PDF"/)
  assert.match(actions, /mes abierto sólo puede actualizar un período OPEN/)
  assert.match(actions, /normalizeAccount\(parsed\.accountNumber\)/)
  assert.match(actions, /currentYear/)
  assert.match(actions, /openingDifference === 0/)
  assert.match(actions, /compareOpenMovements/)
  assert.match(actions, /diff\.conflicts/)
})
