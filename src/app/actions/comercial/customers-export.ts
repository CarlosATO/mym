'use server'

import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { getActiveCompanyId } from '@/app/actions/companies'

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!

function comercialAdmin() {
  return createSupabaseClient(supabaseUrl, serviceKey, {
    db: { schema: 'comercial' },
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function integracionesAdmin() {
  return createSupabaseClient(supabaseUrl, serviceKey, {
    db: { schema: 'integraciones' },
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function coreAdmin() {
  return createSupabaseClient(supabaseUrl, serviceKey, {
    db: { schema: 'core' },
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

const PAGE_SIZE = 1000

async function fetchAll<T>(build: (from: number, to: number) => Promise<T[]>): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const page = await build(from, from + PAGE_SIZE - 1)
    rows.push(...page)
    if (page.length < PAGE_SIZE) break
  }
  return rows
}

function asNumber(value: unknown): number {
  if (value === null || value === undefined) return 0
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export type ClientsExportSellerOrigin = 'PRINCIPAL' | 'ULTIMO' | 'SIN VENDEDOR'

export interface ClientsExportRow {
  bsale_client_id: number
  rut: string | null
  business_name: string
  fantasy_name: string | null
  business_activity: string | null
  city: string | null
  commune: string | null
  region: string | null
  email: string | null
  phone: string | null
  mobile: string | null
  is_active: boolean
  is_internal_account: boolean
  account_type: string | null
  status: string | null
  first_invoice_date: string | null
  last_invoice_date: string | null
  days_since_last_invoice: number | null
  official_sales_30d: number
  official_sales_90d: number
  official_sales_180d: number
  official_sales_365d: number
  official_sales_total: number
  invoice_docs_total: number
  avg_ticket_gross_total: number | null
  credit_note_count_total: number
  credit_note_amount_total: number
  credit_note_count_90d: number
  credit_note_amount_90d: number
  last_seller_name: string | null
  main_seller_name: string | null
  assigned_seller: string
  seller_origin: ClientsExportSellerOrigin
  quality_score: number
  has_possible_sibling: boolean
  has_anomalous_receipt: boolean
  snapshot_calculated_at: string | null
  receivable_pending: number | null
  receivable_overdue: number | null
  receivable_document_count: number | null
}

export interface ClientsExportSnapshotMeta {
  snapshot_at: string | null
  snapshot_date: string | null
  coverage_percent: number
  clients_total: number
  clients_success: number
  clients_unqueryable: number
  clients_error: number
  is_provisional: boolean
  source: string
}

export interface ClientsExportData {
  generatedAt: string
  companyId: string
  companyName: string
  officialSalesDefinition: string
  creditNoteDefinition: string
  snapshot: ClientsExportSnapshotMeta | null
  lastDataUpdateAt: string | null
  clients: ClientsExportRow[]
}

type Client360Row = {
  bsale_client_id: number | string
  rut: string | null
  business_name: string | null
  fantasy_name: string | null
  business_activity: string | null
  city: string | null
  commune: string | null
  region: string | null
  email: string | null
  phone: string | null
  mobile: string | null
  is_active: boolean | null
  status: string | null
  first_invoice_date: string | null
  last_invoice_date: string | null
  days_since_last_invoice: number | null
  official_sales_30d: number | string | null
  official_sales_90d: number | string | null
  official_sales_180d: number | string | null
  official_sales_365d: number | string | null
  official_sales_total: number | string | null
  invoice_docs_total: number | string | null
  avg_ticket_gross_total: number | string | null
  credit_note_count_total: number | string | null
  credit_note_amount_total: number | string | null
  credit_note_count_90d: number | string | null
  credit_note_amount_90d: number | string | null
  last_seller_name: string | null
  main_seller_name: string | null
  snapshot_quality_score: number | string | null
  has_possible_sibling: boolean | null
  has_anomalous_receipt: boolean | null
  snapshot_calculated_at: string | null
}

export async function getClientsExportData(): Promise<ClientsExportData> {
  const companyId = await getActiveCompanyId()
  if (!companyId) throw new Error('No autorizado')

  const comercial = comercialAdmin()

  const [clientRows, profileRows, companyRow] = await Promise.all([
    fetchAll<Client360Row>(async (from, to) => {
      const { data, error } = await comercial
        .from('vw_client_360')
        .select('bsale_client_id,rut,business_name,fantasy_name,business_activity,city,commune,region,email,phone,mobile,is_active,status,first_invoice_date,last_invoice_date,days_since_last_invoice,official_sales_30d,official_sales_90d,official_sales_180d,official_sales_365d,official_sales_total,invoice_docs_total,avg_ticket_gross_total,credit_note_count_total,credit_note_amount_total,credit_note_count_90d,credit_note_amount_90d,last_seller_name,main_seller_name,snapshot_quality_score,has_possible_sibling,has_anomalous_receipt,snapshot_calculated_at')
        .eq('company_id', companyId)
        .order('official_sales_total', { ascending: false, nullsFirst: false })
        .range(from, to)
      if (error) throw error
      return (data || []) as Client360Row[]
    }),
    fetchAll<{ bsale_client_id: number | string; account_type: string | null; is_internal_account: boolean | null }>(async (from, to) => {
      const { data, error } = await comercial
        .from('customer_reporting_profiles')
        .select('bsale_client_id,account_type,is_internal_account')
        .eq('company_id', companyId)
        .range(from, to)
      if (error) throw error
      return (data || []) as { bsale_client_id: number | string; account_type: string | null; is_internal_account: boolean | null }[]
    }),
    coreAdmin().from('companies').select('business_name,trade_name').eq('id', companyId).maybeSingle(),
  ])

  const profileByClient = new Map<number, { account_type: string | null; is_internal_account: boolean }>()
  for (const row of profileRows) {
    profileByClient.set(Number(row.bsale_client_id), {
      account_type: row.account_type,
      is_internal_account: Boolean(row.is_internal_account),
    })
  }

  const companyName = (companyRow.data?.trade_name || companyRow.data?.business_name || 'Empresa') as string

  // Cobranza: solo el último snapshot COMPLETED (cifras referenciales).
  let snapshot: ClientsExportSnapshotMeta | null = null
  const receivableByClient = new Map<number, { pending: number; overdue: number; count: number }>()
  try {
    const integraciones = integracionesAdmin()
    const { data: run } = await integraciones
      .from('bsale_receivable_snapshot_runs')
      .select('id,snapshot_at,snapshot_date,source,status,clients_total,clients_success,clients_unqueryable,clients_error,coverage_percent')
      .eq('company_id', companyId)
      .eq('status', 'COMPLETED')
      .order('snapshot_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (run) {
      const docs = await fetchAll<{ client_id: number | string; total_amount_owed: number | string | null; status: string | null }>(async (from, to) => {
        const { data, error } = await integraciones
          .from('bsale_receivable_snapshot_documents')
          .select('client_id,total_amount_owed,status')
          .eq('company_id', companyId)
          .eq('run_id', run.id)
          .range(from, to)
        if (error) throw error
        return (data || []) as { client_id: number | string; total_amount_owed: number | string | null; status: string | null }[]
      })
      for (const doc of docs) {
        const clientId = Number(doc.client_id)
        const owed = asNumber(doc.total_amount_owed)
        const current = receivableByClient.get(clientId) || { pending: 0, overdue: 0, count: 0 }
        current.pending += owed
        if (doc.status === 'OVERDUE') current.overdue += owed
        current.count += 1
        receivableByClient.set(clientId, current)
      }
      snapshot = {
        snapshot_at: run.snapshot_at ?? null,
        snapshot_date: run.snapshot_date ?? null,
        coverage_percent: asNumber(run.coverage_percent),
        clients_total: asNumber(run.clients_total),
        clients_success: asNumber(run.clients_success),
        clients_unqueryable: asNumber(run.clients_unqueryable),
        clients_error: asNumber(run.clients_error),
        is_provisional: asNumber(run.clients_unqueryable) > 0 || asNumber(run.clients_error) > 0,
        source: run.source || 'BSALE_UNPAID_DOCUMENTS',
      }
    }
  } catch (error) {
    // La cobranza es referencial y opcional: si falla no debe bloquear la exportación.
    console.error('getClientsExportData receivables error:', error)
  }

  let lastDataUpdateAt: string | null = null
  const clients: ClientsExportRow[] = clientRows.map(row => {
    const bsaleClientId = Number(row.bsale_client_id)
    const profile = profileByClient.get(bsaleClientId)
    const mainSeller = row.main_seller_name?.trim() || null
    const lastSeller = row.last_seller_name?.trim() || null
    const assignedSeller = mainSeller || lastSeller || 'SIN VENDEDOR'
    const sellerOrigin: ClientsExportSellerOrigin = mainSeller ? 'PRINCIPAL' : lastSeller ? 'ULTIMO' : 'SIN VENDEDOR'
    const receivables = receivableByClient.get(bsaleClientId) || null
    const calculatedAt = row.snapshot_calculated_at
    if (calculatedAt && (!lastDataUpdateAt || calculatedAt > lastDataUpdateAt)) lastDataUpdateAt = calculatedAt

    return {
      bsale_client_id: bsaleClientId,
      rut: row.rut,
      business_name: row.business_name || `Cliente Bsale ${bsaleClientId}`,
      fantasy_name: row.fantasy_name,
      business_activity: row.business_activity,
      city: row.city,
      commune: row.commune,
      region: row.region,
      email: row.email,
      phone: row.phone || row.mobile,
      mobile: row.mobile,
      is_active: Boolean(row.is_active),
      is_internal_account: Boolean(profile?.is_internal_account),
      account_type: profile?.account_type ?? null,
      status: row.status,
      first_invoice_date: row.first_invoice_date,
      last_invoice_date: row.last_invoice_date,
      days_since_last_invoice: row.days_since_last_invoice,
      official_sales_30d: asNumber(row.official_sales_30d),
      official_sales_90d: asNumber(row.official_sales_90d),
      official_sales_180d: asNumber(row.official_sales_180d),
      official_sales_365d: asNumber(row.official_sales_365d),
      official_sales_total: asNumber(row.official_sales_total),
      invoice_docs_total: asNumber(row.invoice_docs_total),
      avg_ticket_gross_total: nullableNumber(row.avg_ticket_gross_total),
      credit_note_count_total: asNumber(row.credit_note_count_total),
      credit_note_amount_total: asNumber(row.credit_note_amount_total),
      credit_note_count_90d: asNumber(row.credit_note_count_90d),
      credit_note_amount_90d: asNumber(row.credit_note_amount_90d),
      last_seller_name: lastSeller,
      main_seller_name: mainSeller,
      assigned_seller: assignedSeller,
      seller_origin: sellerOrigin,
      quality_score: asNumber(row.snapshot_quality_score),
      has_possible_sibling: Boolean(row.has_possible_sibling),
      has_anomalous_receipt: Boolean(row.has_anomalous_receipt),
      snapshot_calculated_at: calculatedAt,
      receivable_pending: receivables ? receivables.pending : null,
      receivable_overdue: receivables ? receivables.overdue : null,
      receivable_document_count: receivables ? receivables.count : null,
    }
  })

  return {
    generatedAt: new Date().toISOString(),
    companyId,
    companyName,
    officialSalesDefinition:
      'Venta oficial = Documentos Bsale de tipo 5 (Factura electrónica). Montos BRUTOS (con IVA), tal como los entrega Bsale. Las Notas de Venta (tipo 23) NO se suman como facturación.',
    creditNoteDefinition:
      'Las Notas de Crédito (tipo 2) se informan en columnas aparte y NO se descuentan de las columnas de venta. Para venta neta de NC debe restarse manualmente.',
    snapshot,
    lastDataUpdateAt,
    clients,
  }
}
