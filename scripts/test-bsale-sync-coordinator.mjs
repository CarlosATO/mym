import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  BsaleRateLimitError,
  BsaleSyncCredentialResolutionError,
  bsaleProtectedFetch,
  buildBsaleSyncDedupeKey,
  buildBsaleSyncRequestContract,
  getBsaleSyncRolloutConfig,
  parseBsaleRetryAfterSeconds,
  resolveBsaleCredentialScope,
  runWithBsaleSyncCoordinator,
} from '../src/lib/integraciones/bsale-sync-coordinator.ts'

const COMPANY_CAYLO = 'd1000000-0000-0000-0000-000000000001'
const COMPANY_AMIMASCOTA = 'd3000000-0000-0000-0000-000000000003'

function createAtomicTestStore() {
  const locks = new Map()
  const cooldowns = new Map()
  let nowMs = Date.now()
  let failNextRenews = 0

  const keyOf = (companyId, lockName) => `${companyId}:${lockName}`
  const purgeExpired = (scope, companyId, lockName) => {
    for (const [k, row] of locks.entries()) {
      if (row.expiresAtMs <= nowMs && ((row.companyId === companyId && row.lockName === lockName) || row.credentialScope === scope)) {
        locks.delete(k)
      }
    }
    const cd = cooldowns.get(scope)
    if (cd && cd.blockedUntilMs <= nowMs) {
      cooldowns.delete(scope)
    }
  }

  return {
    advanceTimeMs(ms) {
      nowMs += ms
    },
    injectRenewConnectionFailures(count) {
      failNextRenews = count
    },
    snapshot() {
      return [...locks.values()]
    },
    cooldownSnapshot() {
      return [...cooldowns.entries()]
    },
    async acquire(params) {
      if (!params.credentialScope || !params.credentialScope.startsWith('cred:')) {
        throw new Error('BSALE_SYNC_COORDINATOR_INVALID_CREDENTIAL_SCOPE')
      }
      purgeExpired(params.credentialScope, params.companyId, params.lockName)
      const incompatible = new Set([params.lockName, ...(params.incompatibleLockNames ?? [])])
      for (const row of locks.values()) {
        if (row.expiresAtMs <= nowMs) continue
        if (row.credentialScope !== params.credentialScope && row.companyId !== params.companyId) continue
        if (row.ownerToken === params.ownerToken) continue
        if (incompatible.has(row.lockName) || (params.resourceKey && row.resourceKey === params.resourceKey)) {
          return {
            acquired: false,
            blocking: {
              lockName: row.lockName,
              operationKind: row.operationKind,
              runId: row.runId,
              resourceKey: row.resourceKey,
              expiresAt: new Date(row.expiresAtMs).toISOString(),
            },
          }
        }
      }

      const activeCooldown = cooldowns.get(params.credentialScope)
      if (activeCooldown && activeCooldown.blockedUntilMs > nowMs) {
        return {
          acquired: false,
          blocking: {
            lockName: 'bsale_rate_limit_cooldown',
            operationKind: 'HTTP_429_COOLDOWN',
            runId: null,
            resourceKey: null,
            expiresAt: new Date(activeCooldown.blockedUntilMs).toISOString(),
            reason: 'COOLDOWN_ACTIVE',
            retryAfterSeconds: activeCooldown.retryAfterSeconds,
          },
        }
      }

      const key = keyOf(params.companyId, params.lockName)
      const existing = locks.get(key)
      if (existing && existing.expiresAtMs > nowMs && existing.ownerToken !== params.ownerToken) {
        return {
          acquired: false,
          blocking: {
            lockName: existing.lockName,
            operationKind: existing.operationKind,
            runId: existing.runId,
            resourceKey: existing.resourceKey,
            expiresAt: new Date(existing.expiresAtMs).toISOString(),
          },
        }
      }

      const serverNow = new Date(nowMs).toISOString()
      const expiresAtMs = nowMs + params.ttlSeconds * 1000
      locks.set(key, {
        companyId: params.companyId,
        lockName: params.lockName,
        ownerToken: params.ownerToken,
        operationKind: params.operationKind,
        credentialScope: params.credentialScope,
        resourceKey: params.resourceKey,
        runId: params.runId,
        expiresAtMs,
        leaseCount: existing?.ownerToken === params.ownerToken ? existing.leaseCount + 1 : 1,
      })
      return {
        acquired: true,
        serverNow,
        expiresAt: new Date(expiresAtMs).toISOString(),
      }
    },
    async renew(params) {
      if (failNextRenews > 0) {
        failNextRenews -= 1
        throw new Error('ECONNRESET: fallo de conexión con PostgreSQL durante renew')
      }
      const key = keyOf(params.companyId, params.lockName)
      const existing = locks.get(key)
      const serverNow = new Date(nowMs).toISOString()
      if (
        !existing
        || existing.ownerToken !== params.ownerToken
        || existing.credentialScope !== params.credentialScope
        || existing.expiresAtMs <= nowMs
      ) {
        return { renewed: false, reason: 'LOCK_LOST_OR_EXPIRED', serverNow }
      }
      existing.expiresAtMs = nowMs + params.ttlSeconds * 1000
      existing.leaseCount += 1
      return {
        renewed: true,
        serverNow,
        expiresAt: new Date(existing.expiresAtMs).toISOString(),
      }
    },
    async release(params) {
      const key = keyOf(params.companyId, params.lockName)
      const existing = locks.get(key)
      if (
        !existing
        || existing.ownerToken !== params.ownerToken
        || existing.credentialScope !== params.credentialScope
      ) {
        return { released: false, reason: 'NOT_OWNER_OR_ALREADY_RELEASED' }
      }
      locks.delete(key)
      return { released: true }
    },
    async registerCooldown(params) {
      const blockedUntilMs = nowMs + params.retryAfterSeconds * 1000
      cooldowns.set(params.credentialScope, {
        blockedUntilMs,
        retryAfterSeconds: params.retryAfterSeconds,
      })
      return {
        blockedUntil: new Date(blockedUntilMs).toISOString(),
        retryAfterSeconds: params.retryAfterSeconds,
      }
    },
  }
}

