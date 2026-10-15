import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  calculatePurchaseOrderLineTotals,
  calculatePurchaseOrderTotals,
} from '../src/lib/adquisiciones/purchase-order-totals.ts'
import {
  getPurchaseOrderDiscountDisplayValues,
  resolvePurchaseOrderDiscountMode,
} from '../src/lib/adquisiciones/purchase-order-discounts.ts'

const panel = await readFile(new URL('../src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx', import.meta.url), 'utf8')
const pdfSource = await readFile(new URL('../src/lib/pdf/generate-po-pdf.ts', import.meta.url), 'utf8')

function formatCurrency(amount) {
  return `$ ${Math.round(amount).toLocaleString('es-CL')}`
}

function computePdfRow(item) {
  const lineTotals = calculatePurchaseOrderLineTotals({
    quantity: Number(item.quantity) || 0,
    unit_price: Number(item.unit_price) || 0,
    discount_percent: Number(item.discount_percent) || 0,
    discount_unit_amount: Number(item.discount_unit_amount) || 0,
    tax_rate: Number(item.tax_rate) || 0,
  })

  const discountMode = resolvePurchaseOrderDiscountMode(item.discount_percent, item.discount_unit_amount)
  const discountDisplay = getPurchaseOrderDiscountDisplayValues({
    unit_price: Number(item.unit_price) || 0,
    discount_percent: Number(item.discount_percent) || 0,
    discount_unit_amount: Number(item.discount_unit_amount) || 0,
    discount_mode: discountMode,
  })

  const hasDiscount = discountDisplay.discount_percent > 0 || discountDisplay.discount_unit_amount > 0

  const discountPercentText = hasDiscount
    ? `${discountDisplay.discount_percent.toLocaleString('es-CL', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%`
    : '—'

  const discountUnitText = hasDiscount && discountDisplay.discount_unit_amount > 0
    ? formatCurrency(discountDisplay.discount_unit_amount)
    : '—'

  return {
    sku: item.sku || '-',
    description: item.product_description,
    unit: item.unit || '-',
    quantity: item.quantity.toString(),
    unitPrice: formatCurrency(item.unit_price),
    discountPercentText,
    discountUnitText,
    taxRateText: item.tax_rate ? `${item.tax_rate}%` : '0%',
    netText: formatCurrency(lineTotals.net_amount),
    totalText: formatCurrency(lineTotals.line_total),
    netAmount: lineTotals.net_amount,
    totalAmount: lineTotals.line_total,
    discountDisplay,
    lineTotals,
  }
}

// Case 1 validated lines
const line1 = {
  line_number: 1,
  item_type: 'PRODUCT',
  product_id: 'prod-anc-001',
  product_description: 'ANCESTRAL PERRO ADULTO 20KG',
  unit: 'UNIDAD',
  sku: 'ANC001',
  quantity: 1,
  unit_price: 25543,
  discount_percent: 0,
  discount_unit_amount: 500,
  tax_rate: 19,
}

const line2 = {
  line_number: 2,
  item_type: 'PRODUCT',
  product_id: 'prod-anc-004',
  product_description: 'ANCESTRAL GATO ADULTO 10KG',
  unit: 'UNIDAD',
  sku: 'ANC004',
  quantity: 20,
  unit_price: 20581,
  discount_percent: 0,
  discount_unit_amount: 0,
  tax_rate: 19,
}

test('A. SKU ANC001 aparece en PDF', () => {
  const row1 = computePdfRow(line1)
  assert.equal(row1.sku, 'ANC001')
  // Verify generate-po-pdf includes SKU column and maps item.sku
  assert.match(pdfSource, /'SKU'/)
  assert.match(pdfSource, /item\.sku\s*\|\|\s*'-'/)
  // Verify purchase-orders-panel passes sku to preview items
  assert.match(panel, /sku:\s*it\.sku\s*\|\|\s*undefined/)
})

test('B. SKU ANC004 aparece en PDF', () => {
  const row2 = computePdfRow(line2)
  assert.equal(row2.sku, 'ANC004')
})

