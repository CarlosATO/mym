import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workspace = await readFile(new URL('../src/modules/adquisiciones/rendicion-rutas/fund-closures-workspace.tsx', import.meta.url), 'utf8')

test('la bandeja de fondos pendientes ordena las columnas operativas', () => {
  assert.match(workspace, /sortOperationalRows\(pendingFunds, pendingSort/)
  for (const key of ['settlement_number', 'guide_number', 'closed_at', 'custody_name', 'cash_received', 'active_route_expenses', 'net_cash_pending', 'checks_received']) {
    assert.match(workspace, new RegExp(`sortKey: '${key}'`))
  }
  assert.match(workspace, /sortType: 'number'/)
  assert.match(workspace, /sortType: 'date'/)
  assert.match(workspace, /sortType: 'text'/)
  assert.match(workspace, /selectedPendingIds\.has\(pendingGroupKey\(fund\)\)/)
})

test('la bandeja colorea según pending_origin_status', () => {
  assert.match(workspace, /bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/)
  assert.match(workspace, /pending_origin_status === 'CARRY_FORWARD'/)
  assert.match(workspace, /bg-amber-50 hover:bg-amber-100 dark:bg-amber-950/)
  assert.doesNotMatch(workspace, /isAttention|pendingReason|reconciliation_status/)
  assert.match(workspace, /getPendingRouteFundGroups\(\)/)
})

test('el checkbox queda fuera del sorting y el flujo de crear cierre permanece', () => {
  assert.match(workspace, /<input type="checkbox" checked=\{selectedPendingIds\.size === pendingFunds\.length/)
  assert.match(workspace, /onClick=\{handlePrepareClosure\}/)
  assert.match(workspace, /Crear cierre \(\{selectedPendingIds\.size\}\)/)
})
