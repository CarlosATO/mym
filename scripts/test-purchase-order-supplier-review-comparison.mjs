import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(
  new URL('../supabase/migrations/20260930160000_adquisiciones_supplier_review_comparison.sql', import.meta.url),
  'utf8',
)
const action = await readFile(
  new URL('../src/app/actions/adquisiciones/purchase-orders.ts', import.meta.url),
  'utf8',
)

test('comparison RPC is read-only, secured, and uses ORIGINAL_SENT', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION adquisiciones\.get_purchase_order_supplier_review_comparison/)
  assert.match(migration, /SECURITY DEFINER/)
  assert.match(migration, /core\.has_company_access\(p_user_id, p_company_id\)/)
  assert.match(migration, /adquisiciones\.po\.view/)
  assert.match(migration, /snapshot_type = 'ORIGINAL_SENT'/)
  assert.match(migration, /v_snapshot\.items_snapshot/)
  assert.match(migration, /pr\.id = i\.product_id[\s\S]*pr\.company_id = p_company_id/)
  assert.match(migration, /CASE WHEN i\.item_type = 'SERVICE' THEN NULL ELSE pr\.sku END/)
  assert.doesNotMatch(migration, /INSERT INTO adquisiciones\.(purchase_orders|purchase_order_items|purchase_order_snapshots)/)
  assert.doesNotMatch(migration, /UPDATE adquisiciones\.(purchase_orders|purchase_order_items|purchase_order_snapshots)/)
  assert.doesNotMatch(migration, /DELETE FROM adquisiciones\.(purchase_orders|purchase_order_items|purchase_order_snapshots)/)
})

test('comparison RPC models all statuses and detailed changes', () => {
  assert.match(migration, /'SIN_CAMBIOS'/)
  assert.match(migration, /'MODIFICADA'/)
  assert.match(migration, /'ELIMINADA'/)
  assert.match(migration, /'AGREGADA'/)
  assert.match(migration, /'changed_fields', v_changed_fields/)
  assert.match(migration, /'field', v_field/)
  assert.match(migration, /v_item_id = ANY\(v_original_ids\)/)
  assert.match(migration, /'total_difference', v_current_grand_total - v_original_grand_total/)
  assert.match(migration, /'line_number'\)::integer, 2147483647/)
})

test('server action authenticates, scopes company, and calls the comparison RPC', () => {
  const start = action.indexOf('export async function getPurchaseOrderSupplierReviewComparison')
  const end = action.indexOf('export async function updatePurchaseOrderStatus', start)
  assert.ok(start >= 0 && end > start)
  const source = action.slice(start, end)
  assert.match(source, /supabase\.auth\.getUser\(\)/)
  assert.match(source, /getActiveCompanyId\(\)/)
  assert.match(source, /get_purchase_order_supplier_review_comparison/)
  assert.match(source, /p_user_id: user\.id/)
  assert.match(source, /p_company_id: companyId/)
})
