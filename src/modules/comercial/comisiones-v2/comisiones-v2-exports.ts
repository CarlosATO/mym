import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import type { ComisionesV2SettlementDetail } from '@/app/actions/comisiones-v2'
import { buildSnapshotSupplierChartRows, topSupplierChartRows, type SupplierChartRow } from './comisiones-v2-supplier-chart'

type SnapshotLine = ComisionesV2SettlementDetail['lines'][number]
type Rgb = [number, number, number]

const DARK_HEADER: Rgb = [30, 58, 95]
const EMERALD: Rgb = [16, 185, 129]
const DARK_TEXT: Rgb = [30, 41, 59]
const MID_GRAY: Rgb = [100, 116, 139]
const LIGHT_BORDER: Rgb = [226, 232, 240]
const AMBER: Rgb = [245, 158, 11]

function currency(value: number | null | undefined) {
  return `$${Math.round(value ?? 0).toLocaleString('es-CL')}`
}

function civilDate(value: string | null | undefined) {
  if (!value) return '—'
  const [year, month, day] = value.slice(0, 10).split('-')
  return `${day}/${month}/${year}`
}

function instantDate(value: string | null | undefined) {
  if (!value) return '—'
  const parts = new Intl.DateTimeFormat('es-CL', {
    timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(value))
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? ''
  return `${part('day')}/${part('month')}/${part('year')} ${part('hour')}:${part('minute')}`
}

function percent(value: number | null | undefined) {
  return `${(value ?? 0).toLocaleString('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} %`
}

function status(line: SnapshotLine) {
  return typeof line.metadata.simulation_status === 'string' ? line.metadata.simulation_status : 'RULE_APPLIED'
}

function statusLabel(line: SnapshotLine) {
  if (status(line) === 'NO_ACTIVE_PLAN') return 'Sin plan'
  if (status(line) === 'NO_FAMILY_RATE') return 'Sin regla de familia'
  return 'Regla aplicada'
}

function typeLabel(line: SnapshotLine) {
  if (status(line) === 'NO_ACTIVE_PLAN') return 'Sin comisión'
  if (status(line) === 'NO_FAMILY_RATE') return 'Por Familia · Sin regla'
  if (line.plan_type === 'FAMILY_FIXED_PERCENT') return 'Por Familia'
  if (line.plan_type === 'SUPPLIER_SALES_TARGET') return 'Meta de ventas'
  return '—'
}

function planLabel(line: SnapshotLine) {
  return status(line) === 'NO_ACTIVE_PLAN' ? 'Sin plan' : line.plan_code_snapshot ?? '—'
}

function isNoCommission(line: SnapshotLine) {
  return status(line) === 'NO_ACTIVE_PLAN' || status(line) === 'NO_FAMILY_RATE'
}

function footer(doc: jsPDF, page: number, totalPages: number, isDraft: boolean) {
  const width = doc.internal.pageSize.getWidth()
  doc.setDrawColor(...LIGHT_BORDER)
  doc.setLineWidth(0.3)
  doc.line(15, 282, width - 15, 282)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7)
  if (isDraft) {
    doc.setTextColor(...AMBER)
    doc.text('BORRADOR — NO EMITIDO. Este documento no representa una liquidación oficial.', width / 2, 285, { align: 'center' })
  }
  doc.setFontSize(6)
  doc.setTextColor(...MID_GRAY)
  doc.text(`Documento generado desde PetGroup/MYM | Página ${page} de ${totalPages}`, width / 2, 289, { align: 'center' })
}

function addLogo(doc: jsPDF, logoBase64: string | undefined) {
  if (!logoBase64) return
  try { doc.addImage(logoBase64, 'PNG', 17, 5, 22, 17) } catch { /* Logo failure must not block the export. */ }
}

