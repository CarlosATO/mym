import type { ClientsExportData, ClientsExportRow } from '@/app/actions/comercial/customers-export'

const CLP_FORMAT = '$ #,##0;[Red]($ #,##0)'
const INT_FORMAT = '#,##0'
const DATE_FORMAT = 'dd-mm-yyyy'
const COLORS = {
  wine: '7A2A31',
  ink: '2F2A26',
  pale: 'FBF8F4',
  white: 'FFFFFF',
  border: 'CBB9A8',
  total: 'EFE1D6',
}
const TITLE_FONT = { name: 'Calibri', size: 14, bold: true, color: { argb: `FF${COLORS.wine}` } }
const META_FONT = { name: 'Calibri', size: 9, italic: true, color: { argb: 'FF6B6259' } }
const HEADER_FONT = { name: 'Calibri', size: 10, bold: true, color: { argb: `FF${COLORS.white}` } }
const BODY_FONT = { name: 'Calibri', size: 10, color: { argb: `FF${COLORS.ink}` } }
const TOTAL_FONT = { name: 'Calibri', size: 10, bold: true, color: { argb: `FF${COLORS.wine}` } }
const HEADER_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: `FF${COLORS.ink}` } }
const TOTAL_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: `FF${COLORS.total}` } }

type ColumnType = 'text' | 'int' | 'money' | 'date'
type ColumnDef = { header: string; width: number; type: ColumnType }

const CLIENT_COLUMNS: ColumnDef[] = [
  { header: 'ID Bsale', width: 11, type: 'int' },
  { header: 'RUT', width: 15, type: 'text' },
  { header: 'Razón social', width: 38, type: 'text' },
  { header: 'Giro', width: 24, type: 'text' },
  { header: 'Dirección física', width: 34, type: 'text' },
  { header: 'Dirección completa para navegación', width: 48, type: 'text' },
  { header: 'Ver en Google Maps', width: 22, type: 'text' },
  { header: 'Ciudad', width: 16, type: 'text' },
  { header: 'Comuna', width: 16, type: 'text' },
  { header: 'Región', width: 16, type: 'text' },
  { header: 'Teléfono', width: 16, type: 'text' },
  { header: 'Correo', width: 26, type: 'text' },
  { header: 'Vendedor asignado', width: 22, type: 'text' },
  { header: 'Origen asignación', width: 16, type: 'text' },
  { header: 'Estado comercial', width: 18, type: 'text' },
  { header: 'Primera factura', width: 13, type: 'date' },
  { header: 'Última factura', width: 13, type: 'date' },
  { header: 'Días sin comprar', width: 12, type: 'int' },
  { header: 'Ventas 30 días', width: 15, type: 'money' },
  { header: 'Ventas 90 días', width: 15, type: 'money' },
  { header: 'Ventas 180 días', width: 15, type: 'money' },
  { header: 'Ventas 365 días', width: 15, type: 'money' },
  { header: 'Venta histórica', width: 16, type: 'money' },
  { header: 'N° facturas', width: 11, type: 'int' },
  { header: 'Ticket promedio', width: 15, type: 'money' },
  { header: 'NC cantidad', width: 11, type: 'int' },
  { header: 'NC monto', width: 15, type: 'money' },
  { header: 'Cliente interno', width: 12, type: 'text' },
  { header: 'Deuda pendiente*', width: 16, type: 'money' },
  { header: 'Deuda vencida*', width: 15, type: 'money' },
  { header: 'Docs pendientes*', width: 13, type: 'int' },
]

const RISK_COLUMNS: ColumnDef[] = [
  { header: 'Razón social', width: 38, type: 'text' },
  { header: 'RUT', width: 15, type: 'text' },
  { header: 'Vendedor asignado', width: 22, type: 'text' },
  { header: 'Estado comercial', width: 18, type: 'text' },
  { header: 'Última factura', width: 13, type: 'date' },
  { header: 'Días sin comprar', width: 12, type: 'int' },
  { header: 'Venta histórica', width: 16, type: 'money' },
  { header: 'Ventas 90 días', width: 15, type: 'money' },
  { header: 'NC monto', width: 15, type: 'money' },
]

