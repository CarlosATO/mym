'use server'

import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { getActiveCompanyId } from '@/app/actions/companies'

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

function comAdmin() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey,
    { db: { schema: 'comercial' }, auth: { autoRefreshToken: false, persistSession: false } }
  )
}

// Columnas reales de comercial.customers:
// id, company_id, source, bsale_client_id, customer_type,
// rut, rut_clean, business_name, fantasy_name,
// email, phone, mobile,
// address, city, commune, region,
// seller_name, route_name,
// credit_days, credit_limit, notes, is_active,
// last_sale_at, last_bsale_sync_at,
// created_at, updated_at, created_by, updated_by,
// business_activity  (added via migration 20260707152000)

export interface Customer {
  id: string
  company_id: string
  source: 'MANUAL' | 'BSALE'
  bsale_client_id: number | null
  customer_type: string | null
  rut: string | null
  rut_clean: string | null
  business_name: string
  fantasy_name: string | null
  business_activity: string | null
  email: string | null
  phone: string | null
  mobile: string | null
  address: string | null
  city: string | null
  commune: string | null
  region: string | null
  seller_name: string | null
  route_name: string | null
  credit_days: number | null
  credit_limit: number | null
  notes: string | null
  is_active: boolean
  last_bsale_sync_at: string | null
  created_at: string
  updated_at: string
}

export interface CommercialCustomerExplorer {
  company_id: string
  bsale_client_id: number
  rut: string | null
  rut_clean: string | null
  business_name: string
  fantasy_name: string | null
  business_activity: string | null
  email: string | null
  phone: string | null
  mobile: string | null
  address: string | null
  city: string | null
  commune: string | null
  region: string | null
  is_active: boolean
  status: string | null
  official_sales_total: number
  official_sales_current_month: number
  official_sales_current_month_gross: number
  credit_notes_current_month: number
  official_sales_current_month_net: number
  official_sales_90d: number
  official_sales_180d: number
  avg_ticket_gross_total: number
  avg_ticket_gross_90d: number
  official_invoice_docs_total: number
  last_invoice_date: string | null
  days_since_last_invoice: number | null
  sales_order_count_total: number
  sales_order_amount_total: number
  sales_order_count_90d: number
  sales_order_amount_90d: number
  credit_note_count_total: number
  credit_note_amount_total: number
  credit_note_count_90d: number
  credit_note_amount_90d: number
  last_seller_name: string | null
  main_seller_name: string | null
  snapshot_calculated_at: string | null
  quality_score: number
  has_anomalous_receipt: boolean
  has_possible_sibling: boolean
  has_email: boolean
  has_phone: boolean
  has_address: boolean
}

export interface CommercialCustomerStats {
  total: number
  active: number
  observacion: number
  riesgo: number
  inactive: number
  perdido: number
  sinVentaHistorica: number
  withOfficialSales: number
  officialSalesTotal: number
  officialSalesCurrentMonth: number
  official_sales_current_month_gross_total: number
  credit_notes_current_month_total: number
  official_sales_current_month_net_total: number
  officialSales90d: number
  withCreditNotes: number
  withAnomalousReceipt: number
  lowQuality: number
}

type CommercialCustomerExplorerRow = {
  company_id: string
  bsale_client_id: number | string
  rut: string | null
  rut_clean: string | null
  business_name: string
  fantasy_name: string | null
  business_activity: string | null
  email: string | null
  phone: string | null
  mobile: string | null
  address: string | null
  city: string | null
  commune: string | null
  region: string | null
  is_active: boolean | null
  status: string | null
  official_sales_total: number | string | null
  official_sales_90d: number | string | null
  official_sales_180d: number | string | null
  avg_ticket_gross_total: number | string | null
  avg_ticket_gross_90d: number | string | null
  invoice_docs_total: number | string | null
  last_invoice_date: string | null
  days_since_last_invoice: number | null
  sales_order_count_total: number | string | null
  sales_order_amount_total: number | string | null
  sales_order_count_90d: number | string | null
  sales_order_amount_90d: number | string | null
  credit_note_count_total: number | string | null
  credit_note_amount_total: number | string | null
  credit_note_count_90d: number | string | null
  credit_note_amount_90d: number | string | null
  last_seller_name: string | null
  main_seller_name: string | null
  snapshot_calculated_at: string | null
  snapshot_quality_score: number | string | null
  has_anomalous_receipt: boolean | null
  has_possible_sibling: boolean | null
  has_email: boolean | null
  has_phone: boolean | null
  has_address: boolean | null
}