function invoiceRows(lines: SnapshotLine[]) {
  const invoices = new Map<number, { number: number | string; customer: string; payment: string | null; net: number; commission: number }>()
  for (const line of lines) {
    const invoiceId = line.source_document_bsale_id
    const current = invoices.get(invoiceId)
    if (current) {
      current.net += line.net_amount
      current.commission += line.commission_amount
      if (!current.payment && line.full_payment_date) current.payment = line.full_payment_date
      continue
    }
    invoices.set(invoiceId, {
      number: line.source_document_number ?? invoiceId,
      customer: line.customer_name_snapshot ?? '—',
      payment: line.full_payment_date,
      net: line.net_amount,
      commission: line.commission_amount,
    })
  }
  return Array.from(invoices.values()).map(invoice => [
    String(invoice.number), invoice.customer, civilDate(invoice.payment), currency(invoice.net), currency(invoice.commission),
  ])
}

function drawSupplierChart(doc: jsPDF, rows: SupplierChartRow[], startY: number, width: number) {
  const margin = 15
  const rowHeight = 9
  const barX = margin + 48
  const barWidth = 62
  const valueX = width - margin
  const maxNet = rows[0]?.net ?? 0
  const chartHeight = 13 + rows.length * rowHeight
  if (startY + chartHeight > 272) {
    doc.addPage()
    startY = 18
  }

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.setTextColor(...DARK_HEADER)
  doc.text('RESUMEN VISUAL POR PROVEEDOR', margin, startY)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7)
  doc.setTextColor(...MID_GRAY)
  doc.text('Top 10 proveedores por venta neta', margin, startY + 4.5)

  const topY = startY + 10
  rows.forEach((row, index) => {
    const y = topY + index * rowHeight
    const name = row.supplierName.length > 29 ? `${row.supplierName.slice(0, 27)}...` : row.supplierName
    const bar = maxNet > 0 ? (row.net / maxNet) * barWidth : 0
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(6.5)
    doc.setTextColor(...DARK_TEXT)
    doc.text(name, margin, y + 3.5)
    doc.setFillColor(226, 232, 240)
    doc.roundedRect(barX, y + 1, barWidth, 4, 1, 1, 'F')
    if (bar > 0) {
      doc.setFillColor(...EMERALD)
      doc.roundedRect(barX, y + 1, bar, 4, 1, 1, 'F')
    }
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(6.2)
    doc.setTextColor(...DARK_TEXT)
    doc.text(`${currency(row.net)} · ${currency(row.commission)} · ${percent(row.effectivePercent)}`, valueX, y + 3.5, { align: 'right' })
  })
  return startY + chartHeight
}

export type ComisionesV2PdfOptions = {
  status?: 'DRAFT' | 'ISSUED'
  settlementCode?: string
  settlementNumber?: number | null
  issuedAt?: string | null
}

