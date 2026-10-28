import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const migration = await readFile(new URL('supabase/migrations/20261028130000_adquisiciones_purchase_order_operational_views.sql', root), 'utf8')
const action = await readFile(new URL('src/app/actions/adquisiciones/purchase-orders.ts', root), 'utf8')
const panel = await readFile(new URL('src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx', root), 'utf8')

test('operational views keep the existing RPC signature and least-privilege controls', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION adquisiciones\.get_purchase_orders\(\s*p_filters jsonb,\s*p_user_id uuid,\s*p_company_id uuid\s*\)/)
  assert.match(migration, /v_operational_view text/)
  assert.match(migration, /REVOKE ALL ON FUNCTION adquisiciones\.get_purchase_orders\(jsonb, uuid, uuid\) FROM PUBLIC, anon, authenticated/)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION adquisiciones\.get_purchase_orders\(jsonb, uuid, uuid\) TO service_role/)
  assert.match(migration, /portal\.user_has_permission\(p_user_id, 'adquisiciones\.po\.view'\)/)
  assert.match(migration, /core\.has_company_access\(p_user_id, p_company_id\)/)
})

test('classification gives terminal statuses priority over receipt status', () => {
  assert.match(migration, /v_operational_view = 'PENDING'[\s\S]*po\.status NOT IN \('CERRADA', 'CANCELADA', 'RECHAZADA', 'PAGADA', 'RECEPCION_TOTAL'\)/)
  assert.match(migration, /COALESCE\(po\.receipt_status, 'PENDIENTE'\) <> 'RECEPCION_TOTAL'/)
  assert.match(migration, /v_operational_view = 'RECEIVED'[\s\S]*po\.status NOT IN \('CERRADA', 'CANCELADA'\)/)
  assert.match(migration, /v_operational_view = 'CLOSED' AND po\.status = 'CERRADA'/)
  assert.match(migration, /v_operational_view = 'CANCELLED' AND po\.status = 'CANCELADA'/)
  assert.match(migration, /v_operational_view = 'ALL'/)
})

test('existing filters remain server-side and the view is sent to the RPC', () => {
  assert.match(action, /operational_view: filters\.operational_view \|\| 'PENDING'/)
  assert.match(action, /search: filters\.search \|\| null/)
  assert.match(action, /status: filters\.status \|\| null/)
  assert.match(action, /supplier_id: filters\.supplier_id \|\| null/)
  assert.match(action, /page: filters\.page \?\? 1/)
  assert.match(action, /page_size: filters\.pageSize \?\? 50/)
})

test('panel defaults to pending, resets pagination, and shows partial receipt in amber', () => {
  assert.match(panel, /useState<PurchaseOrderFilters>\(\{ operational_view: 'PENDING', page: 1, pageSize: 50 \}\)/)
  assert.match(panel, /Pendientes'[\s\S]*Recibidas'[\s\S]*Cerradas'[\s\S]*Anuladas'[\s\S]*Todas'/)
  assert.match(panel, /operational_view: option\.value, page: 1/)
  assert.match(panel, /setFilters\(\{ operational_view: 'PENDING', page: 1, pageSize: 50 \}\)/)
  assert.match(panel, /RECEPCION_PARCIAL: \{ bg: 'bg-amber-500\/10', text: 'text-amber-600'/)
  assert.match(panel, /pageSize: parseInt\(e\.target\.value\).*page: 1/)
})
