import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20261027130000_logistica_preparation_commercial_reentry.sql', import.meta.url), 'utf8')
const acceptanceMigration = await readFile(new URL('../supabase/migrations/20261027120000_logistica_preparation_commercial_acceptance.sql', import.meta.url), 'utf8')

test('la corrección es una migración nueva y no altera la migración de aceptación aplicada', async () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION logistica\.materialize_sales_order_preparation_snapshot/)
  assert.equal(migration.includes('version_snapshot ='), false)
  assert.equal(migration.includes('applied_actions ='), false)
  assert.match(acceptanceMigration, /CREATE OR REPLACE FUNCTION logistica\.materialize_sales_order_preparation_snapshot/)
})

test('distingue identidad canónica de ID físico y valida la versión aceptada contra su propio snapshot', () => {
  assert.match(migration, /v_accepted_version\.canonical_bsale_token IS DISTINCT FROM v_card\.canonical_bsale_token/)
  assert.match(migration, /v_accepted_version\.version_snapshot->'identity'->>'canonicalToken' IS DISTINCT FROM v_accepted_version\.canonical_bsale_token/)
  assert.match(migration, /v_accepted_version\.current_bsale_nv_id IS DISTINCT FROM \(v_accepted_version\.version_snapshot->>'physicalId'\)::bigint/)
  assert.doesNotMatch(migration, /v_accepted_version\.current_bsale_nv_id IS DISTINCT FROM v_card\.current_bsale_nv_id/)
})

test('conserva bloqueo, líneas activas y evita rematerialización con versión aceptada', () => {
  assert.match(migration, /FROM logistica\.sales_order_preparation_cards[\s\S]*FOR UPDATE;/)
  assert.match(migration, /active_line\.retired_at IS NULL/)
  assert.match(migration, /RETURN 0;/)
  const acceptedBranch = migration.slice(migration.indexOf('IF FOUND THEN'), migration.indexOf('END IF;\n\n  -- No se reconstruye'))
  assert.doesNotMatch(acceptedBranch, /INSERT INTO logistica\.sales_order_preparation_lines/)
  assert.doesNotMatch(acceptedBranch, /UPDATE logistica\.sales_order_preparation_lines/)
})

test('la ruta sin versión aceptada conserva la materialización inicial idempotente', () => {
  assert.match(migration, /IF v_card\.status NOT IN \('PENDING_ROUTE_PREP', 'IN_PREPARATION'\)/)
  assert.match(migration, /FROM integraciones\.vw_bsale_sales_order_items_for_preparation/)
  assert.match(migration, /ON CONFLICT \(company_id, card_id, bsale_detail_id\) DO NOTHING/)
})
