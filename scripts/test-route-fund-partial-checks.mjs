import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const dialogPath = new URL('../src/modules/adquisiciones/rendicion-rutas/components/create-fund-closure-dialog.tsx', import.meta.url)
const migrationPath = new URL('../supabase/migrations/20260827180000_route_fund_partial_check_selection.sql', import.meta.url)
const [dialog, migration] = await Promise.all([
  readFile(dialogPath, 'utf8'),
  readFile(migrationPath, 'utf8'),
])

test('el CFC envía efectivos y sólo los cheques seleccionados', () => {
  assert.match(dialog, /payment_method_received === 'CASH' \|\| confirmedChecks\.has\(payment\.id\)/)
  assert.match(dialog, /paymentIds = includedPayments\.filter\(payment => payment\.source_type !== 'POST_SETTLEMENT_PAYMENT'\)/)
  assert.match(dialog, /postSettlementPaymentIds = includedPayments\.filter\(payment => payment\.source_type === 'POST_SETTLEMENT_PAYMENT'\)/)
  assert.match(dialog, /expectedChecks = checks\.filter\(check => confirmedChecks\.has\(check\.id\)/)
  assert.doesNotMatch(dialog, /hasUnconfirmedCheck/)
})

test('cheques no seleccionados siguen disponibles y los gastos se asignan una sola vez', () => {
  assert.match(dialog, /Los cheques no incluidos permanecerán disponibles/)
  assert.match(dialog, /includedPaymentCount === 0/)
  assert.match(migration, /p_payment_ids uuid\[\]/)
  assert.match(migration, /p_check_payment_ids uuid\[\]/)
  assert.match(migration, /i\.payment_id=v_route\.id.*f\.status<>'CANCELLED'/s)
  assert.match(migration, /route_settlement_id IN\(SELECT settlement_id FROM adquisiciones\.route_settlement_payments.*UNION SELECT route_settlement_id FROM adquisiciones\.post_settlement_payments/s)
  assert.match(migration, /UPDATE adquisiciones\.route_fund_closure_expenses SET fund_closure_id=v_closure.*post_settlement_payments/s)
})

test('el efectivo $0 es válido cuando no hay efectivo por entregar', async () => {
  assert.match(dialog, /const requiresCashDelivery = cashExpected > 0/)
  assert.match(dialog, /const delivered = cashDelivered \?\? 0/)
  assert.match(dialog, /const hasCashDelivered = !requiresCashDelivery \|\| cashDelivered !== null/)
  assert.match(dialog, /required=\{requiresCashDelivery\}/)
  assert.match(dialog, /\(requiresCashDelivery && !hasCashDelivered\)/)
  assert.match(dialog, /disabled=.*!hasCashDelivered/s)

  const action = await readFile(new URL('../src/app/actions/adquisiciones/route-fund-closures.ts', import.meta.url), 'utf8')
  assert.match(action, /if \(input\.cashDelivered < 0\) throw new Error\('El efectivo entregado no puede ser negativo\.'\)/)
  assert.doesNotMatch(action, /cashDelivered <= 0/)
  assert.match(migration, /v_difference:=p_cash_delivered-v_expected/)
})
