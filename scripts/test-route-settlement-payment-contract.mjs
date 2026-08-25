import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationPath = new URL('../supabase/migrations/20260826000000_route_settlement_partial_payment_derivation.sql', import.meta.url)
const viewPath = new URL('../src/modules/adquisiciones/rendicion-rutas/components/route-settlement-client-view.tsx', import.meta.url)
const [migration, view] = await Promise.all([readFile(migrationPath, 'utf8'), readFile(viewPath, 'utf8')])

function deriveInvoice({ expected, applied, resolutionType = null }) {
  const remaining = Math.max(expected - applied, 0)
  const automaticPartial = resolutionType === null && applied > 0 && remaining > 0
  return {
    invoiceResult: applied >= expected ? 'PAID' : resolutionType ?? (automaticPartial ? 'PENDING_PAYMENT' : applied > 0 ? 'PARTIAL' : 'PENDING'),
    resolved: applied >= expected || ['PENDING_PAYMENT', 'CREDIT', 'NOT_DELIVERED'].includes(resolutionType) || automaticPartial,
    source: resolutionType ? 'MANUAL' : automaticPartial ? 'DERIVED' : null,
    remaining,
  }
}

test('partial payment becomes derived pending payment and is resolved', () => {
  assert.deepEqual(deriveInvoice({ expected: 389549, applied: 125994 }), {
    invoiceResult: 'PENDING_PAYMENT', resolved: true, source: 'DERIVED', remaining: 263555,
  })
})

test('editing or adding a payment to zero removes derived pending state', () => {
  assert.equal(deriveInvoice({ expected: 389549, applied: 389549 }).invoiceResult, 'PAID')
  assert.equal(deriveInvoice({ expected: 389549, applied: 125994 + 263555 }).source, null)
})

test('manual resolutions remain manual', () => {
  const result = deriveInvoice({ expected: 100, applied: 20, resolutionType: 'CREDIT' })
  assert.equal(result.invoiceResult, 'CREDIT')
  assert.equal(result.source, 'MANUAL')
  assert.equal(result.resolved, true)
})

test('contract and UI preserve separate new-payment and edit paths', () => {
  assert.match(migration, /resolution_source/)
  assert.match(migration, /get_route_settlement_detail\(p_settlement_id\)/)
  assert.match(migration, /close_route_settlement/)
  assert.match(view, /Registrar otro pago/)
  assert.match(view, /payment\.id/)
})

test('payment read-model separates active allocations from audit history', async () => {
  const activeAllocationsMigration = await readFile(new URL('../supabase/migrations/20260826010000_route_settlement_payment_active_allocations_read.sql', import.meta.url), 'utf8')
  assert.match(activeAllocationsMigration, /'allocations'/)
  assert.match(activeAllocationsMigration, /voided_at.*IS NULL/)
  assert.match(activeAllocationsMigration, /'allocation_history'/)
})