const RECEIVABLE_COLUMNS: ColumnDef[] = [
  { header: 'ID Bsale', width: 11, type: 'int' },
  { header: 'Razón social', width: 38, type: 'text' },
  { header: 'Vendedor asignado', width: 22, type: 'text' },
  { header: 'Deuda pendiente*', width: 16, type: 'money' },
  { header: 'Deuda vencida*', width: 15, type: 'money' },
  { header: 'Docs pendientes*', width: 13, type: 'int' },
]

const SUMMARY_COLUMNS: ColumnDef[] = [
  { header: 'Vendedor', width: 26, type: 'text' },
  { header: 'Total clientes', width: 14, type: 'int' },
  { header: 'Clientes activos', width: 14, type: 'int' },
  { header: 'En riesgo o perdidos', width: 18, type: 'int' },
  { header: 'Sin compras históricas', width: 20, type: 'int' },
  { header: 'Ventas 30 días', width: 16, type: 'money' },
  { header: 'Ventas 90 días', width: 16, type: 'money' },
  { header: 'Ventas 365 días', width: 16, type: 'money' },
  { header: 'Venta histórica', width: 17, type: 'money' },
]

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const date = new Date(String(value).length <= 10 ? `${value}T00:00:00` : value)
  return Number.isNaN(date.getTime()) ? null : date
}

function datetimeLabel(value: string | null | undefined): string {
  if (!value) return 'sin dato'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' })
}

function statusFill(status: string | null): string | null {
  switch (status) {
    case 'ACTIVO': return 'E4F2E6'
    case 'NUEVO': return 'E3EEF7'
    case 'OBSERVACION': return 'FBF0D6'
    case 'RIESGO': return 'FBE3D3'
    case 'PERDIDO': return 'F7D9D9'
    case 'INACTIVO': return 'ECECEC'
    default: return null
  }
}

