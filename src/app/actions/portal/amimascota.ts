'use server'

import { getActiveCompanyId } from '@/app/actions/companies'
import { requirePortalSystemAdmin } from '@/app/actions/portal/authorization'
import { todayInSantiago } from '@/lib/datetime'
import { createClient } from '@/lib/supabase/server'
import { netAmountForGross, type PortalDocumentMoney } from '@/app/actions/portal/net-monetary'

const AMIMASCOTA_BSALE_CLIENT_ID = 643

export interface PortalAmimascotaKpis {
  sales_month: number
  collected_month: number
  healthy_debt: number
  overdue_debt: number
  total_debt: number
}

type SalesRow = {
  document_type_id: number | string | null
  net_amount: number | string | null
}

type PaymentRow = {
  bsale_document_id: number | string
  amount_applied: number | string | null
}

type ReceivablesRow = {
  bsale_document_id: number | string
  pending_amount: number | string | null
  is_overdue: boolean | null
}

type DocumentMoneyRow = PortalDocumentMoney & { bsale_id: number | string }

export async function getPortalAmimascota(): Promise<PortalAmimascotaKpis> {
  await requirePortalSystemAdmin()
  const companyId = await getActiveCompanyId()
  if (!companyId) throw new Error('No se encontró empresa activa para el usuario.')

  const today = todayInSantiago()
  const [year, month] = today.split('-')
  const firstDay = `${year}-${month}-01`
  const nextMonth = month === '12'
    ? `${Number(year) + 1}-01-01`
    : `${year}-${String(Number(month) + 1).padStart(2, '0')}-01`
  const supabase = await createClient()

  const fetchReceivables = async () => {
    const rows: ReceivablesRow[] = []
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabase
        .schema('comercial')
        .from('vw_customer_invoice_receivables')
        .select('bsale_document_id, pending_amount, is_overdue')
        .eq('company_id', companyId)
        .eq('bsale_client_id', AMIMASCOTA_BSALE_CLIENT_ID)
        .range(offset, offset + 999)
      if (error) throw new Error(`Error cargando deuda de Amimascota: ${error.message}`)
      rows.push(...((data ?? []) as ReceivablesRow[]))
      if ((data ?? []).length < 1000) break
    }
    return rows
  }

  const [salesResult, paymentsResult, receivableRows] = await Promise.all([
    supabase
      .schema('integraciones')
      .from('bsale_documents')
      .select('document_type_id, net_amount')
      .eq('company_id', companyId)
      .eq('client_id', AMIMASCOTA_BSALE_CLIENT_ID)
      .eq('state', 0)
      .in('document_type_id', [2, 5])
      .gte('emission_date', firstDay)
      .lte('emission_date', today),
    supabase
      .schema('integraciones')
      .from('bsale_document_payments')
      .select('bsale_document_id, amount_applied')
      .eq('company_id', companyId)
      .eq('client_id', AMIMASCOTA_BSALE_CLIENT_ID)
      .gt('amount_applied', 0)
      .gte('payment_record_date', firstDay)
      .lt('payment_record_date', nextMonth),
    fetchReceivables(),
  ])

  if (salesResult.error) throw new Error(`Error cargando ventas de Amimascota: ${salesResult.error.message}`)
  if (paymentsResult.error) throw new Error(`Error cargando cobros de Amimascota: ${paymentsResult.error.message}`)


  const salesMonth = ((salesResult.data ?? []) as SalesRow[]).reduce((total, row) => {
    const amount = Number(row.net_amount ?? 0)
    if (!Number.isFinite(amount)) return total
    return total + (Number(row.document_type_id) === 2 ? -amount : amount)
  }, 0)
  const paymentRows = (paymentsResult.data ?? []) as PaymentRow[]
  const documentIds = [...new Set([
    ...paymentRows.map(row => Number(row.bsale_document_id)),
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
  if (failedDocuments?.error) throw new Error(`Error cargando composición monetaria de Amimascota: ${failedDocuments.error.message}`)
  const documents = new Map(documentResults.flatMap(result => result.data ?? []).map(row => [Number(row.bsale_id), row as DocumentMoneyRow]))
  const collectedMonth = paymentRows.reduce((total, row) => {
    const document = documents.get(Number(row.bsale_document_id))
    return document ? total + netAmountForGross(Number(row.amount_applied ?? 0), document) : total
  }, 0)
  let healthyDebt = 0
  let overdueDebt = 0
  for (const row of receivableRows) {
    const document = documents.get(Number(row.bsale_document_id))
    if (!document) continue
    const netPending = netAmountForGross(Number(row.pending_amount ?? 0), document)
    if (row.is_overdue) overdueDebt += netPending
    else healthyDebt += netPending
  }
  const safeTotalDebt = healthyDebt + overdueDebt

  return {
    sales_month: salesMonth,
    collected_month: collectedMonth,
    healthy_debt: healthyDebt,
    overdue_debt: overdueDebt,
    total_debt: safeTotalDebt,
  }
}
