import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  calculateCommercialSliceEconomics,
  calculateReceiptEconomics,
  calculateWorksheetLinePreview,
  commercialReceiptAmount,
  findWorksheetOverflowItems,
  formatCommercialPrice,
  formatReceiptMoney,
  isCommercialPurchaseOrder,
  projectPurchaseOrderReceiptData,
  roundCurrencyCents,
} from '../src/lib/logistica/receipt-economics.ts'

const root = new URL('..', import.meta.url)
const worksheetSource = await readFile(new URL('src/modules/logistica/recepciones/receipt-worksheet.tsx', root), 'utf8')
const panelSource = await readFile(new URL('src/modules/logistica/recepciones/recepciones-panel.tsx', root), 'utf8')
const actionsSource = await readFile(new URL('src/app/actions/logistica/recepciones.ts', root), 'utf8')
const poPanelSource = await readFile(new URL('src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx', root), 'utf8')
const poReviewSource = await readFile(new URL('src/modules/adquisiciones/ordenes-compra/purchase-order-supplier-review.tsx', root), 'utf8')
const poActionsSource = await readFile(new URL('src/app/actions/adquisiciones/purchase-orders.ts', root), 'utf8')

function buildReferenceCommercialFixture() {
  const po = {
    id: 'po-comm-ref',
    correlative: 'OC-SIM-000091',
    commercial_draft_revision: 14,
    status: 'CONFIRMADA',
    receipt_status: 'PENDIENTE',
    net_total: 1781735,
    discount_total: 108885,
    tax_total: 338529.65,
    exempt_total: 0,
    grand_total: 2120264.65,
  }

  // Raw items intentionally carry mutated/live unit_price on line 1 to prove historical CONFIRMED snapshot wins
  const rawItems = [
    { id: 'line-1', item_type: 'PRODUCT', sku: '513135', product_description: 'Producto 513135', quantity: 900, quantity_received: 0, unit_price: 999999, commercial_unit_price_snapshot: 999999, purchase_unit_snapshot: 'DISPLAY', purchase_unit_factor_snapshot: 6, discount_percent: 0, discount_amount: 90000, tax_rate: 19 },
    { id: 'line-2', item_type: 'PRODUCT', sku: '513136', product_description: 'Producto 2', quantity: 120, quantity_received: 0, unit_price: 1249.1667, commercial_unit_price_snapshot: 14990, purchase_unit_snapshot: 'CAJA', purchase_unit_factor_snapshot: 12, discount_percent: 5, discount_amount: 7495, tax_rate: 19 },
    { id: 'line-3', item_type: 'PRODUCT', sku: '513137', product_description: 'Producto 3', quantity: 48, quantity_received: 0, unit_price: 2343.75, commercial_unit_price_snapshot: 18750, purchase_unit_snapshot: 'PACK', purchase_unit_factor_snapshot: 8, discount_percent: 5, discount_amount: 5625, tax_rate: 19 },
    { id: 'line-4', item_type: 'PRODUCT', sku: '513138', product_description: 'Producto 4', quantity: 90, quantity_received: 0, unit_price: 1221.6667, commercial_unit_price_snapshot: 7330, purchase_unit_snapshot: 'DISPLAY', purchase_unit_factor_snapshot: 6, discount_percent: 3, discount_amount: 3298.5, tax_rate: 19 },
    { id: 'line-5', item_type: 'PRODUCT', sku: '513139', product_description: 'Producto 5', quantity: 36, quantity_received: 0, unit_price: 1903.3333, commercial_unit_price_snapshot: 11420, purchase_unit_snapshot: 'DISPLAY', purchase_unit_factor_snapshot: 6, discount_percent: 2, discount_amount: 1370.4, tax_rate: 19 },
    { id: 'line-6', item_type: 'SERVICE', sku: null, product_description: 'Flete comercial certificado', quantity: 24, quantity_received: 0, unit_price: 1031.25, commercial_unit_price_snapshot: null, purchase_unit_snapshot: null, purchase_unit_factor_snapshot: null, discount_percent: 0, discount_amount: 1096.1, tax_rate: 19 },
  ]

  const confirmedSnapshot = {
    id: 'snap-confirmed-ref',
    items_snapshot: [
      { item_id: 'line-1', quantity: 900, purchase_unit_snapshot: 'DISPLAY', purchase_unit_factor_snapshot: 6, commercial_quantity: 150, commercial_unit_price_snapshot: 9500, unit_price: 1583.3333, commercial_gross_amount_snapshot: 1425000, discount_percent: 0, discount_amount: 90000, tax_rate: 19, tax_amount: 253650, line_total: 1588650 },
      { item_id: 'line-2', quantity: 120, purchase_unit_snapshot: 'CAJA', purchase_unit_factor_snapshot: 12, commercial_quantity: 10, commercial_unit_price_snapshot: 14990, unit_price: 1249.1667, commercial_gross_amount_snapshot: 149900, discount_percent: 5, discount_amount: 7495, tax_rate: 19, tax_amount: 27056.95, line_total: 169461.95 },
      { item_id: 'line-3', quantity: 48, purchase_unit_snapshot: 'PACK', purchase_unit_factor_snapshot: 8, commercial_quantity: 6, commercial_unit_price_snapshot: 18750, unit_price: 2343.75, commercial_gross_amount_snapshot: 112500, discount_percent: 5, discount_amount: 5625, tax_rate: 19, tax_amount: 20306.25, line_total: 127181.25 },
      { item_id: 'line-4', quantity: 90, purchase_unit_snapshot: 'DISPLAY', purchase_unit_factor_snapshot: 6, commercial_quantity: 15, commercial_unit_price_snapshot: 7330, unit_price: 1221.6667, commercial_gross_amount_snapshot: 109950, discount_percent: 3, discount_amount: 3298.5, tax_rate: 19, tax_amount: 20263.79, line_total: 126915.29 },
      { item_id: 'line-5', quantity: 36, purchase_unit_snapshot: 'DISPLAY', purchase_unit_factor_snapshot: 6, commercial_quantity: 6, commercial_unit_price_snapshot: 11420, unit_price: 1903.3333, commercial_gross_amount_snapshot: 68520, discount_percent: 2, discount_amount: 1370.4, tax_rate: 19, tax_amount: 12758.42, line_total: 79908.02 },
      { item_id: 'line-6', quantity: 24, purchase_unit_snapshot: null, purchase_unit_factor_snapshot: null, commercial_quantity: null, commercial_unit_price_snapshot: null, unit_price: 1031.25, commercial_gross_amount_snapshot: 24750, discount_percent: 0, discount_amount: 1096.1, tax_rate: 19, tax_amount: 4494.24, line_total: 28148.14 },
    ],
  }

  return { po, rawItems, confirmedSnapshot }
}

