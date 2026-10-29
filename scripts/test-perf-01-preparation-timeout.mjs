import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')

test('PERF-01 makes one board request and reuses its readiness batch', async () => {
  const panel = await read('src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx')
  const action = await read('src/app/actions/logistica/sales-order-preparation.ts')

  assert.equal((panel.match(/getSalesOrderPreparationBoard\(/g) ?? []).length, 1)
  assert.doesNotMatch(panel, /getSalesOrderPreparationAccess\(/)
  assert.doesNotMatch(panel, /getSalesOrderRouteReadiness\(/)
  assert.match(action, /Promise\.all\(\[[\s\S]*get_sales_order_route_readiness_v1/)
  assert.match(action, /exposedReadiness/)
  assert.match(action, /query\.in\('status', \['PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT', 'AUDITED'\]\)/)
})

test('PERF-01 avoids rerunning the heavy board view for operator profitability authorization', async () => {
  const profitability = await read('src/app/actions/logistica/sales-order-preparation-profitability.ts')
  assert.doesNotMatch(profitability, /getSalesOrderPreparationBoard/)
  assert.match(profitability, /sales_order_preparation_cards/)
  assert.match(profitability, /get_sales_order_route_readiness_v1/)
})

test('PERF-01 records independent authorization, board and readiness timings', async () => {
  const action = await read('src/app/actions/logistica/sales-order-preparation.ts')
  assert.match(action, /authorization'/)
  assert.match(action, /board-query'/)
  assert.match(action, /readiness-query'/)
})
