import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const panel = await readFile(new URL('src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx', root), 'utf8')

test('the purchase-order shell renders a table skeleton instead of a blocking loading message', () => {
  assert.match(panel, /function PurchaseOrderTableSkeleton\(/)
  assert.match(panel, /aria-label="Cargando órdenes de compra"/)
  assert.match(panel, /Array\.from\(\{ length: 8 \}/)
  assert.match(panel, /initialLoading && data\.length === 0 \?/)
  assert.doesNotMatch(panel, /initialLoading \? \(\s*<div className="p-10 text-center"/)
})

test('initial data waits for the authenticated user and active company, while secondary work follows the list', () => {
  assert.match(panel, /if \(!currentUserId \|\| !activeCompany\?\.id\) return\n\s+void load\(\)/)
  assert.match(panel, /if \(!activeCompany\?\.id \|\| initialLoading\) return/)
  assert.match(panel, /loadVisiblePurchaseOrderInvoices\(res\.data, requestId\)/)
  assert.match(panel, /}, 1000\)/)
})
