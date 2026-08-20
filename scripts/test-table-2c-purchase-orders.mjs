import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const panelPath = new URL('../src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx', import.meta.url)
const actionPath = new URL('../src/app/actions/adquisiciones/purchase-orders.ts', import.meta.url)
const [panel, action] = await Promise.all([
  readFile(panelPath, 'utf8'),
  readFile(actionPath, 'utf8'),
])

test('Órdenes de Compra usa Operational Table con key y columnas independientes', () => {
  assert.match(panel, /useOperationalTableWidths\(PURCHASE_ORDERS_TABLE_KEY, PURCHASE_ORDER_COLUMNS\)/)
  assert.match(panel, /mym:table:adquisiciones:ordenes-compra/)
  assert.equal((panel.match(/id: '/g) ?? []).filter(match => match).length >= 12, true)
  assert.match(panel, /id: 'supplier', defaultWidth: 250/)
  assert.match(panel, /id: 'actions', defaultWidth: 115[\s\S]*sticky: 'right'/)
})

test('resize, persistencia, reset, separadores y scroll interno están configurados', () => {
  assert.match(panel, /OperationalTableResizeHandle/)
  assert.match(panel, /onResizeEnd=\{persist\}/)
  assert.match(panel, /resetWidths/)
  assert.match(panel, /Restablecer anchos/)
  assert.match(panel, /border-r border-theme-border\/30/)
  assert.match(panel, /min-w-\[1650px\].*table-fixed whitespace-nowrap/)
  assert.match(panel, /overflow-x-auto overflow-y-auto/)
})

test('no ofrece sorting falso sobre el contrato paginado server-side', () => {
  assert.doesNotMatch(panel, /useOperationalTableSort/)
  assert.doesNotMatch(panel, /OperationalTableSortIndicator/)
  assert.doesNotMatch(panel, /sortOperationalRows/)
  assert.match(action, /\.rpc\('get_purchase_orders'/)
  assert.match(action, /page: filters\.page \?\? 1/)
  assert.match(action, /page_size: filters\.pageSize \?\? 50/)
})

test('refresh conserva filas, descarta respuestas antiguas y mantiene la tabla operativa', () => {
  assert.match(panel, /initialLoading/)
  assert.match(panel, /refreshing/)
  assert.match(panel, /requestSequence\.current/)
  assert.match(panel, /if \(requestId !== requestSequence\.current\) return/)
  assert.match(panel, /Actualizando\.\.\./)
  assert.doesNotMatch(panel, /refreshing \? \(/)
})

test('doble clic abre la OC natural e ignora controles interactivos', () => {
  assert.match(panel, /shouldIgnoreOperationalRowDoubleClick/)
  assert.match(panel, /onDoubleClick=\{event => \{ if \(!shouldIgnoreOperationalRowDoubleClick\(event\.target\)\) openDetail\(po\) \}\}/)
  assert.match(panel, /onClick=\{e => e\.stopPropagation\(\)\}/)
  assert.match(panel, /title="Ver detalle"/)
  assert.match(panel, /title="Editar"/)
  assert.match(panel, /title="Cancelar"/)
})

test('los flujos de OC existentes permanecen presentes', () => {
  for (const pattern of [
    /createPurchaseOrder/,
    /updatePurchaseOrderStatus/,
    /handleDownloadPDF/,
    /setView\('form'\)/,
    /openPOById/,
    /getPurchaseOrderDetail/,
    /setView\('analysis'\)/,
    /supplier_id/,
    /warehouse_id/,
    /filters\.status/,
    /filters\.po_type/,
    /Anterior/,
    /Siguiente/,
  ]) {
    assert.match(panel, pattern)
  }
})

test('no migra Reposición ni otros listados al cambiar Órdenes de Compra', () => {
  assert.doesNotMatch(panel, /OperationalTableSortIndicator/)
  assert.doesNotMatch(panel, /replenishment-table/)
  assert.doesNotMatch(panel, /warehouses-panel/)
})
