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

export type FinanceApiResult =
  | { ok: true; data: FinanceSalesNetResponse }
  | { ok: false; status: number; message: string }

export async function getFinanceSalesNet(year: number): Promise<FinanceApiResult> {
  const baseUrl = process.env.FINANCE_API_BASE_URL?.trim()
  if (!baseUrl) {
    return { ok: false, status: 503, message: 'FINANCE_API_BASE_URL no está configurada.' }
  }

  const supabase = await createClient()
  const { data: sessionData } = await supabase.auth.getSession()
  const accessToken = sessionData.session?.access_token
  const companyId = await getActiveCompanyId()

  if (!accessToken || !companyId) {
    return { ok: false, status: 401, message: 'La sesión o la empresa activa no están disponibles.' }
  }

  try {
    const response = await fetch(
      `${baseUrl.replace(/\/$/, '')}/financial/income-statement/sales-net?year=${year}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'X-Company-Id': companyId,
          Accept: 'application/json',
        },
        cache: 'no-store',
      },
    )

    if (!response.ok) {
      let message = 'No se pudieron cargar las ventas netas.'
      try {
        const body = await response.json() as { detail?: string }
        if (body.detail) message = body.detail
      } catch {
        // Keep the user-facing fallback when the API does not return JSON.
      }
      return { ok: false, status: response.status, message }
    }

    return { ok: true, data: await response.json() as FinanceSalesNetResponse }
  } catch {
    return { ok: false, status: 503, message: 'Finance API no está disponible.' }
  }
}
