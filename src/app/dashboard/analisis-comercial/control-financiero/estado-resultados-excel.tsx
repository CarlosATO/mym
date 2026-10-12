'use client'

import { Download } from 'lucide-react'
import type { CashFlowMovement, FinancialAccountBalance, FinancialBankAccount } from '@/app/actions/control-financiero/bank-statements'
import type { SalesFamilyGroup, FinanceReceivablesResponse } from '@/lib/control-financiero/finance-api'
import type { StatementRow } from '@/lib/control-financiero/statement'
import type { CurrentCobranzaPosition } from '@/lib/control-financiero/current-cobranza-position'
import type { NonPnlCashData } from '@/app/actions/control-financiero/non-pnl-cash'

const MONTHS = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC']
const CLP_FORMAT = '$ #,##0;[Red]($ #,##0);$ 0'
const PERCENT_FORMAT = '0.0%'
const COLORS = { wine: '72383D', ink: '322D29', beige: 'F5F0EA', pale: 'FAF7F3', result: 'F1E4DE', border: 'AC9C8D', white: 'FFFFFF', estimated: '1453A0', provisional: 'A23E48', pending: 'F8F1E8', reviewed: 'EEF5F0', historical: 'F1F1EF' }
const TITLE_FONT = { name: 'Aptos', size: 16, bold: true, color: { argb: `FF${COLORS.wine}` } }
const SUBTITLE_FONT = { name: 'Aptos', size: 10, bold: true, color: { argb: `FF${COLORS.ink}` } }
const LABEL_FONT = { name: 'Aptos', size: 9, color: { argb: `FF${COLORS.ink}` } }
const VALUE_FONT = { name: 'Aptos', size: 9, color: { argb: `FF${COLORS.ink}` } }
const SECTION_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: `FF${COLORS.beige}` } }
const RESULT_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: `FF${COLORS.result}` } }

type ExportCell = string | number | Date | null
type ExportRow = ExportCell[]

type ExportInput = {
  companyName: string
  tradeName: string | null
  year: number
  cutoffDate: string | null
  coverage: string[]
  coverageNotes?: string[]
  rows: StatementRow[]
  groups: SalesFamilyGroup[]
  nonPnl: NonPnlCashData | null
  currentBalance: number | null
  accountBalances: FinancialAccountBalance[]
  cashFlowAccounts?: FinancialBankAccount[]
  cashFlowMovements?: CashFlowMovement[]
  receivables: FinanceReceivablesResponse | null
   currentCollection?: CurrentCobranzaPosition | null
}

