import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import type { WorkerMonthlyReport } from '@/app/actions/logistica/mermas'
import { formatCivilDate, formatInstantInSantiago, todayInSantiago } from '@/lib/datetime'

const NAVY: [number, number, number] = [30, 58, 95]
const EMERALD: [number, number, number] = [16, 185, 129]
const TEXT: [number, number, number] = [30, 41, 59]
const MUTED: [number, number, number] = [100, 116, 139]
const BORDER: [number, number, number] = [226, 232, 240]
const LIGHT: [number, number, number] = [248, 250, 252]
const WHITE: [number, number, number] = [255, 255, 255]

function money(value: number): string {
  return `$ ${Math.round(value).toLocaleString('es-CL')}`
}

function periodLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat('es-CL', { month: 'long', year: 'numeric', timeZone: 'America/Santiago' })
    .format(new Date(`${year}-${String(month).padStart(2, '0')}-01T12:00:00Z`))
}

function movementLabel(type: string, sourceType: string): string {
  if (type === 'PAYMENT') return 'Pago registrado'
  if (type === 'PAYMENT_VOID') return 'Anulación de pago'
  if (sourceType === 'MERMA') return 'Venta interna Mermas'
  if (sourceType === 'BSALE_BOLETA') return 'Compra / Boleta Bsale'
  if (sourceType === 'BSALE_NOTA_CREDITO') return 'Nota de crédito / Ajuste'
  return 'Movimiento'
}

function productLines(items: WorkerMonthlyReport['workers'][number]['movements'][number]['items'] | null | undefined): string {
  const safeItems = items ?? []
  return safeItems.length === 0
    ? '—'
    : safeItems.map((item) => `${item.product_name || item.sku || 'Producto'} × ${item.quantity ?? 0}`).join('\n')
}

function addLogo(doc: jsPDF, base64?: string): void {
  if (!base64) return
  try {
    const format = base64.startsWith('data:image/jpeg') || base64.startsWith('data:image/jpg') ? 'JPEG' : 'PNG'
    doc.addImage(base64, format, 15, 6, 18, 14)
  } catch (error) {
    console.error('Error adding worker debt report logo:', error)
  }
}

function footer(doc: jsPDF, page: number, total: number): void {
  const width = doc.internal.pageSize.getWidth()
  const height = doc.internal.pageSize.getHeight()
  doc.setDrawColor(...BORDER)
  doc.setLineWidth(0.3)
  doc.line(15, height - 15, width - 15, height - 15)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6.5)
  doc.setTextColor(...MUTED)
  doc.text(`Documento generado el ${formatCivilDate(todayInSantiago())} | Página ${page} de ${total}`, width / 2, height - 8.5, { align: 'center' })
}

async function loadLogo(): Promise<string | undefined> {
  try {
    const response = await fetch('/logo.png')
    if (!response.ok) return undefined
    const blob = await response.blob()
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  } catch (error) {
    console.error('Error loading worker debt report logo:', error)
    return undefined
  }
}

