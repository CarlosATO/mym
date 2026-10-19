import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const reopen = await readFile(new URL('supabase/migrations/20261019133000_logistica_reopen_legacy_archived_preparation_a2.sql', root), 'utf8')
const cleanup = await readFile(new URL('supabase/migrations/20261019133100_logistica_legacy_special_cleanup.sql', root), 'utf8')

test('A2 permite ambos estados, preserva status y bloquea lock/asignacion', () => {
  assert.match(reopen, /PENDING_ROUTE_PREP.*IN_PREPARATION/s)
  assert.match(reopen, /locked_by_user_id IS NOT NULL|locked_at IS NOT NULL/)
  assert.match(reopen, /assigned_user_id IS NOT NULL/)
  assert.match(reopen, /SET closed_at = NULL, closure_reason = NULL, updated_at/)
  assert.match(reopen, /c\.status = 'IN_PREPARATION'/)
  assert.match(reopen, /BODEGA_LEGACY_REOPEN:/)
  assert.match(reopen, /route events|route_events/i)
})

test('el especial contiene exactamente las cuatro identidades y baseline', () => {
  for (const id of [83326, 83327, 83878, 90045]) assert.match(cleanup, new RegExp(`\\b${id}\\b`))
  assert.match(cleanup, /LEGACY_SPECIAL_20261019/)
  assert.match(cleanup, /BODEGA_LEGACY_SPECIAL_ARCHIVE:20261019:/)
  assert.match(cleanup, /83326, 'PENDING_ROUTE_PREP', 2/)
  assert.match(cleanup, /83327, 'PENDING_ROUTE_PREP', 0/)
  assert.match(cleanup, /83878, 'IN_PREPARATION', 3/)
  assert.match(cleanup, /90045, 'PENDING_ROUTE_PREP', 0/)
})

test('guards 90045 y las invariantes transaccionales están presentes', () => {
  assert.match(cleanup, /LOCK TABLE logistica\.sales_order_preparation_cards IN ACCESS EXCLUSIVE MODE/)
  assert.match(cleanup, /ROLLBACK|all-or-nothing|transaccional/i)
  assert.match(cleanup, /covered_qty <> 36|covered_qty = 36/)
  assert.match(cleanup, /remaining_qty <> 2|remaining_qty = 2/)
  assert.match(cleanup, /'PARCIAL'/)
  assert.match(cleanup, /51292/)
  assert.match(cleanup, /future route event/)
  assert.match(cleanup, /active exclusion/)
  assert.match(cleanup, /document evidence/)
  assert.match(cleanup, /invoice link/)
  assert.match(cleanup, /moved_by, movement_source/)
  assert.match(cleanup, /NULL, 'SYSTEM', false/)
  assert.match(cleanup, /movements total final: %, expected 9/)
  assert.match(cleanup, /route events changed/)
  assert.match(cleanup, /snapshot_sha256.*5bb6cc27ab3a759c8ffee8ae1c9b9f4a7e5f92f361e4580618a83292f74bac0a/s)
})

test('no API, Bsale writes, route-event deletes, board/view changes or prohibited IDs', () => {
  assert.doesNotMatch(cleanup, /fetch\(|axios|https?:\/\//i)
  assert.doesNotMatch(cleanup, /INSERT INTO integraciones\.bsale_|UPDATE integraciones\.bsale_|DELETE FROM/)
  assert.doesNotMatch(cleanup, /DELETE FROM logistica\.sales_order_preparation_route_events/)
  assert.doesNotMatch(cleanup, /CREATE OR REPLACE VIEW/)
  assert.doesNotMatch(cleanup, /91741|92172/)
})