function sanitizeSheetName(name: string, used: Set<string>): string {
  const base = (name || 'Hoja').replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 28) || 'Hoja'
  let candidate = base
  let index = 2
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base} ${index}`.slice(0, 31)
    index += 1
  }
  used.add(candidate.toLowerCase())
  return candidate
}

function columnLetter(index: number): string {
  let result = ''
  let value = index
  while (value > 0) {
    const remainder = (value - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    value = Math.floor((value - 1) / 26)
  }
  return result
}

function setCell(row: import('exceljs').Row, index: number, value: string | number | Date | null, type: ColumnType, font = BODY_FONT) {
  const cell = row.getCell(index)
  cell.value = value as import('exceljs').CellValue
  cell.font = font
  cell.alignment = { vertical: 'middle', horizontal: type === 'text' ? 'left' : 'right', wrapText: false }
  if (value instanceof Date) cell.numFmt = DATE_FORMAT
  else if (type === 'money') cell.numFmt = CLP_FORMAT
  else if (type === 'int') cell.numFmt = INT_FORMAT
  return cell
}

function writeHeaderBlock(
  worksheet: import('exceljs').Worksheet,
  columns: ColumnDef[],
  title: string,
  data: ClientsExportData,
  notes: string[],
) {
  worksheet.columns = columns.map(column => ({ width: column.width }))
  const lastCol = columns.length

  const titleRow = worksheet.addRow([title])
  titleRow.getCell(1).font = TITLE_FONT
  worksheet.mergeCells(1, 1, 1, lastCol)
  titleRow.height = 20

  const metaRow = worksheet.addRow([
    `${data.companyName} · Generado: ${datetimeLabel(data.generatedAt)} · Datos al: ${datetimeLabel(data.lastDataUpdateAt)}`,
  ])
  metaRow.getCell(1).font = META_FONT
  worksheet.mergeCells(2, 1, 2, lastCol)

  for (const note of notes) {
    const noteRow = worksheet.addRow([note])
    noteRow.getCell(1).font = META_FONT
    worksheet.mergeCells(noteRow.number, 1, noteRow.number, lastCol)
  }

  worksheet.addRow([])
  const headerRow = worksheet.addRow(columns.map(column => column.header))
  headerRow.eachCell({ includeEmpty: true }, cell => {
    cell.font = HEADER_FONT
    cell.fill = HEADER_FILL
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    cell.border = { bottom: { style: 'thin', color: { argb: `FF${COLORS.border}` } } }
  })
  headerRow.height = 26

  return { headerRowNumber: headerRow.number, dataStartRow: headerRow.number + 1, lastCol }
}

function writeClientRow(row: import('exceljs').Row, client: ClientsExportRow, columns: ColumnDef[]) {
  const values: Record<string, string | number | Date | null> = {
    'ID Bsale': client.bsale_client_id,
    'RUT': client.rut,
    'Razón social': client.business_name,
    'Giro': client.business_activity,
    'Dirección física': client.address,
    'Dirección completa para navegación': client.navigation_address,
    'Ver en Google Maps': client.maps_url,
    'Ciudad': client.city,
    'Comuna': client.commune,
    'Región': client.region,
    'Teléfono': client.phone,
    'Correo': client.email,
    'Vendedor asignado': client.assigned_seller,
    'Origen asignación': client.seller_origin === 'PRINCIPAL' ? 'Vendedor principal' : client.seller_origin === 'ULTIMO' ? 'Último vendedor' : 'Sin asignar',
    'Estado comercial': client.status,
    'Primera factura': toDate(client.first_invoice_date),
    'Última factura': toDate(client.last_invoice_date),
    'Días sin comprar': client.days_since_last_invoice,
    'Ventas 30 días': client.official_sales_30d,
    'Ventas 90 días': client.official_sales_90d,
    'Ventas 180 días': client.official_sales_180d,
    'Ventas 365 días': client.official_sales_365d,
    'Venta histórica': client.official_sales_total,
    'N° facturas': client.invoice_docs_total,
    'Ticket promedio': client.avg_ticket_gross_total,
    'NC cantidad': client.credit_note_count_total,
    'NC monto': client.credit_note_amount_total,
    'Cliente interno': client.is_internal_account ? 'SÍ' : 'NO',
    'Deuda pendiente*': client.receivable_pending,
    'Deuda vencida*': client.receivable_overdue,
    'Docs pendientes*': client.receivable_document_count,
  }
  for (const [index, column] of columns.entries()) {
    setCell(row, index + 1, values[column.header] ?? null, column.type)
  }
  const mapsIndex = columns.findIndex(column => column.header === 'Ver en Google Maps')
  if (mapsIndex >= 0 && client.maps_url) {
    const cell = row.getCell(mapsIndex + 1)
    cell.value = { text: 'Ver en Google Maps', hyperlink: client.maps_url, tooltip: client.navigation_address ?? undefined }
    cell.font = { ...BODY_FONT, color: { argb: 'FF0563C1' }, underline: true }
  }
  const statusIndex = columns.findIndex(column => column.header === 'Estado comercial')
  if (statusIndex >= 0) {
    const fill = statusFill(client.status)
    if (fill) row.getCell(statusIndex + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${fill}` } }
  }
  const internalIndex = columns.findIndex(column => column.header === 'Cliente interno')
  if (internalIndex >= 0 && client.is_internal_account) {
    row.getCell(internalIndex + 1).font = { ...BODY_FONT, bold: true, color: { argb: `FF${COLORS.wine}` } }
  }
}

function addClientSheet(
  workbook: import('exceljs').Workbook,
  sheetName: string,
  data: ClientsExportData,
  clients: ClientsExportRow[],
  title: string,
  notes: string[],
) {
  const worksheet = workbook.addWorksheet(sheetName)
  const { headerRowNumber, lastCol } = writeHeaderBlock(worksheet, CLIENT_COLUMNS, title, data, notes)
  for (const client of clients) {
    writeClientRow(worksheet.addRow([]), client, CLIENT_COLUMNS)
  }
  worksheet.autoFilter = { from: { row: headerRowNumber, column: 1 }, to: { row: headerRowNumber, column: lastCol } }
  worksheet.views = [{ state: 'frozen', ySplit: headerRowNumber, xSplit: 1, showGridLines: false }]
  worksheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  return worksheet
}

