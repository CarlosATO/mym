import assert from 'node:assert/strict'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import ExcelJS from 'exceljs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import ts from 'typescript'

const sourcePath = path.resolve('src/app/dashboard/analisis-comercial/control-financiero/estado-resultados-excel.tsx')
const compiledPath = path.join(os.tmpdir(), 'mym-estado-resultados-excel.cjs')
const outputPath = path.join(os.tmpdir(), 'Estado_Resultados_CAYLO_PREMIUM_SPA_2026.xlsx')
const source = await readFile(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
await writeFile(compiledPath, compiled)
const NodeModule = createRequire(import.meta.url)('node:module')
const runtimeModule = new NodeModule.Module(compiledPath, undefined)
runtimeModule.filename = compiledPath
runtimeModule.paths = NodeModule._nodeModulePaths(process.cwd())
runtimeModule._compile(compiled, compiledPath)
const { buildEstadoResultadosWorkbook } = runtimeModule.exports

const rows = [
  { label: 'Ventas Netas', values: Array(12).fill('100'), ytd: '1200', percentageYtd: 100, missing: Array(12).fill(null), ytdMissing: null },
  { label: 'Costo de Ventas', values: Array(12).fill('40'), ytd: '480', percentageYtd: 40, missing: Array(12).fill(null), ytdMissing: null },
  { label: 'Margen Bruto', values: Array(12).fill('60'), ytd: '720', percentageYtd: 60, missing: Array(12).fill(null), ytdMissing: null },
  { label: 'RESULTADO GERENCIAL', values: Array(12).fill('20'), ytd: '240', percentageYtd: 20, missing: Array(12).fill(null), ytdMissing: null, result: true },
]
const nonPnl = { rows: [
  ...['EXPENSE_OWNER_WITHDRAWAL', 'LOAN_RECEIPT', 'LOAN_PAYMENT', 'INCOME_CONTRIBUTIONS', 'EXPENSE_ASSETS', 'INTERCOMPANY'].map(code => ({ code, label: code, informational: false, monthly: Array(12).fill(0), ytd: 0, movementCount: 0 })),
  { code: 'CREDIT_LINE_DRAW', label: 'Uso', informational: false, monthly: Array(12).fill(0), ytd: 0, movementCount: 0 },
  { code: 'CREDIT_LINE_PAYMENT', label: 'Pago', informational: false, monthly: Array(12).fill(0), ytd: 0, movementCount: 0 },
  { code: 'CREDIT_LINE_NET', label: 'Saldo', informational: true, monthly: Array(12).fill(0), ytd: 0, movementCount: 0 },
], ownerWithdrawalsYtd: 0, loanPaymentsYtd: 0, creditLinePaymentsYtd: 0, loanReceiptsYtd: 0, creditLineDrawsYtd: 0, movements: [] }
const input = {
  companyName: 'CAYLO PREMIUM SPA', tradeName: 'MYM DISTRIBUIDORA', year: 2026,
  coverage: ['Datos hasta 30-09-2026', 'Cobertura común: enero-septiembre 2026'], coverageNotes: ['Costo de Ventas: septiembre con cobertura incompleta; octubre pendiente de actualización de costos.'], rows,
  groups: [{ group_key: 'supplier', group_name: 'Proveedor principal', months: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i + 1), '10'])), ytd: '120', line_count: 1, children: [{ family_name: 'Proveedor principal / Familia', detail_name: 'Familia', months: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i + 1), '10'])), ytd: '120', line_count: 1 }] }],
  nonPnl, currentBalance: 2539811, accountBalances: [{ accountId: 'itau', bankName: 'Itaú', maskedAccountNumber: '•••• 1234', balance: 2539811, balanceDate: '2026-09-30', creditLineTotal: 5000000, creditLineUsed: 2198904, creditLineAvailable: 2801096 }],
  receivables: { company_id: 'company', year: 2026, currency: 'CLP', source: 'test', data_through: '2026-09-30', effective_date: '2026-09-30', has_information: true, months: [], actual: { receivable_amount: '500', overdue_amount: '100', pending_documents: 2 } },
}

test('generated XLSX loads and round-trips with ExcelJS', async () => {
  const workbook = await buildEstadoResultadosWorkbook(input)
  const buffer = await workbook.xlsx.writeBuffer()
  await writeFile(outputPath, buffer)

  const loaded = new ExcelJS.Workbook()
  await loaded.xlsx.load(buffer)
  assert.deepEqual(loaded.worksheets.map(sheet => sheet.name), ['RESUMEN EJECUTIVO', 'ESTADO DE RESULTADOS'])
  assert.equal(loaded.views[0].activeTab, 0)

  const summary = loaded.getWorksheet('RESUMEN EJECUTIVO')
  const detail = loaded.getWorksheet('ESTADO DE RESULTADOS')
  assert.ok(summary)
  assert.ok(detail)
  assert.equal(summary.getCell('A1').value, 'CAYLO PREMIUM SPA')
  assert.equal(summary.getCell('A2').value, 'MYM DISTRIBUIDORA')
  assert.equal(summary.getCell('A11').value, 240)
  assert.equal(typeof summary.getCell('A11').value, 'number')
  assert.equal(summary.getCell('B11').numFmt, '0.0%')
  const summaryResultLabels = ['Ventas Netas', 'Costo de Ventas', 'Margen Bruto', 'GASTOS DE PERSONAL', 'GASTOS OPERACIONALES IDENTIFICADOS', 'RESULTADO OPERACIONAL', 'GASTOS FINANCIEROS / NO OPERACIONALES', 'RESULTADO GERENCIAL']
  for (const label of summaryResultLabels) {
    const resultRow = summary.getRows(1, summary.rowCount).find(row => row.getCell(1).value === label)
    if (!resultRow) continue
    assert.equal(resultRow.getCell(2).value === null || typeof resultRow.getCell(2).value === 'number', true)
    assert.equal(resultRow.getCell(3).numFmt, '0.0%')
  }
  assert.equal(summary.getColumn(2).values.includes('Costo de Ventas: septiembre con cobertura incompleta; octubre pendiente de actualización de costos.'), true)
  assert.equal(summary.getCell('A1').isMerged, true)
  assert.equal(summary.getCell('F1').isMerged, true)
  assert.equal(summary.views[0].showGridLines, false)
  assert.equal(summary.views[0].state, 'frozen')
  assert.equal(summary.views[0].ySplit, 6)
  assert.equal(summary.pageSetup.orientation, 'landscape')
  assert.equal(summary.pageSetup.fitToPage, true)
  assert.equal(summary.pageSetup.fitToWidth, 1)
  assert.equal(detail.getCell('N10').value, 1200)
  assert.equal(detail.getCell('N10').numFmt, '$ #,##0;[Red]($ #,##0);–')
  assert.equal(detail.getRow(9).hidden, true)
  assert.equal(detail.getRow(9).outlineLevel, 1)

  const secondBuffer = await loaded.xlsx.writeBuffer()
  const roundTripped = new ExcelJS.Workbook()
  await roundTripped.xlsx.load(secondBuffer)
  assert.deepEqual(roundTripped.worksheets.map(sheet => sheet.name), ['RESUMEN EJECUTIVO', 'ESTADO DE RESULTADOS'])
  assert.equal(roundTripped.getWorksheet('RESUMEN EJECUTIVO').getCell('A11').value, 240)
  assert.equal(roundTripped.getWorksheet('ESTADO DE RESULTADOS').getCell('N10').numFmt, '$ #,##0;[Red]($ #,##0);–')

  await unlink(outputPath)
  await unlink(compiledPath)
})
