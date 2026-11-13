import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { readConfig, runClientsCron } from './cron.mjs'

const env = { PETGROUP_BASE_URL: 'https://mym.example', CRON_SECRET: 'test-secret' }

test('configura el endpoint fijo, HTTPS y timeout acotado', () => {
  assert.deepEqual(readConfig(env), { url: 'https://mym.example/api/integraciones/bsale/clients/sync', secret: 'test-secret', timeoutMs: 600_000 })
  for (const patch of [
    { CRON_SECRET: '' }, { PETGROUP_BASE_URL: 'http://mym.example' },
    { PETGROUP_BASE_URL: 'https://name:password@mym.example' },
    { PETGROUP_BASE_URL: 'https://mym.example/path' },
    { PETGROUP_BASE_URL: 'https://mym.example/?key=value' },
    { CLIENTS_SYNC_TIMEOUT_MS: '0' }, { CLIENTS_SYNC_TIMEOUT_MS: '1800000' },
  ]) assert.equal(readConfig({ ...env, ...patch }), null)
})

test('solo SUCCESS en HTTP exitoso y solicitud autenticada', async () => {
  let calls = 0
  const result = await runClientsCron(readConfig(env), async (url, options) => {
    calls++
    assert.equal(url, 'https://mym.example/api/integraciones/bsale/clients/sync')
    assert.equal(options.method, 'POST')
    assert.equal(options.headers.authorization, 'Bearer test-secret')
    assert.equal(options.redirect, 'error')
    return { ok: true, status: 200, json: async () => ({ status: 'SUCCESS' }) }
  })
  assert.equal(calls, 1)
  assert.deepEqual(result, { ok: true, reason: 'SUCCESS' })
})

test('FAILED, SKIPPED, HTTP y respuesta inválida nunca reportan éxito', async () => {
  const config = readConfig(env)
  for (const [body, reason] of [[{ status: 'FAILED' }, 'FAILED'], [{ status: 'SKIPPED' }, 'SKIPPED'], [{ status: 'PARTIAL' }, 'INVALID_RESPONSE'], [{}, 'INVALID_RESPONSE'], [null, 'INVALID_RESPONSE'], [[], 'INVALID_RESPONSE']]) {
    assert.deepEqual(await runClientsCron(config, async () => ({ ok: true, json: async () => body })), { ok: false, reason })
  }
  assert.deepEqual(await runClientsCron(config, async () => ({ ok: false, status: 503 })), { ok: false, reason: 'HTTP_ERROR', httpStatus: 503 })
  assert.deepEqual(await runClientsCron(config, async () => ({ ok: false, status: 409, json: async () => ({ status: 'SKIPPED' }) })), { ok: false, reason: 'SKIPPED', httpStatus: 409 })
  assert.deepEqual(await runClientsCron(config, async () => ({ ok: false, status: 500, json: async () => ({ status: 'FAILED' }) })), { ok: false, reason: 'FAILED', httpStatus: 500 })
  assert.deepEqual(await runClientsCron(config, async () => ({ ok: false, status: 500, json: async () => ({ status: 'SUCCESS' }) })), { ok: false, reason: 'HTTP_ERROR', httpStatus: 500 })
  assert.deepEqual(await runClientsCron(config, async () => ({ ok: true, json: async () => { throw new Error('bad json') } })), { ok: false, reason: 'INVALID_RESPONSE' })
  assert.deepEqual(await runClientsCron(config, async () => { throw new Error('network') }), { ok: false, reason: 'REQUEST_ERROR' })
})

test('timeout abarca conexión y lectura, y cancela la solicitud', async () => {
  const config = { ...readConfig(env), timeoutMs: 15 }
  let signal
  const result = await runClientsCron(config, async (_url, options) => {
    signal = options.signal
    return { ok: true, json: () => new Promise(() => {}) }
  })
  assert.deepEqual(result, { ok: false, reason: 'TIMEOUT' })
  assert.equal(signal.aborted, true)
  const waitingConnection = await runClientsCron(config, () => new Promise(() => {}))
  assert.deepEqual(waitingConnection, { ok: false, reason: 'TIMEOUT' })
  const interruptedBody = await runClientsCron(config, async (_url, options) => ({
    ok: true,
    json: () => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))),
  }))
  assert.deepEqual(interruptedBody, { ok: false, reason: 'TIMEOUT' })
})

test('proceso finaliza con código correcto y sin imprimir secreto', () => {
  const path = fileURLToPath(new URL('./cron.mjs', import.meta.url))
  const script = status => `globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({status:${JSON.stringify(status)}})});process.argv[1]=${JSON.stringify(path)};await import(${JSON.stringify(new URL('./cron.mjs', import.meta.url).href)})`
  for (const [status, exit] of [['SUCCESS', 0], ['FAILED', 1], ['SKIPPED', 1]]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script(status)], { encoding: 'utf8', timeout: 3000, env: { ...process.env, ...env } })
    assert.equal(result.status, exit)
    assert.doesNotMatch(result.stdout + result.stderr, /test-secret/)
  }
  const invalid = spawnSync(process.execPath, [path], { encoding: 'utf8', timeout: 3000, env: { ...process.env, PETGROUP_BASE_URL: env.PETGROUP_BASE_URL, CRON_SECRET: '' } })
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /INVALID_CONFIG/)
})
