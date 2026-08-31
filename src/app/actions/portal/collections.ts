'use server'

import { getActiveCompanyId } from '@/app/actions/companies'
import { requirePortalSystemAdmin } from '@/app/actions/portal/authorization'
import { createClient } from '@/lib/supabase/server'
import { netAmountForGross, type PortalDocumentMoney } from '@/app/actions/portal/net-monetary'
import { getPortalPeriod, type PortalPeriodMode } from '@/app/actions/portal/periods'

const AMIMASCOTA_BSALE_CLIENT_ID = 643

export interface PortalDailyCollection {
  date: string
  amount: number
}

export interface PortalCollections {
  collected_month: number
  pending_receivables: number
  overdue_receivables: number
  daily_collections: PortalDailyCollection[]
}

export type PortalCollectionsByMode = Record<PortalPeriodMode, PortalCollections | null>

type PaymentAllocationRow = {
  bsale_document_id: number | string
  amount_applied: number | string | null
  payment_record_date: string | null
}

type ReceivableDocumentRow = {
  bsale_document_id: number | string
  pending_amount: number | string | null
  is_overdue: boolean | null
}

type DocumentMoneyRow = PortalDocumentMoney & { bsale_id: number | string }

async function getPortalCollectionsForModes(modes: PortalPeriodMode[]): Promise<PortalCollectionsByMode> {
  await requirePortalSystemAdmin()
  const companyId = await getActiveCompanyId()
  if (!companyId) throw new Error('No se encontró empresa activa para el usuario.')

  const periods = modes.map(mode => ({ mode, ...getPortalPeriod(mode) }))
  const supabase = await createClient()

  const fetchReceivables = async () => {
    const rows: ReceivableDocumentRow[] = []
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabase
        .schema('comercial')
        .from('vw_customer_invoice_receivables')
        .select('bsale_document_id, pending_amount, is_overdue')
        .eq('company_id', companyId)
        .neq('bsale_client_id', AMIMASCOTA_BSALE_CLIENT_ID)
        .range(offset, offset + 999)
      if (error) throw new Error(`Error cargando cartera del Portal: ${error.message}`)
      rows.push(...((data ?? []) as ReceivableDocumentRow[]))
      if ((data ?? []).length < 1000) break
    }
    return rows
  }

  const [allocationResults, receivableRows] = await Promise.all([
    Promise.all(periods.map(period => supabase
      .schema('integraciones')
      .from('bsale_document_payments')
      .select('bsale_document_id, amount_applied, payment_record_date')
      .eq('company_id', companyId)
      .or(`client_id.is.null,client_id.neq.${AMIMASCOTA_BSALE_CLIENT_ID}`)
      .gt('amount_applied', 0)
      .gte('payment_record_date', period.from)
      .lt('payment_record_date', period.toExclusive))),
    fetchReceivables(),
  ])

  const failedAllocations = allocationResults.find(result => result.error)
  if (failedAllocations?.error) throw new Error(`Error cargando cobros del Portal: ${failedAllocations.error.message}`)

  const paymentRowsByMode = new Map<PortalPeriodMode, PaymentAllocationRow[]>(allocationResults.map((result, index) => [periods[index].mode, (result.data ?? []) as PaymentAllocationRow[]]))
  const documentIds = [...new Set([
    ...allocationResults.flatMap(result => (result.data ?? []).map(row => Number(row.bsale_document_id))),
    ...receivableRows.map(row => Number(row.bsale_document_id)),
  ].filter(Number.isFinite))]
  const documentChunks = Array.from({ length: Math.ceil(documentIds.length / 500) }, (_, index) => documentIds.slice(index * 500, (index + 1) * 500))
  const documentResults = await Promise.all(documentChunks.map(ids => supabase
    .schema('integraciones')
    .from('bsale_documents')
    .select('bsale_id, total_amount, net_amount, exempt_amount')
    .eq('company_id', companyId)
    .in('bsale_id', ids)))
  const failedDocuments = documentResults.find(result => result.error)
  if (failedDocuments?.error) throw new Error(`Error cargando composición monetaria del Portal: ${failedDocuments.error.message}`)

  const documents = new Map(documentResults.flatMap(result => result.data ?? []).map(row => [Number(row.bsale_id), row as DocumentMoneyRow]))

  let pendingReceivables = 0
  let overdueReceivables = 0
  for (const row of receivableRows) {
    const document = documents.get(Number(row.bsale_document_id))
    if (!document) continue
    const netPending = netAmountForGross(Number(row.pending_amount ?? 0), document)
    if (row.is_overdue) overdueReceivables += netPending
    else pendingReceivables += netPending
  }

  const resultByMode = {} as PortalCollectionsByMode
  for (const period of periods) {
    const dailyCollections = new Map<string, number>()
    let collectedMonth = 0
    for (const row of paymentRowsByMode.get(period.mode) ?? []) {
      if (!row.payment_record_date) continue
      const amount = Number(row.amount_applied ?? 0)
      if (!Number.isFinite(amount)) continue
      const document = documents.get(Number(row.bsale_document_id))
      if (!document) continue
      const netAmount = netAmountForGross(amount, document)
      collectedMonth += netAmount
      const date = row.payment_record_date.slice(0, 10)
      dailyCollections.set(date, (dailyCollections.get(date) ?? 0) + netAmount)
    }
    resultByMode[period.mode] = { collected_month: collectedMonth, pending_receivables: pendingReceivables, overdue_receivables: overdueReceivables, daily_collections: Array.from(dailyCollections, ([date, amount]) => ({ date, amount })).sort((a, b) => a.date.localeCompare(b.date)) }
  }
  return resultByMode
}

export async function getPortalCollections(mode: PortalPeriodMode = 'CALENDAR_MONTH'): Promise<PortalCollections> {
  const result = await getPortalCollectionsForModes([mode])
  return result[mode] ?? { collected_month: 0, pending_receivables: 0, overdue_receivables: 0, daily_collections: [] }
}

export async function getPortalCollectionsByMode(): Promise<PortalCollectionsByMode> {
  return getPortalCollectionsForModes(['CALENDAR_MONTH', 'COMMISSIONABLE'])
}
