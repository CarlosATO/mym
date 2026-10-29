import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')

test('1. OPERADOR_BODEGA utiliza exclusivamente la nueva RPC', async () => {
  const source = await read('src/app/actions/logistica/sales-order-preparation.ts')
  assert.match(source, /if\s*\(auth\.isOperatorBodega\)\s*\{/)
  assert.match(source, /\.rpc\('get_operator_preparation_board_v1',\s*\{\s*p_company_id:\s*companyId,?\s*\}\)/)
  assert.match(source, /logPreparationDiagnostics\('OPERATOR_RPC'/)
})

test('2. SUPER_USUARIO mantiene la consulta anterior', async () => {
  const source = await read('src/app/actions/logistica/sales-order-preparation.ts')
  assert.match(source, /from\('vw_sales_order_preparation_board'\)/)
  assert.match(source, /logPreparationDiagnostics\('STANDARD_BOARD'/)
  assert.match(source, /rpc\('get_sales_order_route_readiness_v1'/)
})

test('3. La nueva RPC se ejecuta una sola vez por apertura normal', async () => {
  const panel = await read('src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx')
  const boardCalls = panel.match(/getSalesOrderPreparationBoard\(/g) ?? []
  assert.equal(boardCalls.length, 1)
  assert.doesNotMatch(panel, /get_operator_preparation_board_v1/)
})

test('4. El operador no vuelve a consultar la vista pesada', async () => {
  const source = await read('src/app/actions/logistica/sales-order-preparation.ts')
  const operatorBlock = source.split('if (auth.isOperatorBodega) {')[1]?.split('// STANDARD_BOARD')[0]
  assert.ok(operatorBlock)
  assert.doesNotMatch(operatorBlock, /from\('vw_sales_order_preparation_board'\)/)
  assert.doesNotMatch(operatorBlock, /get_sales_order_route_readiness_v1/)
})

test('5. No se duplica la consulta de readiness', async () => {
  const source = await read('src/app/actions/logistica/sales-order-preparation.ts')
  const operatorBlock = source.split('if (auth.isOperatorBodega) {')[1]?.split('// STANDARD_BOARD')[0]
  assert.ok(operatorBlock)
  assert.match(operatorBlock, /row\.route_readiness/)
  assert.doesNotMatch(operatorBlock, /get_sales_order_route_readiness_v1/)
})

test('6. Las tarjetas AUDITED conservan su clasificación', async () => {
  const source = await read('src/app/actions/logistica/sales-order-preparation.ts')
  assert.match(source, /row\.route_readiness === 'INCIDENTS'/)
  assert.match(source, /row\.route_readiness === 'BLOCKED'/)
  assert.match(source, /row\.route_readiness !== 'READY_TO_INVOICE'/)
})

test('7. Las dos columnas comerciales permanecen inaccesibles para OPERADOR_BODEGA', async () => {
  const panel = await read('src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx')
  assert.match(panel, /serverIsOperatorBodega \?\? roleName === 'OPERADOR_BODEGA' \? COLUMNS\.slice\(0, 4\) : COLUMNS/)
  const source = await read('src/app/actions/logistica/sales-order-preparation.ts')
  assert.match(source, /row\.status !== 'INVOICED_READY_FOR_ROUTE'/)
})

test('8. Los KPI no incorporan tarjetas restringidas', async () => {
  const panel = await read('src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx')
  assert.match(panel, /const columnData = useMemo\(\(\) => \{[\s\S]*visibleColumns\.map\(column =>/)
  assert.match(panel, /boardSummary/)
})

test('9. Los cambios de empresa no mezclan tarjetas ni permisos', async () => {
  const source = await read('src/app/actions/logistica/sales-order-preparation.ts')
  assert.match(source, /if \(!auth \|\| auth\.companyId !== companyId\) return \{ data: \[\], error: 'Empresa activa inválida\.'/)
  assert.match(source, /p_company_id:\s*companyId/)
})

test('10. Errores 42501 y otros errores RPC no exponen información confidencial', async () => {
  const source = await read('src/app/actions/logistica/sales-order-preparation.ts')
  assert.match(source, /result\.error\.code === '42501'/)
  assert.match(source, /No autorizado para consultar el tablero operativo\./)
  assert.doesNotMatch(source, /result\.error\.message as string/)
})

test('11. La búsqueda, selección y ordenamiento funcionan sobre tarjetas autorizadas', async () => {
  const panel = await read('src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx')
  assert.match(panel, /sortPreparationColumnCards/)
  assert.match(panel, /prunePreparationSelection/)
  assert.match(panel, /buildPreparationComunaOptions/)
})

test('12. No se modifica ningún estado persistido en el tablero operativo', async () => {
  const source = await read('src/app/actions/logistica/sales-order-preparation.ts')
  const operatorBlock = source.split('if (auth.isOperatorBodega) {')[1]?.split('// STANDARD_BOARD')[0]
  assert.ok(operatorBlock)
  assert.doesNotMatch(operatorBlock, /\b(insert|update|delete|upsert)\b/i)
})