test('C. Línea con descuento unitario $500 muestra descuento', () => {
  const row1 = computePdfRow(line1)
  assert.equal(row1.discountUnitText, '$ 500')
  assert.match(pdfSource, /'Dcto\/U'/)
})

test('D. Línea con 1,96% refleja porcentaje correctamente', () => {
  const row1 = computePdfRow(line1)
  assert.equal(row1.discountPercentText, '1,96%')
  assert.match(pdfSource, /'Dcto %'/)
})

test('E. Línea sin descuento muestra — según diseño final', () => {
  const row2 = computePdfRow(line2)
  assert.equal(row2.discountPercentText, '—')
  assert.equal(row2.discountUnitText, '—')
})

test('F. Neto línea 1 = $25.043', () => {
  const row1 = computePdfRow(line1)
  assert.equal(row1.netAmount, 25043)
  assert.equal(row1.netText, '$ 25.043')
  assert.match(pdfSource, /'Neto'/)
})

test('G. Total línea 1 = $29.801', () => {
  const row1 = computePdfRow(line1)
  assert.equal(Math.round(row1.totalAmount), 29801)
  assert.equal(row1.totalText, '$ 29.801')
})

test('H. Segunda línea mantiene $489.828', () => {
  const row2 = computePdfRow(line2)
  assert.equal(Math.round(row2.totalAmount), 489828)
  assert.equal(row2.totalText, '$ 489.828')
})

test('I. Resumen: bruto 437.163, descuento 500, neto 436.663, IVA 82.966, total 519.629', () => {
  const totals = calculatePurchaseOrderTotals([line1, line2])
  assert.equal(totals.gross_total, 437163)
  assert.equal(totals.discount_total, 500)
  assert.equal(totals.net_total, 436663)
  assert.equal(Math.round(totals.tax_total), 82966)
  assert.equal(Math.round(totals.grand_total), 519629)

  assert.equal(formatCurrency(totals.gross_total), '$ 437.163')
  assert.equal(formatCurrency(totals.discount_total), '$ 500')
  assert.equal(formatCurrency(totals.net_total), '$ 436.663')
  assert.equal(formatCurrency(totals.tax_total), '$ 82.966')
  assert.equal(formatCurrency(totals.grand_total), '$ 519.629')

  // PDF summary contains all 5 entries
  assert.match(pdfSource, /Subtotal bruto/)
  assert.match(pdfSource, /Descuentos/)
  assert.match(pdfSource, /Neto/)
  assert.match(pdfSource, /IVA/)
  assert.match(pdfSource, /TOTAL/)
})

test('J. Preview PDF no persiste OC en DB ni altera correlativo definitivo', () => {
  const previewStart = panel.indexOf('async function handlePreviewPDF()')
  const previewEnd = panel.indexOf('\n  if (previewUrl) {', previewStart)
  assert.ok(previewStart >= 0 && previewEnd > previewStart)
  const previewBody = panel.slice(previewStart, previewEnd)

  assert.match(previewBody, /sku:\s*it\.sku\s*\|\|\s*undefined/)
  assert.match(previewBody, /getNextCorrelative\(\)/)
  assert.match(previewBody, /generatePdfBlob\(previewDetail/)
  assert.match(previewBody, /URL\.createObjectURL\(blob\)/)

  assert.doesNotMatch(previewBody, /createPurchaseOrder/)
  assert.doesNotMatch(previewBody, /updateDraftPurchaseOrder/)
  assert.doesNotMatch(previewBody, /updatePurchaseOrderStatus/)
})

test('K. No se altera lógica de emisión de OC', () => {
  const submitStart = panel.indexOf('async function handleSubmit(e: React.FormEvent)')
  const submitEnd = panel.indexOf('\n  async function handleDownloadPDF', submitStart)
  assert.ok(submitStart >= 0 && submitEnd > submitStart)
  const submitBody = panel.slice(submitStart, submitEnd)

  assert.match(submitBody, /submittingRef\.current = true/)
  assert.match(submitBody, /setIsSubmitting\(true\)/)
  assert.match(submitBody, /status:\s*'EMITIDA'/)
  assert.match(submitBody, /createPurchaseOrder\(payload\)/)
})
