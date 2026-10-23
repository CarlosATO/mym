import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const repair = await readFile(new URL('supabase/migrations/20261023100000_logistica_restore_preparation_exclusion_guards.sql', root), 'utf8')
const original = await readFile(new URL('supabase/migrations/20261020140000_logistica_preparation_exclusive_lock.sql', root), 'utf8')
const exclusionRpcs = await readFile(new URL('supabase/migrations/20261016130000_logistica_sales_order_preparation_exclusion_rpcs.sql', root), 'utf8')
const auditedBoard = await readFile(new URL('supabase/migrations/20261022120000_logistica_preparation_board_include_audited.sql', root), 'utf8')
const routeInvoiceSelection = await readFile(new URL('supabase/migrations/20261023150107_logistica_route_invoice_selection_production_compat.sql', root), 'utf8')

test('repair is forward-only and restores the exclusion predicate', () => {
  assert.match(repair, /CREATE OR REPLACE VIEW logistica\.vw_sales_order_preparation_board/)
  assert.match(repair, /e\.active = true/)
  assert.match(repair, /e\.bsale_nv_id = c\.bsale_nv_id/)
  assert.match(repair, /e\.bsale_nv_id = c\.current_bsale_nv_id/)
  assert.match(repair, /security_invoker = true/)
  assert.doesNotMatch(repair, /UPDATE logistica\.sales_order_preparation_exclusions/)
  assert.doesNotMatch(repair, /INSERT INTO logistica\.sales_order_preparation_exclusions/)
  assert.match(original, /NOT EXISTS \([\s\S]*sales_order_preparation_exclusions/)
  assert.doesNotMatch(auditedBoard, /sales_order_preparation_exclusions/)
})

test('repair preserves all 28 board columns and operational statuses', () => {
  const outputColumns = [
    'card_id', 'company_id', 'status', 'priority', 'assigned_user_id',
    'route_date', 'normalized_city', 'nv_bsale_id', 'nv_folio',
    'nv_emission_date', 'nv_generation_date', 'client_name', 'city_raw',
    'municipality_raw', 'address_raw', 'seller_bsale_id', 'seller_name',
    'total_quantity', 'total_amount', 'invoice_folio', 'is_invoiced',
    'created_at', 'updated_at', 'net_amount', 'tax_amount', 'gross_amount',
    'locked_by_user_id', 'locked_at',
  ]
  const output = repair.match(/SELECT\n([\s\S]*?)\nFROM board;/)?.[1] ?? ''
  assert.equal(outputColumns.length, 28)
  for (const column of outputColumns) assert.match(output, new RegExp(`\\b${column}\\b`))
  for (const status of ['PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT', 'AUDITED', 'INVOICED_READY_FOR_ROUTE']) {
    assert.match(repair, new RegExp(status))
  }
})

test('active exclusions are data-driven rather than hard-coded', () => {
  assert.match(repair, /e\.active = true/)
  assert.match(repair, /e\.bsale_nv_id = c\.bsale_nv_id/)
  assert.match(repair, /e\.bsale_nv_id = c\.current_bsale_nv_id/)
  assert.match(repair, /excluded_nv\.bsale_id = e\.bsale_nv_id/)
  assert.match(repair, /excluded_nv\.raw_json ->> 'token'/)
  assert.match(repair, /c\.canonical_bsale_token/)
  for (const folio of ['4614', '4616', '4666', '4667', '4731', '4770', '4915']) {
    assert.doesNotMatch(repair, new RegExp(`\\b${folio}\\b`))
  }
})

test('multiple revisions remain excluded by canonical identity and revoke cleanly', () => {
  const canonicalMatch = ({ active, historicalId, currentId, excludedId, cardToken, excludedToken }) =>
    active && (
      excludedId === historicalId
      || excludedId === currentId
      || (cardToken !== null && cardToken === excludedToken)
    )

  assert.equal(canonicalMatch({ active: true, historicalId: 100, currentId: 102, excludedId: 101, cardToken: 'order-token', excludedToken: 'order-token' }), true)
  assert.equal(canonicalMatch({ active: false, historicalId: 100, currentId: 102, excludedId: 101, cardToken: 'order-token', excludedToken: 'order-token' }), false)
  assert.match(repair, /active = true[\s\S]*canonical_bsale_token/)
  assert.match(repair, /NULLIF\(btrim\(excluded_nv\.raw_json ->> 'token'\), ''\)/)
})

test('technical synchronization updates are not intercepted by exclusion guards', () => {
  assert.match(repair, /OLD\.status IS DISTINCT FROM NEW\.status/)
  assert.doesNotMatch(repair, /NEW\.current_bsale_nv_id/)
  assert.doesNotMatch(repair, /NEW\.closed_at/)
  assert.doesNotMatch(repair, /sales_order_preparation_movements/)
})

test('pending route invoice selection does not overwrite the preparation board', () => {
  assert.doesNotMatch(routeInvoiceSelection, /CREATE OR REPLACE VIEW logistica\.vw_sales_order_preparation_board/)
  assert.doesNotMatch(routeInvoiceSelection, /sales_order_preparation_exclusions/)
  assert.match(routeInvoiceSelection, /populate_route_invoice_identity/)
})

test('direct preparation, audit and invoice paths are guarded before mutation', () => {
  for (const trigger of [
    'trg_guard_excluded_preparation_lines',
    'trg_guard_excluded_audits',
    'trg_guard_excluded_audit_lines',
    'trg_guard_excluded_card_status_change',
    'trg_guard_excluded_invoice_attempt',
  ]) assert.match(repair, new RegExp(trigger))
  assert.match(repair, /IF TG_OP = 'INSERT'/)
  assert.match(repair, /ELSIF TG_OP = 'UPDATE'/)
  assert.match(repair, /OLD\.status IS DISTINCT FROM NEW\.status/)
  assert.match(repair, /La tarjeta está excluida administrativamente/)
})

test('revocation remains logical and does not delete history', () => {
  assert.match(exclusionRpcs, /SET active = false/)
  assert.match(exclusionRpcs, /revoked_reason/)
  assert.doesNotMatch(repair, /DELETE FROM logistica\.sales_order_preparation_exclusions/)
})
