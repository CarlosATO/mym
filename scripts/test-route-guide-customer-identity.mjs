import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationPath = new URL('../supabase/migrations/20260827150000_route_guide_customer_identity_backfill.sql', import.meta.url)
const migration = await readFile(migrationPath, 'utf8')

test('la identidad de Guías se resuelve desde documento Bsale y cliente válido', () => {
  assert.match(migration, /d\.number::text = btrim\(NEW\.invoice_number\)/)
  assert.match(migration, /d\.document_type_id = 5/)
  assert.match(migration, /c\.bsale_client_id = d\.client_id/)
  assert.match(migration, /HAVING count\(\*\) = 1/)
  assert.match(migration, /CREATE TRIGGER set_route_guide_item_customer_bsale_id/)
})

test('el backfill excluye GR-2026-000001 y no crea efectos financieros', () => {
  assert.match(migration, /g\.guide_number <> 'GR-2026-000001'/)
  assert.match(migration, /RR-2026-000002/)
  assert.match(migration, /route_settlement_payments WHERE settlement_id = v_settlement_id/)
  assert.doesNotMatch(migration, /INSERT INTO adquisiciones\.route_settlement_payments/)
  assert.doesNotMatch(migration, /INSERT INTO adquisiciones\.route_settlement_items/)
})
