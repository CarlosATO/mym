import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const migration = await readFile(new URL('supabase/migrations/20261016180000_adquisiciones_purchase_order_access_control.sql', root), 'utf8')
const detailFix = await readFile(new URL('supabase/migrations/20261016180001_adquisiciones_purchase_order_detail_jsonb_fix.sql', root), 'utf8')
const action = await readFile(new URL('src/app/actions/adquisiciones/purchase-orders.ts', root), 'utf8')
const cancellationMigration = await readFile(new URL('supabase/migrations/20261028120000_adquisiciones_authenticated_purchase_order_cancellation.sql', root), 'utf8')

test('read RPCs are recreated with company authorization and least privilege', () => {
  assert.match(migration, /DROP FUNCTION IF EXISTS adquisiciones\.get_purchase_orders\(jsonb, uuid\)/)
  assert.match(migration, /DROP FUNCTION IF EXISTS adquisiciones\.get_purchase_order_detail\(uuid\)/)
  assert.match(migration, /CREATE OR REPLACE FUNCTION adquisiciones\.get_purchase_orders\(\s*p_filters jsonb,\s*p_user_id uuid,\s*p_company_id uuid\s*\)/)
  assert.match(migration, /CREATE OR REPLACE FUNCTION adquisiciones\.get_purchase_order_detail\(\s*p_po_id uuid,\s*p_user_id uuid,\s*p_company_id uuid\s*\)/)
  assert.match(migration, /v_actor IS NOT NULL AND v_actor IS DISTINCT FROM p_user_id/)
  assert.match(migration, /portal\.user_has_permission\(p_user_id, 'system\.admin'\)/)
  assert.match(migration, /core\.has_company_access\(p_user_id, p_company_id\)/)
  assert.match(migration, /portal\.user_has_permission\(p_user_id, 'adquisiciones\.po\.view'\)/)
  assert.match(migration, /WHERE po\.id = p_po_id AND po\.company_id = p_company_id/)
  assert.match(migration, /IF v_po IS NULL THEN\s*RETURN NULL;/)
})

test('detail payload stays within jsonb_build_object limits while keeping access control', () => {
  assert.match(detailFix, /CREATE OR REPLACE FUNCTION adquisiciones\.get_purchase_order_detail\(\s*p_po_id uuid,\s*p_user_id uuid,\s*p_company_id uuid\s*\)/)
  assert.match(detailFix, /\) \|\| jsonb_build_object\(/)
  assert.match(detailFix, /WHERE po\.id = p_po_id AND po\.company_id = p_company_id/)
  assert.match(detailFix, /core\.has_company_access\(p_user_id, p_company_id\)/)
  assert.match(detailFix, /REVOKE ALL ON FUNCTION adquisiciones\.get_purchase_order_detail\(uuid, uuid, uuid\) FROM PUBLIC, anon, authenticated/)
})

test('privileged RPCs are removed from PUBLIC, anon and authenticated', () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION adquisiciones\.get_purchase_orders\(jsonb, uuid, uuid\) FROM PUBLIC, anon, authenticated/)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION adquisiciones\.get_purchase_orders\(jsonb, uuid, uuid\) TO service_role/)
  assert.match(migration, /REVOKE ALL ON FUNCTION adquisiciones\.get_purchase_order_detail\(uuid, uuid, uuid\) FROM PUBLIC, anon, authenticated/)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION adquisiciones\.get_purchase_order_detail\(uuid, uuid, uuid\) TO service_role/)
  assert.match(migration, /REVOKE ALL ON FUNCTION adquisiciones\.close_purchase_order_with_pending\(uuid, text, uuid, uuid\) FROM PUBLIC, anon, authenticated/)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION adquisiciones\.close_purchase_order_with_pending\(uuid, text, uuid, uuid\) TO service_role/)
  assert.doesNotMatch(migration, /GRANT EXECUTE ON FUNCTION adquisiciones\.(get_purchase_orders|get_purchase_order_detail|close_purchase_order_with_pending)[^\n]*TO[^\n]*authenticated/)
})

test('server actions scope the read RPCs to the authenticated company', () => {
  const listStart = action.indexOf('export async function getPurchaseOrders')
  const listEnd = action.indexOf('export async function getPurchaseOrderDetail', listStart)
  const detailStart = listEnd
  const detailEnd = action.indexOf('function snapshotText', detailStart)
  assert.ok(listStart >= 0 && listEnd > listStart && detailEnd > detailStart)

  const listSource = action.slice(listStart, listEnd)
  assert.match(listSource, /getActiveCompanyId\(\)/)
  assert.match(listSource, /p_user_id: user\.id/)
  assert.match(listSource, /p_company_id: companyId/)

  const detailSource = action.slice(detailStart, detailEnd)
  assert.match(detailSource, /supabase\.auth\.getUser\(\)/)
  assert.match(detailSource, /getActiveCompanyId\(\)/)
  assert.match(detailSource, /if \(!companyId\) return null/)
  assert.match(detailSource, /p_po_id: poId/)
  assert.match(detailSource, /p_user_id: user\.id/)
  assert.match(detailSource, /p_company_id: companyId/)
})

test('purchase-order cancellation requires the JWT identity and authenticated execution', () => {
  assert.match(cancellationMigration, /v_actor uuid := auth\.uid\(\)/)
  assert.match(cancellationMigration, /IF v_actor IS NULL THEN/)
  assert.match(cancellationMigration, /v_actor IS DISTINCT FROM p_user_id/)
  assert.match(cancellationMigration, /u\.is_active = true/)
  assert.match(cancellationMigration, /u\.deleted_at IS NULL/)
  assert.match(cancellationMigration, /core\.has_company_access\(v_actor, p_company_id\)/)
  assert.match(cancellationMigration, /core\.has_permission_for_company\(v_actor, p_company_id, 'adquisiciones\.po\.update'\)/)
  assert.match(cancellationMigration, /REVOKE ALL ON FUNCTION adquisiciones\.cancel_purchase_order\(uuid, text, uuid, uuid\)\s+FROM PUBLIC, anon, authenticated, service_role/)
  assert.match(cancellationMigration, /GRANT EXECUTE ON FUNCTION adquisiciones\.cancel_purchase_order\(uuid, text, uuid, uuid\)\s+TO authenticated/)
  assert.doesNotMatch(cancellationMigration, /GRANT EXECUTE ON FUNCTION adquisiciones\.cancel_purchase_order[^\n]*TO service_role/)

  const start = action.indexOf('export async function cancelPurchaseOrder')
  const end = action.indexOf('export async function closePurchaseOrderWithPending', start)
  assert.ok(start >= 0 && end > start)
  const source = action.slice(start, end)
  assert.match(source, /supabase\.auth\.getUser\(\)/)
  assert.match(source, /supabase\.schema\('adquisiciones'\)\.rpc\('cancel_purchase_order'/)
  assert.doesNotMatch(source, /adqAdmin\(\)/)
})
