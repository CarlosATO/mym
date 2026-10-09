'use client'

import { Download } from 'lucide-react'
import type { FinancialAccountBalance } from '@/app/actions/control-financiero/bank-statements'
import type { NonPnlCashData } from '@/app/actions/control-financiero/non-pnl-cash'
import type { FinanceReceivablesResponse, SalesFamilyGroup } from '@/lib/control-financiero/finance-api'
import type { StatementRow } from '@/lib/control-financiero/statement'

const MONTHS = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC']
const CLP_FORMAT = '$ #,##0;[Red]($ #,##0);–'
const PERCENT_FORMAT = '0.0%'
const CREDIT_LINE_CODES = ['CREDIT_LINE_DRAW', 'CREDIT_LINE_PAYMENT', 'CREDIT_LINE_NET'] as const

type ExportRow = Array<string | number | null>

type ExportInput = {
  companyName: string
  tradeName: string | null
  year: number
  coverage: string[]
  coverageNotes?: string[]
  rows: StatementRow[]
  groups: SalesFamilyGroup[]
  nonPnl: NonPnlCashData | null
  currentBalance: number | null
  accountBalances: FinancialAccountBalance[]
  receivables: FinanceReceivablesResponse | null
}

function numeric(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function rowWithConcept(label: string, values: Array<string | number | null>, percentage: number | null = null): ExportRow {
  return [label, ...values.map(numeric), numeric(percentage === null ? null : percentage / 100)]
}

function plainRow(label: string, values: Array<string | number | null>): ExportRow {
  return [label, ...values.map(numeric)]
}

function addSection(rows: ExportRow[], label: string) {
  rows.push([label, ...Array(14).fill(null)])
}

function creditLineRows(data: NonPnlCashData, accountBalances: FinancialAccountBalance[], year: number) {
  const usageRow = data.rows.find(row => row.code === 'CREDIT_LINE_DRAW')
  const paymentRow = data.rows.find(row => row.code === 'CREDIT_LINE_PAYMENT')
  const account = accountBalances.find(item => item.creditLineTotal !== null || item.creditLineUsed !== null || item.creditLineAvailable !== null)
  const usage = usageRow?.monthly ?? Array(12).fill(0)
  const payment = (paymentRow?.monthly ?? Array(12).fill(0)).map(value => -Math.abs(value))
  let balance = 0
  const closing = usage.map((value, index) => {
    balance += value + payment[index]
    return balance
  })
  const coverageMonth = account?.balanceDate?.startsWith(`${year}-`) ? Number(account.balanceDate.slice(5, 7)) : null
  const coveredClosing = closing.map((value, index) => coverageMonth !== null && index + 1 <= coverageMonth ? value : null)
  const available = coveredClosing.map(value => value === null || account?.creditLineTotal === null || account?.creditLineTotal === undefined ? null : account.creditLineTotal - value)
  const actualUsed = account?.creditLineUsed ?? closing[11]
  const actualAvailable = account?.creditLineAvailable ?? (account?.creditLineTotal !== null && account?.creditLineTotal !== undefined ? account.creditLineTotal - actualUsed : null)
  return [
    plainRow('Uso de línea de crédito', [...usage, usageRow?.ytd ?? null]),
    plainRow('Pago / restitución línea de crédito', [...payment, payment.reduce((sum, value) => sum + value, 0)]),
    plainRow('Saldo usado al cierre', [...coveredClosing, actualUsed]),
    plainRow('Disponible al cierre', [...available, actualAvailable]),
    { account, usageRow, paymentRow, actualUsed, actualAvailable },
  ] as const
}

function buildRows(input: ExportInput) {
  const rows: ExportRow[] = []
  const salesYtd = numeric(input.rows.find(row => row.label === 'Ventas Netas')?.ytd)
  const percentageOfSales = (value: string | number | null) => salesYtd && salesYtd !== 0 && numeric(value) !== null ? (numeric(value)! / salesYtd) * 100 : null
  rows.push(['CONCEPTO', ...MONTHS, 'YTD', '% VENTAS'])
  addSection(rows, 'INGRESOS Y VENTAS')
  for (const group of input.groups) {
    rows.push(rowWithConcept(group.group_name, MONTHS.map((_, index) => group.months[String(index + 1)] ?? null).concat(group.ytd), percentageOfSales(group.ytd)))
    for (const child of group.children) {
      rows.push(rowWithConcept(`  ${child.detail_name ?? child.family_name}`, MONTHS.map((_, index) => child.months[String(index + 1)] ?? null).concat(child.ytd), percentageOfSales(child.ytd)))
    }
  }
  for (const row of input.rows) {
    rows.push(rowWithConcept(row.label, [...row.values, row.ytd], row.percentageYtd))
    for (const child of row.children ?? []) rows.push(rowWithConcept(`  ${child.label}`, [...child.values, child.ytd], child.percentageYtd))
  }
  return rows
}

const COLORS = { wine: '72383D', ink: '322D29', beige: 'F5F0EA', pale: 'FAF7F3', result: 'F1E4DE', border: 'AC9C8D', muted: '6B625B', white: 'FFFFFF' }
const TITLE_FONT = { name: 'Aptos', size: 16, bold: true, color: { argb: `FF${COLORS.wine}` } }
const SUBTITLE_FONT = { name: 'Aptos', size: 10, bold: true, color: { argb: `FF${COLORS.ink}` } }
const LABEL_FONT = { name: 'Aptos', size: 9, color: { argb: `FF${COLORS.ink}` } }
const VALUE_FONT = { name: 'Aptos', size: 9, color: { argb: `FF${COLORS.ink}` } }
const SECTION_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: `FF${COLORS.beige}` } }
const RESULT_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: `FF${COLORS.result}` } }