test('1. recepción comercial completa e identificación comercial vs tradicional usan el snapshot CONFIRMED exacto', () => {
  const { po, rawItems, confirmedSnapshot } = buildReferenceCommercialFixture()
  assert.equal(isCommercialPurchaseOrder(po, rawItems), true)
  assert.equal(isCommercialPurchaseOrder({ commercial_draft_revision: 0 }, [{ purchase_unit_factor_snapshot: null }]), false)

  const projected = projectPurchaseOrderReceiptData({
    po,
    items: rawItems,
    confirmedSnapshot,
    accountedByItem: new Map(),
    canViewEconomics: true,
    canViewReceiptAmounts: true,
  })

  assert.equal(projected.po.is_commercial, true)
  assert.equal(projected.po.confirmed_snapshot_available, true)

  // Historical CONFIRMED commercial unit price (9500) wins over mutated raw item value (999999)
  const line1 = projected.items[0]
  assert.equal(line1.purchase_unit_snapshot, 'DISPLAY')
  assert.equal(line1.purchase_unit_factor_snapshot, 6)
  assert.equal(line1.commercial_quantity, 150)
  assert.equal(line1.commercial_unit_price_snapshot, 9500)

  let sumGrossBefore = 0
  let sumDiscount = 0
  let sumNet = 0
  let sumTax = 0
  let sumTotal = 0

  for (const item of projected.items) {
    const preview = calculateWorksheetLinePreview(
      item,
      [{ id: 's1', condition: 'CONFORME', quantity: item.quantity }],
      true,
    )
    sumGrossBefore = roundCurrencyCents(sumGrossBefore + preview.grossBeforeDiscount)
    sumDiscount = roundCurrencyCents(sumDiscount + preview.discountAmount)
    sumNet = roundCurrencyCents(sumNet + preview.netAmount)
    sumTax = roundCurrencyCents(sumTax + preview.taxAmount)
    sumTotal = roundCurrencyCents(sumTotal + preview.grossAmount)
  }

  assert.equal(sumGrossBefore, 1890620)
  assert.equal(sumDiscount, 108885)
  assert.equal(sumNet, 1781735)
  assert.equal(sumTax, 338529.65)
  assert.equal(sumTotal, 2120264.65)
  assert.equal(formatReceiptMoney(sumTotal, { alwaysShowCents: true }), '$2.120.264,65')
  assert.equal(formatCommercialPrice(9500), '$9.500')
  assert.equal(formatCommercialPrice(9500.25), '$9.500,25')
})

