import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const migration = await readFile(new URL('supabase/migrations/20261016170000_adquisiciones_close_purchase_order_with_pending.sql', root), 'utf8')
const receiptMigration = await readFile(new URL('supabase/migrations/20261006090000_logistica_purchase_receipts_service_quantity_fix.sql', root), 'utf8')
const action = await readFile(new URL('src/app/actions/adquisiciones/purchase-orders.ts', root), 'utf8')
const panel = await readFile(new URL('src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx', root), 'utf8')

test('closure migration adds auditable closure metadata without touching quantities', () => {
  assert.match(migration, /ALTER TABLE adquisiciones\.purchase_orders/)
  assert.match(migration, /ADD COLUMN IF NOT EXISTS closure_reason text/)
  assert.match(migration, /ADD COLUMN IF NOT EXISTS closed_at timestamptz/)
  assert.match(migration, /ADD COLUMN IF NOT EXISTS closed_by uuid REFERENCES portal\.users\(id\)/)
  assert.match(migration, /ADD COLUMN IF NOT EXISTS closed_with_pending boolean NOT NULL DEFAULT false/)
  assert.doesNotMatch(migration, /quantity_received\s*=/)
  assert.doesNotMatch(migration, /kardex_movements/)
  assert.doesNotMatch(migration, /DELETE FROM adquisiciones\.purchase_order_items/)
})

test('closure RPC is dedicated, secured and permission-checked', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION adquisiciones\.close_purchase_order_with_pending\(/)
  assert.match(migration, /SECURITY DEFINER/)
  assert.match(migration, /SET search_path = adquisiciones, core, portal, public/)
  assert.match(migration, /auth\.uid\(\)/)
  assert.match(migration, /v_actor IS DISTINCT FROM p_user_id/)
  assert.match(migration, /p_user_id IS NULL OR p_company_id IS NULL/)
  assert.match(migration, /portal\.user_has_permission\(p_user_id, 'system\.admin'\)/)
  assert.match(migration, /core\.has_company_access\(p_user_id, p_company_id\)/)
  assert.match(migration, /portal\.user_has_permission\(p_user_id, 'adquisiciones\.po\.update'\)/)
  assert.match(migration, /REVOKE ALL ON FUNCTION adquisiciones\.close_purchase_order_with_pending\(uuid, text, uuid, uuid\) FROM PUBLIC, anon/)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION adquisiciones\.close_purchase_order_with_pending\(uuid, text, uuid, uuid\) TO authenticated, service_role/)
})

test('closure RPC validates motive, state, pending balance and duplicate closures', () => {
  assert.match(migration, /v_reason text := NULLIF\(btrim\(COALESCE\(p_reason, ''\)\), ''\)/)
  assert.match(migration, /v_reason IS NULL/)
  assert.match(migration, /El motivo de cierre es obligatorio/)
  assert.match(migration, /WHERE id = p_po_id AND company_id = p_company_id\s+FOR UPDATE/)
  assert.match(migration, /v_po\.status = 'CERRADA'/)
  assert.match(migration, /'already_closed', true/)
  assert.match(migration, /v_po\.status <> 'RECEPCION_PARCIAL'/)
  assert.match(migration, /v_pending <= 0/)
  assert.match(migration, /SET status = 'CERRADA'/)
  assert.match(migration, /closed_with_pending = true/)
  assert.match(migration, /closure_reason = v_reason/)
  assert.match(migration, /closed_by = p_user_id/)
})

test('closure RPC records the previous status, actor and motive in the history', () => {
  assert.match(migration, /INSERT INTO adquisiciones\.purchase_order_status_history/)
  assert.match(migration, /company_id, po_id, from_status, to_status, changed_by, reason/)
  assert.match(migration, /v_po\.status, 'CERRADA', p_user_id, v_reason/)
})

test('read models expose the closure metadata for the panel', () => {
  assert.match(migration, /'closed_with_pending', q\.closed_with_pending, 'closure_reason', q\.closure_reason/)
  assert.match(migration, /'closed_with_pending', po\.closed_with_pending, 'closure_reason', po\.closure_reason/)
  assert.match(migration, /CREATE OR REPLACE FUNCTION adquisiciones\.get_purchase_orders\(p_filters jsonb, p_company_id uuid\)/)
  assert.match(migration, /CREATE OR REPLACE FUNCTION adquisiciones\.get_purchase_order_detail\(p_po_id uuid\)/)
})

test('receiving stays blocked for closed orders', () => {
  assert.match(receiptMigration, /v_po\.status NOT IN \('CONFIRMADA', 'RECEPCION_PARCIAL'\)/)
})

test('server action authenticates, scopes company and calls only the closure RPC', () => {
  const start = action.indexOf('export async function closePurchaseOrderWithPending')
  const end = action.indexOf('export async function getAuthorizedPersonnel', start)
  assert.ok(start >= 0 && end > start)
  const source = action.slice(start, end)
  assert.match(source, /supabase\.auth\.getUser\(\)/)
  assert.match(source, /getActiveCompanyId\(\)/)
  assert.match(source, /close_purchase_order_with_pending/)
  assert.match(source, /p_user_id: user\.id/)
  assert.match(source, /p_company_id: companyId/)
  assert.match(source, /El motivo de cierre es obligatorio/)
  assert.doesNotMatch(source, /update_purchase_order_status/)
})

test('panel exposes the close action with confirmation, summary and required motive', () => {
  assert.match(panel, /closePurchaseOrderWithPending/)
  assert.match(panel, /Cerrada con saldo pendiente/)
  assert.match(panel, /requestCloseWithPending/)
  assert.match(panel, /handleCloseWithPending/)
  assert.match(panel, /detail\.po\.status === 'RECEPCION_PARCIAL'/)
  assert.match(panel, /po\.status === 'RECEPCION_PARCIAL'/)
  assert.match(panel, /closePendingSummary/)
  assert.match(panel, /Solicitado/)
  assert.match(panel, /Recibido/)
  assert.match(panel, /Pendiente/)
  assert.match(panel, /Motivo de cierre/)
})
