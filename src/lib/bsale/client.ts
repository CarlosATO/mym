const BSALE_API_BASE = process.env.BSALE_API_BASE_URL || 'https://api.bsale.cl/v1'
const BSALE_TOKEN = process.env.BSALE_ACCESS_TOKEN

interface BsaleResponse<T> {
  count: number
  items: T[]
  offset?: number
  limit?: number
}

interface BsaleFetchOptions {
  path: string
  params?: Record<string, string | number | undefined>
  signal?: AbortSignal
}

export class BsaleApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: string
  ) {
    super(message)
    this.name = 'BsaleApiError'
  }
}

function normalizeSku(code: string): string {
  return String(code).trim().toUpperCase()
}

export function getBsaleHeaders(): Record<string, string> {
  if (!BSALE_TOKEN) {
    throw new Error('BSALE_ACCESS_TOKEN no configurado')
  }
  return {
    'access_token': BSALE_TOKEN,
    'Content-Type': 'application/json',
  }
}

async function bsaleFetch<T>(options: BsaleFetchOptions): Promise<BsaleResponse<T>> {
  const { path, params, signal } = options
  const url = new URL(`${BSALE_API_BASE}${path}`)

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value))
      }
    })
  }

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: getBsaleHeaders(),
    signal,
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new BsaleApiError(
      response.status,
      `Bsale API error ${response.status}: ${response.statusText}`,
      body
    )
  }

  return response.json()
}

export async function bsaleFetchAll<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
  options?: { signal?: AbortSignal; onPage?: (page: number, items: T[]) => void }
): Promise<T[]> {
  const LIMIT = 50
  let offset = 0
  let allItems: T[] = []
  let totalCount: number | null = null
  let page = 0

  while (totalCount === null || offset < totalCount) {
    const result = await bsaleFetch<T>({
      path,
      params: { ...params, limit: LIMIT, offset },
      signal: options?.signal,
    })

    totalCount = result.count
    const items = result.items || []

    allItems = allItems.concat(items)
    page++

    if (options?.onPage) {
      options.onPage(page, items)
    }

    if (items.length < LIMIT) {
      break
    }

    offset += LIMIT
  }

  return allItems
}

export { normalizeSku }
export type { BsaleResponse }