type CurrentMonthSalesRow = {
  client_id: number | string | null
  document_type_id: number | string | null
  total_amount: number | string | null
}

type CurrentMonthSalesAmounts = {
  gross: number
  creditNotes: number
  net: number
}

function cleanRut(rut: string | null) {
  if (!rut) return null
  return rut.replace(/[^0-9kK]/g, '').toUpperCase()
}

function asNumber(value: unknown) {
  if (value === null || value === undefined) return 0
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function currentMonthRange() {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return {
    firstDay: `${year}-${month}-01`,
    today: `${year}-${month}-${day}`,
  }
}

async function getCurrentMonthSalesAmountsByClient(companyId: string) {
  const { firstDay, today } = currentMonthRange()
  const sales = new Map<number, CurrentMonthSalesAmounts>()
  const pageSize = 1000
  let from = 0

  // Current month = calendar month. Comparable Bsale sales = invoices type_id=5 minus credit notes type_id=2.
  while (true) {
    const { data, error } = await comAdmin()
      .schema('integraciones')
      .from('bsale_documents')
      .select('client_id,document_type_id,total_amount')
      .eq('company_id', companyId)
      .in('document_type_id', [2, 5])
      .gte('emission_date', firstDay)
      .lte('emission_date', today)
      .not('client_id', 'is', null)
      .range(from, from + pageSize - 1)

    if (error) throw error

    const rows = (data || []) as CurrentMonthSalesRow[]
    for (const row of rows) {
      if (row.client_id === null) continue
      const clientId = Number(row.client_id)
      const current = sales.get(clientId) || { gross: 0, creditNotes: 0, net: 0 }
      if (Number(row.document_type_id) === 5) current.gross += asNumber(row.total_amount)
      if (Number(row.document_type_id) === 2) current.creditNotes += asNumber(row.total_amount)
      current.net = current.gross - current.creditNotes
      sales.set(clientId, current)
    }

    if (rows.length < pageSize) break
    from += pageSize
  }

  return sales
}

function mapExplorerRow(row: CommercialCustomerExplorerRow, currentMonthSales: CurrentMonthSalesAmounts): CommercialCustomerExplorer {
  return {
    company_id: row.company_id,
    bsale_client_id: Number(row.bsale_client_id),
    rut: row.rut,
    rut_clean: row.rut_clean,
    business_name: row.business_name,
    fantasy_name: row.fantasy_name,
    business_activity: row.business_activity,
    email: row.email,
    phone: row.phone,
    mobile: row.mobile,
    address: row.address,
    city: row.city,
    commune: row.commune,
    region: row.region,
    is_active: Boolean(row.is_active),
    status: row.status,
    official_sales_total: asNumber(row.official_sales_total),
    official_sales_current_month: currentMonthSales.net,
    official_sales_current_month_gross: currentMonthSales.gross,
    credit_notes_current_month: currentMonthSales.creditNotes,
    official_sales_current_month_net: currentMonthSales.net,
    official_sales_90d: asNumber(row.official_sales_90d),
    official_sales_180d: asNumber(row.official_sales_180d),
    avg_ticket_gross_total: asNumber(row.avg_ticket_gross_total),
    avg_ticket_gross_90d: asNumber(row.avg_ticket_gross_90d),
    official_invoice_docs_total: asNumber(row.invoice_docs_total),
    last_invoice_date: row.last_invoice_date,
    days_since_last_invoice: row.days_since_last_invoice,
    sales_order_count_total: asNumber(row.sales_order_count_total),
    sales_order_amount_total: asNumber(row.sales_order_amount_total),
    sales_order_count_90d: asNumber(row.sales_order_count_90d),
    sales_order_amount_90d: asNumber(row.sales_order_amount_90d),
    credit_note_count_total: asNumber(row.credit_note_count_total),
    credit_note_amount_total: asNumber(row.credit_note_amount_total),
    credit_note_count_90d: asNumber(row.credit_note_count_90d),
    credit_note_amount_90d: asNumber(row.credit_note_amount_90d),
    last_seller_name: row.last_seller_name,
    main_seller_name: row.main_seller_name,
    snapshot_calculated_at: row.snapshot_calculated_at,
    quality_score: asNumber(row.snapshot_quality_score),
    has_anomalous_receipt: Boolean(row.has_anomalous_receipt),
    has_possible_sibling: Boolean(row.has_possible_sibling),
    has_email: Boolean(row.has_email),
    has_phone: Boolean(row.has_phone),
    has_address: Boolean(row.has_address),
  }
}

export async function getCommercialCustomersExplorer() {
  const companyId = await getActiveCompanyId()
  if (!companyId) return []

  const { data, error } = await comAdmin()
    .from('vw_client_360')
    .select('*')
    .eq('company_id', companyId)
    .order('official_sales_total', { ascending: false, nullsFirst: false })

  if (error) {
    if (error.code === '42P01') throw new Error('MIGRATION_PENDING')
    console.error('getCommercialCustomersExplorer error:', error)
    return []
  }

  const currentMonthSales = await getCurrentMonthSalesAmountsByClient(companyId)
  return ((data || []) as CommercialCustomerExplorerRow[]).map(row => {
    const clientId = Number(row.bsale_client_id)
    return mapExplorerRow(row, currentMonthSales.get(clientId) || { gross: 0, creditNotes: 0, net: 0 })
  })
}

export async function getCommercialCustomersStats(): Promise<CommercialCustomerStats> {
  const rows = await getCommercialCustomersExplorer()

  return {
    total: rows.length,
    active: rows.filter(r => r.status === 'ACTIVO' || r.status === 'NUEVO').length,
    observacion: rows.filter(r => r.status === 'OBSERVACION').length,
    riesgo: rows.filter(r => r.status === 'RIESGO').length,
    inactive: rows.filter(r => r.status === 'INACTIVO').length,
    perdido: rows.filter(r => r.status === 'PERDIDO').length,
    sinVentaHistorica: rows.filter(r => r.status === 'SIN_VENTA_HISTORICA').length,
    withOfficialSales: rows.filter(r => r.official_sales_total > 0).length,
    officialSalesTotal: rows.reduce((sum, r) => sum + r.official_sales_total, 0),
    officialSalesCurrentMonth: rows.reduce((sum, r) => sum + r.official_sales_current_month_net, 0),
    official_sales_current_month_gross_total: rows.reduce((sum, r) => sum + r.official_sales_current_month_gross, 0),
    credit_notes_current_month_total: rows.reduce((sum, r) => sum + r.credit_notes_current_month, 0),
    official_sales_current_month_net_total: rows.reduce((sum, r) => sum + r.official_sales_current_month_net, 0),
    officialSales90d: rows.reduce((sum, r) => sum + r.official_sales_90d, 0),
    withCreditNotes: rows.filter(r => r.credit_note_count_total > 0).length,
    withAnomalousReceipt: rows.filter(r => r.has_anomalous_receipt).length,
    lowQuality: rows.filter(r => r.quality_score < 60).length,
  }
}

export async function getCustomers(params?: { search?: string; status?: string; source?: string }) {
  const companyId = await getActiveCompanyId()
  if (!companyId) return []

  let q = comAdmin().from('customers').select('*').eq('company_id', companyId)
  
  if (params?.search) {
    const s = `%${params.search}%`
    q = q.or(`business_name.ilike.${s},fantasy_name.ilike.${s},rut.ilike.${s},rut_clean.ilike.${s},email.ilike.${s},phone.ilike.${s},city.ilike.${s},commune.ilike.${s},region.ilike.${s},business_activity.ilike.${s}`)
  }

  if (params?.status === 'active') {
    q = q.eq('is_active', true)
  } else if (params?.status === 'inactive') {
    q = q.eq('is_active', false)
  }

  if (params?.source && params.source !== 'all') {
    q = q.eq('source', params.source)
  }

  const { data, error } = await q.order('business_name')
  if (error) {
    if (error.code === '42P01') throw new Error('MIGRATION_PENDING')
    console.error('getCustomers error:', error)
    return []
  }
  return data as Customer[]
}

export async function getCustomer(id: string) {
  const companyId = await getActiveCompanyId()
  if (!companyId) return null

  const { data, error } = await comAdmin().from('customers')
    .select('*')
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle()
  
  if (error) {
    if (error.code === '42P01') throw new Error('MIGRATION_PENDING')
    console.error('getCustomer error:', error)
    return null
  }
  return data as Customer | null
}

export async function createCustomer(payload: Partial<Customer>) {
  const companyId = await getActiveCompanyId()
  if (!companyId) throw new Error('Empresa no activa')
  if (!payload.business_name) throw new Error('Razón social es obligatoria')

  const { data, error } = await comAdmin().from('customers').insert({
    company_id: companyId,
    source: 'MANUAL',
    rut: payload.rut || null,
    rut_clean: cleanRut(payload.rut || null),
    business_name: payload.business_name,
    fantasy_name: payload.fantasy_name || null,
    business_activity: payload.business_activity || null,
    email: payload.email || null,
    phone: payload.phone || null,
    mobile: payload.mobile || null,
    address: payload.address || null,
    city: payload.city || null,
    commune: payload.commune || null,
    region: payload.region || null,
    credit_days: payload.credit_days || null,
    credit_limit: payload.credit_limit || null,
    notes: payload.notes || null,
    is_active: true
  }).select().single()

  if (error) {
    if (error.code === '42P01') throw new Error('MIGRATION_PENDING')
    throw new Error(error.message)
  }
  return data
}

export async function updateCustomer(id: string, payload: Partial<Customer>) {
  const companyId = await getActiveCompanyId()
  if (!companyId) throw new Error('Empresa no activa')
  
  const current = await getCustomer(id)
  if (!current) throw new Error('Cliente no encontrado')

  // Campos que NUNCA se tocan en update (controlados por sync/sistema):
  // source, bsale_client_id, rut_clean, company_id, created_at, last_bsale_sync_at

  let updatePayload: Record<string, unknown> = {}

  if (current.source === 'BSALE') {
    // Whitelist estricta para BSALE: solo notas administrativas
    updatePayload = {
      notes: payload.notes !== undefined ? (payload.notes || null) : current.notes,
    }
  } else {
    // Clientes MANUAL: edición normal
    updatePayload = {
      rut: payload.rut !== undefined ? (payload.rut || null) : current.rut,
      rut_clean: payload.rut !== undefined ? cleanRut(payload.rut || null) : current.rut_clean,
      business_name: payload.business_name || current.business_name,
      fantasy_name: payload.fantasy_name !== undefined ? (payload.fantasy_name || null) : current.fantasy_name,
      business_activity: payload.business_activity !== undefined ? (payload.business_activity || null) : current.business_activity,
      email: payload.email !== undefined ? (payload.email || null) : current.email,
      phone: payload.phone !== undefined ? (payload.phone || null) : current.phone,
      mobile: payload.mobile !== undefined ? (payload.mobile || null) : current.mobile,
      address: payload.address !== undefined ? (payload.address || null) : current.address,
      city: payload.city !== undefined ? (payload.city || null) : current.city,
      commune: payload.commune !== undefined ? (payload.commune || null) : current.commune,
      region: payload.region !== undefined ? (payload.region || null) : current.region,
      credit_days: payload.credit_days !== undefined ? payload.credit_days : current.credit_days,
      credit_limit: payload.credit_limit !== undefined ? payload.credit_limit : current.credit_limit,
      notes: payload.notes !== undefined ? (payload.notes || null) : current.notes,
    }
  }

  const { data, error } = await comAdmin().from('customers').update(updatePayload)
    .eq('id', id).eq('company_id', companyId).select().single()

  if (error) {
    if (error.code === '42P01') throw new Error('MIGRATION_PENDING')
    throw new Error(error.message)
  }
  return data
}

export async function deactivateCustomer(id: string) {
  const companyId = await getActiveCompanyId()
  if (!companyId) throw new Error('Empresa no activa')

  const { data, error } = await comAdmin().from('customers')
    .update({ is_active: false })
    .eq('id', id).eq('company_id', companyId).select().single()
  
  if (error) {
    if (error.code === '42P01') throw new Error('MIGRATION_PENDING')
    throw new Error(error.message)
  }
  return data
}

export async function reactivateCustomer(id: string) {
  const companyId = await getActiveCompanyId()
  if (!companyId) throw new Error('Empresa no activa')

  const { data, error } = await comAdmin().from('customers')
    .update({ is_active: true })
    .eq('id', id).eq('company_id', companyId).select().single()
  
  if (error) {
    if (error.code === '42P01') throw new Error('MIGRATION_PENDING')
    throw new Error(error.message)
  }
  return data
}

export async function getCustomerStats() {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { total: 0, active: 0, inactive: 0, bsale: 0, manual: 0 }

  const { data, error } = await comAdmin().from('customers')
    .select('id, is_active, source')
    .eq('company_id', companyId)

  if (error) {
    if (error.code === '42P01') throw new Error('MIGRATION_PENDING')
    console.error('getCustomerStats error:', error)
    return { total: 0, active: 0, inactive: 0, bsale: 0, manual: 0 }
  }

  const active = data.filter(d => d.is_active).length
  const inactive = data.length - active
  const bsale = data.filter(d => d.source === 'BSALE').length
  const manual = data.filter(d => d.source === 'MANUAL').length
  
  return {
    total: data.length,
    active,
    inactive,
    bsale,
    manual
  }
}
