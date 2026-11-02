import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const generator = await readFile(new URL('src/lib/pdf/generate-pending-purchase-orders-pdf.ts', root), 'utf8')
const panel = await readFile(new URL('src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx', root), 'utf8')

test('pending report PDF contains only operational quantities and required sections', () => {
  assert.match(generator, /REPORTE DE PEDIDOS PENDIENTES DE RECEPCIÓN/)
  assert.match(generator, /Órdenes de compra pendientes/)
  assert.match(generator, /Proveedores involucrados/)
  assert.match(generator, /Líneas pendientes/)
  assert.match(generator, /quantity_ordered/)
  assert.match(generator, /quantity_received/)
  assert.match(generator, /quantity_pending/)
  assert.match(generator, /PROVEEDOR:/)
  assert.match(generator, /OC \$\{order\.header\.correlative\}/)
  assert.match(generator, /Estado: \$\{statusLabel\(order\.header\.status\)\}/)
  assert.match(generator, /No constituye confirmación de disponibilidad ni fecha de entrega/)
  assert.doesNotMatch(generator, /unit_price|discount|tax_total|grand_total|currency|cost/i)
})

test('PDF generation keeps tables together as far as possible and numbers every page', () => {
  assert.match(generator, /pageBreak: 'auto'/)
  assert.match(generator, /willDrawPage/)
  assert.match(generator, /Página \$\{page\} de \$\{totalPages\}/)
  assert.match(generator, /for \(let page = 1; page <= totalPages; page\+\+\)/)
})

test('the panel refreshes the authorized report and downloads all returned lines', () => {
  assert.match(panel, /getCachedPendingPurchaseOrdersReport/)
  assert.match(panel, /handleDownloadPendingPurchaseOrdersPDF/)
  assert.match(panel, /report\.data\.length === 0/)
  assert.match(panel, /downloadPendingPurchaseOrdersReportPdf\(report/)
  assert.match(panel, /Pedidos_Pendientes_\$\{todayInSantiago\(\)\}/)
  assert.match(panel, /Descargar pendientes/)
  assert.match(panel, /downloadingPendingPdf \? <Loader2/)
})
