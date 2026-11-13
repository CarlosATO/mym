import { pathToFileURL } from 'node:url'

const CLIENTS_PATH = '/api/integraciones/bsale/clients/sync'
const DEFAULT_TIMEOUT_MS = 600_000
const MAX_TIMEOUT_MS = 1_200_000

export function readConfig(env) {
  const secret = env.CRON_SECRET
  if (!secret?.trim() || !env.PETGROUP_BASE_URL) return null
  let base
  try {
    base = new URL(env.PETGROUP_BASE_URL)
  } catch {
    return null
  }
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) return null
  const timeoutMs = env.CLIENTS_SYNC_TIMEOUT_MS == null ? DEFAULT_TIMEOUT_MS : Number(env.CLIENTS_SYNC_TIMEOUT_MS)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TIMEOUT_MS) return null
  return { url: new URL(CLIENTS_PATH, base).toString(), secret, timeoutMs }
}

export async function runClientsCron(config, fetchImpl = fetch) {
  const controller = new AbortController()
  let timer
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ ok: false, reason: 'TIMEOUT' })
    }, config.timeoutMs)
  })
  const operation = (async () => {
    try {
      const response = await fetchImpl(config.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.secret}`, accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      })
      let body
      try {
        body = await response.json()
      } catch {
        return { ok: false, reason: controller.signal.aborted ? 'TIMEOUT' : response.ok ? 'INVALID_RESPONSE' : 'HTTP_ERROR', ...(response.ok ? {} : { httpStatus: response.status }) }
      }
      if (!response.ok) {
        const reason = body?.status === 'FAILED' || body?.status === 'SKIPPED' ? body.status : 'HTTP_ERROR'
        return { ok: false, reason, httpStatus: response.status }
      }
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.status !== 'string') {
        return { ok: false, reason: 'INVALID_RESPONSE' }
      }
      if (body.status === 'SUCCESS') return { ok: true, reason: 'SUCCESS' }
      if (body.status === 'FAILED' || body.status === 'SKIPPED') return { ok: false, reason: body.status }
      return { ok: false, reason: 'INVALID_RESPONSE' }
    } catch {
      return { ok: false, reason: controller.signal.aborted ? 'TIMEOUT' : 'REQUEST_ERROR' }
    }
  })()
  try {
    return await Promise.race([operation, timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const config = readConfig(process.env)
  if (!config) {
    console.error('[bsale-clients-cron] INVALID_CONFIG')
    process.exitCode = 1
    return
  }
  const startedAt = Date.now()
  const result = await runClientsCron(config)
  const log = result.ok ? console.info : console.error
  log(`[bsale-clients-cron] ${result.reason} duration_ms=${Date.now() - startedAt}${result.httpStatus ? ` http_status=${result.httpStatus}` : ''}`)
  if (!result.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