test('1. Dos solicitudes simultáneas: exactamente una adquiere y la segunda recibe LOCK_BUSY', async () => {
  const store = createAtomicTestStore()
  let releaseFirst
  const gate = new Promise(resolve => { releaseFirst = resolve })

  const p1 = runWithBsaleSyncCoordinator({
    companyId: COMPANY_CAYLO,
    operationKind: 'OPERATIONAL_PREP_SYNC',
    lockName: 'bsale_operational_prep_sync',
    credentialScope: 'cred:caylo',
    store,
    execute: async () => {
      await gate
      return 'first-done'
    },
  })

  await new Promise(resolve => setTimeout(resolve, 10))
  const p2 = runWithBsaleSyncCoordinator({
    companyId: COMPANY_CAYLO,
    operationKind: 'OPERATIONAL_PREP_SYNC',
    lockName: 'bsale_operational_prep_sync',
    credentialScope: 'cred:caylo',
    store,
    execute: async () => 'second-should-not-run',
  })

  const r2 = await p2
  assert.equal(r2.status, 'LOCK_BUSY')
  assert.equal(r2.ok, false)
  assert.equal(r2.blocking.lockName, 'bsale_operational_prep_sync')

  releaseFirst()
  const r1 = await p1
  assert.equal(r1.status, 'SUCCESS')
  assert.equal(r1.data, 'first-done')
  assert.equal(store.snapshot().length, 0)
})

