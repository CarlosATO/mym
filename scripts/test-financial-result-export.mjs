import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const exporter = await readFile(new URL('../src/app/dashboard/analisis-comercial/control-financiero/estado-resultados-excel.tsx', import.meta.url), 'utf8')
const page = await readFile(new URL('../src/app/dashboard/analisis-comercial/control-financiero/estado-resultados/page.tsx', import.meta.url), 'utf8')

test('Estado de Resultados uses the requested datasets and ExcelJS', () => {
  for (const section of ['COBERTURA Y FUENTES', 'INDICADORES GERENCIALES', 'RESUMEN DEL ESTADO DE RESULTADOS', 'MOVIMIENTOS DE CAJA FUERA DEL RESULTADO', 'CONTROL DE LÍNEA DE CRÉDITO', 'POSICIÓN DE COBRANZA']) assert.match(exporter, new RegExp(section))
  assert.match(page, /EstadoResultadosExcelButton/)
  assert.match(page, /rows=\{rows\}/)
  assert.match(page, /nonPnl=\{nonPnlResult\}/)
  assert.match(page, /currentBalance=\{cashFlowResult\?\.currentBalance \?\? null\}/)
  assert.match(page, /accountBalances=\{cashFlowResult\?\.accountBalances \?\? \[\]\}/)
  assert.match(page, /receivables=\{receivables\}/)
  assert.match(exporter, /await import\('exceljs'\)/)
  assert.match(exporter, /workbook\.xlsx\.writeBuffer\(\)/)
  assert.doesNotMatch(exporter, /fflate|xlsx-js-style|serializeStyledWorkbook|unzipSync|zipSync|strFromU8|workbook\.xml|worksheet XML|showGridLines="0"/)
})

test('ExcelJS export keeps numeric values and requested formats', () => {
  assert.match(exporter, /CLP_FORMAT = '\$ #,##0;\[Red\]\(\$ #,##0\);–'/)
  assert.match(exporter, /PERCENT_FORMAT = '0\.0%'/)
  assert.match(exporter, /cell\.numFmt = columnNumber === isPercentColumn \? PERCENT_FORMAT : CLP_FORMAT/)
  assert.match(exporter, /worksheet\.views = \[/)
  assert.match(exporter, /fitToPage: true/)
  assert.match(exporter, /fitToWidth: 1/)
})
