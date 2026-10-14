import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const client = fs.readFileSync('src/modules/analisis-comercial/control-financiero/components/cash-flow-client.tsx', 'utf8')
const action = fs.readFileSync('src/app/actions/control-financiero/bank-statements.ts', 'utf8')

test('import modal starts in OPEN and exposes bank-specific formats', () => {
  assert.match(client, /useState<"OPEN" \| "CLOSED" \| "FINAL_CLOSE">\("OPEN"\)/)
  assert.match(client, /mode === "OPEN"\s*\? "\.xls,\.xlsx"/)
  assert.match(client, /isItau\s*\? "\.pdf"/)
  assert.match(client, /\.csv,\.txt,\.text/)
  assert.match(client, /XLS\/XLSX acumulado de movimientos del mes actual/)
  assert.match(client, /PDF de consulta de movimientos del mes actual/)
})

test('changing mode or account clears the complete file state', () => {
  assert.match(client, /setSelectedFile\(null\)/)
  assert.match(client, /setPreview\(null\)/)
  assert.match(client, /setMessage\(""\)/)
  assert.match(client, /fileInputRef\.current\.value = ""/)
  assert.match(client, /onClick=\{\(\) => changeMode\("FINAL_CLOSE"\)\}/)
  assert.match(client, /onAccountSelected\(event\.target\.value\);\s*resetFileState\(\)/)
})

test('wrong current Banco de Chile XLS is guided to OPEN mode', () => {
  assert.match(action, /Este archivo corresponde a una cartola de mes actual de Banco de Chile\./)
  assert.match(action, /Selecciona ‘Actualizar mes actual’/)
})

test('OPEN contract uses matchedCount and renders conflict detail', () => {
  assert.match(action, /matchedCount: diff\.exactMatched \+ diff\.balanceRestatements\.length/)
  assert.match(client, /Coincidencias exactas: <strong>\{openPreview\.exactMatchCount\}/)
  assert.match(client, /Saldos reexpresados por el banco: <strong>\{openPreview\.balanceRestatementCount\}/)
  assert.match(client, /Los movimientos originales y sus clasificaciones no serán modificados/)
  assert.match(client, /Diferencia inexplicada:/)
  assert.doesNotMatch(client, /Confirmar y registrar diferencia/)
  assert.match(client, /Movimientos en conflicto/)
  assert.match(client, /conflict\.file\.sourceRowNumber/)
  assert.match(client, /conflict\.existing \?/)
})

test('confirmation remains disabled when OPEN has conflicts', () => {
  assert.match(client, /preview\.mode === "OPEN" && !preview\.openPreview\.canConfirm/)
  assert.match(action, /if \(diff\.conflicts\)/)
})
