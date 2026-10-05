import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const panel = await readFile(new URL('src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx', root), 'utf8')
const review = await readFile(new URL('src/modules/adquisiciones/ordenes-compra/purchase-order-supplier-review.tsx', root), 'utf8')
const action = await readFile(new URL('src/app/actions/adquisiciones/purchase-orders.ts', root), 'utf8')
const migration = await readFile(new URL('supabase/migrations/20261005170000_adquisiciones_supplier_review_service_lines.sql', root), 'utf8')
const pdf = await readFile(new URL('src/lib/pdf/generate-po-pdf.ts', root), 'utf8')
const excel = await readFile(new URL('src/lib/excel/generate-po-excel.ts', root), 'utf8')

test('manual creation exposes service lines without a product selector', () => {
  assert.match(panel, /Agregar servicio/)
  assert.match(panel, /item_type: 'SERVICE'/)
  assert.match(panel, /product_id: ''/)
  assert.match(panel, /serviceDraft\.description/)
  assert.match(panel, /serviceDraft\.notes/)
  assert.match(panel, /product_id: it\.product_id \|\| null/)
  assert.doesNotMatch(panel, /label className="text-\[10px\].*Tipo OC/)
})

test('supplier review can add and persist a service line', () => {
  assert.match(review, /servicePickerOpen/)
  assert.match(review, /item_type: 'SERVICE'/)
  assert.match(review, /product_id: null/)
  assert.match(review, /product_description: line\.item_type === 'SERVICE'/)
  assert.match(action, /product_description\?: string \| null/)
  assert.match(action, /product_description: item\.product_description/)
  assert.match(migration, /v_item_type = 'SERVICE'/)
  assert.match(migration, /v_product_id IS NOT NULL/)
  assert.match(migration, /v_description := NULLIF\(btrim\(v_item->>'product_description'\)/)
})

test('service validation and type derivation remain server-side', () => {
  assert.match(migration, /product_id IS NOT NULL THEN RAISE EXCEPTION 'Una línea SERVICE/)
  assert.match(migration, /descripción es obligatoria/)
  assert.match(migration, /WHEN v_has_product AND v_has_service THEN 'MIXTA'/)
  assert.match(migration, /WHEN v_has_service THEN 'SERVICIOS'/)
  assert.match(migration, /discount_percent < 0 OR NEW\.discount_percent > 100/)
  assert.match(migration, /tax_rate < 0 OR NEW\.tax_rate > 100/)
})

test('service lines remain document-compatible with null SKU/product', () => {
  assert.match(pdf, /item\.sku \|\| '-'/)
  assert.match(excel, /item\.sku \|\| ''/)
})