test('2. Sync general activo bloquea solicitud operativa y full refresh de Bodega', async () => {
  const store = createAtomicTestStore()
  let releaseGeneral
  const gate = new Promise(resolve => { releaseGeneral = resolve })

  const generalPromise = runWithBsaleSyncCoordinator({
    companyId: COMPANY_CAYLO,
    operationKind: 'REPLENISHMENT_SYNC',
    lockName: 'bsale_replenishment_sync',
    credentialScope: 'cred:caylo',
    store,
    execute: async () => {
      await gate
      return 'general-ok'
    },
  })

  await new Promise(resolve => setTimeout(resolve, 10))
  const opResult = await runWithBsaleSyncCoordinator({
    companyId: COMPANY_CAYLO,
    operationKind: 'OPERATIONAL_PREP_SYNC',
    lockName: 'bsale_operational_prep_sync',
    credentialScope: 'cred:caylo',
    store,
    execute: async () => 'op-should-not-run',
  })
  assert.equal(opResult.status, 'LOCK_BUSY')
  assert.equal(opResult.blocking.lockName, 'bsale_replenishment_sync')

  releaseGeneral()
  const genRes = await generalPromise
  assert.equal(genRes.status, 'SUCCESS')
})

test('3. Retry-After superior a 300s se respeta íntegramente y bloquea adquisiciones directas del mismo alcance', async () => {
  assert.equal(parseBsaleRetryAfterSeconds('720', null), 720)
  assert.equal(parseBsaleRetryAfterSeconds('1800', null), 1800)
  assert.equal(parseBsaleRetryAfterSeconds(null, '{"retry_after":950}'), 950)

  const store = createAtomicTestStore()
  const failedDirect = await runWithBsaleSyncCoordinator({
    companyId: COMPANY_CAYLO,
    operationKind: 'WAREHOUSE_MANUAL',
    credentialScope: 'cred:shared-cooldown',
    store,
    execute: async () => {
      throw new BsaleRateLimitError('Bsale HTTP 429', 720)
    },
  })
  assert.equal(failedDirect.status, 'TECHNICAL_ERROR')

  // Adquisición directa subsiguiente (incluso de otra empresa con misma credencial) queda bloqueada por cooldown 720s
  const blockedDirect = await runWithBsaleSyncCoordinator({
    companyId: COMPANY_AMIMASCOTA,
    operationKind: 'OPERATIONAL_PREP_SYNC',
    credentialScope: 'cred:shared-cooldown',
    store,
    execute: async () => 'must-not-bypass-cooldown',
  })
  assert.equal(blockedDirect.status, 'LOCK_BUSY')
  assert.equal(blockedDirect.blocking.reason, 'COOLDOWN_ACTIVE')
  assert.equal(blockedDirect.blocking.retryAfterSeconds, 720)

  // A los 500s (> 300s, < 720s) sigue bloqueado porque NO se truncó a 300s
  store.advanceTimeMs(500_000)
  const stillBlockedAt500s = await runWithBsaleSyncCoordinator({
    companyId: COMPANY_CAYLO,
    operationKind: 'OPERATIONAL_PREP_SYNC',
    credentialScope: 'cred:shared-cooldown',
    store,
    execute: async () => 'still-blocked',
  })
  assert.equal(stillBlockedAt500s.status, 'LOCK_BUSY')

  // Tras superar los 720s, vuelve a adquirir normalmente
  store.advanceTimeMs(225_000)
  const allowedAfter720s = await runWithBsaleSyncCoordinator({
    companyId: COMPANY_CAYLO,
    operationKind: 'OPERATIONAL_PREP_SYNC',
    credentialScope: 'cred:shared-cooldown',
    store,
    execute: async () => 'recovered-after-720s',
  })
  assert.equal(allowedAfter720s.status, 'SUCCESS')
})

