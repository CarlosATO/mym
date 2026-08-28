'use server'

import { getActiveCompanyId } from '@/app/actions/companies'
import { getPortalPeriod, type PortalPeriodMode } from '@/app/actions/portal/periods'
import { createClient } from '@/lib/supabase/server'

const AMIMASCOTA_BSALE_CLIENT_ID = 643

export interface PortalDailySales {
  date: string
  amount: number
}

export interface PortalSales {
  sales_month: number
  invoices_count: number
  average_ticket: number
  daily_sales: PortalDailySales[]
}

type SalesDocumentRow = {
  document_type_id: number | string | null
  net_amount: number | string | null
  emission_date: string | null
}

export async function getPortalSales(mode: PortalPeriodMode = 'CALENDAR_MONTH'): Promise<PortalSales> {
  const companyId = await getActiveCompanyId()
  if (!companyId) throw new Error('No se encontró empresa activa para el usuario.')

  const { from, toExclusive } = getPortalPeriod(mode)

  const supabase = await createClient()
  const { data, error } = await supabase
    .schema('integraciones')
    .from('bsale_documents')
      .select('document_type_id, net_amount, emission_date')
    .eq('company_id', companyId)
    .eq('state', 0)
    .in('document_type_id', [2, 5])
    .or(`client_id.is.null,client_id.neq.${AMIMASCOTA_BSALE_CLIENT_ID}`)
    .gte('emission_date', from)
    .lt('emission_date', toExclusive)

  if (error) throw new Error(`Error cargando ventas del Portal: ${error.message}`)

  const dailySales = new Map<string, number>()
  let salesMonth = 0
  let invoicesCount = 0

  for (const row of (data ?? []) as SalesDocumentRow[]) {
    const amount = Number(row.net_amount ?? 0)
    if (!Number.isFinite(amount) || !row.emission_date) continue

    const sign = Number(row.document_type_id) === 2 ? -1 : 1
    const signedAmount = sign * amount
    salesMonth += signedAmount
    dailySales.set(row.emission_date, (dailySales.get(row.emission_date) ?? 0) + signedAmount)

    if (Number(row.document_type_id) === 5) invoicesCount += 1
  }

  return {
    sales_month: salesMonth,
    invoices_count: invoicesCount,
    average_ticket: invoicesCount === 0 ? 0 : salesMonth / invoicesCount,
    daily_sales: Array.from(dailySales, ([date, amount]) => ({ date, amount }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  }
}
