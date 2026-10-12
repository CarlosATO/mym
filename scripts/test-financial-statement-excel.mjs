import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'
import ExcelJS from 'exceljs'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../src/app/dashboard/analisis-comercial/control-financiero/estado-resultados-excel.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
const exports = {}
new Function('require', 'exports', compiled)(require, exports)

const months = values => Array.from({ length: 12 }, (_, index) => values[index] ?? null)
const row = (label, ytd, extra = {}) => ({ label, values: months({}), ytd, percentageYtd: null, missing: months({}), ytdMissing: null, ...extra })
const accounts = [
  { id: 'chile', bank_name: 'Banco de Chile', account_type: 'CORRIENTE', account_number: '2707', currency: 'CLP', is_active: true },
  { id: 'itau', bank_name: 'Itaú Empresas', account_type: 'CORRIENTE', account_number: '7323', currency: 'CLP', is_active: true },
]
const accountBalances = [
  { accountId: 'chile', bankName: 'Banco de Chile', maskedAccountNumber: '•••• 2707', balance: 5143078, balanceDate: '2026-10-08', creditLineTotal: null, creditLineUsed: null, creditLineAvailable: null },
  { accountId: 'itau', bankName: 'Itaú Empresas', maskedAccountNumber: '•••• 7323', balance: 0, balanceDate: '2026-10-09', creditLineTotal: null, creditLineUsed: null, creditLineAvailable: null },
]
const movement = (id, account, description) => ({ id, bank_account_id: account, transaction_date: '2026-10-09', operation_description: description, credit_amount: 100, debit_amount: 0, balance_after: 500, source_row_number: 1, direction: 'HABER', normalized_description: description, classification_signature: null, category_id: null, category_name: 'Ventas', category_code: 'INCOME_SALES', counterparty: 'Cliente', classification_note: null, classification_source: 'AUTO_RULE', classification_rule_id: null, classified_at: null, review_status: 'REVIEWED', reviewed_by: null, reviewed_at: null, affects_pnl_directly: true, classification_group: 'OPERATING' })
const document = (id, client, pending) => ({ document_id: id, emission_date: '2026-10-01', folio: id, document_type_name: 'Factura', total_amount: String(pending), net_amount: null, tax_amount: null, expiration_date: '2026-10-31', pending_amount: String(pending), client_id: id, client_code: `RUT-${id}`, client_name: client, url_pdf: null, overdue: false, source_status: 'PENDIENTE', events: [] })

function input(overrides = {}) {
  const sales = row('Ventas Netas', '1000', { values: months({ 0: '1000' }), percentageYtd: 100 })
  const cogs = row('Costo de Ventas', '400', { values: months({ 0: '400' }), percentageYtd: 40 })
  const margin = row('Margen Bruto', '600', { values: months({ 0: '600' }), percentageYtd: 60 })
  const total = row('TOTAL GASTOS OPERATIVOS', '150', { values: months({ 0: '150' }), percentageYtd: 15, ytdEstimated: true, estimated: months({ 0: true }) })
  return {
    companyName: 'CAYLO PREMIUM SPA', tradeName: 'MYM DISTRIBUIDORA', year: 2026, cutoffDate: '2026-10-09', coverage: ['Cobertura gerencial: enero–octubre 2026'],
    rows: [sales, cogs, margin, row('GASTOS DE PERSONAL', '100'), row('Otros ingresos', '0'), row('GASTOS OPERACIONALES IDENTIFICADOS', '50'), total, row('RESULTADO OPERACIONAL', '50'), row('GASTOS FINANCIEROS / NO OPERACIONALES', '10'), row('RESULTADO GERENCIAL', '40', { percentageYtd: 4 })],
    groups: [{ group_key: 'provider:1', group_name: 'Proveedor 1', months: { '1': '1000' }, ytd: '1000', line_count: 1, cogsYtd: '400', profitYtd: '600', profitPercentageYtd: 60, children: [{ family_key: 'family:1', family_name: 'Familia 1', detail_name: 'Familia 1', months: { '1': '1000' }, ytd: '1000', line_count: 1, cogsYtd: '400', profitYtd: '600', profitPercentageYtd: 60 }] }],
    nonPnl: { ownerWithdrawalsYtd: 20, loanPaymentsYtd: 30, creditLinePaymentsYtd: 10 }, currentBalance: 5143078, accountBalances, cashFlowAccounts: accounts, cashFlowMovements: [movement('m-chile', 'chile', 'Movimiento Chile'), movement('m-itau', 'itau', 'Movimiento Itaú')],
    receivables: null, currentCollection: { allPortfolio: { receivableAmount: 200, overdueAmount: 0, clientCount: 2 }, defaultScope: { receivableAmount: 200, overdueAmount: 0, clientCount: 2 }, allDocuments: [document(1, 'Cliente 1', 120), document(2, 'Cliente 2', 80)], documents: [], snapshotAt: '2026-10-09T12:00:00Z', asOfDate: '2026-10-09', snapshotDocumentCount: 2, activeDocumentCount: 2, visibleDocumentCount: 2, overlayCount: 0, latestConfirmedPaymentAt: null, clientsUnqueryable: 0 },
    ...overrides,
  }
}