test('4. Dos empresas con credencial compartida se excluyen mutuamente pero conservan dedupeKey separada por companyId', async () => {
  const contractA = buildBsaleSyncRequestContract({
    companyId: COMPANY_CAYLO,
    operationKind: 'WAREHOUSE_MANUAL',
    credentialScope: 'cred:shared-token-xyz',
  })
  const contractB = buildBsaleSyncRequestContract({
    companyId: COMPANY_AMIMASCOTA,
    operationKind: 'WAREHOUSE_MANUAL',
    credentialScope: 'cred:shared-token-xyz',
  })
  assert.equal(contractA.credentialScope, contractB.credentialScope)
  assert.notEqual(contractA.dedupeKey, contractB.dedupeKey)
  assert.equal(
    buildBsaleSyncDedupeKey({ companyId: COMPANY_CAYLO, operationKind: 'CARD_SYNC', resourceKey: 'card:99' }),
    `${COMPANY_CAYLO}:CARD_SYNC:card:99`,
  )
})

test('5. Fallo cerrado si no se pueden resolver las credenciales y flags de rollout reversibles', async () => {
  assert.throws(
    () => resolveBsaleCredentialScope('00000000-0000-0000-0000-999999999999'),
    (err) => err instanceof BsaleSyncCredentialResolutionError && /BSALE_SYNC_CREDENTIALS_UNRESOLVED/.test(err.message),
  )

  const prevCoord = process.env.BSALE_SYNC_COORDINATOR_ENABLED
  const prevQueue = process.env.BSALE_SYNC_QUEUE_ENABLED
  const prevSup = process.env.BSALE_SYNC_SUPERVISOR_ENABLED
  try {
    delete process.env.BSALE_SYNC_COORDINATOR_ENABLED
    delete process.env.BSALE_SYNC_QUEUE_ENABLED
    delete process.env.BSALE_SYNC_SUPERVISOR_ENABLED
    assert.deepEqual(getBsaleSyncRolloutConfig(), {
      coordinatorEnabled: true,
      queueEnabled: true,
      supervisorEnabled: true,
    })

    process.env.BSALE_SYNC_SUPERVISOR_ENABLED = 'false'
    assert.deepEqual(getBsaleSyncRolloutConfig(), {
      coordinatorEnabled: true,
      queueEnabled: true,
      supervisorEnabled: false,
    })

    process.env.BSALE_SYNC_QUEUE_ENABLED = 'false'
    assert.deepEqual(getBsaleSyncRolloutConfig(), {
      coordinatorEnabled: true,
      queueEnabled: false,
      supervisorEnabled: false,
    })

    process.env.BSALE_SYNC_COORDINATOR_ENABLED = 'false'
    assert.deepEqual(getBsaleSyncRolloutConfig(), {
      coordinatorEnabled: false,
      queueEnabled: false,
      supervisorEnabled: false,
    })
  } finally {
    if (prevCoord === undefined) delete process.env.BSALE_SYNC_COORDINATOR_ENABLED
    else process.env.BSALE_SYNC_COORDINATOR_ENABLED = prevCoord
    if (prevQueue === undefined) delete process.env.BSALE_SYNC_QUEUE_ENABLED
    else process.env.BSALE_SYNC_QUEUE_ENABLED = prevQueue
    if (prevSup === undefined) delete process.env.BSALE_SYNC_SUPERVISOR_ENABLED
    else process.env.BSALE_SYNC_SUPERVISOR_ENABLED = prevSup
  }
})

