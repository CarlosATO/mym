import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  getPreparationColumnId,
  getPreparationReadinessLabel,
} from '../src/modules/logistica/preparacion-pedidos/preparation-route-readiness.ts'

const root = new URL('../', import.meta.url)
const panel = await readFile(new URL('src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx', root), 'utf8')
const card = await readFile(new URL('src/modules/logistica/preparacion-pedidos/sales-order-card.tsx', root), 'utf8')
const action = await readFile(new URL('src/app/actions/logistica/sales-order-preparation.ts', root), 'utf8')
const dialog = await readFile(new URL('src/modules/logistica/preparacion-pedidos/preparation-commercial-incidents-dialog.tsx', root), 'utf8')

test('1. existen cinco columnas', () => {
  assert.deepEqual(
    ['PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT', 'INCIDENTS', 'READY_TO_INVOICE']
      .filter(id => panel.includes(`id: '${id}'`)),
    ['PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT', 'INCIDENTS', 'READY_TO_INVOICE'],
  )
})

test('2. desaparece Auditadas como columna visual', () => assert.doesNotMatch(panel, /title: ['"]Auditadas['"]/))
test('3. PENDING va a Pendientes', () => assert.equal(getPreparationColumnId('PENDING_ROUTE_PREP', null), 'PENDING_ROUTE_PREP'))
test('4. IN_PREPARATION va a En preparación', () => assert.equal(getPreparationColumnId('IN_PREPARATION', null), 'IN_PREPARATION'))
test('5. IN_AUDIT va a En auditoría', () => assert.equal(getPreparationColumnId('IN_AUDIT', null), 'IN_AUDIT'))
test('6. AUDITED con INCIDENTS va a Incidencias', () => assert.equal(getPreparationColumnId('AUDITED', 'INCIDENTS'), 'INCIDENTS'))
test('7. AUDITED con BLOCKED va a Incidencias', () => assert.equal(getPreparationColumnId('AUDITED', 'BLOCKED'), 'INCIDENTS'))
test('8. AUDITED con READY_TO_INVOICE va a Lista para facturar', () => assert.equal(getPreparationColumnId('AUDITED', 'READY_TO_INVOICE'), 'READY_TO_INVOICE'))
test('9. readiness loading nunca produce READY', () => assert.equal(getPreparationColumnId('AUDITED', undefined), 'INCIDENTS'))
test('10. readiness error nunca produce READY', () => assert.equal(getPreparationColumnId('AUDITED', null), 'INCIDENTS'))
test('11. readiness no disponible conserva la tarjeta', () => assert.match(panel, /getPreparationColumnId\(card\.status, readinessByCardId\[card\.card_id\]\?\.route_readiness\)/))
test('12. AUDITED permanece no draggable', () => assert.match(panel, /dragDisabled=\{card\.status === 'AUDITED'/))
test('13. IN_AUDIT no se clasifica por incidencias', () => assert.equal(getPreparationColumnId('IN_AUDIT', 'INCIDENTS'), 'IN_AUDIT'))
test('14. una tarjeta se clasifica con una sola columna', () => assert.notEqual(getPreparationColumnId('AUDITED', 'READY_TO_INVOICE'), 'INCIDENTS'))
test('15. columnas se calculan desde filteredCards', () => assert.match(panel, /const colCards = filteredCards\.filter\(card =>/))
test('16. filtros siguen alimentando filteredCards', () => assert.match(panel, /const filteredCards = useMemo\(/))
test('17. montos usan el resumen canónico por columna', () => assert.match(panel, /const columnSummary = summarizePreparationBoard\(colCards\)/))
test('18. refresh invalida y vuelve a cargar readiness', () => {
  assert.match(panel, /setReadinessVersion\(current => current \+ 1\)/)
  assert.match(panel, /\[companyId, auditedCardKey, readinessVersion\]/)
})
test('19. readiness cambia de columna sin drag', () => assert.match(panel, /getPreparationColumnId\(card\.status, readinessByCardId\[card\.card_id\]\?\.route_readiness\)/))
test('20. count de tareas viene del read model', () => assert.match(panel, /openCommercialIncidentCount=\{readinessByCardId\[card\.card_id\]\?\.open_commercial_incident_count/))
test('21. el detalle sólo consulta OPEN', () => assert.match(action, /\.eq\('status', 'OPEN'\)/))
test('22. el detalle no usa SUPERSEDED ni RESOLVED', () => assert.doesNotMatch(dialog, /SUPERSEDED|RESOLVED/))
test('23. BLOCKED tiene etiqueta visual conservadora', () => assert.equal(getPreparationReadinessLabel('BLOCKED', 'ready'), 'Bloqueada'))
test('24. costo identificado permanece separado', () => assert.match(panel, /label="Costo identificado"/))
test('25. headers mantienen conteo y monto compacto', () => {
  assert.match(panel, /min-w-\[18px\].*text-\[10px\] font-bold tabular-nums/)
  assert.match(panel, /formatPreparationClp\(columnSummary\.amount\)/)
})
test('26. no se agrega segunda fila de KPI', () => assert.equal((panel.match(/<SummaryStat/g) ?? []).length, 7))
test('27. readiness usa una carga batch, no RPC por tarjeta', () => {
  assert.equal((panel.match(/getSalesOrderRouteReadiness\(companyId\)/g) ?? []).length, 1)
  assert.match(action, /rpc\('get_sales_order_route_readiness_v1'/)
})
test('28. detalle comercial es lazy y compacto', () => {
  assert.match(panel, /getSalesOrderPreparationCommercialIncidents\(/)
  assert.match(dialog, /max-w-lg/)
})
test('29. acciones comerciales traducen SET_QUANTITY y REMOVE_LINE', () => {
  assert.match(action, /'SET_QUANTITY' \| 'REMOVE_LINE'/)
  assert.match(dialog, /REMOVE_LINE/)
})