test('2. recepciones parciales sucesivas, cantidades no múltiplos del factor, servicios y partidas múltiples coinciden al centavo con el backend', () => {
  const { po, rawItems, confirmedSnapshot } = buildReferenceCommercialFixture()

  // Simulate 3 successive receptions across all 6 lines (5 products + 1 service), using non-multiples of commercial factor
  // Wave 2 includes MULTIPLE SPLITS on the same line (CONFORME + RECHAZADO + DANADO + FALTANTE)
  const waves = [
    // Wave 1: non-multiples
    [
      [{ id: 'w1-1', condition: 'CONFORME', quantity: 1 }],
      [{ id: 'w1-2', condition: 'CONFORME', quantity: 7 }],
      [{ id: 'w1-3', condition: 'CONFORME', quantity: 3 }],
      [{ id: 'w1-4', condition: 'CONFORME', quantity: 11 }],
      [{ id: 'w1-5', condition: 'CONFORME', quantity: 5 }],
      [{ id: 'w1-6', condition: 'CONFORME', quantity: 5 }],
    ],
    // Wave 2: multiple splits on each line including DANADO, RECHAZADO and FALTANTE
    [
      [
        { id: 'w2-1a', condition: 'CONFORME', quantity: 130 },
        { id: 'w2-1b', condition: 'RECHAZADO', quantity: 4 },
        { id: 'w2-1c', condition: 'DANADO', quantity: 7 },
        { id: 'w2-1d', condition: 'FALTANTE', quantity: 2 },
      ],
      [
        { id: 'w2-2a', condition: 'CONFORME', quantity: 29 },
        { id: 'w2-2b', condition: 'DANADO', quantity: 14 },
      ],
      [{ id: 'w2-3a', condition: 'CONFORME', quantity: 19 }],
      [{ id: 'w2-4a', condition: 'CONFORME', quantity: 31 }],
      [{ id: 'w2-5a', condition: 'DANADO', quantity: 13 }],
      [{ id: 'w2-6a', condition: 'CONFORME', quantity: 7 }],
    ],
    // Wave 3: remaining internal balance to complete 100% of every line
    [
      [{ id: 'w3-1', condition: 'CONFORME', quantity: 900 - 1 - 137 }],
      [{ id: 'w3-2', condition: 'CONFORME', quantity: 120 - 7 - 43 }],
      [{ id: 'w3-3', condition: 'CONFORME', quantity: 48 - 3 - 19 }],
      [{ id: 'w3-4', condition: 'CONFORME', quantity: 90 - 11 - 31 }],
      [{ id: 'w3-5', condition: 'CONFORME', quantity: 36 - 5 - 13 }],
      [{ id: 'w3-6', condition: 'CONFORME', quantity: 24 - 5 - 7 }],
    ],
  ]

  const accountedByItem = new Map()
  let accumulatedGrossBefore = 0
  let accumulatedDiscount = 0
  let accumulatedNet = 0
  let accumulatedTax = 0
  let accumulatedTotal = 0

  for (const wave of waves) {
    const projected = projectPurchaseOrderReceiptData({
      po,
      items: rawItems,
      confirmedSnapshot,
      accountedByItem,
      canViewEconomics: true,
      canViewReceiptAmounts: true,
    })

    let waveNet = 0
    let waveTax = 0
    let waveTotal = 0

    projected.items.forEach((item, idx) => {
      const splits = wave[idx]
      const preview = calculateWorksheetLinePreview(item, splits, true)

      // Verify split-level coherence: sum of split slices equals line preview exactly
      const splitsNetSum = roundCurrencyCents(preview.splitSlices.reduce((acc, s) => acc + s.netAmount, 0))
      const splitsDiscSum = roundCurrencyCents(preview.splitSlices.reduce((acc, s) => acc + s.discountAmount, 0))
      const splitsTaxSum = roundCurrencyCents(preview.splitSlices.reduce((acc, s) => acc + s.taxAmount, 0))
      const splitsGrossSum = roundCurrencyCents(preview.splitSlices.reduce((acc, s) => acc + s.grossAmount, 0))
      assert.equal(splitsNetSum, preview.netAmount)
      assert.equal(splitsDiscSum, preview.discountAmount)
      assert.equal(splitsTaxSum, preview.taxAmount)
      assert.equal(splitsGrossSum, preview.grossAmount)

      // Verify RECHAZADO and FALTANTE splits have 0 economic impact
      for (const slice of preview.splitSlices) {
        if (slice.condition === 'RECHAZADO' || slice.condition === 'FALTANTE') {
          assert.equal(slice.netAmount, 0)
          assert.equal(slice.grossAmount, 0)
          assert.equal(slice.cumulativeAfter, slice.cumulativeBefore)
        }
      }

      waveNet = roundCurrencyCents(waveNet + preview.netAmount)
      waveTax = roundCurrencyCents(waveTax + preview.taxAmount)
      waveTotal = roundCurrencyCents(waveTotal + preview.grossAmount)

      accumulatedGrossBefore = roundCurrencyCents(accumulatedGrossBefore + preview.grossBeforeDiscount)
      accumulatedDiscount = roundCurrencyCents(accumulatedDiscount + preview.discountAmount)
      accumulatedNet = roundCurrencyCents(accumulatedNet + preview.netAmount)
      accumulatedTax = roundCurrencyCents(accumulatedTax + preview.taxAmount)
      accumulatedTotal = roundCurrencyCents(accumulatedTotal + preview.grossAmount)

      accountedByItem.set(item.id, (accountedByItem.get(item.id) ?? 0) + preview.acceptedQuantity)
    })

    assert.equal(waveTotal, roundCurrencyCents(waveNet + waveTax))
  }

  assert.equal(accumulatedGrossBefore, 1890620)
  assert.equal(accumulatedDiscount, 108885)
  assert.equal(accumulatedNet, 1781735)
  assert.equal(accumulatedTax, 338529.65)
  assert.equal(accumulatedTotal, 2120264.65)
})

