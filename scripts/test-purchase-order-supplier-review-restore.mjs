import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const migration = await readFile(new URL('supabase/migrations/20260930220000_adquisiciones_supplier_review_restore_removed_lines.sql', root), 'utf8')
const review = await readFile(new URL('src/modules/adquisiciones/ordenes-compra/purchase-order-supplier-review.tsx', root), 'utf8')

test('restoration uses ORIGINAL_SENT identity and preserves the original UUID', () => {
  assert.match(migration, /snapshot_type = 'ORIGINAL_SENT'/)
  assert.match(migration, /v_original_count <> 1/)
  assert.match(migration, /v_item_type IS DISTINCT FROM v_original_item->>'item_type'/)
  assert.match(migration, /v_product_id IS DISTINCT FROM NULLIF\(v_original_item->>'product_id', ''\)::uuid/)
  assert.match(migration, /ELSIF v_restore THEN[\s\S]*INSERT INTO adquisiciones\.purchase_order_items \([\s\S]*id, company_id, po_id/)
  assert.match(migration, /v_original_item->>'product_description'/)
  assert.match(migration, /v_original_item->>'warehouse_id'/)
  assert.match(migration, /v_original_item->>'cost_center'/)
  assert.doesNotMatch(migration, /UPDATE adquisiciones\.purchase_order_snapshots/)
})

test('restored lines are opt-in in the UI and use the existing review payload', () => {
  assert.match(review, /function restoreLine\(/)
  assert.match(review, /onClick=\{\(\) => restoreLine\(line\.original_item\)\}/)
  assert.match(review, /line\.comparison_status === 'ELIMINADA' && !lines\.some\(item => item\.item_id === line\.item_id\)/)
  assert.match(review, /matchesOriginal\(line, persisted\.original_item\)/)
  assert.match(review, /item_id: line\.item_id\?\.startsWith\('new-'\) \? null : line\.item_id/)
})

test('mixed existing, restored, and new payload retains all three rows', () => {
  const mixedPayload = [
    { item_id: 'existing-item-id', item_type: 'PRODUCT' },
    { item_id: 'restored-original-id', item_type: 'PRODUCT' },
    { item_id: null, item_type: 'PRODUCT' },
  ]

  assert.equal(mixedPayload.length, 3)
  assert.equal(mixedPayload.filter(item => item.item_id === null).length, 1)
  assert.match(migration, /v_retained_item_ids uuid\[\] := ARRAY\[\]::uuid\[\]/)
  assert.match(migration, /\) RETURNING id INTO v_item_id;/)
  assert.match(migration, /v_retained_item_ids := array_append\(v_retained_item_ids, v_item_id\)/)
  assert.match(migration, /v_item_id, p_company_id, p_po_id, v_line_number/)
  assert.match(migration, /AND NOT \(id = ANY\(v_retained_item_ids\)\)/)
  assert.doesNotMatch(migration, /v_restore_line_number|v_seen_item_ids/)
})
