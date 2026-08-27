import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const tablePath = new URL('../src/modules/adquisiciones/rendicion-rutas/components/unified-route-settlements-table.tsx', import.meta.url)
const panelPath = new URL('../src/modules/adquisiciones/rendicion-rutas/route-settlements-panel.tsx', import.meta.url)
const workspacePath = new URL('../src/modules/adquisiciones/rendicion-rutas/components/route-settlement-workspace.tsx', import.meta.url)
const [table, panel, workspace] = await Promise.all([
  readFile(tablePath, 'utf8'),
  readFile(panelPath, 'utf8'),
  readFile(workspacePath, 'utf8'),
])

test('la acción de fila distingue pendiente, editable y terminal', () => {
  assert.match(table, /'Iniciar rendición'/)
  assert.match(table, /'Abrir rendición'/)
  assert.match(table, /'Ver detalle'/)
  assert.match(table, /disabled=\{!item\.settlement_id && !canCreateSettlement\}/)
})

test('doble clic continúa siendo navegación y no inicio', () => {
  assert.match(table, /shouldIgnoreOperationalRowDoubleClick/)
  assert.match(table, /onDoubleClick=\{\(event\) => \{ if \(!shouldIgnoreOperationalRowDoubleClick\(event\.target\)\) handleRowDoubleClick\(item\) \}\}/)
  assert.match(table, /onRowDoubleClick\(row\)/)
  assert.match(workspace, /createRouteSettlementFromGuide\(guide\.id\)/)
})

test('workspace confirma, bloquea submit y maneja created/replayed', () => {
  assert.match(workspace, /window\.confirm\(/)
  assert.match(workspace, /isStartingSettlement/)
  assert.match(workspace, /setIsStartingSettlement\(true\)/)
  assert.match(workspace, /settlementResult\.replayed \? 'La rendición ya había sido iniciada\./)
  assert.match(panel, /onSettlementStarted=\{/)
})

test('abrir una rendición existente no se resetea por el cambio de view', () => {
  assert.match(panel, /setView\(\{ kind: 'loading-settlement', settlementId: row\.settlement_id \}\)/)
  assert.match(panel, /getRouteSettlementDetail\(row\.settlement_id\)/)
  assert.match(panel, /setView\(\{ kind: 'client-view', detail: settlementRes\.data \}\)/)
  assert.match(panel, /previousMainTabRef\.current === mainTab/)
  assert.match(panel, /\}, \[mainTab\]\)/)
  assert.match(panel, /startTransition\(\(\) => setView\(\{ kind: 'list' \}\)\)/)
  assert.match(panel, /viewRequestIdRef\.current \+= 1/)
  assert.match(panel, /requestId !== viewRequestIdRef\.current/)
  assert.match(panel, /router\.push\(`\$\{pathname\}\?tab=/)
  assert.doesNotMatch(panel, /\}, \[searchParams, view\.kind\]\)/)
})

test('la bandeja conserva un viewport interno con ancho mínimo profesional', () => {
  assert.match(table, /min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-auto/)
  assert.match(table, /min-w-\[1840px\]/)
  assert.match(table, /sticky top-0 z-20/)
  assert.match(panel, /h-\[calc\(100dvh-9\.75rem\)\] min-h-0 min-w-0 flex flex-col/)
  assert.match(panel, /lg:h-\[calc\(100dvh-7\.25rem\)\]/)
})