export function generateComisionesV2DraftPdf(detail: ComisionesV2SettlementDetail, logoBase64?: string, options: ComisionesV2PdfOptions = {}) {
  const doc = new jsPDF('p', 'mm', 'a4')
  const width = doc.internal.pageSize.getWidth()
  const margin = 15
  const usableWidth = width - margin * 2
  const { settlement, lines } = detail
  const isDraft = options.status !== 'ISSUED'
  const noCommissionLines = lines.filter(isNoCommission)
  const noCommissionNet = noCommissionLines.reduce((total, line) => total + line.net_amount, 0)
  const effectivePercent = settlement.total_net_amount ? settlement.total_commission_amount / settlement.total_net_amount * 100 : 0

  doc.setFillColor(...DARK_HEADER); doc.rect(0, 0, width, 32, 'F'); addLogo(doc, logoBase64)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(255, 255, 255); doc.text('DISTRIBUIDORA MYM', width - margin, 8, { align: 'right' })
  doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.text('PetGroup', width - margin, 13, { align: 'right' })

  let cursorY = 42
  doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.setTextColor(...DARK_HEADER); doc.text('LIQUIDACIÓN DE COMISIONES', margin, cursorY)
  const badgeText = isDraft ? 'BORRADOR' : 'EMITIDA'; const badgeWidth = doc.getTextWidth(badgeText) + 6
  doc.setFillColor(...AMBER); doc.roundedRect(width - margin - badgeWidth, cursorY - 3, badgeWidth, 5.5, 1, 1, 'F'); doc.setFontSize(7); doc.setTextColor(255, 255, 255); doc.text(badgeText, width - margin - badgeWidth / 2, cursorY + 1.5, { align: 'center' })
  cursorY += 7; doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MID_GRAY); doc.text(`Código: ${isDraft ? '—' : options.settlementCode ?? '—'}`, margin, cursorY); doc.text(isDraft ? 'Pendiente de emisión' : `N° ${options.settlementNumber ?? '—'}`, width - margin, cursorY, { align: 'right' })

  cursorY += 8
  doc.setDrawColor(...LIGHT_BORDER); doc.setFillColor(248, 250, 252); doc.roundedRect(margin, cursorY, usableWidth, 39, 2, 2, 'FD')
  const col1 = margin + 5; const col2 = margin + 85; const col3 = margin + 145; let infoY = cursorY + 5
  doc.setFontSize(7); doc.setTextColor(...DARK_TEXT)
  doc.setFont('helvetica', 'bold'); doc.text('VENDEDOR', col1, infoY); doc.setFont('helvetica', 'normal'); doc.text(settlement.seller_name_snapshot, col1 + 20, infoY)
  doc.setFont('helvetica', 'bold'); doc.text('PERÍODO', col2, infoY); doc.setFont('helvetica', 'normal'); doc.text(`${civilDate(settlement.period_from)} al ${civilDate(settlement.period_to)}`, col2 + 18, infoY)
  doc.setFont('helvetica', 'bold'); doc.text('CREACIÓN', col3, infoY); doc.setFont('helvetica', 'normal'); doc.text(instantDate(settlement.created_at), col3 + 18, infoY)
  infoY += 5; doc.setFont('helvetica', 'bold'); doc.text('ESTADO', col1, infoY); doc.setFont('helvetica', 'normal'); doc.text(isDraft ? 'BORRADOR' : 'EMITIDA', col1 + 20, infoY); doc.setFont('helvetica', 'bold'); doc.text('EMISIÓN', col2, infoY); doc.setFont('helvetica', 'normal'); doc.text(isDraft ? 'Pendiente' : instantDate(options.issuedAt), col2 + 18, infoY)
  infoY += 7; doc.setDrawColor(...LIGHT_BORDER); doc.line(margin + 3, infoY, width - margin - 3, infoY); infoY += 4
  const kpis = [['Facturas', String(new Set(lines.map(line => line.source_document_bsale_id)).size)], ['Líneas', lines.length.toLocaleString('es-CL')], ['Sin comisión', noCommissionLines.length.toLocaleString('es-CL')], ['Neto sin comisión', currency(noCommissionNet)], ['Neto elegible', currency(settlement.total_net_amount)], ['Comisión total', currency(settlement.total_commission_amount)], ['% efectivo', percent(effectivePercent)]]
  const kpiWidth = usableWidth / kpis.length
  doc.setFontSize(6.2); kpis.forEach(([label], index) => { doc.setFont('helvetica', 'bold'); doc.text(label, margin + kpiWidth * index + kpiWidth / 2, infoY, { align: 'center' }) }); infoY += 3.5
  kpis.forEach(([, value], index) => { doc.setFont('helvetica', 'normal'); doc.text(value, margin + kpiWidth * index + kpiWidth / 2, infoY, { align: 'center' }) })
  cursorY += 43

  autoTable(doc, { startY: cursorY, head: [['Factura', 'Cliente', 'Pago completo', 'Neto elegible', 'Comisión']], body: invoiceRows(lines), margin: { left: margin, right: margin }, styles: { fontSize: 7, textColor: [...DARK_TEXT], lineColor: [...LIGHT_BORDER], lineWidth: 0.3 }, headStyles: { fillColor: [...DARK_HEADER], textColor: 255, fontSize: 7, fontStyle: 'bold' }, alternateRowStyles: { fillColor: [248, 250, 252] }, columnStyles: { 0: { cellWidth: 22 }, 1: { cellWidth: 62 }, 2: { cellWidth: 28 }, 3: { cellWidth: 35, halign: 'right' }, 4: { cellWidth: 35, halign: 'right' } }, didDrawPage: () => footer(doc, doc.getCurrentPageInfo().pageNumber, doc.getNumberOfPages(), isDraft) })
  const finalY = ((doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY) + 6
  doc.setDrawColor(...LIGHT_BORDER); doc.setFillColor(248, 250, 252); doc.roundedRect(margin, finalY, usableWidth, 22, 2, 2, 'FD')
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...DARK_TEXT); doc.text('NETO ELEGIBLE', margin + 8, finalY + 8); doc.text(currency(settlement.total_net_amount), width - margin - 8, finalY + 8, { align: 'right' }); doc.setTextColor(...EMERALD); doc.text('COMISIÓN TOTAL', margin + 8, finalY + 16); doc.text(currency(settlement.total_commission_amount), width - margin - 8, finalY + 16, { align: 'right' })
  const supplierRows = topSupplierChartRows(buildSnapshotSupplierChartRows(detail))
  if (supplierRows.length > 0) drawSupplierChart(doc, supplierRows, finalY + 29, width)
  const totalPages = doc.getNumberOfPages(); for (let page = 1; page <= totalPages; page++) { doc.setPage(page); footer(doc, page, totalPages, isDraft) }
  doc.setProperties({ title: `Liquidación de Comisiones ${options.settlementCode ?? 'borrador'}`, subject: isDraft ? 'Borrador V2 desde snapshot' : 'Liquidación V2 emitida desde snapshot', author: 'DISTRIBUIDORA MYM' })
  if (!isDraft && options.issuedAt) {
    const creationDate = new Date(options.issuedAt)
    if (Number.isNaN(creationDate.getTime())) throw new Error('INVALID_OFFICIAL_PDF_TIMESTAMP')
    doc.setCreationDate(creationDate)
    doc.setFileId(settlement.id.replaceAll('-', ''))
  }
  return doc.output('blob')
}

