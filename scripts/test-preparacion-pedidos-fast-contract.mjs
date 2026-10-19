import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const panel = await readFile(new URL('src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx', root), 'utf8')
const action = await readFile(new URL('src/app/actions/logistica/sales-order-preparation.ts', root), 'utf8')
const drawer = await readFile(new URL('src/modules/logistica/preparacion-pedidos/preparation-exclusions-drawer.tsx', root), 'utf8')
const policy = await readFile(new URL('src/modules/logistica/preparacion-pedidos/preparation-sync-policy.ts', root), 'utf8')

test('la política usa 5 minutos como fuente única y el panel no hace polling de 45s', () => {
  assert.match(policy, /PREPARATION_SYNC_STALE_AFTER_MINUTES = 5/)
  assert.match(panel, /PREPARATION_SYNC_CHECK_INTERVAL_MS/)
  assert.match(panel, /PREPARATION_SYNC_STALE_AFTER_MINUTES/)
  assert.doesNotMatch(panel, /45_000/)
})

test('autosync al entrar, por intervalo y al volver visible, con cleanup', () => {
  assert.match(panel, /maybeAutoSync\('mount'\)/)
  assert.match(panel, /maybeAutoSync\('interval'\)/)
  assert.match(panel, /maybeAutoSync\('visibility'\)/)
  assert.match(panel, /document\.addEventListener\('visibilitychange'/)
  assert.match(panel, /document\.removeEventListener\('visibilitychange'/)
  assert.match(panel, /window\.clearInterval\(interval\)/)
  assert.match(panel, /PREPARATION_SYNC_CHECK_INTERVAL_MS/)
})

test('servidor decide frescura y reutiliza el pipeline manual existente', () => {
  assert.match(action, /export async function syncOperationalBsaleSalesOrdersIfStale/)
  assert.match(action, /getWarehousePreparationSyncHealth\(\)/)
  assert.match(action, /decidePreparationSync\(/)
  const staleStart = action.indexOf('export async function syncOperationalBsaleSalesOrdersIfStale')
  const stale = action.slice(staleStart)
  assert.match(stale, /await syncOperationalBsaleSalesOrders\(\)/)
  assert.match(stale, /SKIPPED_LOCKED/)
  assert.match(stale, /skipped: 'running'/)
})

test('manual y autosync comparten pipeline; no hay implementación paralela', () => {
  assert.match(action, /runManualWarehouseBsaleRefresh\(companyId\)/)
  assert.match(panel, /syncOperationalBsaleSalesOrders\(\)/)
  assert.match(panel, /syncOperationalBsaleSalesOrdersIfStale\(\)/)
  assert.match(panel, /runSync\('manual'\)/)
  assert.doesNotMatch(panel, /window\.location\.reload/)
})

test('exclusión optimista: cierra, remueve antes de persistir y no recarga board al éxito', () => {
  const persistStart = panel.indexOf('const persistExclusion = async')
  const persistEnd = panel.indexOf('const handleExclusionConfirm = async')
  const persist = panel.slice(persistStart, persistEnd)
  const confirmStart = panel.indexOf('const handleExclusionConfirm = async')
  const confirmEnd = panel.indexOf('const loadBoard = useCallback')
  const confirm = panel.slice(confirmStart, confirmEnd)

  assert.ok(persistStart >= 0 && persistEnd > persistStart)
  assert.doesNotMatch(persist, /loadBoard\(/)
  assert.match(persist, /restoreCardOptimistically/)
  assert.match(persist, /toast\.error/)
  assert.match(confirm, /removeCardOptimistically/)
  assert.match(confirm, /setExcludeCard\(null\)/)
  assert.match(confirm, /setCards\(optimistic\.cards\)/)
  assert.match(confirm, /void persistExclusion\(/)
  assert.ok(confirm.indexOf('setCards(optimistic.cards)') < confirm.indexOf('void persistExclusion('))
})

test('protección contra respuestas stale y doble submit', () => {
  assert.match(panel, /boardRequestSeqRef/)
  assert.match(panel, /pendingStatusByCardRef/)
  assert.match(panel, /pendingExclusionNvIdsRef/)
  assert.match(panel, /mergePreparationBoardRows/)
  assert.match(panel, /pendingExclusionNvIdsRef\.current\.has\(card\.nv_bsale_id\)/)
  assert.match(panel, /restoreCardOptimistically/)
})

test('drawer no consulta historial si está cerrado y refresca sólo si está abierto', () => {
  assert.match(drawer, /refreshToken\?: number/)
  assert.match(drawer, /\[open, load, refreshToken\]/)
  assert.match(drawer, /if \(open\)/)
})

test('indicador de frescura y error no bloqueante', () => {
  assert.match(panel, /Sincronizando…/)
  assert.match(panel, /Actualizado/)
  assert.match(panel, /Desactualizado/)
  assert.match(panel, /ERROR/)
  assert.match(panel, /setSyncError/)
  assert.match(panel, /title=\{syncError \|\| undefined\}/)
})

test('instrumentación mínima de desarrollo/test', () => {
  assert.match(panel, /markPreparationBoardFetch\(\)/)
  assert.match(panel, /recordPreparationDuration\('boardLoad'/)
  assert.match(panel, /recordPreparationDuration\('exclusionPersist'/)
  assert.match(panel, /recordPreparationDuration\('sync'/)
})
