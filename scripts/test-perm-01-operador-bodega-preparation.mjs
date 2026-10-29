import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')

test('PERM-01 resolves the effective company role from user_company_access', async () => {
  const source = await read('src/app/actions/logistica/authorization.ts')
  assert.match(source, /schema\('core'\)[\s\S]*from\('user_company_access'\)/)
  assert.match(source, /eq\('company_id', companyId\)/)
  assert.match(source, /effectiveRole === 'OPERADOR_BODEGA'/)
})

test('PERM-01 filters commercial readiness and board rows server-side', async () => {
  const source = await read('src/app/actions/logistica/sales-order-preparation.ts')
  assert.match(source, /get_sales_order_route_readiness_v1/)
  assert.match(source, /row\.route_readiness !== 'READY_TO_INVOICE'/)
  assert.match(source, /row\.status !== 'INVOICED_READY_FOR_ROUTE'/)
  assert.match(source, /No se pudo verificar la clasificación comercial/)
})

test('PERM-01 blocks commercial invoice actions for the operator', async () => {
  const invoice = await read('src/app/actions/logistica/sales-order-invoice-attempts.ts')
  const diagnostics = await read('src/app/actions/logistica/sales-order-invoice-diagnostics.ts')
  assert.match(invoice, /auth\.isOperatorBodega/)
  assert.match(invoice, /No autorizado para facturación/)
  assert.match(diagnostics, /auth\.isOperatorBodega/)
})

test('PERM-01 renders only four columns for the operator without exposing hidden column data', async () => {
  const panel = await read('src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx')
  assert.match(panel, /COLUMNS\.slice\(0, 4\)/)
  assert.match(panel, /visibleColumns\.map\(col =>/)
  assert.match(panel, /visibleColumns\.map\(column =>/)
})

test('PERM-01 blocks unauthorized card movement targets', async () => {
  const source = await read('src/app/actions/logistica/sales-order-preparation.ts')
  assert.match(source, /!\['PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT', 'INCIDENTS'\]\.includes\(params\.toStatus\)/)
})

test('PERM-01A exposes preparation navigation through a server-verified capability', async () => {
  const navigation = await read('src/app/dashboard/logistica/wms-navigation.ts')
  const layout = await read('src/app/dashboard/logistica/layout.tsx')
  const client = await read('src/app/dashboard/logistica/logistica-layout-client.tsx')
  const shell = await read('src/app/dashboard/logistica/wms-shell.tsx')
  assert.match(navigation, /logistica\.preparation\.access/)
  assert.match(layout, /getEffectiveRoleForActiveCompany/)
  assert.match(layout, /effectiveRole === 'OPERADOR_BODEGA'/)
  assert.match(layout, /hasLogisticaAccess === true/)
  assert.match(client, /canAccessPreparation/)
  assert.match(shell, /navigationPermissions/)
  assert.doesNotMatch(layout, /logistica\.preparation\.manage.*OPERADOR_BODEGA/)
})