function numeric(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function percent(value: number | null | undefined) {
  return value === null || value === undefined ? null : value / 100
}

function addSection(rows: ExportRow[], label: string, width = 17) {
  rows.push([label, ...Array(width - 1).fill(null)])
}

function displayLabel(label: string) {
  if (label === 'RESULTADO OPERACIONAL') return 'Resultado del negocio'
  if (label === 'RESULTADO GERENCIAL') return 'Resultado final del período'
  return label
}

function monthsOf(months: Record<string, string>) {
  return MONTHS.map((_, index) => numeric(months[String(index + 1)] ?? null))
}

function buildStatementRows(input: ExportInput) {
  const rows: ExportRow[] = [['CONCEPTO', ...MONTHS, 'YTD', 'UTILIDAD YTD', '% VENTAS', '% UTILIDAD']]
  const salesYtd = numeric(input.rows.find(item => item.label === 'Ventas Netas')?.ytd)
  const percentageOfSales = (value: string | number | null | undefined) => salesYtd && salesYtd !== 0 && numeric(value) !== null ? (numeric(value)! / salesYtd) * 100 : null
  addSection(rows, 'INGRESOS Y VENTAS')
  for (const group of input.groups) {
    rows.push([group.group_name, ...monthsOf(group.months), numeric(group.ytd), numeric(group.profitYtd), percent(percentageOfSales(group.ytd)), percent(group.profitPercentageYtd)])
    for (const child of group.children) {
      rows.push([`  ${child.detail_name ?? child.family_name}`, ...monthsOf(child.months), numeric(child.ytd), numeric(child.profitYtd), percent(percentageOfSales(child.ytd)), percent(child.profitPercentageYtd)])
    }
  }
  addSection(rows, 'GASTOS Y RESULTADOS')
  for (const row of input.rows.filter(item => !['Ventas Netas', 'Costo de Ventas', 'Margen Bruto'].includes(item.label))) {
    rows.push([displayLabel(row.label), ...row.values.map(numeric), numeric(row.ytd), null, percent(row.percentageYtd), null])
    for (const child of row.children ?? []) rows.push([`  ${child.label}`, ...child.values.map(numeric), numeric(child.ytd), null, percent(child.percentageYtd), null])
  }
  const openingRows = input.rows.filter(row => ['Ventas Netas', 'Costo de Ventas', 'Margen Bruto'].includes(row.label))
  const margin = input.rows.find(row => row.label === 'Margen Bruto')
  const sectionIndex = rows.findIndex(row => row[0] === 'GASTOS Y RESULTADOS')
  const openingOutput = openingRows.map(row => {
    const profit = row.label === 'Ventas Netas' || row.label === 'Margen Bruto' ? margin : null
    return [displayLabel(row.label), ...row.values.map(numeric), numeric(row.ytd), numeric(profit?.ytd), percent(row.percentageYtd), percent(profit?.percentageYtd)] as ExportRow
  })
  rows.splice(sectionIndex, 0, ...openingOutput)
  return rows
}

function addTitle(rows: ExportRow[], input: ExportInput, title: string, width: number) {
  rows.push([input.companyName], [input.tradeName || 'MYM DISTRIBUIDORA'], [title], [`Corte: ${input.cutoffDate ?? 'sin fecha'} · ${input.coverage.join(' · ')}`], ['Moneda', 'CLP'], [])
  while (rows[0].length < width) rows[0].push(null)
}

function summaryMetric(rows: ExportRow[], label: string, value: string | number | null, percentage: number | null = null, estimated = false) {
  rows.push([label, numeric(value), percent(percentage), estimated ? 'EST.' : null])
}

function clearSummaryAuxiliaryColumn(rows: ExportRow[], sectionLabel: string) {
  const start = rows.findIndex(row => row[0] === sectionLabel)
  if (start < 0) return
  const nextSection = rows.findIndex((row, index) => index > start && ['RESULTADO', 'CAJA / LIQUIDEZ', 'COBRANZA', 'NOTA DE ALCANCE'].includes(String(row[0] ?? '')))
  const end = nextSection < 0 ? rows.length : nextSection
  for (let index = start; index < end; index += 1) rows[index][3] = null
}

function bankAmount(accountBalances: FinancialAccountBalance[], matcher: (name: string) => boolean) {
  const matches = accountBalances.filter(account => matcher(account.bankName.toLocaleLowerCase('es-CL')))
  return matches.length && matches.every(account => account.balance !== null) ? matches.reduce((total, account) => total + (account.balance ?? 0), 0) : null
}

function bankSheetRows(input: ExportInput, accountIds: Set<string>, accountName: string) {
  const rows: ExportRow[] = []
  addTitle(rows, input, 'INFORME FINANCIERO', 13)
  rows.splice(3, 0, [accountName])
  const balances = input.accountBalances.filter(account => accountIds.has(account.accountId))
  const movements = (input.cashFlowMovements ?? []).filter(item => accountIds.has(item.bank_account_id))
  rows.push(['Saldo actual total', balances.every(account => account.balance !== null) ? balances.reduce((total, account) => total + (account.balance ?? 0), 0) : null])
  rows.push(['Fecha de saldo', balances.map(account => `${account.maskedAccountNumber}: ${account.balanceDate ?? 'sin fecha'}`).join(' · ') || 'sin saldo'])
  rows.push(['Movimientos exportados', movements.length])
  rows.push(['TOTAL PERÍODO', null, movements.reduce((total, movement) => total + Number(movement.credit_amount || 0), 0), movements.reduce((total, movement) => total + Number(movement.debit_amount || 0), 0), null])
  rows.push([])
  rows.push(['Fecha', 'Descripción / operación', 'Haber', 'Debe', 'Saldo', 'Categoría', 'Grupo / naturaleza', 'Afecta resultado', 'Revisión', 'Origen clasificación', 'Contraparte', 'Observación', 'ID interno'])
  for (const movement of movements) {
    rows.push([
      new Date(`${movement.transaction_date}T00:00:00Z`), movement.operation_description,
      numeric(movement.credit_amount), numeric(movement.debit_amount), numeric(movement.balance_after),
      movement.category_name, movement.classification_group, movement.affects_pnl_directly === null ? null : movement.affects_pnl_directly ? 'SÍ' : 'NO',
      movement.review_status, movement.classification_source, movement.counterparty, movement.classification_note, movement.id,
    ])
  }
  return rows
}

function daysLate(date: string | null, cutoffDate: string | null) {
  if (!date || !cutoffDate) return null
  const value = Math.floor((Date.parse(`${cutoffDate}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000)
  return Number.isFinite(value) ? Math.max(0, value) : null
}

function receivablesRows(input: ExportInput) {
  const rows: ExportRow[] = []
  addTitle(rows, input, 'INFORME FINANCIERO', 13)
  rows.splice(3, 0, ['CUENTAS POR COBRAR'])
  const documents = input.currentCollection?.allDocuments ?? input.currentCollection?.documents ?? []
  const total = documents.reduce((sum, document) => sum + Number(document.pending_amount), 0)
  const overdue = documents.filter(document => document.overdue).reduce((sum, document) => sum + Number(document.pending_amount), 0)
  rows.push(['Cartera vigente total', input.currentCollection?.allPortfolio.receivableAmount ?? null], ['Monto vencido', overdue], ['Documentos', documents.length], ['Fecha de corte', input.currentCollection?.asOfDate ?? input.cutoffDate])
  rows.push(['Cliente', 'RUT / identificador', 'Documento', 'Folio', 'Fecha emisión', 'Fecha vencimiento', 'Monto original', 'Saldo pendiente', 'Estado', 'Vencido', 'Días de atraso', 'Etapa / compromiso', 'Observación'])
  for (const document of documents) {
    const eventNote = document.events.map(event => [event.type, event.date ?? 'sin fecha', event.amount, event.reference].filter(Boolean).join(' · ')).join(' | ')
    rows.push([
      document.client_name, document.client_code, document.document_type_name, document.folio,
      new Date(`${document.emission_date}T00:00:00Z`), document.expiration_date ? new Date(`${document.expiration_date}T00:00:00Z`) : null,
      numeric(document.total_amount), numeric(document.pending_amount), document.source_status ?? 'PENDIENTE', document.overdue ? 'SÍ' : 'NO',
      daysLate(document.expiration_date, input.cutoffDate), null, eventNote || null,
    ])
  }
  rows.push([])
  rows.push(['TOTAL CARTERA', null, null, null, null, null, null, total, null, null, null, null, input.currentCollection ? `Diferencia de control: ${total - input.currentCollection.allPortfolio.receivableAmount}` : null])
  return rows
}

function styleSheet(worksheet: import('exceljs').Worksheet, rows: ExportRow[], mode: 'summary' | 'statement' | 'bank' | 'receivables') {
  const widths = mode === 'statement'
    ? [42, ...Array(12).fill(13), 16, 16, 12, 12]
    : mode === 'summary'
      ? [46, 20, 16, 12]
      : mode === 'bank'
        ? [14, 34, 14, 14, 15, 24, 20, 16, 14, 20, 24, 34, 18]
        : [28, 18, 20, 10, 14, 16, 16, 16, 14, 12, 14, 22, 38]
  worksheet.columns = Array.from({ length: Math.max(widths.length, Math.max(...rows.map(row => row.length), 1)) }, (_, index) => ({ width: widths[index] ?? 16 }))
  let inRevenue = false
  worksheet.eachRow((row, rowNumber) => {
    const values = rows[rowNumber - 1] ?? []
    const label = String(values[0] ?? '')
    const isTitle = rowNumber <= 3
    const isSection = ['INGRESOS Y VENTAS', 'GASTOS Y RESULTADOS', 'RESULTADO', 'CAJA / LIQUIDEZ', 'NOTA DE ALCANCE'].includes(label)
    const isHeader = ['CONCEPTO', 'Fecha', 'Cliente', 'Indicador'].includes(label)
    if (label === 'INGRESOS Y VENTAS') inRevenue = true
    if (label === 'GASTOS Y RESULTADOS') inRevenue = false
    const isProvider = mode === 'statement' && inRevenue && !isSection && !isHeader && !['Ventas Netas', 'Costo de Ventas', 'Margen Bruto'].includes(label) && !label.startsWith('  ')
    const isTotal = ['TOTAL PERÍODO', 'TOTAL CARTERA'].includes(label)
    row.height = isTitle ? 22 : isHeader ? 30 : isTotal ? 22 : mode === 'bank' || mode === 'receivables' ? 22 : 18
    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      cell.font = columnNumber === 1 ? LABEL_FONT : VALUE_FONT
      const centered = cell.value instanceof Date || (mode === 'receivables' && [5, 6].includes(columnNumber))
      cell.alignment = { vertical: 'middle', horizontal: centered ? 'center' : columnNumber === 1 ? 'left' : 'right', wrapText: true }
      if (cell.value instanceof Date) cell.numFmt = 'dd-mm-yyyy'
      else if (typeof cell.value === 'number') cell.numFmt = (mode === 'statement' && (columnNumber === 16 || columnNumber === 17)) || (mode === 'summary' && columnNumber === 3) ? PERCENT_FORMAT : CLP_FORMAT
      if (isTitle) cell.font = rowNumber === 1 ? TITLE_FONT : SUBTITLE_FONT
      if (isSection) {
        cell.font = { ...LABEL_FONT, bold: true, color: { argb: `FF${COLORS.wine}` } }
        cell.fill = SECTION_FILL
        cell.border = { bottom: { style: 'thin', color: { argb: `FF${COLORS.border}` } } }
      }
      if (isHeader) {
        cell.font = { ...VALUE_FONT, bold: true, color: { argb: `FF${COLORS.white}` } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${COLORS.ink}` } }
      }
      if (isProvider) {
        cell.font = { ...LABEL_FONT, bold: true, color: { argb: `FF${COLORS.ink}` } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${COLORS.pale}` } }
      }
      if (label.startsWith('  ')) {
        cell.font = LABEL_FONT
        cell.alignment = { ...cell.alignment, indent: 1 }
      }
      if (isTotal) {
        cell.font = { ...VALUE_FONT, bold: true, color: { argb: `FF${COLORS.wine}` } }
        cell.fill = RESULT_FILL
        cell.border = { top: { style: 'thin', color: { argb: `FF${COLORS.wine}` } } }
      }
      if (['Resultado del negocio', 'Resultado final del período', 'TOTAL GASTOS OPERATIVOS'].includes(label)) {
        cell.font = { ...VALUE_FONT, bold: true, color: { argb: `FF${COLORS.wine}` } }
        cell.fill = RESULT_FILL
        cell.border = { top: { style: 'thin', color: { argb: `FF${COLORS.wine}` } }, bottom: { style: 'thin', color: { argb: `FF${COLORS.wine}` } } }
      }
    })
  })
  worksheet.views = [{ state: 'frozen', ySplit: mode === 'statement' ? 7 : mode === 'summary' ? 8 : 12, xSplit: 1, showGridLines: false }]
  worksheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  worksheet.pageSetup.margins = { left: 0.3, right: 0.3, top: 0.45, bottom: 0.45, header: 0.2, footer: 0.2 }
}

function statusFill(status: string) {
  if (status === 'PENDING') return COLORS.pending
  if (status === 'REVIEWED') return COLORS.reviewed
  if (status === 'HISTORICAL') return COLORS.historical
  return null
}

function decorateBankSheet(worksheet: import('exceljs').Worksheet, dataStart: number) {
  const subtitle = worksheet.getRow(4)
  subtitle.eachCell({ includeEmpty: true }, cell => { cell.font = SUBTITLE_FONT; cell.fill = SECTION_FILL })
  for (let rowNumber = dataStart; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber)
    const status = String(row.getCell(9).value ?? '')
    const fill = statusFill(status)
    if (fill) row.getCell(9).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${fill}` } }
    if (String(row.getCell(8).value ?? '') === 'SÍ') row.getCell(8).font = { ...VALUE_FONT, bold: true, color: { argb: `FF${COLORS.provisional}` } }
  }
}

