import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const sync = await readFile(new URL('src/app/actions/integraciones/bsale-sync.ts', root), 'utf8')
const action = await readFile(new URL('src/app/actions/logistica/sales-order-preparation.ts', root), 'utf8')
const panel = await readFile(new URL('src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx', root), 'utf8')
const middleware = await readFile(new URL('src/middleware.ts', root), 'utf8')
const workflow = await readFile(new URL('.github/workflows/bodega-warehouse-sync.yml', root), 'utf8')
const incrementalRoute = await readFile(new URL('src/app/api/cron/warehouse-incremental/route.ts', root), 'utf8')
const operationalRoute = await readFile(new URL('src/app/api/cron/warehouse-operational/route.ts', root), 'utf8')

test('incremental descubre NV y facturas con ventana solapada', () => {
  assert.match(sync, /documenttypeid=23[\s\S]*generationdaterange=/)
  assert.match(sync, /documenttypeid=5[\s\S]*generationdaterange=/)
  assert.match(sync, /checkpointDate\.getTime\(\) - 10 \* 60000/)
  assert.match(sync, /new Map<number, BsalePreparationDocument>/)
})

test('facturas relacionan por relatedDetailId y reconcilian cards', () => {
  assert.match(sync, /normalizeBsaleRelatedDetailId\(detail\.relatedDetailId\)/)
  assert.match(sync, /reconcile_bodega_preparation_cards/)
  assert.match(sync, /onConflict: 'company_id,bsale_id'/)
})

test('incremental no consulta el board y operacional sólo usa el board activo', () => {
  assert.match(sync, /runIncrementalWarehouseBsaleRefresh[\s\S]*discoverRecent: true[\s\S]*refreshActiveBoard: false/)
  assert.match(sync, /runOperationalWarehouseBsaleRefresh[\s\S]*discoverRecent: false[\s\S]*refreshActiveBoard: true/)
  assert.match(sync, /options\.refreshActiveBoard[\s\S]*vw_sales_order_preparation_board/)
  assert.match(sync, /options\.discoverRecent[\s\S]*documenttypeid=5/)
})

test('manual ejecuta incremental y operacional con ventana interactiva de 30 días, nunca FULL', () => {
  const manualStart = sync.indexOf('export async function runManualWarehouseBsaleRefresh')
  const manualEnd = sync.indexOf('/**', manualStart)
  const manual = sync.slice(manualStart, manualEnd)
  assert.match(manual, /runIncrementalWarehouseBsaleRefresh\(companyId\)/)
  assert.match(manual, /runOperationalWarehouseBsaleRefresh\(companyId,\s*\{\s*closureDocsRepairDays:\s*30,?\s*\}\)/)
  assert.doesNotMatch(manual, /runFullWarehouseBsaleRefresh/)
})

test('cron/background conserva 90 días por default sin duplicar pipelines', () => {
  assert.match(operationalRoute, /runOperationalWarehouseBsaleRefresh\(COMPANY_ID\)/)
  assert.match(sync, /closureDocsRepairDays:\s*options\?\.closureDocsRepairDays\s*\?\?\s*90/)
})

test('lock evita ejecuciones solapadas', () => {
  assert.match(sync, /acquireSyncLock\(companyId, lockName, runId, 10\)/)
  assert.match(sync, /SKIPPED_LOCKED: Sync already running/)
  assert.match(sync, /status: 'SKIPPED_LOCKED'/)
  assert.match(sync, /Ya existe una sincronización de Notas de Venta en curso\./)
  assert.match(incrementalRoute, /runIncrementalWarehouseBsaleRefresh/)
  assert.match(operationalRoute, /runOperationalWarehouseBsaleRefresh/)
  assert.match(incrementalRoute, /status === 'SKIPPED_LOCKED'[\s\S]*status: 409/)
  assert.match(operationalRoute, /status === 'SKIPPED_LOCKED'[\s\S]*status: 409/)
})

test('errores reales siguen siendo 500 y el lock queda liberable', () => {
  assert.match(incrementalRoute, /!result\.success[\s\S]*status: 500/)
  assert.match(operationalRoute, /!result\.success[\s\S]*status: 500/)
  assert.match(sync, /await releaseSyncLock\(companyId, lockName, runId\)/)
  assert.match(sync, /releaseSyncLock\(companyId, lockName, run\.id\)\.catch/)
})

test('scheduler ejecuta incremental cada 5 minutos y operacional cada 30', () => {
  assert.match(workflow, /cron: '\*\/5 \* \* \* \*'/)
  assert.match(workflow, /cron: '0,30 \* \* \* \*'/)
  assert.match(workflow, /warehouse-incremental/)
  assert.match(workflow, /warehouse-operational/)
  assert.match(middleware, /warehouse-incremental/)
  assert.match(middleware, /warehouse-operational/)
})

test('botón usa manual y la pantalla sólo refresca PetGroup', () => {
  assert.match(action, /runManualWarehouseBsaleRefresh\(companyId\)/)
  assert.match(action, /status: result\.status/)
  assert.match(action, /Ya existe una sincronización en curso\./)
  assert.match(panel, /PREPARATION_SYNC_CHECK_INTERVAL_MS/)
  assert.doesNotMatch(panel, /45_000/)
  assert.match(panel, /getSalesOrderPreparationBoard\(/)
  assert.doesNotMatch(panel, /runFullWarehouseBsaleRefresh|runReplenishmentBsaleSync/)
})
