import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20261022120000_logistica_preparation_board_include_audited.sql', import.meta.url), 'utf8')
const readiness = await readFile(new URL('../src/modules/logistica/preparacion-pedidos/preparation-route-readiness.ts', import.meta.url), 'utf8')

test('AUDITED remains visible in the operational board filter', () => {
  assert.match(migration, /c\.status IN \('PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT', 'AUDITED'\)/)
  assert.match(migration, /c\.closed_at IS NULL/)
  assert.match(migration, /nv\.is_invoiced = false/)
  assert.doesNotMatch(migration, /c\.status IN \([^)]*'CANCELLED'/)
})

test('the current-NV identity and route invoice eligibility remain intact', () => {
  assert.match(migration, /COALESCE\(c\.current_bsale_nv_id, c\.bsale_nv_id\) = nv\.nv_bsale_id/)
  assert.match(migration, /a\.status = 'CONFIRMED'/)
  assert.match(migration, /d\.document_type_id = 5[\s\S]*?d\.state = 0/)
  assert.match(migration, /rg\.status IN \('DRAFT', 'DISPATCHED'\)/)
  assert.match(migration, /c\.status = 'INVOICED_READY_FOR_ROUTE'[\s\S]*?eligible\.invoice_bsale_id IS NOT NULL/)
})

test('the view still exposes exactly 28 ordered columns and security invoker', () => {
  const select = migration.match(/SELECT\n  card_id,([\s\S]*?)\nFROM board;/)?.[1]
  assert.ok(select)
  assert.equal(select.split(',').length + 1, 28)
  assert.match(migration, /SELECT\n  card_id, company_id, status, priority, assigned_user_id/)
  assert.match(select, /locked_by_user_id, locked_at$/)
  assert.match(migration, /ALTER VIEW logistica\.vw_sales_order_preparation_board SET \(security_invoker = true\)/)
})

test('the frontend maps audited readiness to billing or incidents', () => {
  assert.match(readiness, /if \(status === 'AUDITED'\)/)
  assert.match(readiness, /readiness === 'READY_TO_INVOICE' \? 'READY_TO_INVOICE' : 'INCIDENTS'/)
})