test('3. descuentos, redondeos extremos, costo cero acumulado y compatibilidad con órdenes tradicionales', () => {
  // 0.01 across 3 units telescopes as 0.00 + 0.01 + 0.00 = 0.01
  assert.equal(commercialReceiptAmount(0.01, 0, 1, 3), 0)
  assert.equal(commercialReceiptAmount(0.01, 1, 2, 3), 0.01)
  assert.equal(commercialReceiptAmount(0.01, 2, 3, 3), 0)

  // Exact half-away-from-zero rational boundary (1.005 -> 1.01, matching PostgreSQL numeric round)
  assert.equal(commercialReceiptAmount(2.01, 0, 1, 2), 1.01)
  assert.equal(commercialReceiptAmount(2.01, 1, 2, 2), 1.00)

  // Commercial slice with discount rounding (gross 1.00, discount 0.33, net 0.67, tax 0.13, total 0.80 over 6 units)
  const confirmed = { snapshotId: 's', quantity: 6, commercialGrossAmount: 1, discountAmount: 0.33, taxAmount: 0.13, lineTotal: 0.80 }
  const s1 = calculateCommercialSliceEconomics(confirmed, 0, 1)
  const s2 = calculateCommercialSliceEconomics(confirmed, 1, 5)
  assert.equal(roundCurrencyCents(s1.netAmount + s2.netAmount), 0.67)
  assert.equal(roundCurrencyCents(s1.discountAmount + s2.discountAmount), 0.33)
  assert.equal(roundCurrencyCents(s1.taxAmount + s2.taxAmount), 0.13)
  assert.equal(roundCurrencyCents(s1.grossAmount + s2.grossAmount), 0.80)

  // Traditional PO compatibility: retains legacy formula without requiring snapshot
  const tradPo = { id: 'po-trad', commercial_draft_revision: 0, status: 'CONFIRMADA' }
  const tradItems = [{ id: 't1', item_type: 'PRODUCT', quantity: 10, quantity_received: 2, unit_price: 1000, discount_percent: 10, discount_unit_amount: 0, discount_amount: 1000, tax_rate: 19 }]
  const tradProjected = projectPurchaseOrderReceiptData({
    po: tradPo,
    items: tradItems,
    confirmedSnapshot: null,
    accountedByItem: new Map([['t1', 2]]),
    canViewEconomics: true,
    canViewReceiptAmounts: true,
  })
  assert.equal(tradProjected.po.is_commercial, false)
  assert.equal(tradProjected.items[0].purchase_unit_factor_snapshot, null)

  const tradPreview = calculateWorksheetLinePreview(
    tradProjected.items[0],
    [{ id: 'ts1', condition: 'CONFORME', quantity: 5 }],
    false,
  )
  const expectedLegacy = calculateReceiptEconomics({ quantity: 10, unitPrice: 1000, discountPercent: 10, discountAmount: 1000, taxRate: 19 }, 5)
  assert.equal(tradPreview.netAmount, expectedLegacy.netAmount)
  assert.equal(tradPreview.taxAmount, expectedLegacy.taxAmount)
  assert.equal(tradPreview.grossAmount, expectedLegacy.grossAmount)
})