test('6. Expiración confirmada por PostgreSQL, fallo de conexión en renew y cancelación de HTTP protegido', async () => {
  const store = createAtomicTestStore()
  let protectedWriteAttempted = false
  let fetchWasAborted = false

  const res = await runWithBsaleSyncCoordinator({
    companyId: COMPANY_CAYLO,
    operationKind: 'OPERATIONAL_PREP_SYNC',
    lockName: 'bsale_operational_prep_sync',
    credentialScope: 'cred:caylo',
    ttlSeconds: 1,
    heartbeatIntervalMs: 30,
    leaseSafetyMarginMs: 120,
    store,
    execute: async (lease) => {
      const initialConfirmed = lease.confirmedExpiresAt
      assert.ok(Date.parse(initialConfirmed) > 0)

      store.advanceTimeMs(40)
      await new Promise(resolve => setTimeout(resolve, 45))
      assert.equal(lease.renewedCount >= 1, true)
      assert.notEqual(lease.confirmedExpiresAt, initialConfirmed)

      store.injectRenewConnectionFailures(10_000)

      try {
        await bsaleProtectedFetch('https://api.bsale.test/v1/documents.json', {
          fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
            const socketRef = setTimeout(() => reject(new Error('Mock socket timeout')), 5_000)
            if (init?.signal?.aborted) {
              clearTimeout(socketRef)
              fetchWasAborted = true
              reject(init.signal.reason ?? new Error('Aborted'))
              return
            }
            init?.signal?.addEventListener('abort', () => {
              clearTimeout(socketRef)
              fetchWasAborted = true
              reject(init.signal.reason ?? new Error('Aborted'))
            }, { once: true })
          }),
        })
      } catch (err) {
        assert.equal(fetchWasAborted, true)
        throw err
      }

      protectedWriteAttempted = true
      return 'unreachable'
    },
  })

  assert.equal(fetchWasAborted, true)
  assert.equal(protectedWriteAttempted, false)
  assert.equal(res.status, 'TECHNICAL_ERROR')
  assert.match(res.error, /BSALE_SYNC_LEASE_UNVERIFIED/)
})

test('7. Contratos SQL endurecidos: sin borrado por solo owner_token y con cooldown directo', async () => {
  const coordSql = await readFile(
    new URL('../supabase/migrations/20261127151840_integraciones_bsale_sync_coordinator.sql', import.meta.url),
    'utf8',
  )
  const queueSql = await readFile(
    new URL('../supabase/migrations/20261127151858_integraciones_bsale_sync_queue.sql', import.meta.url),
    'utf8',
  )
  assert.match(coordSql, /register_bsale_scope_cooldown_v1/)
  assert.match(coordSql, /COOLDOWN_ACTIVE/)
  assert.doesNotMatch(queueSql, /LEAST\(300/)
  assert.doesNotMatch(queueSql, /WHERE l\.owner_token = p_owner_token;/)
  assert.match(queueSql, /LEASE_EXPIRED_BEFORE_COMPLETE/)
})

test('8. Cierre SYNC-02: complete valida identidad/RUNNING/asociación antes de liberar y recover/claim usan advisory locks no bloqueantes', async () => {
  const queueSql = await readFile(
    new URL('../supabase/migrations/20261127151858_integraciones_bsale_sync_queue.sql', import.meta.url),
    'utf8',
  )
  const fnBody = (name) => {
    const start = queueSql.indexOf(`FUNCTION integraciones.${name}(`)
    assert.ok(start >= 0, `no se encontró ${name}`)
    const end = queueSql.indexOf('$$;', queueSql.indexOf('AS $$', start))
    return queueSql.slice(start, end)
  }

  const complete = fnBody('complete_bsale_sync_request_v1')
  const runningCheck = complete.indexOf(`AND q.status = 'RUNNING'`)
  const firstLockDelete = complete.indexOf('DELETE FROM integraciones.bsale_sync_locks')
  assert.ok(runningCheck > 0 && firstLockDelete > runningCheck, 'la validación RUNNING debe preceder a cualquier DELETE de bloqueo')
  assert.match(complete, /metadata ->> 'queue_request_id' = p_request_id::text/)

  for (const name of ['recover_bsale_sync_queue_v1', 'claim_next_bsale_sync_request_v1']) {
    const body = fnBody(name)
    assert.match(body, /pg_try_advisory_xact_lock\(hashtextextended\('bsale_sync_coord:'/)
    assert.match(body, /pg_try_advisory_xact_lock\(hashtextextended\('bsale_sync_queue_dedupe:'/)
    assert.doesNotMatch(body, /PERFORM pg_advisory_xact_lock/)
  }
})
