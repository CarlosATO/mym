import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const sql = await readFile(new URL('../supabase/migrations/20261021100000_logistica_canonical_bsale_identity.sql', import.meta.url), 'utf8')

test('resolver canónico ordena por generation_date y bsale_id', () => {
  assert.match(sql, /PARTITION BY d\.company_id, d\.document_type_id, d\.raw_json ->> 'token'/)
  assert.match(sql, /generation_date DESC NULLS LAST, d\.bsale_id DESC/)
})

test('cards separan evidencia histórica de versión vigente', () => {
  assert.match(sql, /ADD COLUMN IF NOT EXISTS canonical_bsale_token text/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS current_bsale_nv_id bigint/)
  assert.match(sql, /bsale_nv_id IS NOT DISTINCT FROM 92486|bsale_nv_id=92486/)
  assert.match(sql, /current_bsale_nv_id=92513/)
})

test('verify prioriza documento vigente y variante/SKU, no detail histórico', () => {
  assert.match(sql, /d\.bsale_id=s\.current_id/)
  assert.match(sql, /det\.variant_id=s\.bsale_variant_id/)
  assert.match(sql, /lower\(btrim\(det\.variant_code\)\)/)
  assert.match(sql, /matching_line_count/)
})

test('repair 5032 cancela sólo el duplicado y conserva card histórica', () => {
  assert.match(sql, /status='CANCELLED'/)
  assert.match(sql, /Duplicado técnico por revisión Bsale de NV 5032/)
  assert.match(sql, /INSERT INTO logistica\.sales_order_preparation_movements/)
})