test('4. permisos económicos estrictos: Bodega sin permisos económicos no recibe ningún campo económico del servidor ni en la UI', () => {
  const { po, rawItems, confirmedSnapshot } = buildReferenceCommercialFixture()

  // Tier 1: Pure Bodega (canViewEconomics = false, canViewReceiptAmounts = false)
  const bodegaOnly = projectPurchaseOrderReceiptData({
    po,
    items: rawItems,
    confirmedSnapshot,
    accountedByItem: new Map([['line-1', 12]]),
    canViewEconomics: false,
    canViewReceiptAmounts: false,
  })

  assert.equal(bodegaOnly.po.is_commercial, true)
  assert.equal('grand_total' in bodegaOnly.po, false)
  assert.equal('net_total' in bodegaOnly.po, false)
  assert.equal('discount_total' in bodegaOnly.po, false)
  assert.equal('tax_total' in bodegaOnly.po, false)

  const bodegaLine1 = bodegaOnly.items[0]
  // Operational commercial fields ARE available for physical verification
  assert.equal(bodegaLine1.purchase_unit_snapshot, 'DISPLAY')
  assert.equal(bodegaLine1.purchase_unit_factor_snapshot, 6)
  assert.equal(bodegaLine1.commercial_quantity, 150)
  assert.equal(bodegaLine1.quantity, 900)
  assert.equal(bodegaLine1.accounted_quantity_before, 12)
  assert.equal(bodegaLine1.quantity_pending, 888)

  // Economic fields MUST be completely absent from serialized payload
  for (const forbiddenKey of [
    'unit_price',
    'commercial_unit_price_snapshot',
    'commercial_gross_amount_snapshot',
    'discount_percent',
    'discount_unit_amount',
    'discount_amount',
    'tax_rate',
    'tax_amount',
    'line_total',
    'confirmed_commercial_economics',
  ]) {
    assert.equal(forbiddenKey in bodegaLine1, false, `Campo económico filtrado indebidamente a Bodega: ${forbiddenKey}`)
  }

  // Tier 2: Bodega with receipt summary access (canViewEconomics = false, canViewReceiptAmounts = true)
  const summaryOnly = projectPurchaseOrderReceiptData({
    po,
    items: rawItems,
    confirmedSnapshot,
    accountedByItem: new Map(),
    canViewEconomics: false,
    canViewReceiptAmounts: true,
  })
  assert.equal('grand_total' in summaryOnly.po, false)
  assert.equal('commercial_unit_price_snapshot' in summaryOnly.items[0], false)
  assert.equal('unit_price' in summaryOnly.items[0], false)
  assert.ok(summaryOnly.items[0].confirmed_commercial_economics, 'Summary calculation context must be present for authorized receipt-amount summary')
})

