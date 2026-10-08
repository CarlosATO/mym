import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const sync = await readFile(new URL('src/app/actions/integraciones/bsale-sync.ts', root), 'utf8')
const health = await readFile(new URL('src/app/actions/integraciones/sync.ts', root), 'utf8')
const action = await readFile(new URL('src/app/actions/logistica/sales-order-preparation.ts', root), 'utf8')
const panel = await readFile(new URL('src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx', root), 'utf8')
const migration = await readFile(new URL('supabase/migrations/20261007182000_bodega_operational_freshness.sql', root), 'utf8')

test('el refresco operacional incluye todas las cards abiertas, no sólo NV recientes', () => {
  assert.match(sync, /from\('vw_sales_order_preparation_board'\)/)
  assert.match(sync, /\.in\('status', \['PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT'\]\)/)
  assert.match(sync, /const activeNvIds = \[\.\.\.new Set\(/)
  assert.doesNotMatch(sync, /activeNvIds[\s\S]*?\.filter\(id => !bsaleDocsMap\.has\(id\)\)/)
  assert.match(sync, /mapWithConcurrency\(\s*activeNvIds/)
})

test('discovery y refresh quedan separados y el refresh tiene concurrencia limitada', () => {
  assert.match(sync, /generationdaterange=\$\{rangeEncoded\}/)
  assert.match(sync, /export const PREPARATION_REFRESH_CONCURRENCY = 6/)
  assert.match(sync, /fetch\(url, \{ headers: prepHeaders, signal: AbortSignal\.timeout\(15000\) \}\)/)
  assert.match(sync, /fetchPreparationDocumentDetails\(prepBase, prepHeaders, doc\.id/)
})

test('la reconciliación se ejecuta después de documentos y detalles', () => {
  assert.match(sync, /const preparationResult = await materializePreparationAfterSalesSync\(companyId\)/)
  assert.match(sync, /relations_created: preparationResult\?\.relations_created/)
  assert.match(sync, /cards_closed: \(preparationResult\?\.closed_invoiced \|\| 0\)/)
})

test('el botón usa el flujo operacional y conserva el refetch único explícito', () => {
  assert.match(action, /syncBsaleSalesOrdersForPreparation\(companyId\)/)
  assert.match(panel, /const res = await syncOperationalBsaleSalesOrders\(\)/)
  assert.match(panel, /await loadBoard\(\)/)
})

test('la salud del Kanban usa exclusivamente corridas WAREHOUSE_OPERATIONAL', () => {
  assert.match(health, /getWarehousePreparationSyncHealth/)
  assert.match(health, /\.eq\('trigger', 'WAREHOUSE_OPERATIONAL'\)/)
  assert.match(panel, /getWarehousePreparationSyncHealth\(\)/)
  assert.doesNotMatch(panel, /getBsaleSalesSyncHealth\(\)/)
})

test('el FULL es explícito, idempotente y usa paginación exhaustiva sin truncar', () => {
  assert.match(sync, /export async function runFullWarehouseBsaleRefresh\(companyId: string\)/)
  assert.match(sync, /path: '\/documents\.json', params: \{ documenttypeid: 23, expand: 'details' \}/)
  assert.match(sync, /path: '\/documents\.json', params: \{ documenttypeid: 5, expand: 'details' \}/)
  assert.match(sync, /WAREHOUSE_FULL/)
  assert.match(sync, /onConflict: 'company_id,bsale_id'/)
  assert.match(sync, /vw_sales_order_preparation_board[\s\S]*?PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT'/)
  assert.match(sync, /related_detail_bsale_id: normalizeBsaleRelatedDetailId\(detail\.relatedDetailId\)/)
  assert.match(sync, /finishSyncRun\(run\.id, 'FAILED'/)
  assert.doesNotMatch(sync.slice(sync.indexOf('export async function runFullWarehouseBsaleRefresh')), /references\.json/)
  assert.match(sync, /expand: 'details'/)
  assert.match(sync, /completeExpandedPreparationDetails/)
  assert.match(sync, /client_get_requests/)
  assert.match(sync, /document_seller_requests: 0/)
  assert.match(sync, /invoice_reference_requests: 0/)
  assert.match(sync, /knownMissingIds/)
  assert.match(sync, /select\('nv_bsale_id'\)/)
  assert.doesNotMatch(sync.slice(sync.indexOf('export async function runFullWarehouseBsaleRefresh')), /TRUNCATE\s+integraciones/i)
  assert.doesNotMatch(sync, /delete\(\)\.eq\('company_id', companyId\)\.eq\('document_type_id'/)
})

test('state 8888 permanece visible y no recibe cierre automático', () => {
  assert.match(migration, /nv\.state IN \(0, 8888\)/)
  assert.doesNotMatch(migration, /nv\.state IN \(0, 1, 8888\)/)
  assert.match(sync, /Number\(doc\.state\) === 0\)/)
})