function addDataBars(worksheet: import('exceljs').Worksheet, columns: ColumnDef[], headerRow: number, count: number) {
  if (count <= 0) return
  const salesColumns = ['Ventas 30 días', 'Ventas 90 días', 'Ventas 365 días', 'Venta histórica']
  for (const name of salesColumns) {
    const index = columns.findIndex(column => column.header === name)
    if (index < 0) continue
    try {
      worksheet.addConditionalFormatting({
        ref: `${columnLetter(index + 1)}${headerRow + 1}:${columnLetter(index + 1)}${headerRow + count}`,
        rules: [{ type: 'dataBar', minLength: 0, maxLength: 100, cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: 'FF8FB8A0' } }] as never,
      })
    } catch {
      // Los data bars son cosméticos; si fallan, la exportación continúa.
    }
  }
}

function summarize(clients: ClientsExportRow[]) {
  const active = clients.filter(client => client.status === 'ACTIVO' || client.status === 'NUEVO').length
  const risk = clients.filter(client => client.status === 'RIESGO' || client.status === 'PERDIDO').length
  const noHistory = clients.filter(client => client.official_sales_total <= 0 || client.status === 'SIN_VENTA_HISTORICA').length
  const sales30 = clients.reduce((sum, client) => sum + client.official_sales_30d, 0)
  const sales90 = clients.reduce((sum, client) => sum + client.official_sales_90d, 0)
  const sales365 = clients.reduce((sum, client) => sum + client.official_sales_365d, 0)
  const salesTotal = clients.reduce((sum, client) => sum + client.official_sales_total, 0)
  return { clients: clients.length, active, risk, noHistory, sales30, sales90, sales365, salesTotal }
}

function groupBySeller(clients: ClientsExportRow[]): Array<{ seller: string; clients: ClientsExportRow[] }> {
  const map = new Map<string, ClientsExportRow[]>()
  for (const client of clients) {
    const list = map.get(client.assigned_seller) || []
    list.push(client)
    map.set(client.assigned_seller, list)
  }
  return [...map.entries()]
    .map(([seller, list]) => ({ seller, clients: list }))
    .sort((a, b) => {
      if (a.seller === 'SIN VENDEDOR') return 1
      if (b.seller === 'SIN VENDEDOR') return -1
      return b.clients.reduce((sum, client) => sum + client.official_sales_total, 0) - a.clients.reduce((sum, client) => sum + client.official_sales_total, 0)
    })
}