async function reopen(workbook) {
  const reopened = new ExcelJS.Workbook()
  await reopened.xlsx.load(await workbook.xlsx.writeBuffer())
  return reopened
}

test('workbook contains exactly five integrated sheets and numeric EERR metrics', async () => {
  const workbook = await exports.buildEstadoResultadosWorkbook(input())
  const reopened = await reopen(workbook)
  assert.deepEqual(reopened.worksheets.map(sheet => sheet.name), ['RESUMEN EJECUTIVO', 'ESTADO DE RESULTADOS', 'BANCO DE CHILE', 'BANCO ITAÚ', 'CUENTAS POR COBRAR'])
  const detail = reopened.getWorksheet('ESTADO DE RESULTADOS')
  const find = label => detail.getRows(1, detail.rowCount).find(item => item.getCell(1).value === label)
  const header = detail.getRows(1, detail.rowCount).find(item => item.getCell(1).value === 'CONCEPTO')
  assert.equal(header.getCell(15).value, 'UTILIDAD YTD')
  assert.equal(header.getCell(16).value, '% VENTAS')
  assert.equal(header.getCell(17).value, '% UTILIDAD')
  assert.equal(find('TOTAL GASTOS OPERATIVOS').getCell(14).value, 150)
  assert.equal(find('Resultado del negocio').getCell(14).value, 50)
  assert.equal(find('Resultado final del período').getCell(14).value, 40)
  assert.equal(find('Proveedor 1').getCell(15).value, 600)
  assert.equal(find('  Familia 1').getCell(15).value, 600)
  assert.equal(find('TOTAL GASTOS OPERATIVOS').getCell(14).numFmt.includes('EST.'), true)
})

test('EST. remains numeric and the integrated summary excludes estimated bank balance', async () => {
  const workbook = await exports.buildEstadoResultadosWorkbook(input())
  const reopened = await reopen(workbook)
  const summary = reopened.getWorksheet('RESUMEN EJECUTIVO')
  const total = summary.getRows(1, summary.rowCount).find(item => item.getCell(1).value === 'Total Gastos Operativos')
  assert.equal(total.getCell(2).value, 150)
  assert.equal(total.getCell(2).numFmt.includes('EST.'), true)
  assert.equal(summary.getRows(1, summary.rowCount).find(item => item.getCell(1).value === 'Margen final %').getCell(2).numFmt, '0.0%')
  const values = reopened.worksheets.flatMap(sheet => sheet.getRows(1, sheet.rowCount).map(item => item.values.map(value => String(value)).join(' '))).join(' ')
  assert.doesNotMatch(values, /Saldo estimado en cuentas corrientes/)
})

test('bank sheets are account-isolated and CxC reconciles to current portfolio', async () => {
  const reopened = await reopen(await exports.buildEstadoResultadosWorkbook(input()))
  const chile = reopened.getWorksheet('BANCO DE CHILE')
  const itau = reopened.getWorksheet('BANCO ITAÚ')
  assert.equal(chile.getRows(1, chile.rowCount).filter(row => row.getCell(2).value === 'Movimiento Chile').length, 1)
  assert.equal(chile.getRows(1, chile.rowCount).some(row => row.getCell(2).value === 'Movimiento Itaú'), false)
  assert.equal(itau.getRows(1, itau.rowCount).filter(row => row.getCell(2).value === 'Movimiento Itaú').length, 1)
  assert.equal(itau.getRows(1, itau.rowCount).some(row => row.getCell(2).value === 'Movimiento Chile'), false)
  const receivables = reopened.getWorksheet('CUENTAS POR COBRAR')
  const findReceivables = label => receivables.getRows(1, receivables.rowCount).find(row => row.getCell(1).value === label)
  assert.equal(findReceivables('Cartera vigente total').getCell(2).value, 200)
  assert.equal(findReceivables('Monto vencido').getCell(2).value, 0)
  assert.equal(findReceivables('TOTAL CARTERA').getCell(8).value, 200)
  assert.equal(receivables.getCell('A12').value, 'Cliente')
  assert.equal(chile.getCell('A13').value, 'Fecha')
  assert.equal(chile.getCell('I14').fill.fgColor.argb, 'FFEEF5F0')
  const summary = reopened.getWorksheet('RESUMEN EJECUTIVO')
  for (const section of ['CAJA / LIQUIDEZ', 'COBRANZA']) {
    const start = summary.getRows(1, summary.rowCount).findIndex(row => row.getCell(1).value === section)
    const next = summary.getRows(start + 2, summary.rowCount - start - 1).findIndex(row => ['RESULTADO', 'CAJA / LIQUIDEZ', 'COBRANZA', 'NOTA DE ALCANCE'].includes(String(row.getCell(1).value ?? '')))
    const end = next < 0 ? summary.rowCount : start + 1 + next
    for (const row of summary.getRows(start + 1, end - start)) assert.notEqual(row.getCell(4).value, 22)
  }
})
