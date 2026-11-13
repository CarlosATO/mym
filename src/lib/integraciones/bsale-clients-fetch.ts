const MAX_RATE_LIMIT_RETRIES = 4
const REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_RETRY_MS = 2_000

export function clientsRetryAfterMs(value: string | null, nowMs: number): number {
  if (!value) return DEFAULT_RETRY_MS
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const date = Date.parse(trimmed)
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : DEFAULT_RETRY_MS
}

export async function fetchBsaleClientsPage<T>(input: {
  url: string
  token: string
  deadlineAt: number
  fetcher?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}): Promise<T> {
  const now = input.now ?? Date.now
  const wait = input.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const fetcher = input.fetcher ?? fetch
  for (let retry = 0; retry <= MAX_RATE_LIMIT_RETRIES; retry++) {
    const remaining = input.deadlineAt - now()
    if (remaining <= 0) throw new Error('BSALE_CLIENTS_FETCH_TIMEOUT')
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('BSALE_CLIENTS_FETCH_TIMEOUT')) }, Math.min(remaining, REQUEST_TIMEOUT_MS))
    })
    try {
      const response = await Promise.race([fetcher(input.url, {
        method: 'GET',
        headers: { access_token: input.token, 'Content-Type': 'application/json' },
        signal: controller.signal,
      }), timeout])
      if (response.status === 429) {
        const retryAfter = clientsRetryAfterMs(response.headers.get('retry-after'), now())
        if (response.body && typeof (response.body as any).cancel === 'function') {
          await Promise.race([(response.body as any).cancel(), timeout]).catch(() => {})
        }
        if (retry === MAX_RATE_LIMIT_RETRIES) throw new Error('BSALE_CLIENTS_RATE_LIMIT_RETRIES_EXHAUSTED')
        if (!Number.isFinite(retryAfter) || retryAfter >= input.deadlineAt - now()) throw new Error('BSALE_CLIENTS_RATE_LIMIT_DEADLINE_EXCEEDED')
        if (timer) clearTimeout(timer)
        await wait(retryAfter)
        continue
      }
      if (!response.ok) throw new Error(`Bsale API error: ${response.status} ${response.statusText}`)
      return await Promise.race([response.json() as Promise<T>, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  throw new Error('BSALE_CLIENTS_RATE_LIMIT_RETRIES_EXHAUSTED')
}