function addSummarySheet(workbook: import('exceljs').Workbook, data: ClientsExportData) {
  const worksheet = workbook.addWorksheet('Resumen Gerencial')
  const notes = [data.officialSalesDefinition, data.creditNoteDefinition]
  const { headerRowNumber, lastCol } = writeHeaderBlock(worksheet, SUMMARY_COLUMNS, 'RESUMEN GERENCIAL POR VENDEDOR', data, notes)

  const groups = groupBySeller(data.clients)
  const totals = { clients: 0, active: 0, risk: 0, noHistory: 0, sales30: 0, sales90: 0, sales365: 0, salesTotal: 0 }
  for (const group of groups) {
    const metrics = summarize(group.clients)
    const row = worksheet.addRow([])
    const values: Array<string | number> = [
      group.seller,
      metrics.clients,
      metrics.active,
      metrics.risk,
      metrics.noHistory,
      metrics.sales30,
      metrics.sales90,
      metrics.sales365,
      metrics.salesTotal,
    ]
    for (const [index, column] of SUMMARY_COLUMNS.entries()) setCell(row, index + 1, values[index], column.type)
    row.getCell(1).font = { ...BODY_FONT, bold: group.seller === 'SIN VENDEDOR' }
    totals.clients += metrics.clients
    totals.active += metrics.active
    totals.risk += metrics.risk
    totals.noHistory += metrics.noHistory
    totals.sales30 += metrics.sales30
    totals.sales90 += metrics.sales90
    totals.sales365 += metrics.sales365
    totals.salesTotal += metrics.salesTotal
  }

  const totalRow = worksheet.addRow([])
  const totalValues: Array<string | number> = ['TOTAL', totals.clients, totals.active, totals.risk, totals.noHistory, totals.sales30, totals.sales90, totals.sales365, totals.salesTotal]
  for (const [index, column] of SUMMARY_COLUMNS.entries()) {
    const cell = setCell(totalRow, index + 1, totalValues[index] ?? null, column.type, TOTAL_FONT)
    cell.fill = TOTAL_FILL
  }

  worksheet.autoFilter = { from: { row: headerRowNumber, column: 1 }, to: { row: headerRowNumber, column: lastCol } }
  worksheet.views = [{ state: 'frozen', ySplit: headerRowNumber, xSplit: 1, showGridLines: false }]
  worksheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  return worksheet
}

