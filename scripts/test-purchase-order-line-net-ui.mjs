import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { calculatePurchaseOrderLineTotals } from '../src/lib/adquisiciones/purchase-order-totals.ts'

const panel = await readFile(new URL('../src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx', import.meta.url), 'utf8')

test('1. preparador con descuentos: orden IVA -> NETO -> Agregar producto', () => {
  // Find pendingProduct block
  const pendingBlockMatch = panel.match(/\{pendingProduct && \(\(\) => \{([\s\S]*?)\}\)\(\)\}/)
  assert.ok(pendingBlockMatch, 'pendingProduct IIFE block must exist')
  const pendingBlock = pendingBlockMatch[1]

  const ivaIndex = pendingBlock.indexOf('IVA')
  const netoIndex = pendingBlock.indexOf('Neto')
  const buttonIndex = pendingBlock.indexOf('Agregar producto')

  assert.ok(ivaIndex > 0, 'IVA must be present in pending block')
  assert.ok(netoIndex > ivaIndex, 'Neto must appear after IVA in pending block')
  assert.ok(buttonIndex > netoIndex, 'Agregar producto must appear after Neto in pending block')
})

test('2. preparador sin descuentos: orden IVA -> NETO -> Agregar producto y grilla de 6 columnas', () => {
  // Grid definition without discounts has 6 explicit tracks
  assert.match(
    panel,
    /sm:grid-cols-\[minmax\(0,1\.5fr\)_minmax\(95px,\.65fr\)_minmax\(120px,\.8fr\)_minmax\(64px,\.45fr\)_minmax\(104px,\.7fr\)_auto\]/,
    'Grid without discounts must define 6 explicit tracks: Producto, Cantidad, P.Unit, IVA, Neto, Agregar'
  )
})

test('preparador con descuentos tiene grilla de 8 columnas explícitas', () => {
  assert.match(
    panel,
    /sm:grid-cols-\[minmax\(0,1\.25fr\)_minmax\(82px,\.55fr\)_minmax\(108px,\.7fr\)_minmax\(82px,\.55fr\)_minmax\(108px,\.7fr\)_minmax\(60px,\.45fr\)_minmax\(96px,\.65fr\)_auto\]/,
    'Grid with discounts must define 8 explicit tracks: Producto, Cantidad, P.Unit, Dcto%, Dcto/U, IVA, Neto, Agregar'
  )
})

