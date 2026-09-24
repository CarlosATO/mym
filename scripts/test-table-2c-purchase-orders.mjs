import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const panelPath = new URL('../src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx', import.meta.url)
const actionPath = new URL('../src/app/actions/adquisiciones/purchase-orders.ts', import.meta.url)
const pagePath = new URL('../src/app/dashboard/adquisiciones/ordenes-compra/page.tsx', import.meta.url)
const warehouseCachePath = new URL('../src/modules/adquisiciones/ordenes-compra/warehouse-cache.ts', import.meta.url)
const analysisPath = new URL('../src/modules/adquisiciones/ordenes-compra/replenishment-analysis-panel.tsx', import.meta.url)
const migrationPath = new URL('../supabase/migrations/20260924184940_validate_purchase_order_prices_on_issue.sql', import.meta.url)
const [panel, action, page, warehouseCache, analysis, migration] = await Promise.all([
  readFile(panelPath, 'utf8'),
  readFile(actionPath, 'utf8'),
  readFile(pagePath, 'utf8'),
  readFile(warehouseCachePath, 'utf8'),
  readFile(analysisPath, 'utf8'),
  readFile(migrationPath, 'utf8'),
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

test('el formulario de OC permite ajustar líneas antes de emitir y reutiliza el estado actual', () => {
  for (const pattern of [
    /Agregar producto/,
    /onClick=\{focusProductSearch\}/,
    /function selectProductForAddition\(p: PurchaseOrderCatalogProduct\)/,
    /function addProductToItems\(\)/,
    /getPurchaseOrderProductCatalogCached/,
    /last_purchase_unit_cost/,
    /pendingQuantity/,
    /pendingUnitPrice/,
    /Sin precio disponible/,
    /invalidPriceItemIds/,
    /Hay productos sin precio unitario\. Complete el precio antes de emitir la orden\./,
    /aria-invalid=/,
    /linePriceInputRefs\.current\[invalidPriceItems\[0\]\.tempId\]\?\.focus\(\)/,
    /items\.some\(it => it\.product_id === p\.id\)/,
    /function removeItem\(tempId: string\)/,
    /setItems\(prev => prev\.filter\(it => it\.tempId !== tempId\)\)/,
    /value=\{it\.quantity\}/,
    /const grandTotal = netTotal - discountTotal \+ taxTotal/,
    /items: items\.map\(it =>/,
    /quantity: it\.quantity/,
    /handlePreviewPDF/,
    /downloadPOBooklet/,
  ]) {
    assert.match(panel, pattern)
  }
  assert.match(panel, /po\.status === 'BORRADOR'/)
  assert.doesNotMatch(panel, /po\.status === 'EMITIDA'[\s\S]*editPO\(po\)/)
})

test('la emisión de OC envía estado explícito y el backend permite borradores pero bloquea precios inválidos al emitir', () => {
  assert.match(action, /status\?: 'BORRADOR' \| 'EMITIDA'/)
  assert.match(panel, /status: 'EMITIDA'/)
  assert.match(migration, /v_status = 'EMITIDA'/)
  assert.match(migration, /NEW\.unit_price IS NULL OR NEW\.unit_price <= 0/)
  assert.match(migration, /NEW\.status = 'EMITIDA'/)
  assert.match(migration, /Hay productos sin precio unitario\. Complete el precio antes de emitir la orden\./)
})

test('no migra Reposición ni otros listados al cambiar Órdenes de Compra', () => {
  assert.doesNotMatch(panel, /OperationalTableSortIndicator/)
  assert.doesNotMatch(panel, /replenishment-table/)
  assert.doesNotMatch(panel, /warehouses-panel/)
})

test('el handoff de Reposición abre Nueva OC mediante searchParams explícito y conserva el payload', () => {
  assert.match(page, /prepareReplenishment = params\.prepare === 'replenishment'/)
  assert.match(page, /prepareReplenishment=\{prepareReplenishment\}/)
  assert.match(panel, /prepareReplenishment = false/)
  assert.match(panel, /if \(!prepareReplenishment \|\| typeof window === 'undefined'\) return/)
  assert.match(panel, /setForm\(prev => \(\{ \.\.\.prev, supplier_id: payload\.supplier\?\.id/)
  assert.match(panel, /setItems\(payload\.items\.map/)
  assert.match(panel, /setView\('form'\)/)
  assert.match(analysis, /source: 'EXCEL'/)
  assert.match(analysis, /filter\(row => row\.status === 'VALIDO'/)
  assert.match(analysis, /sessionStorage\.setItem\(REPLENISHMENT_PO_PREPARATION_KEY/)
  assert.match(analysis, /unit_price: cost !== null && cost !== undefined/)
})

test('las bodegas se precargan por empresa, reutilizan caché y solo consultan activas', () => {
  assert.match(warehouseCache, /const warehouseCache = new Map<string,/)
  assert.match(warehouseCache, /company\.id/)
  assert.match(warehouseCache, /WAREHOUSE_CACHE_TTL_MS = 60_000/)
  assert.match(warehouseCache, /getWarehouses\(\{ is_active: 'true', page: 1, pageSize: 1000 \}\)/)
  assert.match(warehouseCache, /warehouse\.is_active/)
  assert.match(warehouseCache, /prefetchPurchaseOrderWarehouses/)
  assert.match(panel, /getPurchaseOrderWarehousesCached/)
  assert.match(panel, /setWarehouses\(warehouses\)/)
  assert.match(panel, /w\.is_active/)
  assert.match(panel, /onClick=\{\(\) => \{ setForm\(p => \(\{ \.\.\.p, warehouse_id: w\.id \}\)\)/)
  assert.match(warehouseCache, /if \(cached && cached\.expiresAt > now\) return cached\.promise/)
})