function addTitle(rows: ExportRow[], input: ExportInput) {
  rows.push([input.companyName], [input.tradeName || 'MYM DISTRIBUIDORA'], [`ESTADO DE RESULTADOS · ${input.year}`], [input.coverage.join(' · ')], [])
}

function addExecutiveSummary(rows: ExportRow[], input: ExportInput) {
  addSection(rows, 'COBERTURA Y FUENTES')
  rows.push(['Fuente de datos', 'Cobertura'], ['ERP financiero', input.coverage.join(' · ')])
  addSection(rows, 'INDICADORES GERENCIALES')
  rows.push(['Resultado final disponible', 'Margen final', 'Retiros de socios', 'Pago de préstamos', 'Saldo bancos', 'Línea de crédito utilizada'])
  const finalResult = input.rows.find(row => row.label === 'RESULTADO GERENCIAL')
  const margin = finalResult?.percentageYtd ?? null
  const creditLineUsed = input.accountBalances.find(account => account.creditLineUsed !== null)?.creditLineUsed ?? null
  rows.push([numeric(finalResult?.ytd), margin === null ? null : margin / 100, input.nonPnl?.ownerWithdrawalsYtd ?? null, input.nonPnl?.loanPaymentsYtd ?? null, input.currentBalance, creditLineUsed])
  addSection(rows, 'RESUMEN DEL ESTADO DE RESULTADOS')
  rows.push(['Concepto', 'YTD', '% VENTAS'])
  for (const label of ['Ventas Netas', 'Costo de Ventas', 'Margen Bruto', 'GASTOS DE PERSONAL', 'GASTOS OPERACIONALES IDENTIFICADOS', 'RESULTADO OPERACIONAL', 'GASTOS FINANCIEROS / NO OPERACIONALES', 'RESULTADO GERENCIAL']) {
    const row = input.rows.find(item => item.label === label)
     if (row) rows.push([label, numeric(row.ytd), numeric(row.percentageYtd === null ? null : row.percentageYtd / 100)])
   }
  rows.push(['Nota de cobertura', 'Resultado operacional y resultado gerencial calculados sobre cobertura común.'])
  for (const note of input.coverageNotes ?? []) rows.push(['Nota de cobertura', note])

  if (input.nonPnl) {
    addSection(rows, 'MOVIMIENTOS DE CAJA FUERA DEL RESULTADO')
    for (const row of input.nonPnl.rows.filter(row => !CREDIT_LINE_CODES.includes(row.code as typeof CREDIT_LINE_CODES[number]))) rows.push(plainRow(row.label, [...row.monthly, row.ytd]))
    addSection(rows, 'CONTROL DE LÍNEA DE CRÉDITO')
    const [usage, payment, closing, available, details] = creditLineRows(input.nonPnl, input.accountBalances, input.year)
    const account = details.account
    rows.push(['Indicador', 'Valor'], ['Línea total', account?.creditLineTotal ?? null], ['Utilizado actual', account?.creditLineUsed ?? null], ['Disponible actual', account?.creditLineAvailable ?? null], ['Uso acumulado YTD', details.usageRow?.ytd ?? null], ['Pago / restitución YTD', details.paymentRow?.ytd === null || details.paymentRow?.ytd === undefined ? null : Math.abs(details.paymentRow.ytd)], [], ['CONCEPTO', ...MONTHS, 'YTD/ACTUAL'])
    rows.push(usage, payment, closing, available)
  }

  if (input.receivables) {
    addSection(rows, 'POSICIÓN DE COBRANZA')
    rows.push(['CONCEPTO', ...MONTHS, 'ACTUAL'])
    rows.push(plainRow('CxC pendiente', [...MONTHS.map((_, index) => input.receivables!.months.find(month => month.month === index + 1)?.receivable_amount ?? null), input.receivables.actual.receivable_amount]))
    rows.push(plainRow('CxC vencida', [...MONTHS.map((_, index) => input.receivables!.months.find(month => month.month === index + 1)?.overdue_amount ?? null), input.receivables.actual.overdue_amount]))
    rows.push(['Documentos pendientes', input.receivables.actual.pending_documents])
  }
}

