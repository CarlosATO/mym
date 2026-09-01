import { jsPDF } from 'jspdf'
import { QRCodeCanvas } from 'qrcode.react'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'

export interface LocationLabelRecord {
  id: string
  code: string
  name: string | null
  aisle: string | null
  rack: string | null
  level: string | null
  position: string | null
}

export type LocationLabelFormat = 'labels' | 'full-sheet'

const PAGE = {
  width: 210,
  height: 297,
  marginX: 7,
  marginY: 9,
  labelWidth: 63.5,
  labelHeight: 34.9,
  columns: 3,
  rows: 8,
}

function valueOrDash(value: string | null): string {
  return value?.trim() || '—'
}

function qrPngDataUrl(payload: string): string {
  const container = document.createElement('div')
  container.style.position = 'fixed'
  container.style.left = '-10000px'
  document.body.appendChild(container)
  const root = createRoot(container)
  flushSync(() => {
    root.render(createElement(QRCodeCanvas, {
      value: payload,
      size: 256,
      level: 'M',
      marginSize: 2,
      bgColor: '#FFFFFF',
      fgColor: '#000000',
    }))
  })
  const canvas = container.querySelector('canvas') as HTMLCanvasElement | null
  if (!canvas) throw new Error('No se pudo generar el QR de la ubicación')
  const dataUrl = canvas.toDataURL('image/png')
  root.unmount()
  container.remove()
  return dataUrl
}

function drawLabel(doc: jsPDF, location: LocationLabelRecord, x: number, y: number, warehouseName: string) {
  doc.setDrawColor(190, 196, 204)
  doc.setLineWidth(0.25)
  doc.roundedRect(x, y, PAGE.labelWidth, PAGE.labelHeight, 1.5, 1.5, 'S')

  doc.setTextColor(70, 78, 88)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(6.5)
  const warehouseLines = doc.splitTextToSize(warehouseName, 37) as string[]
  doc.text(warehouseLines.slice(0, 2), x + 3, y + 4.5, { baseline: 'top' })

  doc.setTextColor(20, 28, 38)
  doc.setFont('courier', 'bold')
  doc.setFontSize(location.code.length > 22 ? 8.5 : location.code.length > 15 ? 10 : 12)
  const codeLines = doc.splitTextToSize(location.code, 36) as string[]
  doc.text(codeLines.slice(0, 2), x + 3, y + 10, { baseline: 'top' })

  doc.setTextColor(75, 84, 95)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(5.8)
  const details = [
    `Pasillo: ${valueOrDash(location.aisle)}`,
    `Rack: ${valueOrDash(location.rack)}`,
    `Nivel: ${valueOrDash(location.level)}`,
    `Posición: ${valueOrDash(location.position)}`,
  ]
  doc.text(details, x + 3, y + 19.5, { baseline: 'top', lineHeightFactor: 1.2 })

  const qrPayload = `PGLOC:${location.id}`
  doc.addImage(qrPngDataUrl(qrPayload), 'PNG', x + 41, y + 6.5, 19, 19)
  doc.setFontSize(4.5)
  doc.setTextColor(100, 108, 118)
  doc.text('ID ubicación', x + 50.5, y + 27.5, { align: 'center' })
}

function drawFullSheet(doc: jsPDF, location: LocationLabelRecord, warehouseName: string) {
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const centerX = pageWidth / 2
  const qrSize = 82
  const qrX = centerX - qrSize / 2

  doc.setDrawColor(210, 215, 221)
  doc.setLineWidth(0.3)
  doc.line(24, 28, pageWidth - 24, 28)

  doc.setTextColor(65, 73, 84)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.text(warehouseName, centerX, 20, { align: 'center' })

  doc.setTextColor(18, 25, 35)
  doc.setFont('courier', 'bold')
  doc.setFontSize(location.code.length > 22 ? 27 : location.code.length > 15 ? 32 : 38)
  const codeLines = doc.splitTextToSize(location.code, pageWidth - 42) as string[]
  doc.text(codeLines.slice(0, 2), centerX, 57, { align: 'center', baseline: 'top', lineHeightFactor: 1.15 })

  doc.addImage(qrPngDataUrl(`PGLOC:${location.id}`), 'PNG', qrX, 83, qrSize, qrSize)

  doc.setTextColor(65, 73, 84)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(14)
  const details = [
    `Pasillo: ${valueOrDash(location.aisle)}`,
    `Rack: ${valueOrDash(location.rack)}`,
    `Nivel: ${valueOrDash(location.level)}`,
    `Posición: ${valueOrDash(location.position)}`,
  ]
  doc.text(details, centerX, 183, { align: 'center', lineHeightFactor: 1.65 })

  if (location.name?.trim()) {
    doc.setFontSize(11)
    doc.setTextColor(105, 113, 123)
    doc.text(doc.splitTextToSize(location.name.trim(), pageWidth - 48).slice(0, 2), centerX, 226, { align: 'center', lineHeightFactor: 1.4 })
  }

  doc.setDrawColor(210, 215, 221)
  doc.line(24, pageHeight - 25, pageWidth - 24, pageHeight - 25)
}

export function generateLocationLabelsPdf(
  warehouseName: string,
  locations: LocationLabelRecord[],
  format: LocationLabelFormat = 'labels',
): Blob {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true })

  if (format === 'full-sheet') {
    locations.forEach((location, index) => {
      if (index > 0) doc.addPage()
      drawFullSheet(doc, location, warehouseName)
    })
    return doc.output('blob')
  }

  const perPage = PAGE.columns * PAGE.rows

  locations.forEach((location, index) => {
    if (index > 0 && index % perPage === 0) doc.addPage()
    const pageIndex = index % perPage
    const column = pageIndex % PAGE.columns
    const row = Math.floor(pageIndex / PAGE.columns)
    drawLabel(
      doc,
      location,
      PAGE.marginX + column * PAGE.labelWidth,
      PAGE.marginY + row * PAGE.labelHeight,
      warehouseName,
    )
  })

  return doc.output('blob')
}
