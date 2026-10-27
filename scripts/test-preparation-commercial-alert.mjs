import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const action = await readFile(new URL('../src/app/actions/logistica/sales-order-preparation-commercial.ts', import.meta.url), 'utf8')
const hook = await readFile(new URL('../src/modules/logistica/preparacion-pedidos/use-preparation-commercial-alerts.ts', import.meta.url), 'utf8')
const alert = await readFile(new URL('../src/modules/logistica/preparacion-pedidos/preparation-commercial-change-alert.tsx', import.meta.url), 'utf8')
const card = await readFile(new URL('../src/modules/logistica/preparacion-pedidos/sales-order-card.tsx', import.meta.url), 'utf8')

test('la acción comercial solo opera sobre tarjetas En preparación y usa source_snapshot', () => {
  assert.match(action, /persistedCard\.status !== 'IN_PREPARATION'/)
  assert.match(action, /source_snapshot/)
  assert.match(action, /detectPreparationCommercialChange/)
  assert.doesNotMatch(action, /confirm_sales_order_preparation_line|verify_open_preparation_incidents_v1|moveSalesOrderPreparationCard/)
})

test('el polling limita concurrencia, deduplica vuelos y respeta TTL de 30 segundos', () => {
  assert.match(hook, /PREPARATION_COMMERCIAL_POLL_INTERVAL_MS = 60_000/)
  assert.match(hook, /PREPARATION_COMMERCIAL_CACHE_TTL_MS = 30_000/)
  assert.match(hook, /PREPARATION_COMMERCIAL_MAX_CONCURRENCY = 3/)
  assert.match(hook, /inFlightRef/)
  assert.match(hook, /Promise\.all\(candidates\.slice\(index, index \+ PREPARATION_COMMERCIAL_MAX_CONCURRENCY\)/)
  assert.match(hook, /visibilitychange/)
})

test('la alerta visual contiene estado CHANGED, reducción de movimiento y estados de error', () => {
  assert.match(alert, /NV MODIFICADA EN BSALE/)
  assert.match(card, /animate-pulse motion-reduce:animate-none/)
  assert.match(alert, /ATENCIÓN: NOTA DE VENTA MODIFICADA/)
  assert.match(alert, /Productos retirados/)
  assert.match(alert, /Productos agregados/)
  assert.match(alert, /Cantidades modificadas/)
  assert.match(alert, /Esta lista corresponde a la versión anterior/)
  assert.match(alert, /UNAVAILABLE/)
  assert.match(alert, /INCOMPLETE/)
  assert.match(alert, /AMBIGUOUS/)
  assert.match(alert, /Bsale registra cambios en este pedido\. Revisa las diferencias antes de continuar/)
})
