import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parseDateOnly, formatDateOnly } from '../src/modules/logistica/preparacion-pedidos/preparation-board-utils.ts'

const root = new URL('../', import.meta.url)
const syncSrc = await readFile(new URL('src/app/actions/integraciones/bsale-sync.ts', root), 'utf8')
const actionSrc = await readFile(new URL('src/app/actions/logistica/sales-order-preparation.ts', root), 'utf8')
const panelSrc = await readFile(new URL('src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx', root), 'utf8')
const cronOperationalSrc = await readFile(new URL('src/app/api/cron/warehouse-operational/route.ts', root), 'utf8')
const cardSrc = await readFile(new URL('src/modules/logistica/preparacion-pedidos/sales-order-card.tsx', root), 'utf8')
const drawerSrc = await readFile(new URL('src/modules/logistica/preparacion-pedidos/sales-order-drawer.tsx', root), 'utf8')
const pdfSrc = await readFile(new URL('src/lib/pdf/generate-preparation-orders-pdf.ts', root), 'utf8')
const printDocSrc = await readFile(new URL('src/modules/logistica/preparacion-pedidos/components/sales-order-print-document.tsx', root), 'utf8')

test('1. cron/background conserva 90 días por defecto sin degradar', () => {
  // El cron llama a runOperationalWarehouseBsaleRefresh(COMPANY_ID) sin opciones
  assert.match(cronOperationalSrc, /runOperationalWarehouseBsaleRefresh\(COMPANY_ID\)/)
  // La función usa 90 días como fallback default si no se pasa closureDocsRepairDays
  assert.match(syncSrc, /closureDocsRepairDays:\s*options\?\.closureDocsRepairDays\s*\?\?\s*90/)
})

test('2. manual usa explícitamente 30 días para no sufrir timeout en interacción de usuario', () => {
  const manualStart = syncSrc.indexOf('export async function runManualWarehouseBsaleRefresh')
  const manualEnd = syncSrc.indexOf('/**', manualStart)
  const manualBody = syncSrc.slice(manualStart, manualEnd)
  assert.match(manualBody, /runOperationalWarehouseBsaleRefresh\(companyId,\s*\{\s*closureDocsRepairDays:\s*30,?\s*\}\)/)
})

test('3. no se duplican pipelines: manual orquesta incremental y operacional compartidos', () => {
  const manualStart = syncSrc.indexOf('export async function runManualWarehouseBsaleRefresh')
  const manualEnd = syncSrc.indexOf('/**', manualStart)
  const manualBody = syncSrc.slice(manualStart, manualEnd)
  assert.match(manualBody, /runIncrementalWarehouseBsaleRefresh\(companyId\)/)
  assert.match(manualBody, /runOperationalWarehouseBsaleRefresh\(companyId/)
  assert.doesNotMatch(manualBody, /runFullWarehouseBsaleRefresh/)
  assert.doesNotMatch(manualBody, /fetchPreparationDocumentDetails/)
})

test('4. incremental OK + operational OK: flujo normal retorna éxito y conteos combinados', () => {
  const manualStart = syncSrc.indexOf('export async function runManualWarehouseBsaleRefresh')
  const manualEnd = syncSrc.indexOf('/**', manualStart)
  const manualBody = syncSrc.slice(manualStart, manualEnd)
  assert.match(manualBody, /return\s*\{\s*\.\.\.operational,\s*counts:\s*combinedCounts,?\s*\}/)
})

test('5. incremental OK + operational FAILED: conserva resultado parcial con error real y counts', () => {
  const manualStart = syncSrc.indexOf('export async function runManualWarehouseBsaleRefresh')
  const manualEnd = syncSrc.indexOf('/**', manualStart)
  const manualBody = syncSrc.slice(manualStart, manualEnd)
  assert.match(manualBody, /if\s*\(!operational\.success\)\s*\{/)
  assert.match(manualBody, /partial:\s*true/)
  assert.match(manualBody, /counts:\s*combinedCounts/)
  assert.match(manualBody, /success:\s*false/)

  // Server action propaga counts parciales
  assert.match(actionSrc, /if\s*\(!result\.success\)\s*\{[\s\S]*ok:\s*false[\s\S]*data:\s*result\.counts/)
})

test('6 & 7. si incremental creó tarjeta y operational falla: frontend recarga board y error queda visible', () => {
  assert.match(panelSrc, /const createdCount = res\.data\?\.new_cards \?\? 0/)
  assert.match(panelSrc, /if \(createdCount > 0 && mountedRef\.current\) \{[\s\S]*detailCacheRef\.current\.clear\(\)[\s\S]*await loadBoard\(\)/)
  // Error de operational sigue visible (no enmascara)
  assert.match(panelSrc, /setSyncError\(message\)/)
  // Mensaje diferenciado al usuario
  assert.match(panelSrc, /NV actualizadas \(\$\{createdCount\} nueva/)
})

test('8. incremental FAILED: no finge éxito ni recarga el board como si hubiera datos válidos', () => {
  const manualStart = syncSrc.indexOf('export async function runManualWarehouseBsaleRefresh')
  const manualEnd = syncSrc.indexOf('/**', manualStart)
  const manualBody = syncSrc.slice(manualStart, manualEnd)
  assert.match(manualBody, /if \(!incremental\.success \|\| !incremental\.counts\) return incremental/)
  // En el panel solo recarga si createdCount > 0
  assert.match(panelSrc, /if \(createdCount > 0 && mountedRef\.current\)/)
})

test('9. locks siguen funcionando con bsale_operational_prep_sync', () => {
  assert.match(syncSrc, /const lockName = 'bsale_operational_prep_sync'/)
  assert.match(syncSrc, /await acquireSyncLock\(companyId, lockName, runId, 10\)/)
  assert.match(syncSrc, /await releaseSyncLock\(companyId, lockName, runId\)/)
})

test('10. formateo de campos DATE-only (2026-10-19 -> 19/10/2026) sin desfase UTC', () => {
  const dateStr = '2026-10-19'
  const parsed = parseDateOnly(dateStr)
  assert.ok(parsed, 'parseDateOnly debe devolver una Date válida')
  assert.equal(parsed.getFullYear(), 2026)
  assert.equal(parsed.getMonth(), 9) // 0-indexed: 9 = octubre
  assert.equal(parsed.getDate(), 19) // Debe ser exactamente 19, NUNCA 18

  const formatted = formatDateOnly(dateStr)
  assert.equal(formatted, '19/10/2026')

  // En card, drawer, PDF y print document se usa parseDateOnly / formatDateOnly o regex seguro
  assert.match(cardSrc, /parseDateOnly\(value\)/)
  assert.match(drawerSrc, /parseDateOnly\(card\.nv_emission_date\)/)
  assert.match(drawerSrc, /formatDateOnly\(card\.route_date\)/)
  assert.ok(pdfSrc.includes('/^(\\d{4})-(\\d{2})-(\\d{2})/'), 'pdfSrc debe usar regex para parsear YYYY-MM-DD')
  assert.ok(printDocSrc.includes('/^(\\d{4})-(\\d{2})-(\\d{2})/'), 'printDocSrc debe usar regex para parsear YYYY-MM-DD')
})
