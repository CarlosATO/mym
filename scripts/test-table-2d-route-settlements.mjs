import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const tablePath = new URL('../src/modules/adquisiciones/rendicion-rutas/components/unified-route-settlements-table.tsx', import.meta.url)
const panelPath = new URL('../src/modules/adquisiciones/rendicion-rutas/route-settlements-panel.tsx', import.meta.url)
const actionPath = new URL('../src/app/actions/adquisiciones/rendicion-rutas.ts', import.meta.url)
const [table, panel, action] = await Promise.all([
  readFile(tablePath, 'utf8'),
  readFile(panelPath, 'utf8'),
  readFile(actionPath, 'utf8'),
])

test('usa primitives shared con tableKey y columnas propios', () => {
  assert.match(table, /useOperationalTableWidths\(ROUTE_SETTLEMENTS_TABLE_KEY, ROUTE_SETTLEMENT_COLUMNS\)/)
  assert.match(table, /mym:table:adquisiciones:rendicion-rutas/)
  assert.match(table, /id: 'guide', defaultWidth: 110/)
  assert.match(table, /id: 'route', defaultWidth: 140/)
  assert.match(table, /id: 'actions', defaultWidth: 125[\s\S]*sticky: 'right'/)
  assert.match(table, /OperationalTableResizeHandle/)
})

test('resize, persistencia, reset, separadores, truncado y tooltip permanecen configurados', () => {
  assert.match(table, /onResizeEnd=\{persist\}/)
  assert.match(table, /resetWidths/)
  assert.match(table, /Restablecer anchos/)
  assert.match(table, /border-r border-theme-border\/30/)
  assert.match(table, /className="truncate px-3 py-2.5 text-theme-text" title=\{item\.route_name/)
  assert.match(table, /min-w-\[1840px\]/)
})

test('viewport, scroll y header sticky especializados no se modifican', () => {
  assert.match(table, /min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-auto overscroll-contain/)
  assert.match(table, /sticky top-0 z-20/)
  assert.match(panel, /h-\[calc\(100dvh-9\.75rem\)\] min-h-0 min-w-0 flex flex-col/)
  assert.match(panel, /lg:h-\[calc\(100dvh-7\.25rem\)\]/)
})

test('no ofrece sorting falso y el dataset sigue siendo completo/local', () => {
  assert.doesNotMatch(table, /useOperationalTableSort/)
  assert.doesNotMatch(table, /OperationalTableSortIndicator/)
  assert.doesNotMatch(table, /sortOperationalRows/)
  assert.match(table, /data\.filter\(row =>/)
  assert.match(action, /export async function getRouteSettlementsDashboardData\(\)/)
})

test('refresh conserva filas y usa indicador sin desmontar la tabla', () => {
  assert.match(table, /if \(isLoading && data\.length === 0\)/)
  assert.match(table, /Actualizando\.\.\./)
  assert.match(panel, /latestRequestIdRef\.current/)
  assert.match(panel, /requestId !== latestRequestIdRef\.current/)
})

test('acciones y doble clic conservan la semántica segura', () => {
  for (const label of ['Iniciar rendición', 'Abrir rendición', 'Ver detalle']) assert.match(table, new RegExp(label))
  assert.match(table, /shouldIgnoreOperationalRowDoubleClick/)
  assert.match(table, /onDoubleClick=\{\(event\) => \{ if \(!shouldIgnoreOperationalRowDoubleClick\(event\.target\)\) handleRowDoubleClick\(item\) \}\}/)
  assert.match(table, /onClick=\{\(e\) => \{\n\s+e\.stopPropagation\(\)/)
  assert.match(panel, /onRowDoubleClick=\{handleRowDoubleClick\}/)
  assert.match(panel, /onStartSettlement=\{handleRowDoubleClick\}/)
})

test('flujos de rendición y Fund Closures quedan fuera del alcance', () => {
  assert.match(panel, /<RouteSettlementWorkspace/)
  assert.match(panel, /<FundClosuresWorkspace \/>/)
  assert.match(table, /onStartSettlement\(item\)/)
  assert.doesNotMatch(table, /createRouteSettlementFromGuide/)
})