function addRiskSheet(workbook: import('exceljs').Workbook, data: ClientsExportData, usedNames: Set<string>) {
  const riskClients = data.clients
    .filter(client => client.status === 'RIESGO' || client.status === 'PERDIDO')
    .sort((a, b) => (b.days_since_last_invoice ?? 0) - (a.days_since_last_invoice ?? 0))
  const worksheet = workbook.addWorksheet(sanitizeSheetName('Clientes en Riesgo', usedNames))
  const notes = ['Clientes con estado comercial RIESGO o PERDIDO. Se prioriza última compra, días sin comprar y venta histórica.']
  const { headerRowNumber, lastCol } = writeHeaderBlock(worksheet, RISK_COLUMNS, 'CLIENTES EN RIESGO O PERDIDOS', data, notes)
  for (const client of riskClients) {
    const row = worksheet.addRow([])
    const values: Record<string, string | number | Date | null> = {
      'Razón social': client.business_name,
      'RUT': client.rut,
      'Vendedor asignado': client.assigned_seller,
      'Estado comercial': client.status,
      'Última factura': toDate(client.last_invoice_date),
      'Días sin comprar': client.days_since_last_invoice,
      'Venta histórica': client.official_sales_total,
      'Ventas 90 días': client.official_sales_90d,
      'NC monto': client.credit_note_amount_total,
    }
    for (const [index, column] of RISK_COLUMNS.entries()) setCell(row, index + 1, values[column.header] ?? null, column.type)
    const fill = statusFill(client.status)
    if (fill) row.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${fill}` } }
  }
  worksheet.autoFilter = { from: { row: headerRowNumber, column: 1 }, to: { row: headerRowNumber, column: lastCol } }
  worksheet.views = [{ state: 'frozen', ySplit: headerRowNumber, xSplit: 1, showGridLines: false }]
  worksheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  return riskClients.length
}

function addReceivableSheet(workbook: import('exceljs').Workbook, data: ClientsExportData, usedNames: Set<string>) {
  if (!data.snapshot) return false
  const clientsWithDebt = data.clients
    .filter(client => (client.receivable_pending ?? 0) > 0)
    .sort((a, b) => (b.receivable_pending ?? 0) - (a.receivable_pending ?? 0))
  const worksheet = workbook.addWorksheet(sanitizeSheetName('Cobranza (referencial)', usedNames))
  const snapshot = data.snapshot
  const notes = [
    `CIFRAS REFERENCIALES, sujetas a conciliación. Fuente: snapshot Bsale ${snapshot.source} del ${datetimeLabel(snapshot.snapshot_at)} (día ${snapshot.snapshot_date ?? 'sin fecha'}).`,
    `Cobertura del snapshot: ${snapshot.coverage_percent}% (${snapshot.clients_success}/${snapshot.clients_total} clientes; ${snapshot.clients_unqueryable} no consultables, ${snapshot.clients_error} con error).${snapshot.is_provisional ? ' Cobertura incompleta: cifras provisionales.' : ''}`,
    '* Deuda tomada del último snapshot Bsale completado; no usa las vistas legacy de Comercial > Cobranzas.',
  ]
  const { headerRowNumber, lastCol } = writeHeaderBlock(worksheet, RECEIVABLE_COLUMNS, 'COBRANZA (REFERENCIAL) — DEUDA POR CLIENTE', data, notes)
  const totals = { pending: 0, overdue: 0, docs: 0 }
  for (const client of clientsWithDebt) {
    const row = worksheet.addRow([])
    const values: Record<string, string | number | null> = {
      'ID Bsale': client.bsale_client_id,
      'Razón social': client.business_name,
      'Vendedor asignado': client.assigned_seller,
      'Deuda pendiente*': client.receivable_pending,
      'Deuda vencida*': client.receivable_overdue,
      'Docs pendientes*': client.receivable_document_count,
    }
    for (const [index, column] of RECEIVABLE_COLUMNS.entries()) setCell(row, index + 1, values[column.header] ?? null, column.type)
    totals.pending += client.receivable_pending ?? 0
    totals.overdue += client.receivable_overdue ?? 0
    totals.docs += client.receivable_document_count ?? 0
  }
  const totalRow = worksheet.addRow([])
  const totalValues: Array<string | number | null> = ['TOTAL', '', '', totals.pending, totals.overdue, totals.docs]
  for (const [index, column] of RECEIVABLE_COLUMNS.entries()) {
    const cell = setCell(totalRow, index + 1, totalValues[index] ?? null, column.type, TOTAL_FONT)
    cell.fill = TOTAL_FILL
  }
  worksheet.autoFilter = { from: { row: headerRowNumber, column: 1 }, to: { row: headerRowNumber, column: lastCol } }
  worksheet.views = [{ state: 'frozen', ySplit: headerRowNumber, xSplit: 1, showGridLines: false }]
  worksheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  return true
}

function addNotesSheet(workbook: import('exceljs').Workbook, data: ClientsExportData) {
  const worksheet = workbook.addWorksheet('Notas y Definiciones')
  worksheet.columns = [{ width: 120 }]
  const lines = [
    'MYM · INFORME GERENCIAL DE CLIENTES',
    '',
    `Empresa: ${data.companyName}`,
    `Generado: ${new Date(data.generatedAt).toLocaleString('es-CL')}`,
    `Última actualización de datos comerciales (snapshot): ${datetimeLabel(data.lastDataUpdateAt)}`,
    '',
    'DEFINICIONES COMERCIALES',
    `• ${data.officialSalesDefinition}`,
    `• ${data.creditNoteDefinition}`,
    '• Ticket promedio = venta oficial histórica / número de facturas (monto bruto).',
    '• "Días sin comprar" = días desde la última factura oficial (tipo 5).',
    '',
    'ASIGNACIÓN DE VENDEDOR (criterio analítico y provisional)',
    '• 1° Vendedor principal del cliente (main_seller_name; calculado sobre los últimos 180 días).',
    '• 2° Último vendedor conocido (last_seller_name).',
    '• 3° "SIN VENDEDOR" cuando no hay asignación determinable.',
    '• No modifica el responsable comercial persistente. La columna "Origen asignación" indica el criterio usado.',
    '• Clientes inactivos >180 días pueden quedar como "SIN VENDEDOR" por diseño de la métrica.',
    '',
    'COBRANZA',
    data.snapshot
      ? `• Las columnas marcadas con * provienen del último snapshot Bsale completado (${datetimeLabel(data.snapshot.snapshot_at)}, cobertura ${data.snapshot.coverage_percent}%). Son REFERENCIALES y sujetas a conciliación.`
      : '• No se incorporó deuda: no hay snapshot Bsale completado disponible al momento de generar.',
    '• No se usan las vistas legacy de Comercial > Cobranzas como fuente de deuda.',
    '',
    'CUENTAS INTERNAS',
    '• Los clientes identificados como internos se conservan y se marcan en la columna "Cliente interno". No se excluyen automáticamente.',
    '',
    'DIRECCIONES Y NAVEGACIÓN',
    `• Cobertura: ${data.addressCoverage.complete} completas, ${data.addressCoverage.partial} parciales y ${data.addressCoverage.missing} inexistentes sobre ${data.clients.length} clientes.`,
    '• Dirección física y comuna/ciudad/región provienen prioritariamente del espejo sincronizado de Bsale; la vista comercial se usa como respaldo si un cliente no existe en el espejo. No se reutiliza la región histórica cuando no está disponible en Bsale.',
    '• El enlace de Google Maps se genera solo para direcciones clasificadas como domicilio específico: texto de dirección con número y comuna separada. No se geocodifica ni se infieren datos faltantes.',
  ]
  for (const line of lines) {
    const row = worksheet.addRow([line])
    if (line === line.toUpperCase() && line.length > 3) row.getCell(1).font = { ...TITLE_FONT, size: 11 }
    else row.getCell(1).font = BODY_FONT
    row.getCell(1).alignment = { vertical: 'middle', horizontal: 'left', wrapText: true }
  }
  worksheet.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }]
  return worksheet
}

function sortClients(a: ClientsExportRow, b: ClientsExportRow): number {
  return String(a.assigned_seller).localeCompare(String(b.assigned_seller), 'es')
    || b.official_sales_total - a.official_sales_total
}

export async function buildClientsWorkbook(data: ClientsExportData): Promise<import('exceljs').Workbook> {
  const imported = await import('exceljs')
  const ExcelJS = ((imported as unknown as { default?: typeof import('exceljs') }).default ?? imported) as typeof import('exceljs')
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'MYM Distribuidora'
  workbook.created = new Date(data.generatedAt)

  addSummarySheet(workbook, data)

  const allClientsSheet = addClientSheet(
    workbook,
    'Todos los Clientes',
    data,
    [...data.clients].sort(sortClients),
    'TODOS LOS CLIENTES',
    [data.officialSalesDefinition, `Direcciones: ${data.addressCoverage.complete} completas, ${data.addressCoverage.partial} parciales, ${data.addressCoverage.missing} inexistentes. Los enlaces solo se generan para domicilios específicos.`],
  )
  addDataBars(allClientsSheet, CLIENT_COLUMNS, 5, data.clients.length)

  const usedNames = new Set<string>(['resumen gerencial', 'todos los clientes', 'sin vendedor'])
  const groups = groupBySeller(data.clients)
  for (const group of groups) {
    if (group.seller === 'SIN VENDEDOR') continue
    const sheetName = sanitizeSheetName(`Vend. ${group.seller}`, usedNames)
    addClientSheet(workbook, sheetName, data, [...group.clients].sort(sortClients), `CARTERA · ${group.seller}`, [data.officialSalesDefinition, 'Las columnas de dirección y navegación usan el mismo criterio y fuente que "Todos los Clientes".'])
  }

  const sinVendedor = data.clients.filter(client => client.assigned_seller === 'SIN VENDEDOR')
  if (sinVendedor.length > 0) {
    addClientSheet(workbook, 'Sin Vendedor', data, [...sinVendedor].sort(sortClients), 'CLIENTES SIN VENDEDOR ASIGNADO', ['Clientes cuya asignación comercial no pudo determinarse (sin vendedor principal ni último vendedor registrado).', 'Las columnas de dirección y navegación usan el mismo criterio y fuente que "Todos los Clientes".'])
  }

  if (data.clients.some(client => client.status === 'RIESGO' || client.status === 'PERDIDO')) {
    addRiskSheet(workbook, data, usedNames)
  }

  addReceivableSheet(workbook, data, usedNames)
  addNotesSheet(workbook, data)

  return workbook
}
