import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  getPurchaseOrderDiscountDisplayValues,
  getPurchaseOrderDiscountPayload,
  resolvePurchaseOrderDiscountMode,
} from '../src/lib/adquisiciones/purchase-order-discounts.ts'

const panel = await readFile(new URL('../src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx', import.meta.url), 'utf8')
const actions = await readFile(new URL('../src/app/actions/adquisiciones/purchase-orders.ts', import.meta.url), 'utf8')

const line = (overrides = {}) => ({
  unit_price: 1000,
  discount_percent: 0,
  discount_unit_amount: 0,
  discount_mode: null,
  ...overrides,
})

test('new and loaded lines resolve the three supported discount modes', () => {
  assert.equal(resolvePurchaseOrderDiscountMode(0, 0), null)
  assert.equal(resolvePurchaseOrderDiscountMode(10, 0), 'percent')
  assert.equal(resolvePurchaseOrderDiscountMode(0, 500), 'unit')
  assert.equal(resolvePurchaseOrderDiscountMode(0, undefined), null)
})

test('percentage mode keeps the percentage and exposes the unit equivalent', () => {
  const values = getPurchaseOrderDiscountDisplayValues(line({ discount_percent: 10, discount_mode: 'percent' }))
  assert.deepEqual(values, { discount_percent: 10, discount_unit_amount: 100 })
  assert.deepEqual(getPurchaseOrderDiscountPayload(line({ discount_percent: 10, discount_mode: 'percent' })), { discount_percent: 10, discount_unit_amount: 0 })
})

test('unit mode keeps the unit amount and recalculates the percentage equivalent', () => {
  const values = getPurchaseOrderDiscountDisplayValues(line({ discount_unit_amount: 100, discount_mode: 'unit' }))
  assert.deepEqual(values, { discount_percent: 10, discount_unit_amount: 100 })
  assert.deepEqual(getPurchaseOrderDiscountPayload(line({ discount_unit_amount: 100, discount_mode: 'unit' })), { discount_percent: 0, discount_unit_amount: 100 })
})

test('price changes recalculate percentage display and clamp unit discounts', () => {
  assert.deepEqual(getPurchaseOrderDiscountDisplayValues(line({ unit_price: 1200, discount_percent: 10, discount_mode: 'percent' })), { discount_percent: 10, discount_unit_amount: 120 })
  assert.deepEqual(getPurchaseOrderDiscountDisplayValues(line({ unit_price: 2000, discount_unit_amount: 100, discount_mode: 'unit' })), { discount_percent: 5, discount_unit_amount: 100 })
  assert.deepEqual(getPurchaseOrderDiscountDisplayValues(line({ unit_price: 80, discount_unit_amount: 100, discount_mode: 'unit' })), { discount_percent: 100, discount_unit_amount: 80 })
})

test('discount payload is mutually exclusive and safe for invalid values', () => {
  assert.deepEqual(getPurchaseOrderDiscountPayload(line({ unit_price: 0, discount_percent: 20, discount_unit_amount: 50, discount_mode: 'unit' })), { discount_percent: 0, discount_unit_amount: 0 })
  assert.deepEqual(getPurchaseOrderDiscountPayload(line({ discount_percent: Number.NaN, discount_mode: 'percent' })), { discount_percent: 0, discount_unit_amount: 0 })
  assert.deepEqual(getPurchaseOrderDiscountPayload(line({ discount_unit_amount: -5, discount_mode: 'unit' })), { discount_percent: 0, discount_unit_amount: 0 })
})

test('creation form exposes optional discounts and all source handoffs', () => {
  assert.match(panel, /\[showDiscountColumns, setShowDiscountColumns\] = useState\(false\)/)
  assert.match(panel, /Agregar descuentos/)
  assert.match(panel, /Ocultar descuentos/)
  assert.match(panel, /discount_mode: resolvePurchaseOrderDiscountMode/)
  assert.match(panel, /source === 'REPLENISHMENT'/)
  assert.match(panel, /source: 'EXCEL'/)
  assert.match(panel, /getPurchaseOrderDiscountPayload\(it\)/)
  assert.match(panel, /showDiscountColumns && \<\>[\s\S]*Dcto %/)
  assert.match(panel, /showDiscountColumns && \<\>[\s\S]*Dcto por unidad/)
  assert.match(panel, /pendingDiscountPercent, setPendingDiscountPercent/)
  assert.match(panel, /pendingDiscountUnitAmount, setPendingDiscountUnitAmount/)
  assert.match(panel, /updatePendingDiscount\('discount_percent'/)
  assert.match(panel, /updatePendingDiscount\('discount_unit_amount'/)
  assert.match(panel, /\.\.\.discountPayload/)
  assert.match(panel, /setPendingDiscountPercent\(0\)[\s\S]*setPendingDiscountUnitAmount\(0\)[\s\S]*setPendingDiscountMode\(null\)/)
  assert.match(panel, /updateDraftPurchaseOrder\(editId, payload\)/)
})

test('create and draft update actions persist both discount fields without discount_amount authority', () => {
  assert.match(actions, /discount_unit_amount: i\.discount_unit_amount \?\? 0/)
  assert.match(actions, /export async function updateDraftPurchaseOrder/)
  assert.match(actions, /discount_amount: discountAmount/)
  assert.match(actions, /calculatePurchaseOrderTotals\(data\.items\.map/)
  const createStart = actions.indexOf('export async function createPurchaseOrder')
  const updateStart = actions.indexOf('export async function updateDraftPurchaseOrder')
  assert.ok(createStart >= 0 && updateStart > createStart)
  assert.doesNotMatch(actions.slice(createStart, updateStart), /discount_amount\s*:/)
})