test('3. NETO pendiente usa helper canónico calculatePurchaseOrderLineTotals', () => {
  assert.match(
    panel,
    /const pendingLineTotals = calculatePurchaseOrderLineTotals\(\{[\s\S]*?quantity: Number\(pendingQuantity\)/,
    'pending product must compute totals using calculatePurchaseOrderLineTotals'
  )
  assert.match(
    panel,
    /pendingLineTotals\.net_amount\.toLocaleString\('es-CL'/,
    'pending product Neto display must use pendingLineTotals.net_amount'
  )
})

test('4. cambio de porcentaje actualiza Neto canónicamente', () => {
  const line10Pct = calculatePurchaseOrderLineTotals({
    quantity: 2,
    unit_price: 10000,
    discount_percent: 10,
    tax_rate: 19,
  })
  assert.equal(line10Pct.gross_amount, 20000)
  assert.equal(line10Pct.discount_amount, 2000)
  assert.equal(line10Pct.net_amount, 18000)

  const line20Pct = calculatePurchaseOrderLineTotals({
    quantity: 2,
    unit_price: 10000,
    discount_percent: 20,
    tax_rate: 19,
  })
  assert.equal(line20Pct.gross_amount, 20000)
  assert.equal(line20Pct.discount_amount, 4000)
  assert.equal(line20Pct.net_amount, 16000)
})

test('5. cambio de descuento unitario actualiza Neto canónicamente', () => {
  const base = {
    quantity: 2,
    unit_price: 10000,
    discount_percent: 0,
    discount_unit_amount: 1500,
    tax_rate: 19,
  }
  const totals1 = calculatePurchaseOrderLineTotals(base)
  assert.equal(totals1.gross_amount, 20000)
  assert.equal(totals1.discount_amount, 3000)
  assert.equal(totals1.net_amount, 17000)

  const totals2 = calculatePurchaseOrderLineTotals({
    ...base,
    discount_unit_amount: 2000,
  })
  assert.equal(totals2.discount_amount, 4000)
  assert.equal(totals2.net_amount, 16000)
})

test('6. cambio de cantidad actualiza Neto canónicamente', () => {
  const unitCost = 18882
  const discUnit = 2000
  const lineQty1 = calculatePurchaseOrderLineTotals({
    quantity: 1,
    unit_price: unitCost,
    discount_percent: 0,
    discount_unit_amount: discUnit,
    tax_rate: 19,
  })
  assert.equal(lineQty1.net_amount, 16882)

  const lineQty3 = calculatePurchaseOrderLineTotals({
    quantity: 3,
    unit_price: unitCost,
    discount_percent: 0,
    discount_unit_amount: discUnit,
    tax_rate: 19,
  })
  assert.equal(lineQty3.gross_amount, 56646)
  assert.equal(lineQty3.discount_amount, 6000)
  assert.equal(lineQty3.net_amount, 50646)
})

test('7. cambio de precio actualiza Neto canónicamente', () => {
  const linePrice10k = calculatePurchaseOrderLineTotals({
    quantity: 1,
    unit_price: 10000,
    discount_percent: 10,
    tax_rate: 19,
  })
  assert.equal(linePrice10k.net_amount, 9000)

  const linePrice15k = calculatePurchaseOrderLineTotals({
    quantity: 1,
    unit_price: 15000,
    discount_percent: 10,
    tax_rate: 19,
  })
  assert.equal(linePrice15k.net_amount, 13500)
})

test('8. tabla muestra NETO antes de TOTAL en colgroup, thead y tbody', () => {
  // colgroup: two w-28 columns before w-12 Acción
  assert.match(
    panel,
    /<col className="w-16" \/>\s*<col className="w-28" \/>\s*<col className="w-28" \/>\s*<col className="w-12" \/>/,
    'colgroup must have two w-28 columns (Neto and Total) before w-12 (Acción)'
  )

  // thead: Neto before Total
  assert.match(
    panel,
    /<th[^>]*>IVA %<\/th>\s*<th[^>]*>Neto<\/th>\s*<th[^>]*>Total<\/th>\s*<th[^>]*>Acción<\/th>/,
    'thead must render Neto before Total and after IVA %'
  )

  // tbody: renders net_amount td then line_total td
  assert.match(
    panel,
    /lineTotals\.net_amount\.toLocaleString[\s\S]*?<\/td>\s*<td[^>]*>[\s\S]*?lineTotals\.line_total\.toLocaleString/,
    'tbody must render net_amount td before line_total td'
  )

  // colSpan: 9 when showDiscountColumns, 7 when false
  assert.match(
    panel,
    /colSpan=\{showDiscountColumns \? 9 : 7\}/,
    'empty table row must span 9 or 7 columns'
  )
})

test('9. TOTAL mantiene semántica: neto + IVA', () => {
  const line = calculatePurchaseOrderLineTotals({
    quantity: 1,
    unit_price: 18882,
    discount_percent: 0,
    discount_unit_amount: 2000,
    tax_rate: 19,
  })
  assert.equal(line.gross_amount, 18882)
  assert.equal(line.discount_amount, 2000)
  assert.equal(line.net_amount, 16882)
  assert.equal(line.tax_amount, 3207.58)
  assert.equal(line.line_total, 16882 + 3207.58)
})

test('10. botón Agregar producto continúa visible en el mismo bloque operativo', () => {
  assert.match(
    panel,
    /<button type="button" onClick=\{addProductToItems\} className="h-8 whitespace-nowrap rounded-md border border-\[#72383D\]\/40 bg-\[#EFE9E1\] px-2\.5 text-\[11px\] font-bold text-\[#72383D\] hover:bg-\[#F5EDEE\]">Agregar producto<\/button>/,
    'Agregar producto button is intact inside pendingProduct block'
  )
})