export function generateWorkerDebtReportPdfBlob(report: WorkerMonthlyReport, year: number, month: number, logoBase64?: string): Blob {
  const doc = new jsPDF('p', 'mm', 'a4')
  const width = doc.internal.pageSize.getWidth()
  const margin = 15

  doc.setFillColor(...NAVY)
  doc.rect(0, 0, width, 27, 'F')
  addLogo(doc, logoBase64)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.setTextColor(...WHITE)
  doc.text('DISTRIBUIDORA MYM', width - margin, 12, { align: 'right' })
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7)
  doc.text('RUT 77.196.005-7', width - margin, 18, { align: 'right' })

  let y = 38
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.setTextColor(...NAVY)
  doc.text('REPORTE DE DEUDA DE TRABAJADORES', margin, y)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...MUTED)
  doc.text(`Período: ${periodLabel(year, month)} | Emitido: ${formatInstantInSantiago(new Date().toISOString())}`, margin, y + 6)
  doc.setDrawColor(...EMERALD)
  doc.setLineWidth(1)
  doc.line(margin, y + 11, width - margin, y + 11)
  y += 19

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8)
  doc.setTextColor(...EMERALD)
  doc.text('RESUMEN DEL PERÍODO', margin, y)
  y += 4

  const summary = report.summary
  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Saldo anterior', 'Ventas internas Mermas', 'Compras / Boletas Bsale', 'NC / Ajustes', 'Pagos registrados', 'Saldo pendiente']],
    body: [[money(summary.opening_balance), money(summary.merma_charges), money(summary.bsale_charges), money(summary.adjustments), money(summary.payments), money(summary.closing_balance)]],
    theme: 'grid',
    styles: { font: 'helvetica', fontSize: 8, cellPadding: 3, textColor: TEXT, lineColor: BORDER, lineWidth: 0.3, halign: 'right' },
    headStyles: { fillColor: NAVY, textColor: WHITE, fontStyle: 'bold', fontSize: 7, halign: 'center' },
    bodyStyles: { fillColor: LIGHT, fontStyle: 'bold' },
    columnStyles: { 5: { textColor: EMERALD, fontStyle: 'bold' } },
  })
  y = ((doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? y) + 9
  doc.setFillColor(240, 253, 250)
  doc.setDrawColor(...EMERALD)
  doc.roundedRect(margin, y - 4, width - margin * 2, 12, 2, 2, 'FD')
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(...NAVY)
  doc.text('TOTAL A DESCONTAR', margin + 4, y + 3)
  doc.setFontSize(12)
  doc.setTextColor(...EMERALD)
  doc.text(money(summary.closing_balance), width - margin - 4, y + 3, { align: 'right' })
  y += 18

  doc.setFontSize(8)
  doc.setTextColor(...EMERALD)
  doc.text('RESUMEN POR TRABAJADOR', margin, y)
  y += 4
  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Trabajador', 'RUT', 'Ventas Mermas', 'Boletas Bsale', 'Ajustes / NC', 'Pagos', 'Saldo pendiente']],
    body: report.workers.map((worker) => [worker.name, worker.rut, money(worker.merma_charges), money(worker.bsale_charges), money(worker.adjustments), money(worker.payments), money(worker.closing_balance)]),
    theme: 'grid',
    styles: { font: 'helvetica', fontSize: 7.5, cellPadding: 2.5, textColor: TEXT, lineColor: BORDER, lineWidth: 0.3 },
    headStyles: { fillColor: NAVY, textColor: WHITE, fontStyle: 'bold', fontSize: 7, halign: 'center' },
    alternateRowStyles: { fillColor: LIGHT },
    columnStyles: { 0: { cellWidth: 38 }, 1: { cellWidth: 24 }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right', fontStyle: 'bold' } },
    didParseCell: (data) => { if (data.section === 'body' && data.column.index === 6) data.cell.styles.textColor = data.cell.raw && report.workers[data.row.index]?.closing_balance > 0 ? NAVY : EMERALD },
  })
  y = ((doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? y) + 10

  doc.setFontSize(8)
  doc.setTextColor(...EMERALD)
  doc.text('DETALLE DE MOVIMIENTOS', margin, y)
  y += 4
  for (const worker of report.workers.filter((item) => item.movements.length > 0)) {
    if (y > 260) { doc.addPage(); y = 20 }
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(...NAVY)
    doc.text(worker.name, margin, y)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.setTextColor(...MUTED)
    doc.text(`RUT ${worker.rut}`, margin, y + 4)
    const balanceY = y - 1
    const balanceX = width - margin
    doc.setFontSize(6.5)
    doc.text('SALDO ANTERIOR', balanceX - 42, balanceY, { align: 'right' })
    doc.text('SALDO A DESCONTAR', balanceX, balanceY, { align: 'right' })
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8)
    doc.setTextColor(...NAVY)
    doc.text(money(worker.opening_balance), balanceX - 42, balanceY + 5, { align: 'right' })
    doc.setFontSize(worker.closing_balance > 0 ? 13 : 8)
    doc.setTextColor(...(worker.closing_balance > 0 ? EMERALD : MUTED))
    doc.text(money(worker.closing_balance), balanceX, balanceY + 5, { align: 'right' })
    y += 11
    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Fecha', 'Referencia', 'Producto(s)', 'Concepto', 'Cargo', 'Pago']],
      body: worker.movements.map((movement) => {
        const payment = movement.type === 'PAYMENT' || movement.type === 'PAYMENT_VOID'
        return [formatInstantInSantiago(movement.date), movement.reference_number ?? 'Sin referencia', productLines(movement.items), movementLabel(movement.type, movement.source_type), payment ? '-' : money(movement.amount), payment ? `${movement.type === 'PAYMENT_VOID' ? '+' : '-'}${money(movement.amount)}` : '-']
      }),
      theme: 'grid',
      styles: { font: 'helvetica', fontSize: 7, cellPadding: 2, textColor: TEXT, lineColor: BORDER, lineWidth: 0.3 },
      headStyles: { fillColor: LIGHT, textColor: NAVY, fontStyle: 'bold', fontSize: 6.5 },
      columnStyles: { 0: { cellWidth: 24 }, 1: { cellWidth: 25 }, 2: { cellWidth: 42 }, 4: { halign: 'right', cellWidth: 20 }, 5: { halign: 'right', cellWidth: 20 } },
    })
    y = ((doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? y) + 7
  }

  const totalPages = doc.getNumberOfPages()
  for (let page = 1; page <= totalPages; page++) { doc.setPage(page); footer(doc, page, totalPages) }
  doc.setProperties({ title: `Deuda de trabajadores - ${periodLabel(year, month)}`, subject: 'Reporte de deuda de trabajadores', author: 'DISTRIBUIDORA MYM' })
  return doc.output('blob')
}

export async function createWorkerDebtReportPdfBlob(report: WorkerMonthlyReport, year: number, month: number): Promise<Blob> {
  return generateWorkerDebtReportPdfBlob(report, year, month, await loadLogo())
}

export async function downloadWorkerDebtReportPdf(report: WorkerMonthlyReport, year: number, month: number): Promise<void> {
  const blob = await createWorkerDebtReportPdfBlob(report, year, month)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `reporte-deuda-trabajadores-${year}-${String(month).padStart(2, '0')}.pdf`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
