import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const exporter = await readFile(new URL('../src/app/dashboard/analisis-comercial/control-financiero/estado-resultados-excel.tsx', import.meta.url), 'utf8')
const page = await readFile(new URL('../src/app/dashboard/analisis-comercial/control-financiero/estado-resultados/page.tsx', import.meta.url), 'utf8')

test('integrated export uses canonical datasets and exactly five worksheets', () => {
  for (const sheet of ['RESUMEN EJECUTIVO', 'ESTADO DE RESULTADOS', 'BANCO DE CHILE', 'BANCO ITAÚ', 'CUENTAS POR COBRAR']) assert.match(exporter, new RegExp(sheet))
  assert.match(page, /rows=\{rows\}/)
  assert.match(page, /groups=\{groups\}/)
  assert.match(page, /accountBalances=\{cashFlowResult\?\.accountBalances \?\? \[\]\}/)
  assert.match(page, /cashFlowAccounts=\{cashFlowResult\?\.accounts \?\? \[\]\}/)
  assert.match(page, /cashFlowMovements=\{cashFlowResult\?\.movements \?\? \[\]\}/)
  assert.match(page, /currentCollection=\{currentCollection\}/)
  assert.match(exporter, /await import\('exceljs'\)/)
  assert.match(exporter, /workbook\.xlsx\.writeBuffer\(\)/)
  assert.match(exporter, /TOTAL GASTOS OPERATIVOS/)
  assert.match(exporter, /Resultado del negocio/)
  assert.match(exporter, /Resultado final del período/)
  assert.doesNotMatch(exporter, /Saldo estimado en cuentas corrientes/)
})

test('integrated export keeps numeric CLP and percentage formats, filters and frozen panes', () => {
  assert.match(exporter, /CLP_FORMAT = '\$ #,##0;\[Red\]\(\$ #,##0\);\$ 0'/)
  assert.match(exporter, /PERCENT_FORMAT = '0\.0%'/)
  assert.match(exporter, /cell\.numFmt = \(mode === 'statement'/)
  assert.match(exporter, /worksheet\.views = \[/)
  assert.match(exporter, /autoFilter =/)
  assert.match(exporter, /fitToWidth: 1/)
})
