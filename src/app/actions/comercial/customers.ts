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

export type CommercialCustomerBehaviorDocumentType = 'invoice' | 'sales_order' | 'credit_note'

export type CommercialCustomerBehaviorDocument = {
  bsale_document_id: number
  documentTypeId: number
  type: CommercialCustomerBehaviorDocumentType
  label: string
  date: string | null
  number: number | null
  amount: number
  sellerName: string
}

export type CommercialCustomerMonthlyEvolution = {
  month: string
  monthLabel: string
  invoiceGrossAmount: number
  creditNoteAmount: number
  netSalesAmount: number
  invoiceCount: number
  creditNoteCount: number
  salesOrderAmount: number
  salesOrderCount: number
  avgTicket: number
}

export type CommercialCustomerBehaviorSummary = {
  totalNetSales12m: number
  totalInvoiceGross12m: number
  totalCreditNotes12m: number
  invoices12m: number
  salesOrders12m: number
  creditNotes12m: number
  avgTicket12m: number
  lastInvoiceDate: string | null
  daysSinceLastInvoice: number | null
  bestMonth: string | null
  worstMonth: string | null
  trendLabel: 'En crecimiento' | 'Estable' | 'En baja' | 'Sin información suficiente'
}

export type CommercialCustomerBehavior = {
  monthlyEvolution: CommercialCustomerMonthlyEvolution[]
  recentInvoices: CommercialCustomerBehaviorDocument[]
  recentSalesOrders: CommercialCustomerBehaviorDocument[]
  recentCreditNotes: CommercialCustomerBehaviorDocument[]
  recentDocuments: CommercialCustomerBehaviorDocument[]
  behaviorSummary: CommercialCustomerBehaviorSummary
}

export type CommercialCustomerMetricKey =
  | 'current_month_sales'
  | 'official_sales_total'
  | 'official_sales_90d'
  | 'official_sales_180d'
  | 'invoices_total'
  | 'avg_ticket'
  | 'credit_notes_total'
  | 'credit_notes_90d'
  | 'sales_orders_90d'

export type CommercialCustomerMetricDocuments = {
  metricKey: CommercialCustomerMetricKey
  title: string
  note: string | null
  documents: CommercialCustomerBehaviorDocument[]
  summary: {
    documentsCount: number
    invoiceGrossAmount: number
    creditNoteAmount: number
    netAmount: number
    salesOrderAmount: number
  }
}

export type CommercialDocumentDetail = {
  header: {
    bsale_document_id: number
    document_type_id: number
    document_type_label: string
    number: number | null
    emission_date: string | null
    generation_date: string | null
    client_id: number | null
    client_name: string | null
    total_amount: number
    net_amount: number
    tax_amount: number
    exempt_amount: number
    discount_amount: number
    state: number | null
    url_pdf: string | null
    seller_name: string
  }
  items: Array<{
    line_number: number | null
    bsale_detail_id: number
    variant_id: number | null
    sku: string | null
    description: string | null
    format: string | null
    quantity: number
    net_unit_value: number
    total_unit_value: number
    net_discount: number
    net_amount: number
    tax_amount: number
    total_amount: number
  }>
  totals: {
    lines: number
    units: number
    subtotal: number
    discounts: number
    taxes: number
    total: number
  }
}

export type CommercialCustomerPurchaseMixProduct = {
  sku: string
  productName: string
  totalAmount: number
  totalUnits: number
  invoiceCount: number
  lastPurchaseDate: string | null
  daysSinceLastPurchase: number | null
  formats: string[]
  avgUnitPrice: number
}

export type CommercialCustomerPurchaseMix = {
  monthlyQuantityEvolution: Array<{
    month: string
    monthLabel: string
    totalUnits: number
    invoiceCount: number
    netSalesAmount: number
    distinctProducts: number
    avgUnitsPerInvoice: number
  }>
  topProductsByAmount: CommercialCustomerPurchaseMixProduct[]
  topProductsByUnits: CommercialCustomerPurchaseMixProduct[]
  recentProductActivity: Array<{
    date: string | null
    invoiceNumber: number | null
    sku: string
    productName: string
    format: string | null
    quantity: number
    totalAmount: number
  }>
  staleProducts: CommercialCustomerPurchaseMixProduct[]
  mixSummary: {
    totalProducts: number
    totalUnits12m: number
    totalAmount12m: number
    topProductName: string | null
    topProductSharePercent: number
    lastProductPurchaseDate: string | null
    monthsWithPurchases: number
    avgMonthlyUnits: number
  }
}

type BehaviorDocumentRow = {
  bsale_id: number | string
  number: number | string | null
  emission_date: string | null
  total_amount: number | string | null
  document_type_id: number | string | null
}

type DetailDocumentRow = BehaviorDocumentRow & {
  generation_date: string | null
  client_id: number | string | null
  net_amount: number | string | null
  tax_amount: number | string | null
  exempt_amount: number | string | null
  state: number | string | null
  url_pdf: string | null
  raw_json: Record<string, unknown> | null
}

