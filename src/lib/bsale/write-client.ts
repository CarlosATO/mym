import { getBsaleConfigForCompany } from './company-config'
import { BsaleApiError } from './client'

type BsaleWriteForCompanyOptions = {
  companyId: string
  path: string
  body: Record<string, unknown>
  timeoutMs?: number
}

export async function bsaleWriteForCompany<T>({ companyId, path, body, timeoutMs = 15_000 }: BsaleWriteForCompanyOptions): Promise<T> {
  const { baseUrl, accessToken } = getBsaleConfigForCompany(companyId)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        access_token: accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      const responseBody = await response.text().catch(() => '')
      throw new BsaleApiError(
        response.status,
        `Bsale API error ${response.status}: ${response.statusText}`,
        responseBody,
      )
    }

    return response.json() as Promise<T>
  } finally {
    clearTimeout(timeout)
  }
}
