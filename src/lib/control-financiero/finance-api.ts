import { createClient } from '@/lib/supabase/server'
import { getActiveCompanyId } from '@/app/actions/companies'

export type FinanceMonthlyAmount = {
  month: number
  amount: string | null
}

export type FinanceSalesNetResponse = {
  company_id: string
  year: number
  currency: 'CLP'
  source: string
  data_through: string | null
  has_information: boolean
  documents_count: number
  lines_count: number
  months: FinanceMonthlyAmount[]
  total_ytd: string
}

export type FinanceCogsMonthly = {
  month: number
  gross_cogs: string | null
  credit_note_reversal: string | null
  net_cogs: string | null
  observed_document_count: number | null
  missing_document_count: number | null
  coverage_status: 'COMPLETE' | 'INCOMPLETE' | null
}

export type FinanceCogsYtd = {
  gross_cogs: string | null
  credit_note_reversal: string | null
  net_cogs: string | null
  observed_document_count: number | null
  missing_document_count: number | null
  coverage_status: 'COMPLETE' | 'INCOMPLETE' | null
}

export type FinanceCogsResponse = {
  company_id: string
  year: number
  currency: 'CLP'
  source: string
  data_through: string | null
  has_information: boolean
  months: FinanceCogsMonthly[]
  ytd: FinanceCogsYtd
}

export type FinanceApiResult =
  | { ok: true; data: FinanceSalesNetResponse }
  | { ok: false; status: number; message: string }

export type FinanceCogsApiResult =
  | { ok: true; data: FinanceCogsResponse }
  | { ok: false; status: number; message: string }

async function getFinanceApiResponse(path: string): Promise<Response> {
  const baseUrl = process.env.FINANCE_API_BASE_URL?.trim()
  if (!baseUrl) throw new Error('FINANCE_API_BASE_URL no está configurada.')

  const supabase = await createClient()
  const { data: sessionData } = await supabase.auth.getSession()
  const accessToken = sessionData.session?.access_token
  const companyId = await getActiveCompanyId()

  if (!accessToken || !companyId) throw new Error('La sesión o la empresa activa no están disponibles.')

  return fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Company-Id': companyId,
      Accept: 'application/json',
    },
    cache: 'no-store',
  })
}

async function readFinanceApiError(response: Response, fallback: string) {
  try {
    const body = await response.json() as { detail?: string }
    if (body.detail) return body.detail
  } catch {
    // Keep the fallback when the API does not return JSON.
  }
  return fallback
}

function financeApiFailure(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.includes('no está configurada')) {
    return { ok: false as const, status: 503, message: error.message }
  }
  if (error instanceof Error && error.message.includes('sesión o la empresa')) {
    return { ok: false as const, status: 401, message: error.message }
  }
  return { ok: false as const, status: 503, message: fallback }
}

export async function getFinanceSalesNet(year: number): Promise<FinanceApiResult> {
  try {
    const response = await getFinanceApiResponse(`/financial/income-statement/sales-net?year=${year}`)

    if (!response.ok) {
      return { ok: false, status: response.status, message: await readFinanceApiError(response, 'No se pudieron cargar las ventas netas.') }
    }

    return { ok: true, data: await response.json() as FinanceSalesNetResponse }
  } catch (error) {
    return financeApiFailure(error, 'Finance API no está disponible.')
  }
}

export async function getFinanceCogs(year: number): Promise<FinanceCogsApiResult> {
  try {
    const response = await getFinanceApiResponse(`/financial/income-statement/cogs?year=${year}`)
    if (!response.ok) {
      return { ok: false, status: response.status, message: await readFinanceApiError(response, 'No se pudo cargar el costo de ventas.') }
    }
    return { ok: true, data: await response.json() as FinanceCogsResponse }
  } catch (error) {
    return financeApiFailure(error, 'Finance API no está disponible.')
  }
}