test('5. contratos de interfaz y seguridad de producción antes de aplicar la migración 07D.1', () => {
  // Commercial badges, presentation, factor, confirmed commercial qty, and internal units indicator in worksheet
  assert.match(worksheetSource, /OC Comercial/)
  assert.match(worksheetSource, /Presentación: \{commercialUnitLabel\}/)
  assert.match(worksheetSource, /Factor: \{fmtQuantity\(commercialFactor\)\} un\.\/\{commercialUnitLabel\}/)
  assert.match(worksheetSource, /Confirmado: \{fmtQuantity\(confirmedCommercialQty\)\} \{commercialUnitLabel\}/)
  assert.match(worksheetSource, /Ingreso en un\. internas/)

  // Line-level prices, discounts and amounts strictly gated by canViewEconomics
  assert.doesNotMatch(worksheetSource, /canViewReceiptAmounts && <p[^>]*>\{discountLabel/)
  assert.match(worksheetSource, /const linePreview = canViewEconomics/)

  // Server queries in recepciones.ts MUST NOT select unapplied 20261126130000 columns on purchase_receipt_items / purchase_receipts
  for (const unappliedColumn of [
    'commercial_confirmed_snapshot_id',
    'commercial_confirmed_item',
    'commercial_gross_before_discount',
    'commercial_discount_amount',
    'commercial_qty_before',
    'commercial_qty_after',
    'idempotency_request_fingerprint',
  ]) {
    assert.doesNotMatch(actionsSource, new RegExp(unappliedColumn), `recepciones.ts no debe consultar columna aún no migrada: ${unappliedColumn}`)
  }

  // Detail panel preserves historical receipt_total_gross and displays commercial presentation & price
  assert.match(panelSource, /rec\.receipt_total_gross/)
  assert.match(panelSource, /formatCommercialPrice/)
})

test('6. ajustes finales 07D.3: aviso de disponibilidad condicional, encabezado P. Comercial y bloqueo/invalidez por exceso de pendiente', () => {
  // Ajuste 1: el mensaje de no disponibilidad solo se muestra si commercial_receipt_enabled === false
  assert.match(poActionsSource, /async function isCommercialReceiptsBackendEnabled\(\): Promise<boolean>/)
  assert.match(poActionsSource, /\.select\('commercial_confirmed_snapshot_id'\)/)
  assert.doesNotMatch(
    poPanelSource,
    /detail\.po\.status === 'CONFIRMADA' && detail\.po\.commercial_managed && <div[^>]*>La recepción de órdenes comerciales aún no está disponible\.<\/div>/,
  )
  assert.match(
    poPanelSource,
    /detail\.po\.status === 'CONFIRMADA' && detail\.po\.commercial_managed && detail\.po\.commercial_receipt_enabled === false && <div[^>]*>La recepción de órdenes comerciales aún no está disponible\.<\/div>/,
  )
  assert.match(
    poReviewSource,
    /commercial && commercialReceiptEnabled === false && ' La recepción comercial aún no está disponible\.'/,
  )

  // Ajuste 2: encabezado P. Comercial para recepciones comerciales, preservando P. Unitario tradicional e identificación de servicios
  assert.match(worksheetSource, /\{isCommercialOrder \? 'P\. Comercial' : 'P\. Unitario'\}/)
  assert.match(worksheetSource, /unitario \(servicio\)/)
  assert.match(worksheetSource, /por \{commercialUnitLabel\}/)
  assert.match(worksheetSource, /unitario \(un\. int\.\)/)
  assert.match(panelSource, /detail\?\.po\?\.is_commercial \? 'P\. Comercial' : 'P\.Un\.'/)

  // Ajuste 3: exceso de cantidades aceptadas (CONFORME / DANADO) sobre pendiente deshabilita el registro e invalida el resumen económico
  const sampleItems = [
    { id: 'item-prod', quantity_pending: 10 },
    { id: 'item-serv', quantity_pending: 2 },
  ]
  // Exact pending (6 CONFORME + 4 DANADO = 10) + RECHAZADO 3 does NOT overflow accepted balance
  assert.equal(
    findWorksheetOverflowItems(sampleItems, {
      'item-prod': [
        { id: 's1', condition: 'CONFORME', quantity: 6 },
        { id: 's2', condition: 'DANADO', quantity: 4 },
        { id: 's3', condition: 'RECHAZADO', quantity: 3 },
      ],
      'item-serv': [{ id: 's4', condition: 'CONFORME', quantity: 2 }],
    }).length,
    0,
  )
  // Accepted sum 11 > 10 overflows
  const overflowing = findWorksheetOverflowItems(sampleItems, {
    'item-prod': [
      { id: 's1', condition: 'CONFORME', quantity: 7 },
      { id: 's2', condition: 'DANADO', quantity: 4 },
    ],
    'item-serv': [{ id: 's4', condition: 'CONFORME', quantity: 2 }],
  })
  assert.equal(overflowing.length, 1)
  assert.equal(overflowing[0].id, 'item-prod')

  assert.match(worksheetSource, /disabled=\{saving \|\| confirmedSnapshotMissing \|\| hasPendingOverflow\}/)
  assert.match(worksheetSource, /Resumen económico inválido/)
  assert.match(worksheetSource, /Inválido \(excede pendiente\)/)
})
