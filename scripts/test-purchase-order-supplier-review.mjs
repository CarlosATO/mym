import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(
  new URL('../supabase/migrations/20260930150000_adquisiciones_supplier_review_retain_new_items.sql', import.meta.url),
  'utf8',
)
const action = await readFile(
  new URL('../src/app/actions/adquisiciones/purchase-orders.ts', import.meta.url),
  'utf8',
)

test('supplier review RPC has transactional safety and server-side validation', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION adquisiciones\.update_purchase_order_supplier_review/)
  assert.match(migration, /FROM adquisiciones\.purchase_orders[\s\S]*FOR UPDATE/)
  assert.match(migration, /v_po\.status <> 'ENVIADA_PROVEEDOR'/)
  assert.match(migration, /snapshot_type = 'ORIGINAL_SENT'/)
  assert.match(migration, /quantity_received, 0\) > 0/)
  assert.match(migration, /p_item_type NOT IN|v_item_type NOT IN/)
  assert.match(migration, /v_quantity <= 0/)
  assert.match(migration, /v_unit_price < 0/)
  assert.match(migration, /is_active = true/)
  assert.match(migration, /RETURNING id INTO v_item_id/)
  assert.match(migration, /v_retained_item_ids := array_append\(v_retained_item_ids, v_item_id\)/)
  assert.match(migration, /v_item_id = ANY\(v_retained_item_ids\)/)
  assert.match(migration, /DELETE FROM adquisiciones\.purchase_order_items/)
  assert.match(migration, /AND NOT \(id = ANY\(v_retained_item_ids\)\)/)
  assert.doesNotMatch(migration, /v_seen_item_ids/)
  assert.match(migration, /ROUND\(v_grand_total, 2\)/)
  assert.doesNotMatch(migration, /UPDATE adquisiciones\.purchase_order_snapshots/)
  assert.doesNotMatch(migration, /DELETE FROM adquisiciones\.purchase_order_snapshots/)
})

test('server action authenticates, scopes company, and calls only the review RPC', () => {
  const start = action.indexOf('export async function updateSentPurchaseOrderReview')
  const end = action.indexOf('export async function updatePurchaseOrderStatus', start)
  assert.ok(start >= 0 && end > start)
  const source = action.slice(start, end)
  assert.match(source, /supabase\.auth\.getUser\(\)/)
  assert.match(source, /getActiveCompanyId\(\)/)
  assert.match(source, /update_purchase_order_supplier_review/)
  assert.match(source, /p_user_id: user\.id/)
  assert.match(source, /p_company_id: companyId/)
})