function styleWorksheet(worksheet: import('exceljs').Worksheet, rows: ExportRow[], mode: 'summary' | 'detail') {
  const width = mode === 'detail' ? 15 : 14
  worksheet.columns = Array.from({ length: width }, (_, index) => ({ width: index === 0 ? (mode === 'detail' ? 42 : 30) : 13 }))
  worksheet.eachRow((row, rowNumber) => {
    row.height = rowNumber <= 4 ? 22 : 18
    const values = rows[rowNumber - 1] ?? []
    const label = String(values[0] ?? '')
    const nextLabel = String(rows[rowNumber]?.[0] ?? '')
    const isSection = ['COBERTURA Y FUENTES', 'INDICADORES GERENCIALES', 'RESUMEN DEL ESTADO DE RESULTADOS', 'MOVIMIENTOS DE CAJA FUERA DEL RESULTADO', 'CONTROL DE LÍNEA DE CRÉDITO', 'POSICIÓN DE COBRANZA', 'INGRESOS Y VENTAS'].includes(label)
    const isHeader = ['CONCEPTO', 'Concepto', 'Indicador', 'Fuente de datos'].includes(label)
    const isResult = ['RESULTADO OPERACIONAL', 'RESULTADO GERENCIAL', 'RESULTADO FINAL'].includes(label)
    const summaryResultLabels = new Set(['Ventas Netas', 'Costo de Ventas', 'Margen Bruto', 'GASTOS DE PERSONAL', 'GASTOS OPERACIONALES IDENTIFICADOS', 'RESULTADO OPERACIONAL', 'GASTOS FINANCIEROS / NO OPERACIONALES', 'RESULTADO GERENCIAL'])
    const isPercentColumn = mode === 'detail' ? 15 : summaryResultLabels.has(label) ? 3 : rows[rowNumber - 2]?.[0] === 'Resultado final disponible' ? 2 : -1

    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      cell.font = columnNumber === 1 ? LABEL_FONT : VALUE_FONT
      cell.alignment = { vertical: 'middle', horizontal: columnNumber === 1 ? 'left' : 'right', wrapText: true }
      if (typeof cell.value === 'number') cell.numFmt = columnNumber === isPercentColumn ? PERCENT_FORMAT : CLP_FORMAT
      if (isSection) {
        cell.font = { ...LABEL_FONT, bold: true, color: { argb: `FF${COLORS.wine}` } }
        cell.fill = SECTION_FILL
        cell.border = { bottom: { style: 'thin', color: { argb: `FF${COLORS.border}` } } }
      }
      if (isHeader) {
        cell.font = { ...VALUE_FONT, bold: true, color: { argb: `FF${COLORS.white}` } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${COLORS.ink}` } }
      }
      if (isResult) {
        cell.font = { ...VALUE_FONT, bold: true, color: { argb: `FF${COLORS.wine}` } }
        cell.fill = RESULT_FILL
        cell.border = { top: { style: 'thin', color: { argb: `FF${COLORS.wine}` } }, bottom: { style: 'thin', color: { argb: `FF${COLORS.wine}` } } }
      }
      if (label.startsWith('  ')) cell.font = LABEL_FONT
    })
    if (mode === 'detail' && nextLabel.startsWith('  ')) {
      row.font = { ...LABEL_FONT, bold: true }
      row.eachCell({ includeEmpty: true }, cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${COLORS.pale}` } } })
    }
  })
  worksheet.views = [{ state: 'frozen', ySplit: mode === 'detail' ? 4 : 6, xSplit: mode === 'detail' ? 1 : 0, showGridLines: false }]
  worksheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  worksheet.pageSetup.margins = { left: 0.3, right: 0.3, top: 0.45, bottom: 0.45, header: 0.2, footer: 0.2 }
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
  addTitle(summaryRows, input)
  addExecutiveSummary(summaryRows, input)
  const summarySheet = workbook.addWorksheet('RESUMEN EJECUTIVO')
  addRows(summarySheet, summaryRows)
  summarySheet.mergeCells('A1:F1')
  summarySheet.mergeCells('A2:F2')
  summarySheet.mergeCells('A3:F3')
  summarySheet.mergeCells('A4:F4')
  styleWorksheet(summarySheet, summaryRows, 'summary')

  const detailRows: ExportRow[] = []
  addTitle(detailRows, input)
  detailRows.push(...buildRows(input))
  const detailSheet = workbook.addWorksheet('ESTADO DE RESULTADOS')
  addRows(detailSheet, detailRows)
  detailSheet.mergeCells('A1:O1')
  detailSheet.mergeCells('A2:O2')
  detailSheet.mergeCells('A3:O3')
  detailSheet.mergeCells('A4:O4')
  styleWorksheet(detailSheet, detailRows, 'detail')
  detailSheet.autoFilter = { from: 'A6', to: 'O6' }
  detailRows.forEach((row, index) => {
    const excelRow = detailSheet.getRow(index + 1)
    if (String(row[0] ?? '').startsWith('  ')) {
      excelRow.outlineLevel = 1
      excelRow.hidden = true
    }
  })
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
    anchor.download = `Estado_Resultados_${filePart(input.companyName)}_${input.year}.xlsx`
    anchor.click()
    URL.revokeObjectURL(url)
  }
  return <button type="button" onClick={download} className="inline-flex h-8 items-center gap-1.5 border border-[#AC9C8D] bg-white px-3 text-xs font-semibold text-[#72383D] hover:border-[#72383D] hover:bg-[#F5F0EA]" title="Exportar Estado de Resultados a Excel"><Download className="h-3.5 w-3.5" />Exportar Excel</button>
}