type DetailLineRow = {
  bsale_id: number | string
  line_number: number | string | null
  quantity: number | string | null
  net_unit_value: number | string | null
  total_unit_value: number | string | null
  net_amount: number | string | null
  tax_amount: number | string | null
  total_amount: number | string | null
  net_discount: number | string | null
  variant_id: number | string | null
  variant_code: string | null
  variant_description: string | null
}

type PurchaseMixLineRow = DetailLineRow & {
  bsale_document_id: number | string
  documents: {
    bsale_id: number | string
    number: number | string | null
    emission_date: string | null
  } | null
}

type PurchaseMixInvoiceRow = {
  bsale_id: number | string
  number: number | string | null
  emission_date: string | null
}

type BsaleVariantRow = {
  bsale_id: number | string
  bsale_product_id: number | string
  code: string | null
  description: string | null
}

type BsaleProductRow = {
  bsale_id: number | string
  name: string | null
  description: string | null
}

type DocumentSellerRow = {
  bsale_document_id: number | string
  seller_name: string | null
  is_primary: boolean | null
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

function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function addMonths(date: Date, months: number) {
  return new Date(date.getFullYear(), date.getMonth() + months, 1)
}

function documentLabel(typeId: number): { type: CommercialCustomerBehaviorDocumentType; label: string } | null {
  if (typeId === 5) return { type: 'invoice', label: 'Factura' }
  if (typeId === 23) return { type: 'sales_order', label: 'Nota de venta' }
  if (typeId === 2) return { type: 'credit_note', label: 'Nota de crédito' }
  return null
}

function daysBetweenToday(date: string | null) {
  if (!date) return null
  const start = new Date(date + 'T00:00:00')
  const today = new Date()
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.max(0, Math.floor((todayStart.getTime() - start.getTime()) / 86400000))
}

function buildTrendLabel(months: CommercialCustomerMonthlyEvolution[]): CommercialCustomerBehaviorSummary['trendLabel'] {
  const recent = months.slice(-3)
  const previous = months.slice(-6, -3)
  const recentHasData = recent.some(m => m.invoiceCount > 0 || m.creditNoteCount > 0)
  const previousHasData = previous.some(m => m.invoiceCount > 0 || m.creditNoteCount > 0)
  if (recent.length < 3 || previous.length < 3 || !recentHasData || !previousHasData) return 'Sin información suficiente'

  const recentTotal = recent.reduce((sum, m) => sum + m.netSalesAmount, 0)
  const previousTotal = previous.reduce((sum, m) => sum + m.netSalesAmount, 0)
  if (previousTotal === 0) return recentTotal > 0 ? 'En crecimiento' : 'Sin información suficiente'

  const change = (recentTotal - previousTotal) / Math.abs(previousTotal)
  if (change > 0.1) return 'En crecimiento'
  if (change < -0.1) return 'En baja'
  return 'Estable'
}

function sellerMapFromRows(rows: DocumentSellerRow[]) {
  const map = new Map<number, string>()
  const grouped = new Map<number, DocumentSellerRow[]>()

  for (const row of rows) {
    const docId = Number(row.bsale_document_id)
    const current = grouped.get(docId) || []
    current.push(row)
    grouped.set(docId, current)
  }

  for (const [docId, sellers] of grouped) {
    const primary = sellers.filter(s => s.is_primary && s.seller_name).map(s => s.seller_name as string)
    const names = primary.length > 0 ? primary : sellers.filter(s => s.seller_name).map(s => s.seller_name as string)
    map.set(docId, Array.from(new Set(names)).join(', ') || 'Pendiente')
  }

  return map
}

function mapBehaviorDocument(row: BehaviorDocumentRow, sellers: Map<number, string>): CommercialCustomerBehaviorDocument | null {
  const typeId = Number(row.document_type_id)
  const meta = documentLabel(typeId)
  if (!meta) return null
  const bsaleDocumentId = Number(row.bsale_id)
  return {
    bsale_document_id: bsaleDocumentId,
    documentTypeId: typeId,
    type: meta.type,
    label: meta.label,
    date: row.emission_date,
    number: row.number == null ? null : Number(row.number),
    amount: asNumber(row.total_amount),
    sellerName: sellers.get(bsaleDocumentId) || 'Pendiente',
  }
}

async function validateCommercialClient(companyId: string, bsaleClientId: number) {
  const { data, error } = await comAdmin()
    .from('customers')
    .select('id, bsale_client_id, business_name, fantasy_name')
    .eq('company_id', companyId)
    .eq('bsale_client_id', bsaleClientId)
    .maybeSingle()

  if (error) throw error
  return data as { id: string; bsale_client_id: number | string; business_name: string; fantasy_name: string | null } | null
}

async function loadCertifiedSellerMap(companyId: string, documentIds: number[]) {
  const sellerRows: DocumentSellerRow[] = []
  const uniqueIds = Array.from(new Set(documentIds.filter(Number.isFinite)))

  for (let i = 0; i < uniqueIds.length; i += 500) {
    const { data, error } = await comAdmin()
      .schema('integraciones')
      .from('bsale_document_sellers')
      .select('bsale_document_id,seller_name,is_primary')
      .eq('company_id', companyId)
      .in('bsale_document_id', uniqueIds.slice(i, i + 500))

    if (error) throw error
    sellerRows.push(...((data || []) as DocumentSellerRow[]))
  }

  return sellerMapFromRows(sellerRows)
}

function metricConfig(metricKey: CommercialCustomerMetricKey) {
  const { firstDay, today } = currentMonthRange()
  const now = new Date()
  const date90 = new Date(now.getTime() - 90 * 86400000).toISOString().slice(0, 10)
  const date180 = new Date(now.getTime() - 180 * 86400000).toISOString().slice(0, 10)

  switch (metricKey) {
    case 'current_month_sales':
      return { title: 'Detalle venta mes actual', types: [2, 5], from: firstDay, to: today, note: 'Venta neta = facturas - notas de crédito.' }
    case 'official_sales_total':
      return { title: 'Detalle venta oficial total', types: [5], from: null, to: null, note: 'Incluye facturas oficiales.' }
    case 'official_sales_90d':
      return { title: 'Detalle venta 90d', types: [5], from: date90, to: null, note: 'Incluye facturas oficiales de los últimos 90 días.' }
    case 'official_sales_180d':
      return { title: 'Detalle venta 180d', types: [5], from: date180, to: null, note: 'Incluye facturas oficiales de los últimos 180 días.' }
    case 'invoices_total':
      return { title: 'Detalle facturas totales', types: [5], from: null, to: null, note: 'Incluye todas las facturas del cliente.' }
    case 'avg_ticket':
      return { title: 'Documentos del ticket promedio', types: [5], from: null, to: null, note: 'Ticket promedio calculado sobre facturas oficiales totales.' }
    case 'credit_notes_total':
      return { title: 'Detalle notas de crédito', types: [2], from: null, to: null, note: 'Notas de crédito como corrección de venta.' }
    case 'credit_notes_90d':
      return { title: 'Detalle notas de crédito 90d', types: [2], from: date90, to: null, note: 'Notas de crédito de los últimos 90 días.' }
    case 'sales_orders_90d':
      return { title: 'Detalle notas de venta 90d', types: [23], from: date90, to: null, note: 'Notas de venta son pedidos operativos; no suman como venta oficial.' }
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

export async function getCommercialCustomerBehavior(params: {
  bsaleClientId: number
  monthsBack?: number
  limit?: number
}): Promise<CommercialCustomerBehavior | { error: string }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'No autorizado' }

  const bsaleClientId = Number(params.bsaleClientId)
  if (!Number.isFinite(bsaleClientId)) return { error: 'Cliente inválido' }

  const monthsBack = Math.min(Math.max(Number(params.monthsBack || 12), 3), 24)
  const limit = Math.min(Math.max(Number(params.limit || 20), 5), 50)

  const { data: customer, error: customerError } = await comAdmin()
    .from('customers')
    .select('id, bsale_client_id')
    .eq('company_id', companyId)
    .eq('bsale_client_id', bsaleClientId)
    .maybeSingle()

  if (customerError) {
    console.error('getCommercialCustomerBehavior customer error:', customerError)
    return { error: 'No se pudo validar el cliente' }
  }
  if (!customer) return { error: 'Cliente no pertenece a la empresa activa' }

  const now = new Date()
  const firstMonth = addMonths(startOfMonth(now), -(monthsBack - 1))
  const fromDate = monthKey(firstMonth) + '-01'
  const pageSize = 1000
  let from = 0
  const monthlyRows: BehaviorDocumentRow[] = []

  while (true) {
    const { data, error } = await comAdmin()
      .schema('integraciones')
      .from('bsale_documents')
      .select('bsale_id,number,emission_date,total_amount,document_type_id')
      .eq('company_id', companyId)
      .eq('client_id', bsaleClientId)
      .in('document_type_id', [2, 5, 23])
      .gte('emission_date', fromDate)
      .order('emission_date', { ascending: false })
      .range(from, from + pageSize - 1)

    if (error) {
      console.error('getCommercialCustomerBehavior documents error:', error)
      return { error: 'No se pudieron cargar documentos del cliente' }
    }

    const rows = (data || []) as BehaviorDocumentRow[]
    monthlyRows.push(...rows)
    if (rows.length < pageSize) break
    from += pageSize
  }

  const recentByType = await Promise.all([2, 5, 23].map(async documentTypeId => {
    const { data, error } = await comAdmin()
      .schema('integraciones')
      .from('bsale_documents')
      .select('bsale_id,number,emission_date,total_amount,document_type_id')
      .eq('company_id', companyId)
      .eq('client_id', bsaleClientId)
      .eq('document_type_id', documentTypeId)
      .order('emission_date', { ascending: false })
      .order('bsale_id', { ascending: false })
      .limit(limit)

    if (error) throw error
    return (data || []) as BehaviorDocumentRow[]
  })).catch(error => {
    console.error('getCommercialCustomerBehavior recent documents error:', error)
    return null
  })

  if (!recentByType) return { error: 'No se pudieron cargar documentos recientes' }

  const recentRows = recentByType.flat()

  const sellerDocumentIds = Array.from(new Set([...monthlyRows, ...recentRows].map(row => Number(row.bsale_id)).filter(Number.isFinite)))
  const sellerRows: DocumentSellerRow[] = []

  for (let i = 0; i < sellerDocumentIds.length; i += 500) {
    const { data, error } = await comAdmin()
      .schema('integraciones')
      .from('bsale_document_sellers')
      .select('bsale_document_id,seller_name,is_primary')
      .eq('company_id', companyId)
      .in('bsale_document_id', sellerDocumentIds.slice(i, i + 500))

    if (error) {
      console.error('getCommercialCustomerBehavior sellers error:', error)
      return { error: 'No se pudieron cargar vendedores certificados' }
    }
    sellerRows.push(...((data || []) as DocumentSellerRow[]))
  }

  const sellers = sellerMapFromRows(sellerRows)
  const monthlyDocuments = monthlyRows
    .map(row => mapBehaviorDocument(row, sellers))
    .filter(Boolean) as CommercialCustomerBehaviorDocument[]
  const recentDocumentsAll = recentRows
    .map(row => mapBehaviorDocument(row, sellers))
    .filter(Boolean) as CommercialCustomerBehaviorDocument[]

  const monthlyEvolution: CommercialCustomerMonthlyEvolution[] = Array.from({ length: monthsBack }, (_, index) => {
    const date = addMonths(firstMonth, index)
    return {
      month: monthKey(date),
      monthLabel: date.toLocaleDateString('es-CL', { month: 'short', year: '2-digit' }).replace('.', ''),
      invoiceGrossAmount: 0,
      creditNoteAmount: 0,
      netSalesAmount: 0,
      invoiceCount: 0,
      creditNoteCount: 0,
      salesOrderAmount: 0,
      salesOrderCount: 0,
      avgTicket: 0,
    }
  })
  const monthIndex = new Map(monthlyEvolution.map((item, index) => [item.month, index]))

  for (const doc of monthlyDocuments) {
    if (!doc.date) continue
    const index = monthIndex.get(doc.date.slice(0, 7))
    if (index === undefined) continue
    const month = monthlyEvolution[index]
    if (doc.documentTypeId === 5) {
      month.invoiceGrossAmount += doc.amount
      month.invoiceCount++
    }
    if (doc.documentTypeId === 2) {
      month.creditNoteAmount += doc.amount
      month.creditNoteCount++
    }
    if (doc.documentTypeId === 23) {
      month.salesOrderAmount += doc.amount
      month.salesOrderCount++
    }
    month.netSalesAmount = month.invoiceGrossAmount - month.creditNoteAmount
    month.avgTicket = month.invoiceCount > 0 ? Math.round(month.invoiceGrossAmount / month.invoiceCount) : 0
  }

  const sortedDocuments = recentDocumentsAll.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || b.bsale_document_id - a.bsale_document_id)
  const recentInvoices = sortedDocuments.filter(doc => doc.documentTypeId === 5).slice(0, limit)
  const recentSalesOrders = sortedDocuments.filter(doc => doc.documentTypeId === 23).slice(0, limit)
  const recentCreditNotes = sortedDocuments.filter(doc => doc.documentTypeId === 2).slice(0, limit)
  const recentDocuments = sortedDocuments.slice(0, limit)

  const invoiceMonths = monthlyEvolution.filter(m => m.invoiceCount > 0)
  const bestMonth = invoiceMonths.length > 0 ? invoiceMonths.reduce((best, month) => month.netSalesAmount > best.netSalesAmount ? month : best).monthLabel : null
  const worstMonth = invoiceMonths.length > 0 ? invoiceMonths.reduce((worst, month) => month.netSalesAmount < worst.netSalesAmount ? month : worst).monthLabel : null
  const lastInvoiceDate = recentInvoices[0]?.date || null
  const totalInvoiceGross12m = monthlyEvolution.reduce((sum, month) => sum + month.invoiceGrossAmount, 0)
  const totalCreditNotes12m = monthlyEvolution.reduce((sum, month) => sum + month.creditNoteAmount, 0)
  const invoices12m = monthlyEvolution.reduce((sum, month) => sum + month.invoiceCount, 0)

  return {
    monthlyEvolution,
    recentInvoices,
    recentSalesOrders,
    recentCreditNotes,
    recentDocuments,
    behaviorSummary: {
      totalNetSales12m: totalInvoiceGross12m - totalCreditNotes12m,
      totalInvoiceGross12m,
      totalCreditNotes12m,
      invoices12m,
      salesOrders12m: monthlyEvolution.reduce((sum, month) => sum + month.salesOrderCount, 0),
      creditNotes12m: monthlyEvolution.reduce((sum, month) => sum + month.creditNoteCount, 0),
      avgTicket12m: invoices12m > 0 ? Math.round(totalInvoiceGross12m / invoices12m) : 0,
      lastInvoiceDate,
      daysSinceLastInvoice: daysBetweenToday(lastInvoiceDate),
      bestMonth,
      worstMonth,
      trendLabel: buildTrendLabel(monthlyEvolution),
    },
  }
}

