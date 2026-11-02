import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const action = await readFile(new URL('src/app/actions/adquisiciones/purchase-orders.ts', root), 'utf8')

test('the pending-receipt report is a server-side authorized action', () => {
  assert.match(action, /export async function getPendingPurchaseOrdersReport\(\)/)
  assert.match(action, /authorizePurchaseOrderRead\(\)/)
  assert.match(action, /adquisiciones\.po\.view/)
  assert.match(action, /getActiveCompanyId\(user\)/)
  assert.match(action, /eq\('company_id', authorization\.companyId\)/)
})

test('the report uses the authoritative pending balance and excludes non-issued orders', () => {
  const start = action.indexOf('export async function getPendingPurchaseOrdersReport')
  const end = action.indexOf('export interface AuthorizedPersonnel', start)
  const report = action.slice(start, end)
  assert.match(action, /quantity_pending/)
  assert.match(action, /quantity_received/)
  assert.match(action, /\.gt\('quantity_pending', 0\)/)
  const statusesStart = action.indexOf('const ISSUED_PURCHASE_ORDER_STATUSES')
  const statusesEnd = action.indexOf('])', statusesStart)
  assert.doesNotMatch(action.slice(statusesStart, statusesEnd), /RECEPCION_PARCIAL/)
  assert.doesNotMatch(report, /purchase_receipt_items/)
  assert.doesNotMatch(report, /unit_price|grand_total|tax_total|discount_total/)
})

test('the report reads all pages and has stable provider-order-line ordering', () => {
  assert.match(action, /const pageSize = 1000/)
  assert.match(action, /from \+= pageSize/)
  assert.match(action, /supplier_name\.localeCompare/)
  assert.match(action, /correlative\.localeCompare\([^\n]*numeric: true/)
  assert.match(action, /left\.line_number - right\.line_number/)
  assert.match(action, /purchase_order_item_id\.localeCompare/)
})

test('the response contains only report identifiers, product data and quantities', () => {
  assert.match(action, /purchase_order_id: order\.id/)
  assert.match(action, /purchase_order_item_id: item\.id/)
  assert.match(action, /quantity_ordered: Number\(item\.quantity\)/)
  assert.match(action, /quantity_received: Number\(item\.quantity_received/)
  assert.match(action, /quantity_pending: quantityPending/)
  assert.match(action, /total_orders: new Set\(data\.map\(line => line\.purchase_order_id\)\)\.size/)
})
