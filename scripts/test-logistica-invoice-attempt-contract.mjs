import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const sql = await readFile(new URL('../supabase/migrations/20261021140000_logistica_invoice_attempts_readonly.sql', import.meta.url), 'utf8')
const repairSql = await readFile(new URL('../supabase/migrations/20261021143000_logistica_invoice_attempts_ambiguity_fix.sql', import.meta.url), 'utf8')
const core = await import('../src/lib/integraciones/invoice-attempt-contract.ts')

test('migration has immutable attempt states, active idempotency and server locking', () => {
  assert.match(sql, /sales_order_invoice_attempts_active_key/)
  assert.match(sql, /status IN \('PREPARED', 'LOCKED', 'UNKNOWN'/)
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended/)
})

test('snapshot and balance use current NV and N:M links', () => {
  assert.match(sql, /c\.current_bsale_nv_id/)
  assert.match(sql, /c\.bsale_nv_id/)
  assert.match(sql, /billable_quantity/)
  assert.match(sql, /bsale_invoice_sales_order_links/)
  assert.match(sql, /related_detail_bsale_id/)
  assert.doesNotMatch(sql, /POST \/v1\/documents|fetch\([^\n]*documents\.json/)
})

test('fingerprint and salesId are deterministic and NV changes are visible', () => {
  const base = { company_id: 'c', canonical_bsale_token: 't', current_bsale_nv_id: 92513, client_id: 1, office_id: 2, sale_condition_id: null, details: [{ detail_id: 334790, variant_id: 28210, quantity: 1 }], total: 100 }
  const one = core.invoiceAttemptFingerprint(base)
  assert.equal(one, core.invoiceAttemptFingerprint({ ...base, details: [...base.details] }))
  assert.notEqual(one, core.invoiceAttemptFingerprint({ ...base, current_bsale_nv_id: 92514 }))
  assert.equal(core.invoiceAttemptSalesId('c', 't', one), core.invoiceAttemptSalesId('c', 't', one))
})

test('case 5032 is explicitly current-only', () => {
  const case5032 = { historical_bsale_nv_id: 92486, current_bsale_nv_id: 92513, detail_id: 334790, quantity: 1, historical_detail_id: 334633, historical_quantity: 2 }
  assert.equal(core.invoiceAttemptUsesCurrentNv(case5032, 92513), true)
  assert.equal(core.invoiceAttemptUsesCurrentNv(case5032, 92486), false)
  assert.deepEqual({ detail_id: case5032.detail_id, quantity: case5032.quantity }, { detail_id: 334790, quantity: 1 })
  assert.notDeepEqual({ detail_id: case5032.detail_id, quantity: case5032.quantity }, { detail_id: 334633, quantity: 2 })
  assert.match(sql, /current_bsale_nv_id.*detail_snapshots|detail_snapshots.*current_bsale_nv_id/s)
})

test('prevalidation exposes contract, readiness, incident, state and balance blockers', () => {
  for (const blocker of ['NOT_READY_CONTRACT', 'OPEN_COMMERCIAL_INCIDENTS', 'READINESS_NOT_READY_TO_INVOICE', 'BSALE_STATE_NOT_ACTIVE', 'OVERCONSUMED']) {
    assert.match(sql, new RegExp(blocker))
  }
  assert.match(sql, /sum\(invdet\.quantity\)/)
  assert.match(sql, /HAVING sum\(x\.quantity\) > current_line\.current_quantity/)
})

test('reconciliation is read-only and distinguishes unknown/ambiguous/confirmed', () => {
  assert.match(sql, /status','UNKNOWN'/)
  assert.match(sql, /status','RECONCILIATION_REQUIRED'/)
  assert.match(sql, /status','CONFIRMED'/)
  assert.match(sql, /INSERT INTO integraciones\.bsale_invoice_sales_order_links/)
  assert.doesNotMatch(sql, /INSERT INTO integraciones\.bsale_documents|UPDATE integraciones\.bsale_documents|DELETE FROM integraciones\.bsale_documents/)
})

test('future emission contracts preserve the card and require explicit confirmation', () => {
  assert.match(sql, /Doble emisión: el lock\/índice server-side/)
  assert.match(sql, /Emitir factura/)
  assert.match(sql, /CONFIRMED conserva la card/)
  assert.match(sql, /UNKNOWN\/RECONCILIATION_REQUIRED bloquean/)
  assert.doesNotMatch(sql, /UPDATE logistica\.sales_order_preparation_cards|DELETE FROM logistica\.sales_order_preparation_cards/)
  assert.doesNotMatch(sql, /INVOICED_READY_FOR_ROUTE/)
})

test('forward repair removes PL/pgSQL document alias ambiguity', () => {
  assert.match(repairSql, /SELECT doc\.\* INTO doc_row/)
  assert.match(repairSql, /FROM integraciones\.bsale_documents doc/)
  assert.doesNotMatch(repairSql, /SELECT d\.\* INTO d/)
})
