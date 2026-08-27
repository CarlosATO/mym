import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const component = await readFile(new URL('../src/modules/adquisiciones/rendicion-rutas/components/route-settlement-checks.tsx', import.meta.url), 'utf8')
const actions = await readFile(new URL('../src/app/actions/adquisiciones/rendicion-rutas.ts', import.meta.url), 'utf8')

test('Cheques es informativo y sólo permite abrir el detalle', () => {
  assert.match(component, /getRouteSettlementCheckRegistry/)
  assert.match(component, /title="Ver"/)
  assert.doesNotMatch(component, /setRouteSettlementCheckStatus|set_route_settlement_check_status/)
  assert.doesNotMatch(component, /route_settlement_check_status_history/)
  assert.doesNotMatch(component, /Entregar a depósito|Confirmar depósito|Confirmar cambio de situación|Observación o referencia/)
})

test('la situación visible deriva de current_location y datos reales del read-model', () => {
  assert.match(component, /CON_CUSTODIO: 'Con custodio'/)
  assert.match(component, /EN_TESORERIA: 'En Tesorería'/)
  assert.match(component, /row\.current_location/)
  assert.match(component, /row\.current_holder_name/)
  assert.match(actions, /current_holder_name: string \| null/)
  assert.match(actions, /current_location: RouteSettlementCheckStatus/)
})

test('el drawer expone origen, CFC, depósito y trazabilidad sin fecha ficticia', () => {
  for (const section of ['Cheque', 'Origen', 'Cierre de Fondos', 'Depósito', 'Trazabilidad']) {
    assert.match(component, new RegExp(`title="${section}"`))
  }
  for (const field of ['fund_closure_number', 'fund_closure_at', 'fund_closure_status', 'deposit_id', 'deposit_reference_number', 'deposit_amount', 'deposit_status', 'deposited_at', 'received_at']) {
    assert.match(component, new RegExp(`row\\.${field}`))
  }
  assert.doesNotMatch(component, /Fecha entrega a depósito/)
  assert.doesNotMatch(component, /created_at/)
  assert.doesNotMatch(component, /CFC-\$\{row\.fund_closure_number\}/)
})