export async function getCommercialCustomerMetricDocuments(params: {
  bsaleClientId: number
  metricKey: CommercialCustomerMetricKey
  limit?: number
}): Promise<CommercialCustomerMetricDocuments | { error: string }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'No autorizado' }

  const bsaleClientId = Number(params.bsaleClientId)
  if (!Number.isFinite(bsaleClientId)) return { error: 'Cliente inválido' }

  const allowedKeys: CommercialCustomerMetricKey[] = ['current_month_sales', 'official_sales_total', 'official_sales_90d', 'official_sales_180d', 'invoices_total', 'avg_ticket', 'credit_notes_total', 'credit_notes_90d', 'sales_orders_90d']
  if (!allowedKeys.includes(params.metricKey)) return { error: 'Métrica inválida' }

  try {
    const customer = await validateCommercialClient(companyId, bsaleClientId)
    if (!customer) return { error: 'Cliente no pertenece a la empresa activa' }

    const config = metricConfig(params.metricKey)
    const limit = Math.min(Math.max(Number(params.limit || 120), 20), 500)
    let query = comAdmin()
      .schema('integraciones')
      .from('bsale_documents')
      .select('bsale_id,number,emission_date,total_amount,document_type_id')
      .eq('company_id', companyId)
      .eq('client_id', bsaleClientId)
      .in('document_type_id', config.types)
      .order('emission_date', { ascending: false })
      .order('bsale_id', { ascending: false })
      .limit(limit)

    if (config.from) query = query.gte('emission_date', config.from)
    if (config.to) query = query.lte('emission_date', config.to)

    const { data, error } = await query
    if (error) throw error

    const rows = (data || []) as BehaviorDocumentRow[]
    const sellers = await loadCertifiedSellerMap(companyId, rows.map(row => Number(row.bsale_id)))
    const documents = rows
      .map(row => mapBehaviorDocument(row, sellers))
      .filter(Boolean) as CommercialCustomerBehaviorDocument[]

    const summary = documents.reduce((acc, doc) => {
      if (doc.documentTypeId === 5) acc.invoiceGrossAmount += doc.amount
      if (doc.documentTypeId === 2) acc.creditNoteAmount += doc.amount
      if (doc.documentTypeId === 23) acc.salesOrderAmount += doc.amount
      acc.netAmount = acc.invoiceGrossAmount - acc.creditNoteAmount
      return acc
    }, { documentsCount: documents.length, invoiceGrossAmount: 0, creditNoteAmount: 0, netAmount: 0, salesOrderAmount: 0 })

    return {
      metricKey: params.metricKey,
      title: config.title,
      note: config.note,
      documents,
      summary,
    }
  } catch (error) {
    console.error('getCommercialCustomerMetricDocuments error:', error)
    return { error: 'No se pudo cargar el detalle de la métrica' }
  }
}

