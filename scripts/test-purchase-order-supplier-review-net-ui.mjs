import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { calculatePurchaseOrderLineTotals } from '../src/lib/adquisiciones/purchase-order-totals.ts'

const root = new URL('..', import.meta.url)
const review = await readFile(new URL('src/modules/adquisiciones/ordenes-compra/purchase-order-supplier-review.tsx', root), 'utf8')

test('A. Neto existe siempre, también con showDiscountColumns = false', () => {
  assert.match(review, /<th[^>]*>Neto<\/th>/, 'thead must always render a Neto header')
  // El bloque condicional de descuentos cierra antes de IVA; IVA/Neto/Total son incondicionales.
  assert.match(
    review,
    /Dcto\/U Neto<\/th>\s*<\/>\s*\)\}\s*<th[^>]*>IVA %<\/th>\s*<th[^>]*>Neto<\/th>\s*<th[^>]*>Total<\/th>\s*<th[^>]*>Acción<\/th>/,
    'Neto must be rendered outside the showDiscountColumns conditional',
  )
})

test('B. Neto existe con showDiscountColumns = true (Dcto % y Dcto/U Neto presentes)', () => {
  assert.match(review, /<th[^>]*>Dcto %<\/th>\s*<th[^>]*>Dcto\/U Neto<\/th>/)
  assert.match(review, /<th[^>]*>Neto<\/th>\s*<th[^>]*>Total<\/th>\s*<th[^>]*>Acción<\/th>/)
})

test('C. sin descuentos: orden IVA % -> Neto -> Total -> Acción', () => {
  assert.match(
    review,
    /<th[^>]*>IVA %<\/th>\s*<th[^>]*>Neto<\/th>\s*<th[^>]*>Total<\/th>\s*<th[^>]*>Acción<\/th>/,
  )
})

test('D. con descuentos: orden Dcto % -> Dcto/U Neto -> IVA % -> Neto -> Total', () => {
  assert.match(
    review,
    /<th[^>]*>Dcto %<\/th>\s*<th[^>]*>Dcto\/U Neto<\/th>[\s\S]*?<th[^>]*>IVA %<\/th>\s*<th[^>]*>Neto<\/th>\s*<th[^>]*>Total<\/th>/,
  )
})

test('E. caso PW39005 sin descuento: neto 8922 y total 10617', () => {
  const pw39005 = calculatePurchaseOrderLineTotals({
    quantity: 6,
    unit_price: 1487,
    discount_percent: 0,
    discount_unit_amount: 0,
    tax_rate: 19,
  })
  assert.equal(pw39005.gross_amount, 8922)
  assert.equal(pw39005.discount_amount, 0)
  assert.equal(pw39005.net_amount, 8922)
  assert.equal(pw39005.tax_amount, 1695.18)
  assert.equal(pw39005.line_total, 10617.18)
  assert.equal(Math.round(pw39005.line_total), 10617)
})

test('F. caso C2462 con descuento: neto 27420 y total 32630', () => {
  const c2462 = calculatePurchaseOrderLineTotals({
    quantity: 2,
    unit_price: 22850,
    discount_percent: 40,
    discount_unit_amount: 9140,
    tax_rate: 19,
  })
  assert.equal(c2462.gross_amount, 45700)
  assert.equal(c2462.discount_amount, 18280)
  assert.equal(c2462.net_amount, 27420)
  assert.equal(c2462.tax_amount, 5209.8)
  assert.equal(c2462.line_total, 32629.8)
  assert.equal(Math.round(c2462.line_total), 32630)
})

test('G. Agregar/Ocultar descuentos sólo afecta las columnas Dcto % y Dcto/U Neto', () => {
  // El bloque condicional del thead contiene exactamente los dos encabezados de descuento.
  assert.match(
    review,
    /\{showDiscountColumns && \(\s*<>\s*<th[^>]*>Dcto %<\/th>\s*<th[^>]*>Dcto\/U Neto<\/th>\s*<\/>\s*\)\}/,
    'thead discount conditional must only wrap Dcto % and Dcto/U Neto',
  )
  // El bloque condicional del tbody sólo envuelve los dos inputs de descuento.
  assert.match(
    review,
    /\{showDiscountColumns && \(\s*<>\s*<td className="px-3 py-2">\s*<input aria-label=\{`Dcto % \$\{line\.product_description\}`\}[\s\S]*?<input aria-label=\{`Dcto\/U Neto \$\{line\.product_description\}`\}[\s\S]*?<\/>\s*\)\}/,
    'tbody discount conditional must only wrap the Dcto % and Dcto/U Neto inputs',
  )
  // Neto y Total se calculan una sola vez por fila y se renderizan incondicionalmente.
  assert.match(review, /const lineTotals = calculatePurchaseOrderLineTotals\(line\)/)
  assert.equal((review.match(/calculatePurchaseOrderLineTotals\(line\)/g) ?? []).length, 1)
  assert.match(review, /currency\(lineTotals\.net_amount, po\.currency\)/)
  assert.match(review, /currency\(lineTotals\.line_total, po\.currency\)/)
  const unitInput = review.indexOf("'discount_unit_amount', event.target.value")
  const netCell = review.indexOf('lineTotals.net_amount')
  const totalCell = review.indexOf('lineTotals.line_total')
  assert.ok(unitInput >= 0 && netCell > unitInput && totalCell > netCell, 'NETO must render after the discount inputs and before TOTAL')
})

test('H. el buscador y la edición de descuentos siguen funcionando', () => {
  assert.match(review, /placeholder="Buscar por SKU o producto\.\.\."/)
  assert.match(review, /const visibleLines = useMemo\(\(\) => \{[\s\S]*?return lines\.filter/)
  assert.match(review, /\{visibleLines\.map\(\(line\) => \{/)
  assert.match(review, /Mostrando \{visibleLines\.length\} de \{lines\.length\} productos/)
  assert.match(review, /if \(field === 'discount_percent'\)/)
  assert.match(review, /if \(field === 'discount_unit_amount'\)/)
  assert.match(review, /onChange=\{\(event\) => updateLine\(line\.item_id, 'discount_unit_amount', event\.target\.value\)\}/)
  assert.match(review, /const preview = useMemo\(\(\) => calculatePurchaseOrderTotals\(lines\), \[lines\]\)/)
  assert.doesNotMatch(review, /calculatePurchaseOrderTotals\(visibleLines\)/)
})