export function buildComisionesV2DraftWorkbook(detail: ComisionesV2SettlementDetail) {
  const data = detail.lines.map(line => ({
    Estado: 'Borrador', Vendedor: detail.settlement.seller_name_snapshot, Período: `${civilDate(detail.settlement.period_from)} al ${civilDate(detail.settlement.period_to)}`,
    Factura: line.source_document_number ?? line.source_document_bsale_id, Cliente: line.customer_name_snapshot ?? '', 'Pago completo': civilDate(line.full_payment_date), SKU: line.sku_snapshot ?? '', Producto: line.description_snapshot ?? '', 'Proveedor REAL': line.real_supplier_name_snapshot ?? '', Familia: line.family_name_snapshot ?? '', Cantidad: Number(line.quantity), Neto: Number(line.net_amount), 'Estado comisión': statusLabel(line), 'Plan / Regla': planLabel(line), 'Tipo de comisión': typeLabel(line), '%': Number(isNoCommission(line) ? 0 : line.percentage ?? 0), Comisión: Number(isNoCommission(line) ? 0 : line.commission_amount),
    bsale_variant_id: line.bsale_variant_id ?? null, source_document_bsale_id: line.source_document_bsale_id, source_document_line_id: line.source_document_line_id ?? null, source_document_detail_bsale_id: line.source_document_detail_bsale_id ?? null, plan_id: line.plan_id ?? null, plan_code_snapshot: line.plan_code_snapshot ?? null, plan_version: line.plan_version_no ?? null, family_rate_id: line.family_rate_id ?? null, tier_id: line.tier_id ?? null, supplier_total_net: line.supplier_total_net ?? null, tier_min: line.tier_lower_bound ?? null, tier_max: line.tier_upper_bound ?? null, simulation_status: status(line),
  }))
  return data
}

export async function generateComisionesV2DraftExcel(detail: ComisionesV2SettlementDetail) {
  const XLSX = await import('xlsx')
  const data = buildComisionesV2DraftWorkbook(detail)
  const workbook = XLSX.utils.book_new(); const worksheet = XLSX.utils.json_to_sheet(data)
  worksheet['!cols'] = Object.keys(data[0] ?? {}).map(key => ({ wch: Math.min(Math.max(key.length + 2, 14), 34) }))
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Detalle')
  const output = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' })
  return new Blob([output], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}
