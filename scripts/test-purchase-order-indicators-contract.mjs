import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const migration = await readFile(new URL('supabase/migrations/20261028140000_adquisiciones_purchase_order_indicators.sql', root), 'utf8')
const action = await readFile(new URL('src/app/actions/adquisiciones/purchase-orders.ts', root), 'utf8')
const panel = await readFile(new URL('src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx', root), 'utf8')

test('indicators aggregate the PENDING classification and exclude cancelled receipts', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION adquisiciones\.get_purchase_order_indicators\(/)
  assert.match(migration, /po\.status NOT IN \('CERRADA', 'CANCELADA', 'RECHAZADA', 'PAGADA', 'RECEPCION_TOTAL'\)/)
  assert.match(migration, /coalesce\(po\.receipt_status, 'PENDIENTE'\) <> 'RECEPCION_TOTAL'/)
  assert.match(migration, /greatest\(coalesce\(i\.quantity, 0\) - coalesce\(i\.quantity_received, 0\), 0\)/)
  assert.match(migration, /r\.status = 'COMPLETED'/)
  assert.match(migration, /r\.received_at >= now\(\) - interval '30 days'/)
  assert.match(migration, /count\(DISTINCT r\.purchase_order_id\)/)
})

test('indicator action and client cache are company scoped and independently refreshable', () => {
  assert.match(action, /export async function getPurchaseOrderIndicators\(\)/)
  assert.match(action, /get_purchase_order_indicators/)
  assert.match(panel, /const PURCHASE_ORDER_INDICATORS_CACHE_TTL = 30_000/)
  assert.match(panel, /fetchCachedPurchaseOrderIndicators = useCallback/)
  assert.match(panel, /purchaseOrderIndicatorsCacheRef\.current\.clear\(\)/)
  assert.match(panel, /aria-label="Indicadores de órdenes de compra"/)
  assert.match(panel, /indicators\.pending_count/)
  assert.match(panel, /indicators\.received_amount/)
})