export async function getCommercialDocumentDetail(params: {
  bsaleDocumentId: number
}): Promise<CommercialDocumentDetail | { error: string }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'No autorizado' }

  const bsaleDocumentId = Number(params.bsaleDocumentId)
  if (!Number.isFinite(bsaleDocumentId)) return { error: 'Documento inválido' }

  try {
    const { data: documentData, error: documentError } = await comAdmin()
      .schema('integraciones')
      .from('bsale_documents')
      .select('bsale_id,number,emission_date,generation_date,total_amount,net_amount,tax_amount,exempt_amount,document_type_id,client_id,state,url_pdf,raw_json')
      .eq('company_id', companyId)
      .eq('bsale_id', bsaleDocumentId)
      .maybeSingle()

    if (documentError) throw documentError
    if (!documentData) return { error: 'Documento no encontrado' }

    const document = documentData as DetailDocumentRow
    const clientId = document.client_id == null ? null : Number(document.client_id)
    const customer = clientId == null ? null : await validateCommercialClient(companyId, clientId)
    if (clientId != null && !customer) return { error: 'Documento no pertenece a la empresa activa' }

    const { data: lineData, error: lineError } = await comAdmin()
      .schema('integraciones')
      .from('bsale_document_details')
      .select('bsale_id,line_number,quantity,net_unit_value,total_unit_value,net_amount,tax_amount,total_amount,net_discount,variant_id,variant_code,variant_description')
      .eq('company_id', companyId)
      .eq('bsale_document_id', bsaleDocumentId)
      .order('line_number', { ascending: true })

    if (lineError) throw lineError

    const sellers = await loadCertifiedSellerMap(companyId, [bsaleDocumentId])
    const typeId = Number(document.document_type_id)
    const label = documentLabel(typeId)?.label || 'Documento'
    const rawClient = document.raw_json?.client as { company?: string; firstName?: string; lastName?: string } | undefined
    const clientName = customer?.business_name || rawClient?.company || [rawClient?.firstName, rawClient?.lastName].filter(Boolean).join(' ') || null
    const lines = (lineData || []) as DetailLineRow[]
    const variantIds = Array.from(new Set(lines.map(line => line.variant_id == null ? null : Number(line.variant_id)).filter((id): id is number => Number.isFinite(id))))
    const variantMap = new Map<number, BsaleVariantRow>()
    const productMap = new Map<number, BsaleProductRow>()

    if (variantIds.length > 0) {
      const { data: variantData, error: variantError } = await comAdmin()
        .schema('integraciones')
        .from('bsale_variants')
        .select('bsale_id,bsale_product_id,code,description')
        .eq('company_id', companyId)
        .in('bsale_id', variantIds)

      if (variantError) throw variantError
      const variants = (variantData || []) as BsaleVariantRow[]
      for (const variant of variants) variantMap.set(Number(variant.bsale_id), variant)

      const productIds = Array.from(new Set(variants.map(variant => Number(variant.bsale_product_id)).filter(Number.isFinite)))
      if (productIds.length > 0) {
        const { data: productData, error: productError } = await comAdmin()
          .schema('integraciones')
          .from('bsale_products')
          .select('bsale_id,name,description')
          .eq('company_id', companyId)
          .in('bsale_id', productIds)

        if (productError) throw productError
        for (const product of (productData || []) as BsaleProductRow[]) productMap.set(Number(product.bsale_id), product)
      }
    }

    const items = lines.map((line, index) => {
      const variantId = line.variant_id == null ? null : Number(line.variant_id)
      const variant = variantId == null ? null : variantMap.get(variantId)
      const product = variant ? productMap.get(Number(variant.bsale_product_id)) : null
      const lineNumber = line.line_number == null ? null : Number(line.line_number)
      const format = variant?.description || line.variant_description || null
      const productName = product?.name || product?.description || (format ? null : line.variant_description) || line.variant_code || null

      return {
      line_number: lineNumber && lineNumber > 0 ? lineNumber : index + 1,
      bsale_detail_id: Number(line.bsale_id),
      variant_id: variantId,
      sku: line.variant_code || variant?.code || null,
      description: productName,
      format,
      quantity: asNumber(line.quantity),
      net_unit_value: asNumber(line.net_unit_value),
      total_unit_value: asNumber(line.total_unit_value),
      net_discount: asNumber(line.net_discount),
      net_amount: asNumber(line.net_amount),
      tax_amount: asNumber(line.tax_amount),
      total_amount: asNumber(line.total_amount),
    }
    })

    return {
      header: {
        bsale_document_id: Number(document.bsale_id),
        document_type_id: typeId,
        document_type_label: label,
        number: document.number == null ? null : Number(document.number),
        emission_date: document.emission_date,
        generation_date: document.generation_date,
        client_id: clientId,
        client_name: clientName,
        total_amount: asNumber(document.total_amount),
        net_amount: asNumber(document.net_amount),
        tax_amount: asNumber(document.tax_amount),
        exempt_amount: asNumber(document.exempt_amount),
        discount_amount: items.reduce((sum, item) => sum + item.net_discount, 0),
        state: document.state == null ? null : Number(document.state),
        url_pdf: document.url_pdf,
        seller_name: sellers.get(bsaleDocumentId) || 'Pendiente',
      },
      items,
      totals: {
        lines: items.length,
        units: items.reduce((sum, item) => sum + item.quantity, 0),
        subtotal: items.reduce((sum, item) => sum + item.net_amount, 0),
        discounts: items.reduce((sum, item) => sum + item.net_discount, 0),
        taxes: items.reduce((sum, item) => sum + item.tax_amount, 0),
        total: asNumber(document.total_amount),
      },
    }
  } catch (error) {
    console.error('getCommercialDocumentDetail error:', error)
    return { error: 'No se pudo cargar el detalle del documento' }
  }
}

