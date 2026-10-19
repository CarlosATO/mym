import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PREPARATION_SYNC_CHECK_INTERVAL_MS,
  PREPARATION_SYNC_RUNNING_MAX_MINUTES,
  PREPARATION_SYNC_STALE_AFTER_MINUTES,
  decidePreparationSync,
  mergePreparationBoardRows,
  removeCardOptimistically,
  restoreCardOptimistically,
  shouldRefreshBoardAfterSync,
} from '../src/modules/logistica/preparacion-pedidos/preparation-sync-policy.ts'

test('regla base: 5 minutos y check cada 5 minutos', () => {
  assert.equal(PREPARATION_SYNC_STALE_AFTER_MINUTES, 5)
  assert.equal(PREPARATION_SYNC_CHECK_INTERVAL_MS, 5 * 60 * 1000)
})

test('A. entrada con sync fresco no dispara sync', () => {
  assert.deepEqual(
    decidePreparationSync({ lastSuccessAgeMinutes: 2, latestRunStatus: 'COMPLETED' }),
    { action: 'skip', reason: 'fresh' },
  )
})

test('B. entrada stale dispara sync', () => {
  assert.deepEqual(
    decidePreparationSync({ lastSuccessAgeMinutes: 8, latestRunStatus: 'COMPLETED' }),
    { action: 'sync', reason: 'stale' },
  )
})

test('C. si hay una corrida STARTED reciente no se lanza otra', () => {
  assert.equal(PREPARATION_SYNC_RUNNING_MAX_MINUTES, 15)
  assert.deepEqual(
    decidePreparationSync({ lastSuccessAgeMinutes: 8, latestRunStatus: 'STARTED', latestRunAgeMinutes: 2 }),
    { action: 'skip', reason: 'running' },
  )
})

test('C2. una corrida STARTED colgada no bloquea el autosync para siempre', () => {
  assert.deepEqual(
    decidePreparationSync({ lastSuccessAgeMinutes: 8, latestRunStatus: 'STARTED', latestRunAgeMinutes: 20 }),
    { action: 'sync', reason: 'stale' },
  )
})

test('D. sin evidencia de sync se solicita una corrida', () => {
  assert.deepEqual(
    decidePreparationSync({ lastSuccessAgeMinutes: null, latestRunStatus: null }),
    { action: 'sync', reason: 'no_evidence' },
  )
})

test('E. throttle evita reintentos inmediatos tras un fallo', () => {
  assert.deepEqual(
    decidePreparationSync({
      lastSuccessAgeMinutes: 8,
      latestRunStatus: 'FAILED',
      lastAttemptAt: 1_000_000,
      now: 1_030_000,
    }),
    { action: 'skip', reason: 'throttled' },
  )
})

test('F. merge no resucita exclusiones pendientes y conserva estados optimistas', () => {
  const rows = [
    { card_id: 'a', nv_bsale_id: 1, status: 'PENDING_ROUTE_PREP', total_quantity: 1 },
    { card_id: 'b', nv_bsale_id: 2, status: 'PENDING_ROUTE_PREP', total_quantity: 2 },
    { card_id: 'c', nv_bsale_id: 3, status: 'IN_PREPARATION', total_quantity: 3 },
  ]

  const merged = mergePreparationBoardRows(rows, {
    pendingStatuses: new Map([['a', 'IN_AUDIT']]),
    pendingExclusionNvIds: new Set([2]),
  })

  assert.deepEqual(merged, [
    { card_id: 'a', nv_bsale_id: 1, status: 'IN_AUDIT', total_quantity: 1 },
    { card_id: 'c', nv_bsale_id: 3, status: 'IN_PREPARATION', total_quantity: 3 },
  ])
})

test('G. exclusión optimista elimina y restaura en la posición original', () => {
  const cards = [{ card_id: 'a' }, { card_id: 'b' }, { card_id: 'c' }]
  const removed = removeCardOptimistically(cards, 'b')

  assert.deepEqual(removed.cards, [{ card_id: 'a' }, { card_id: 'c' }])
  assert.ok(removed.snapshot)
  assert.deepEqual(restoreCardOptimistically(removed.cards, removed.snapshot), cards)
})

test('G2. rollback no duplica una tarjeta que ya volvió', () => {
  const cards = [{ card_id: 'a' }, { card_id: 'b' }]
  const removed = removeCardOptimistically(cards, 'b')
  assert.deepEqual(restoreCardOptimistically(cards, removed.snapshot), cards)
})

test('H. sólo se refresca board tras sync propio o cambio de corrida exitosa', () => {
  assert.equal(shouldRefreshBoardAfterSync({ didRun: true, previousRunId: null, nextRunId: null }), true)
  assert.equal(shouldRefreshBoardAfterSync({ didRun: false, previousRunId: 'run-1', nextRunId: 'run-1' }), false)
  assert.equal(shouldRefreshBoardAfterSync({ didRun: false, previousRunId: 'run-1', nextRunId: 'run-2' }), true)
  assert.equal(shouldRefreshBoardAfterSync({ didRun: false, previousRunId: null, nextRunId: null }), false)
})

test('I. tras el throttle, un stale vuelve a solicitar sync', () => {
  assert.deepEqual(
    decidePreparationSync({
      lastSuccessAgeMinutes: 8,
      latestRunStatus: 'FAILED',
      lastAttemptAt: 1_000_000,
      now: 1_061_000,
    }),
    { action: 'sync', reason: 'stale' },
  )
})