function decorateReceivablesSheet(worksheet: import('exceljs').Worksheet) {
  const subtitle = worksheet.getRow(4)
  subtitle.eachCell({ includeEmpty: true }, cell => { cell.font = SUBTITLE_FONT; cell.fill = SECTION_FILL })
  for (let rowNumber = 13; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber)
    if (String(row.getCell(1).value ?? '') === 'TOTAL CARTERA') break
    const status = String(row.getCell(9).value ?? '')
    const fill = statusFill(status)
    if (fill) row.getCell(9).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${fill}` } }
    if (String(row.getCell(10).value ?? '') === 'SÍ') {
      row.getCell(10).font = { ...VALUE_FONT, bold: true, color: { argb: `FF${COLORS.provisional}` } }
      row.getCell(10).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FFF8EAEA` } }
    }
  }
}

function addRows(worksheet: import('exceljs').Worksheet, rows: ExportRow[]) {
  for (const values of rows) worksheet.addRow(values)
}

function filePart(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'Empresa'
}

export async function buildEstadoResultadosWorkbook(input: ExportInput) {
  const ExcelJS = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'MyM Distribuidora'
  workbook.created = new Date()
  workbook.views = [{ x: 0, y: 0, width: 19200, height: 10800, activeTab: 0, firstSheet: 0, visibility: 'visible' }]

  const summaryRows: ExportRow[] = []
  addTitle(summaryRows, input, `INFORME FINANCIERO INTEGRADO · ${input.year}`, 4)
  addSection(summaryRows, 'RESULTADO', 4)
  summaryRows.push(['Indicador', 'YTD', '% VENTAS', 'EST.'])
  const row = (label: string) => input.rows.find(item => item.label === label)
  for (const [label, source] of [
    ['Ventas Netas', row('Ventas Netas')], ['Costo de Ventas', row('Costo de Ventas')], ['Margen Bruto', row('Margen Bruto')],
    ['Total Gastos Operativos', row('TOTAL GASTOS OPERATIVOS')], ['Resultado del negocio', row('RESULTADO OPERACIONAL')],
    ['Gastos financieros / no operacionales', row('GASTOS FINANCIEROS / NO OPERACIONALES')], ['Resultado final', row('RESULTADO GERENCIAL')],
  ] as const) summaryMetric(summaryRows, label, source?.ytd ?? null, source?.percentageYtd ?? null, source?.ytdEstimated ?? false)
  const finalResult = row('RESULTADO GERENCIAL')
  summaryRows.push(['Margen final %', percent(finalResult?.percentageYtd), null, finalResult?.ytdEstimated ? 'EST.' : null])
  addSection(summaryRows, 'CAJA / LIQUIDEZ', 4)
  summaryRows.push(['Indicador', 'Valor', 'Fecha', ''])
  const chile = bankAmount(input.accountBalances, name => name.includes('chile') || name.includes('banco de chile'))
  const itau = bankAmount(input.accountBalances, name => name.includes('itau') || name.includes('itaú'))
  summaryRows.push(['Saldo Banco de Chile', chile, null, ''], ['Saldo Itaú', itau, null, ''], ['Saldo bancario total', input.currentBalance, input.cutoffDate, ''], ['Retiros de socios', input.nonPnl?.ownerWithdrawalsYtd ?? null, null, ''], ['Pago de préstamos YTD', input.nonPnl?.loanPaymentsYtd ?? null, null, ''], ['Pago línea de crédito YTD', input.nonPnl?.creditLinePaymentsYtd ?? null, null, ''])
  addSection(summaryRows, 'COBRANZA', 4)
  summaryRows.push(['Indicador', 'Valor', 'Fecha', ''], ['Pendientes de ingreso a caja / Cuentas por cobrar', input.currentCollection?.allPortfolio.receivableAmount ?? null, input.currentCollection?.asOfDate ?? null, ''])
  addSection(summaryRows, 'NOTA DE ALCANCE', 4)
  summaryRows.push(['El resultado económico no equivale al efectivo disponible. La conciliación completa resultado-caja requiere incorporar cuentas por pagar, obligaciones y otros componentes del capital de trabajo.'])
  clearSummaryAuxiliaryColumn(summaryRows, 'CAJA / LIQUIDEZ')
  clearSummaryAuxiliaryColumn(summaryRows, 'COBRANZA')

  const summarySheet = workbook.addWorksheet('RESUMEN EJECUTIVO')
  addRows(summarySheet, summaryRows)
  summarySheet.mergeCells('A1:D1'); summarySheet.mergeCells('A2:D2'); summarySheet.mergeCells('A3:D3'); summarySheet.mergeCells('A4:D4')
  styleSheet(summarySheet, summaryRows, 'summary')
  summarySheet.autoFilter = { from: 'A8', to: 'D8' }
  summarySheet.pageSetup.fitToHeight = 1
  summarySheet.eachRow(summaryRow => {
    const label = String(summaryRow.getCell(1).value ?? '')
    if (['Resultado final', 'Margen final %', 'Saldo bancario total', 'Pendientes de ingreso a caja / Cuentas por cobrar'].includes(label)) {
      summaryRow.eachCell({ includeEmpty: true }, cell => { cell.font = { ...VALUE_FONT, bold: true, color: { argb: `FF${COLORS.wine}` } }; cell.fill = RESULT_FILL })
    }
   })
   for (const [index, values] of summaryRows.entries()) {
    if (values[3] === 'EST.') {
      const cell = summarySheet.getRow(index + 1).getCell(2)
      cell.font = { ...VALUE_FONT, bold: true, color: { argb: `FF${COLORS.estimated}` } }
      cell.numFmt = values[0] === 'Margen final %' ? '0.0%" EST."' : '$ #,##0" EST.";[Red]($ #,##0)" EST.";$ 0" EST."'
      cell.note = 'EST. · Reutiliza la semántica de estimación del Estado de Resultados.'
    }
    if (values[0] === 'Margen final %' && values[3] !== 'EST.') summarySheet.getRow(index + 1).getCell(2).numFmt = '0.0%'
  }

  const statementRows: ExportRow[] = []
  addTitle(statementRows, input, `ESTADO DE RESULTADOS · ${input.year}`, 17)
  statementRows.push(...buildStatementRows(input))
  const statementSheet = workbook.addWorksheet('ESTADO DE RESULTADOS')
  addRows(statementSheet, statementRows)
  statementSheet.mergeCells('A1:Q1'); statementSheet.mergeCells('A2:Q2'); statementSheet.mergeCells('A3:Q3'); statementSheet.mergeCells('A4:Q4')
  styleSheet(statementSheet, statementRows, 'statement')
  statementSheet.autoFilter = { from: 'A7', to: 'Q7' }
  const estimatedRows = new Map<string, StatementRow>()
  for (const item of input.rows) { estimatedRows.set(displayLabel(item.label), item); for (const child of item.children ?? []) estimatedRows.set(`  ${child.label}`, child) }
  statementRows.forEach((values, index) => {
    const source = estimatedRows.get(String(values[0] ?? ''))
    if (!source) return
    const excelRow = statementSheet.getRow(index + 1)
    if (source.provisional) {
      excelRow.getCell(1).font = { ...LABEL_FONT, bold: true, color: { argb: `FF${COLORS.provisional}` } }
      excelRow.getCell(14).font = { ...VALUE_FONT, bold: true, color: { argb: `FF${COLORS.provisional}` } }
      excelRow.getCell(1).note = `${source.provisionalNote ?? 'Clasificación provisional.'} Señal: POR VALIDAR.`
      excelRow.getCell(14).note = source.provisionalNote ?? 'Clasificación provisional.'
    }
    for (let month = 1; month <= 12; month += 1) if (source.estimated?.[month - 1] && values[month] !== null) {
      const cell = excelRow.getCell(month + 1)
      cell.font = { ...VALUE_FONT, bold: true, color: { argb: `FF${COLORS.estimated}` } }
      cell.numFmt = '$ #,##0" EST.";[Red]($ #,##0)" EST.";$ 0" EST."'
      cell.note = 'EST. · Reutiliza la semántica de estimación del Estado de Resultados.'
    }
    if (source.ytdEstimated && values[13] !== null) {
      for (const column of [14, 16]) {
        const cell = excelRow.getCell(column)
        cell.font = { ...VALUE_FONT, bold: true, color: { argb: `FF${COLORS.estimated}` } }
        cell.numFmt = column === 16 ? '0.0%" EST."' : '$ #,##0" EST.";[Red]($ #,##0)" EST.";$ 0" EST."'
      }
    }
  })

  const accountsByBank = (matcher: (name: string) => boolean) => new Set((input.cashFlowAccounts ?? []).filter(account => matcher(account.bank_name.toLocaleLowerCase('es-CL'))).map(account => account.id))
  const chileSheet = workbook.addWorksheet('BANCO DE CHILE')
  const chileRows = bankSheetRows(input, accountsByBank(name => name.includes('chile') || name.includes('banco de chile')), 'BANCO DE CHILE')
  addRows(chileSheet, chileRows); styleSheet(chileSheet, chileRows, 'bank'); chileSheet.autoFilter = { from: 'A13', to: 'M13' }
  decorateBankSheet(chileSheet, 13)
  const itauSheet = workbook.addWorksheet('BANCO ITAÚ')
  const itauRows = bankSheetRows(input, accountsByBank(name => name.includes('itau') || name.includes('itaú')), 'BANCO ITAÚ')
  addRows(itauSheet, itauRows); styleSheet(itauSheet, itauRows, 'bank'); itauSheet.autoFilter = { from: 'A13', to: 'M13' }
  decorateBankSheet(itauSheet, 13)

  const receivablesSheet = workbook.addWorksheet('CUENTAS POR COBRAR')
  const receivableRows = receivablesRows(input)
  addRows(receivablesSheet, receivableRows); styleSheet(receivablesSheet, receivableRows, 'receivables'); receivablesSheet.autoFilter = { from: 'A12', to: 'M12' }
  decorateReceivablesSheet(receivablesSheet)

  return workbook
}

export function EstadoResultadosExcelButton(input: ExportInput) {
  async function download() {
    const workbook = await buildEstadoResultadosWorkbook(input)
    const buffer = await workbook.xlsx.writeBuffer()
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `Informe_Financiero_${filePart(input.companyName)}_${input.year}_${input.cutoffDate ?? 'sin_fecha'}.xlsx`
    anchor.click()
    URL.revokeObjectURL(url)
  }
  return <button type="button" onClick={download} className="inline-flex h-8 items-center gap-1.5 border border-[#AC9C8D] bg-white px-3 text-xs font-semibold text-[#72383D] hover:border-[#72383D] hover:bg-[#F5F0EA]" title="Exportar informe financiero integrado a Excel"><Download className="h-3.5 w-3.5" />Exportar Excel</button>
}