export async function getCommercialCustomerPurchaseMix(params: {
  bsaleClientId: number
  monthsBack?: number
  topLimit?: number
}): Promise<CommercialCustomerPurchaseMix | { error: string }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'No autorizado' }

  const bsaleClientId = Number(params.bsaleClientId)
  if (!Number.isFinite(bsaleClientId)) return { error: 'Cliente inválido' }

  const monthsBack = Math.min(Math.max(Number(params.monthsBack || 12), 3), 24)
  const topLimit = Math.min(Math.max(Number(params.topLimit || 15), 5), 30)

  try {
    const customer = await validateCommercialClient(companyId, bsaleClientId)
    if (!customer) return { error: 'Cliente no pertenece a la empresa activa' }

    const now = new Date()
    const firstMonth = addMonths(startOfMonth(now), -(monthsBack - 1))
    const fromDate = monthKey(firstMonth) + '-01'
    const pageSize = 1000
    let from = 0
    const invoices: PurchaseMixInvoiceRow[] = []
    const lines: PurchaseMixLineRow[] = []

    while (true) {
      const { data, error } = await comAdmin()
        .schema('integraciones')
        .from('bsale_documents')
        .select('bsale_id,number,emission_date')
        .eq('company_id', companyId)
        .eq('client_id', bsaleClientId)
        .eq('document_type_id', 5)
        .gte('emission_date', fromDate)
        .order('emission_date', { ascending: false })
        .order('bsale_id', { ascending: false })
        .range(from, from + pageSize - 1)

      if (error) throw error
      const rows = (data || []) as PurchaseMixInvoiceRow[]
      invoices.push(...rows)
      if (rows.length < pageSize) break
      from += pageSize
    }

    const invoiceMap = new Map(invoices.map(invoice => [Number(invoice.bsale_id), invoice]))
    const invoiceIds = invoices.map(invoice => Number(invoice.bsale_id)).filter(Number.isFinite)

    for (let i = 0; i < invoiceIds.length; i += 500) {
      let detailFrom = 0
      while (true) {
        const { data, error } = await comAdmin()
          .schema('integraciones')
          .from('bsale_document_details')
          .select('bsale_id,bsale_document_id,line_number,quantity,net_unit_value,total_unit_value,net_amount,tax_amount,total_amount,net_discount,variant_id,variant_code,variant_description')
          .eq('company_id', companyId)
          .in('bsale_document_id', invoiceIds.slice(i, i + 500))
          .range(detailFrom, detailFrom + pageSize - 1)

        if (error) throw error
        const rows = (data || []) as Array<DetailLineRow & { bsale_document_id: number | string }>
        lines.push(...rows.map(line => ({
          ...line,
          documents: invoiceMap.get(Number(line.bsale_document_id)) || null,
        })))
        if (rows.length < pageSize) break
        detailFrom += pageSize
      }
    }

    const variantIds = Array.from(new Set(lines.map(line => line.variant_id == null ? null : Number(line.variant_id)).filter((id): id is number => Number.isFinite(id))))
    const variantMap = new Map<number, BsaleVariantRow>()
    const productMap = new Map<number, BsaleProductRow>()

    for (let i = 0; i < variantIds.length; i += 500) {
      const { data, error } = await comAdmin()
        .schema('integraciones')
        .from('bsale_variants')
        .select('bsale_id,bsale_product_id,code,description')
        .eq('company_id', companyId)
        .in('bsale_id', variantIds.slice(i, i + 500))

      if (error) throw error
      for (const variant of (data || []) as BsaleVariantRow[]) variantMap.set(Number(variant.bsale_id), variant)
    }

    const productIds = Array.from(new Set(Array.from(variantMap.values()).map(variant => Number(variant.bsale_product_id)).filter(Number.isFinite)))
    for (let i = 0; i < productIds.length; i += 500) {
      const { data, error } = await comAdmin()
        .schema('integraciones')
        .from('bsale_products')
        .select('bsale_id,name,description')
        .eq('company_id', companyId)
        .in('bsale_id', productIds.slice(i, i + 500))

      if (error) throw error
      for (const product of (data || []) as BsaleProductRow[]) productMap.set(Number(product.bsale_id), product)
    }

    const monthlyQuantityEvolution = Array.from({ length: monthsBack }, (_, index) => {
      const date = addMonths(firstMonth, index)
      return {
        month: monthKey(date),
        monthLabel: date.toLocaleDateString('es-CL', { month: 'short', year: '2-digit' }).replace('.', ''),
        totalUnits: 0,
        invoiceCount: 0,
        netSalesAmount: 0,
        distinctProducts: 0,
        avgUnitsPerInvoice: 0,
      }
    })
    const monthIndex = new Map(monthlyQuantityEvolution.map((item, index) => [item.month, index]))
    const monthInvoices = new Map<string, Set<number>>()
    const monthProducts = new Map<string, Set<string>>()
    const productMapAgg = new Map<string, CommercialCustomerPurchaseMixProduct & { invoiceIds: Set<number>; formatSet: Set<string> }>()
    const recentProductActivity: CommercialCustomerPurchaseMix['recentProductActivity'] = []

    for (const line of lines) {
      const invoice = line.documents
      const date = invoice?.emission_date || null
      const variantId = line.variant_id == null ? null : Number(line.variant_id)
      const variant = variantId == null ? null : variantMap.get(variantId)
      const product = variant ? productMap.get(Number(variant.bsale_product_id)) : null
      const sku = line.variant_code || variant?.code || 'Sin SKU'
      const format = variant?.description || line.variant_description || null
      const productName = product?.name || product?.description || (format ? null : line.variant_description) || 'Producto sin nombre'
      const productKey = product ? `p:${product.bsale_id}` : `sku:${sku}`
      const quantity = asNumber(line.quantity)
      const amount = asNumber(line.total_amount)
      const invoiceId = invoice ? Number(invoice.bsale_id) : Number(line.bsale_document_id)

      if (date) {
        const index = monthIndex.get(date.slice(0, 7))
        if (index !== undefined) {
          const month = monthlyQuantityEvolution[index]
          month.totalUnits += quantity
          month.netSalesAmount += amount
          const invoices = monthInvoices.get(month.month) || new Set<number>()
          invoices.add(invoiceId)
          monthInvoices.set(month.month, invoices)
          const products = monthProducts.get(month.month) || new Set<string>()
          products.add(productKey)
          monthProducts.set(month.month, products)
        }
      }

      const current = productMapAgg.get(productKey) || {
        sku,
        productName,
        totalAmount: 0,
        totalUnits: 0,
        invoiceCount: 0,
        lastPurchaseDate: null,
        daysSinceLastPurchase: null,
        formats: [],
        avgUnitPrice: 0,
        invoiceIds: new Set<number>(),
        formatSet: new Set<string>(),
      }
      current.totalAmount += amount
      current.totalUnits += quantity
      current.invoiceIds.add(invoiceId)
      if (format) current.formatSet.add(format)
      if (date && (!current.lastPurchaseDate || date > current.lastPurchaseDate)) current.lastPurchaseDate = date
      current.avgUnitPrice = current.totalUnits > 0 ? Math.round(current.totalAmount / current.totalUnits) : 0
      current.invoiceCount = current.invoiceIds.size
      current.formats = Array.from(current.formatSet).sort()
      current.daysSinceLastPurchase = daysBetweenToday(current.lastPurchaseDate)
      productMapAgg.set(productKey, current)

      recentProductActivity.push({
        date,
        invoiceNumber: invoice?.number == null ? null : Number(invoice.number),
        sku,
        productName,
        format,
        quantity,
        totalAmount: amount,
      })
    }

    for (const month of monthlyQuantityEvolution) {
      month.invoiceCount = monthInvoices.get(month.month)?.size || 0
      month.distinctProducts = monthProducts.get(month.month)?.size || 0
      month.avgUnitsPerInvoice = month.invoiceCount > 0 ? Math.round(month.totalUnits / month.invoiceCount) : 0
    }

    const products = Array.from(productMapAgg.values()).map(product => ({
      sku: product.sku,
      productName: product.productName,
      totalAmount: product.totalAmount,
      totalUnits: product.totalUnits,
      invoiceCount: product.invoiceCount,
      lastPurchaseDate: product.lastPurchaseDate,
      daysSinceLastPurchase: product.daysSinceLastPurchase,
      formats: product.formats,
      avgUnitPrice: product.avgUnitPrice,
    }))
    const topProductsByAmount = [...products].sort((a, b) => b.totalAmount - a.totalAmount).slice(0, topLimit)
    const topProductsByUnits = [...products].sort((a, b) => b.totalUnits - a.totalUnits).slice(0, topLimit)
    const staleProducts = [...products]
      .filter(product => (product.daysSinceLastPurchase || 0) > 90)
      .sort((a, b) => b.totalAmount - a.totalAmount)
      .slice(0, 10)
    const sortedRecentActivity = recentProductActivity
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
      .slice(0, 20)
    const totalAmount12m = products.reduce((sum, product) => sum + product.totalAmount, 0)
    const totalUnits12m = products.reduce((sum, product) => sum + product.totalUnits, 0)
    const topProduct = topProductsByAmount[0] || null
    const lastProductPurchaseDate = products.reduce<string | null>((latest, product) => {
      if (!product.lastPurchaseDate) return latest
      return !latest || product.lastPurchaseDate > latest ? product.lastPurchaseDate : latest
    }, null)
    const monthsWithPurchases = monthlyQuantityEvolution.filter(month => month.totalUnits > 0).length

    return {
      monthlyQuantityEvolution,
      topProductsByAmount,
      topProductsByUnits,
      recentProductActivity: sortedRecentActivity,
      staleProducts,
      mixSummary: {
        totalProducts: products.length,
        totalUnits12m,
        totalAmount12m,
        topProductName: topProduct?.productName || null,
        topProductSharePercent: topProduct && totalAmount12m > 0 ? Math.round((topProduct.totalAmount / totalAmount12m) * 100) : 0,
        lastProductPurchaseDate,
        monthsWithPurchases,
        avgMonthlyUnits: monthsBack > 0 ? Math.round(totalUnits12m / monthsBack) : 0,
      },
    }
  } catch (error) {
    console.error('getCommercialCustomerPurchaseMix error:', error)
    return { error: 'No se pudo cargar el mix de compra' }
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
