'use server'

import { createClient } from '@/lib/supabase/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { getActiveCompanyId } from '@/app/actions/companies'

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

function adqAdmin() {
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
    db: { schema: 'adquisiciones' }, auth: { autoRefreshToken: false, persistSession: false },
  })
}

export interface PurchaseOrder {
  id: string
  correlative: string
  issue_date: string
  required_date: string | null
  supplier_id: string
  source_type: 'MANUAL' | 'REPLENISHMENT'
  supplier_name: string
  supplier_rut: string | null
  warehouse_id: string | null
  warehouse_name: string | null
  po_type: string
  currency: string
  payment_terms: string | null
  requested_by: string
  requester_name: string
  authorized_by: string | null
  authorized_name: string | null
  notes: string | null
  net_total: number
  discount_total: number
  tax_total: number
  exempt_total: number
  grand_total: number
  status: string
  receipt_status: string | null
  invoice_status: string | null
  email_sent_at: string | null
  cancel_reason: string | null
  created_at: string
  updated_at: string
}

export interface PurchaseOrderItem {
  id: string
  line_number: number
  item_type: string
  product_id: string | null
  product_description: string
  unit: string | null
  quantity: number
  unit_price: number
  discount_percent: number
  discount_amount: number
  tax_rate: number
  tax_amount: number
  line_total: number
  warehouse_id: string | null
  warehouse_name: string | null
  cost_center: string | null
  required_date: string | null
  notes: string | null
  quantity_received: number
  quantity_pending: number
  lot_number: string | null
  expiration_date: string | null
  sku?: string | null
}

export interface PurchaseOrderDetail {
  po: {
    id: string
    correlative: string
    issue_date: string
    required_date: string | null
    supplier_id: string
    source_type: 'MANUAL' | 'REPLENISHMENT'
    supplier_name: string
    supplier_rut: string | null
    supplier_contact: string | null
    supplier_email: string | null
    supplier_phone: string | null
    supplier_address: string | null
    warehouse_id: string | null
    warehouse_name: string | null
    po_type: string
    currency: string
    payment_terms: string | null
    requested_by: string
    requester_name: string
    requester_email: string | null
    authorized_by: string | null
    authorized_name: string | null
    authorized_position: string | null
    notes: string | null
    net_total: number
    discount_total: number
    tax_total: number
    exempt_total: number
    grand_total: number
    status: string
    receipt_status: string | null
    invoice_status: string | null
    cancel_reason: string | null
    cancelled_at: string | null
    email_sent_at: string | null
    supplier_email_snapshot: string | null
    created_at: string
    updated_at: string
    company_name?: string | null
    company_rut?: string | null
    company_logo_url?: string | null
    company_phone?: string | null
    company_email?: string | null
    company_address?: string | null
    company_giro?: string | null
    company_region?: string | null
    company_comuna?: string | null
    company_city?: string | null
    company_purchase_terms?: string | null
    company_document_footer?: string | null
  }
  items: PurchaseOrderItem[]
}

export type PurchaseOrderDocumentSource = 'CURRENT' | 'CONFIRMED'

export interface PurchaseOrderDocumentDetail extends PurchaseOrderDetail {
  items: (PurchaseOrderItem & { sku: string | null })[]
  document_source: PurchaseOrderDocumentSource
  snapshot_id?: string
  generated_from_persisted_data: true
}

export interface PurchaseOrderFilters {
  search?: string
  status?: string
  supplier_id?: string
  po_type?: string
  date_from?: string
  date_to?: string
  page?: number
  pageSize?: number
}

export interface AuthorizedPersonnel {
  id: string
  full_name: string
  position: string | null
  email: string | null
}

export interface DuplicateWarning {
  type: string
  message: string
  product_sku: string
}

export async function getPurchaseOrders(filters: PurchaseOrderFilters = {}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: [], total: 0 }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: [], total: 0 }

  const db = adqAdmin()
  const { data, error } = await db.rpc('get_purchase_orders', {
    p_filters: {
      search: filters.search || null,
      status: filters.status || null,
      supplier_id: filters.supplier_id || null,
      po_type: filters.po_type || null,
      date_from: filters.date_from || null,
      date_to: filters.date_to || null,
      page: filters.page ?? 1,
      page_size: filters.pageSize ?? 50,
    },
    p_company_id: companyId
  })
  if (error) {
    console.error('get_purchase_orders error:', error)
    return { data: [], total: 0 }
  }
  const result = data as { data: PurchaseOrder[]; total: number; page: number; page_size: number } | null
  if (!result) return { data: [], total: 0 }
  return { data: result.data ?? [], total: result.total ?? 0 }
}

export async function getPurchaseOrderDetail(poId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const db = adqAdmin()
  if (process.env.NODE_ENV === 'development') console.time(`getPurchaseOrderDetail_${poId}`)
  const { data, error } = await db.rpc('get_purchase_order_detail', { p_po_id: poId })
  if (process.env.NODE_ENV === 'development') console.timeEnd(`getPurchaseOrderDetail_${poId}`)
  if (error) {
    console.error('get_purchase_order_detail error:', error)
    return null
  }
  return data as PurchaseOrderDetail | null
}

function snapshotText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return typeof value === 'string' ? value : String(value)
}

function snapshotNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

export async function getPurchaseOrderDocumentDetail(poId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' }

  const current = await getPurchaseOrderDetail(poId)
  if (!current) return { error: 'No se pudo obtener el detalle persistido de la OC' }

  const db = adqAdmin()
  const { data: confirmed, error: snapshotError } = await db
    .from('purchase_order_snapshots')
    .select('id, header_snapshot, items_snapshot')
    .eq('po_id', poId)
    .eq('company_id', companyId)
    .eq('snapshot_type', 'CONFIRMED')
    .maybeSingle()

  if (snapshotError) {
    console.error('get_purchase_order_document_detail snapshot error:', snapshotError)
    return { error: 'No se pudo obtener la versión documental de la OC' }
  }

  if (!confirmed) {
    const productIds = current.items.map(item => item.product_id).filter((id): id is string => Boolean(id))
    const { data: products } = productIds.length > 0
      ? await db.from('products').select('id, sku').in('id', productIds).eq('company_id', companyId)
      : { data: [] as { id: string; sku: string | null }[] }
    const currentSkuById = new Map((products ?? []).map(product => [product.id, product.sku]))
    return {
      data: {
        ...current,
        items: current.items.map(item => ({
          ...item,
          sku: item.sku ?? (item.product_id ? currentSkuById.get(item.product_id) ?? null : null),
        })),
        document_source: 'CURRENT' as const,
        generated_from_persisted_data: true as const,
      } satisfies PurchaseOrderDocumentDetail,
    }
  }

  const header = (confirmed.header_snapshot ?? {}) as Record<string, unknown>
  const snapshotItems = Array.isArray(confirmed.items_snapshot) ? confirmed.items_snapshot : []
  const currentItemsById = new Map(current.items.map(item => [item.id, item]))
  const snapshotPo = {
    ...current.po,
    issue_date: snapshotText(header.issue_date) as string,
    required_date: snapshotText(header.required_date),
    supplier_id: snapshotText(header.supplier_id) as string,
    supplier_name: snapshotText(header.supplier_name) as string,
    supplier_rut: snapshotText(header.supplier_rut),
    warehouse_id: snapshotText(header.warehouse_id),
    warehouse_name: snapshotText(header.warehouse_name),
    po_type: snapshotText(header.po_type) as string,
    source_type: snapshotText(header.source_type) as PurchaseOrder['source_type'],
    currency: snapshotText(header.currency) as string,
    payment_terms: snapshotText(header.payment_terms),
    requested_by: snapshotText(header.requested_by) as string,
    requester_name: snapshotText(header.requester_name) as string,
    authorized_by: snapshotText(header.authorized_by),
    authorized_name: snapshotText(header.authorized_name),
    notes: snapshotText(header.notes),
    net_total: snapshotNumber(header.net_total) as number,
    discount_total: snapshotNumber(header.discount_total) as number,
    tax_total: snapshotNumber(header.tax_total) as number,
    exempt_total: snapshotNumber(header.exempt_total) as number,
    grand_total: snapshotNumber(header.grand_total) as number,
    status: current.po.status,
    receipt_status: current.po.receipt_status,
    invoice_status: current.po.invoice_status,
  }
  const documentItems = snapshotItems.map(raw => {
    const item = (raw ?? {}) as Record<string, unknown>
    const itemId = snapshotText(item.item_id) as string
    const currentItem = currentItemsById.get(itemId)
    const quantity = snapshotNumber(item.quantity) as number
    const quantityReceived = currentItem?.quantity_received ?? 0
    return {
      id: itemId,
      line_number: snapshotNumber(item.line_number) as number,
      item_type: snapshotText(item.item_type) as string,
      product_id: snapshotText(item.product_id),
      sku: snapshotText(item.sku),
      product_description: snapshotText(item.product_description) as string,
      unit: snapshotText(item.unit),
      quantity,
      unit_price: snapshotNumber(item.unit_price) as number,
      discount_percent: snapshotNumber(item.discount_percent) as number,
      discount_amount: snapshotNumber(item.discount_amount) as number,
      tax_rate: snapshotNumber(item.tax_rate) as number,
      tax_amount: snapshotNumber(item.tax_amount) as number,
      line_total: snapshotNumber(item.line_total) as number,
      warehouse_id: snapshotText(item.warehouse_id),
      warehouse_name: snapshotText(item.warehouse_name),
      cost_center: snapshotText(item.cost_center),
      required_date: snapshotText(item.required_date),
      notes: snapshotText(item.notes),
      quantity_received: quantityReceived,
      quantity_pending: Math.max(quantity - quantityReceived, 0),
      lot_number: currentItem?.lot_number ?? null,
      expiration_date: currentItem?.expiration_date ?? null,
    }
  })

  return {
    data: {
      po: snapshotPo,
      items: documentItems,
      document_source: 'CONFIRMED' as const,
      snapshot_id: confirmed.id,
      generated_from_persisted_data: true as const,
    } satisfies PurchaseOrderDocumentDetail,
  }
}

export interface CreatePOItem {
  item_type: 'PRODUCT' | 'SERVICE'
  product_id?: string | null
  product_description: string
  unit?: string | null
  quantity: number
  unit_price: number
  discount_percent?: number
  tax_rate?: number
  warehouse_id?: string | null
  cost_center?: string | null
  required_date?: string | null
  notes?: string | null
}

export interface CreatePOData {
  issue_date: string
  required_date?: string
  supplier_id: string
  source_type?: 'MANUAL' | 'REPLENISHMENT'
  warehouse_id?: string | null
  payment_terms?: string
  authorized_by?: string | null
  notes?: string
  currency?: string
  status?: 'BORRADOR' | 'EMITIDA'
  items: CreatePOItem[]
}

export async function createPurchaseOrder(data: CreatePOData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' }

  const db = adqAdmin()
  const { data: result, error } = await db.rpc('create_purchase_order', {
    p_data: {
      issue_date: data.issue_date,
      required_date: data.required_date || null,
      supplier_id: data.supplier_id,
      source_type: data.source_type ?? 'MANUAL',
      warehouse_id: data.warehouse_id || null,
      payment_terms: data.payment_terms || null,
      authorized_by: data.authorized_by || null,
      notes: data.notes || null,
      currency: data.currency || 'CLP',
      status: data.status || 'EMITIDA',
      items: data.items.map(i => ({
        item_type: i.item_type,
        product_id: i.product_id || null,
        product_description: i.product_description,
        unit: i.unit || null,
        quantity: i.quantity,
        unit_price: i.unit_price,
        discount_percent: i.discount_percent ?? 0,
        tax_rate: i.tax_rate ?? 19,
        warehouse_id: i.warehouse_id || null,
        cost_center: i.cost_center || null,
        required_date: i.required_date || null,
        notes: i.notes || null,
      })),
    },
    p_user_id: user.id,
    p_company_id: companyId
  })
  if (error) return { error: error.message }
  const r = result as { success: boolean; error?: string; po_id?: string; correlative?: string }
  if (!r.success) return { error: r.error || 'Error al crear OC' }
  return { success: true, po_id: r.po_id, correlative: r.correlative }
}

export interface SupplierReviewItemInput {
  item_id?: string | null
  item_type: 'PRODUCT' | 'SERVICE'
  product_id?: string | null
  product_description?: string | null
  quantity: number
  unit_price: number
  discount_percent?: number | null
  tax_rate?: number | null
  notes?: string | null
}

export interface SupplierReviewData {
  items: SupplierReviewItemInput[]
}

export type PurchaseOrderReviewComparisonStatus =
  | 'SIN_CAMBIOS'
  | 'MODIFICADA'
  | 'ELIMINADA'
  | 'AGREGADA'

export interface PurchaseOrderReviewItem {
  item_id: string
  line_number: number
  item_type: 'PRODUCT' | 'SERVICE'
  product_id: string | null
  sku: string | null
  product_description: string
  unit: string | null
  quantity: number
  unit_price: number
  discount_percent: number
  discount_amount: number
  tax_rate: number
  tax_amount: number
  line_total: number
  notes: string | null
}

export interface PurchaseOrderReviewChangedField {
  field: string
  original: unknown
  current: unknown
}

export interface PurchaseOrderReviewComparisonLine {
  item_id: string
  comparison_status: PurchaseOrderReviewComparisonStatus
  original_item: PurchaseOrderReviewItem | null
  current_item: PurchaseOrderReviewItem | null
  changed_fields: PurchaseOrderReviewChangedField[]
}

export interface PurchaseOrderSupplierReviewPO {
  id: string
  correlative: string
  status: string
  supplier_id: string
  supplier_name: string | null
  supplier_rut: string | null
  warehouse_id: string | null
  warehouse_name: string | null
  currency: string
  issue_date: string
  required_date: string | null
  payment_terms: string | null
  net_total: number
  discount_total: number
  tax_total: number
  grand_total: number
}

export interface PurchaseOrderSupplierReviewComparison {
  success: true
  po: PurchaseOrderSupplierReviewPO
  original: {
    snapshot_id: string
    created_at: string
    header: Record<string, unknown>
    items: PurchaseOrderReviewItem[]
  }
  current: { items: PurchaseOrderReviewItem[] }
  comparison: PurchaseOrderReviewComparisonLine[]
  summary: {
    total_lines: number
    unchanged_count: number
    modified_count: number
    removed_count: number
    added_count: number
    original_grand_total: number
    current_grand_total: number
    total_difference: number
  }
}

export async function updateSentPurchaseOrderReview(poId: string, data: SupplierReviewData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' }

  const db = adqAdmin()
  const { data: result, error } = await db.rpc('update_purchase_order_supplier_review', {
    p_po_id: poId,
    p_data: {
      items: data.items.map(item => ({
        item_id: item.item_id || null,
        item_type: item.item_type,
        product_id: item.product_id || null,
        product_description: item.product_description ?? null,
        quantity: item.quantity,
        unit_price: item.unit_price,
        discount_percent: item.discount_percent ?? null,
        tax_rate: item.tax_rate ?? null,
        notes: item.notes ?? null,
      })),
    },
    p_user_id: user.id,
    p_company_id: companyId,
  })
  if (error) return { error: error.message }
  const r = result as { success: boolean; error?: string; po_id?: string; item_count?: number }
  if (!r.success) return { error: r.error || 'Error al revisar la OC' }
  return {
    success: true,
    po_id: r.po_id,
    item_count: r.item_count,
  }
}

export type ConfirmPurchaseOrderSupplierReviewResult = {
  success: true
  already_confirmed: boolean
  po_id: string
  status: 'CONFIRMADA'
  snapshot_id: string
}

export async function confirmPurchaseOrderSupplierReview(poId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' }

  const db = adqAdmin()
  const { data, error } = await db.rpc('confirm_purchase_order_supplier_review', {
    p_po_id: poId,
    p_user_id: user.id,
    p_company_id: companyId,
  })
  if (error) return { error: error.message }
  const result = data as Partial<ConfirmPurchaseOrderSupplierReviewResult> & { success?: boolean; error?: string }
  if (result.success !== true) return { error: result.error || 'No se pudo confirmar la OC' }
  return result as ConfirmPurchaseOrderSupplierReviewResult
}

export async function getPurchaseOrderSupplierReviewComparison(poId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' }

  const db = adqAdmin()
  const { data, error } = await db.rpc('get_purchase_order_supplier_review_comparison', {
    p_po_id: poId,
    p_user_id: user.id,
    p_company_id: companyId,
  })
  if (error) return { error: error.message }
  if (!data || typeof data !== 'object' || (data as { success?: boolean }).success !== true) {
    return { error: 'No se pudo obtener la comparación de la OC' }
  }
  return { data: data as PurchaseOrderSupplierReviewComparison }
}

export async function updatePurchaseOrderStatus(poId: string, newStatus: string, reason?: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const db = adqAdmin()
  const { data, error } = await db.rpc('update_purchase_order_status', {
    p_po_id: poId,
    p_new_status: newStatus,
    p_reason: reason ?? null,
    p_user_id: user.id,
  })
  if (error) return { error: error.message }
  const r = data as { success: boolean; error?: string }
  if (!r.success) return { error: r.error || 'Error al actualizar estado' }
  return { success: true }
}

export async function getAuthorizedPersonnel() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const companyId = await getActiveCompanyId()
  if (!companyId) return []

  const db = adqAdmin()
  const { data, error } = await db.rpc('get_authorized_personnel_list', { p_company_id: companyId })
  if (error) return []
  return (data ?? []) as AuthorizedPersonnel[]
}

export async function createAuthorizedPersonnel(data: {
  full_name: string
  position?: string
  email?: string
  phone?: string
  notes?: string
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' }

  const db = adqAdmin()
  const { data: result, error } = await db.rpc('create_authorized_personnel', {
    p_data: {
      full_name: data.full_name,
      position: data.position || null,
      email: data.email || null,
      phone: data.phone || null,
      notes: data.notes || null,
    },
    p_user_id: user.id,
    p_company_id: companyId
  })
  if (error) return { error: error.message }
  const r = result as { success: boolean; error?: string; id?: string; full_name?: string; existing_id?: string }
  if (!r.success) return { error: r.error || 'Error al crear autorizador', existing_id: r.existing_id }
  return { success: true, id: r.id, full_name: r.full_name }
}

export async function createProductFromPO(data: {
  sku: string
  barcode?: string
  description: string
  short_description?: string
  brand?: string
  category?: string
  subcategory?: string
  product_type?: string
  unit_of_measure?: string
  tax_rate?: number
  is_perishable?: boolean
  requires_lot?: boolean
  requires_expiration?: boolean
  notes?: string
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' }

  const db = adqAdmin()
  const { data: result, error } = await db.rpc('create_product_from_po', {
    p_data: {
      sku: data.sku,
      barcode: data.barcode || null,
      description: data.description,
      short_description: data.short_description || null,
      brand: data.brand || null,
      category: data.category || null,
      subcategory: data.subcategory || null,
      product_type: data.product_type || null,
      unit_of_measure: data.unit_of_measure || null,
      tax_rate: data.tax_rate ?? 19,
      is_perishable: data.is_perishable ?? false,
      requires_lot: data.requires_lot ?? false,
      requires_expiration: data.requires_expiration ?? false,
      notes: data.notes || null,
    },
    p_user_id: user.id,
    p_company_id: companyId
  })
  if (error) return { error: error.message }
  const r = result as { success: boolean; error?: string; product_id?: string; sku?: string; description?: string }
  if (!r.success) return { error: r.error || 'Error al crear producto' }
  return { success: true, product_id: r.product_id, sku: r.sku, description: r.description }
}

export async function checkProductDuplicates(data: {
  sku?: string
  barcode?: string
  description?: string
  brand?: string
  unit?: string
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const companyId = await getActiveCompanyId()
  if (!companyId) return []

  const db = adqAdmin()
  const { data: result, error } = await db.rpc('check_product_duplicates', {
    p_data: {
      sku: data.sku || null,
      barcode: data.barcode || null,
      description: data.description || null,
      brand: data.brand || null,
      unit: data.unit || null,
    },
    p_company_id: companyId
  })
  if (error) return []
  const r = result as { warnings: DuplicateWarning[] } | null
  return r?.warnings ?? []
}

export async function getNextCorrelative() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const companyId = await getActiveCompanyId()
  if (!companyId) return null

  const db = adqAdmin()
  const { data, error } = await db.rpc('get_next_correlative_display', { p_company_id: companyId })
  if (error) return null
  return data as string
}

export interface ReplenishmentOrderItem {
  sku: string
  product_name: string
  suggested_qty: number
  confirmed_qty: number
  unit_cost: number
  stock_available: number
  avg_per_7: number
}

export interface ReplenishmentOrderRequest {
  period_days: number
  coverage_weeks: number
  items: ReplenishmentOrderItem[]
}

export interface ReplenishmentPurchaseOrderPreparationItem {
  sku: string
  product_name: string
  quantity: number
}

export interface PrepareReplenishmentPurchaseOrderRequest {
  items: ReplenishmentPurchaseOrderPreparationItem[]
}

export interface PreparedReplenishmentPurchaseOrderItem {
  product_id: string
  sku: string
  product_description: string
  unit: string
  quantity: number
  unit_price: number
  reference_unit_cost: number
  discount_percent: 0
  tax_rate: number
}

export interface PreparedReplenishmentPurchaseOrder {
  success: true
  supplier: { id: string; name: string }
  items: PreparedReplenishmentPurchaseOrderItem[]
}

export interface ReplenishmentPurchaseOrderUnresolvedItem {
  sku: string
  product_name: string
}

export type PrepareReplenishmentPurchaseOrderResult =
  | PreparedReplenishmentPurchaseOrder
  | {
      success: false
      code: 'MULTIPLE_SUPPLIERS'
      suppliers: Array<{
        supplier_id: string
        supplier_name: string
        items: Array<{ sku: string; product_name: string }>
      }>
    }
  | {
      success: false
      code: 'UNRESOLVED_SUPPLIER'
      items: ReplenishmentPurchaseOrderUnresolvedItem[]
    }
  | {
      success: false
      code: 'CANONICAL_COST_LOOKUP_FAILED'
      items: ReplenishmentPurchaseOrderUnresolvedItem[]
    }

export async function prepareReplenishmentPurchaseOrder(
  req: PrepareReplenishmentPurchaseOrderRequest,
): Promise<PrepareReplenishmentPurchaseOrderResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, code: 'UNRESOLVED_SUPPLIER', items: [] }

  const companyId = await getActiveCompanyId(user)
  if (!companyId) return { success: false, code: 'UNRESOLVED_SUPPLIER', items: [] }

  const selectedItems = (req.items ?? []).filter(item => Number.isFinite(item.quantity) && item.quantity > 0)
  if (selectedItems.length === 0) {
    return { success: false, code: 'UNRESOLVED_SUPPLIER', items: [] }
  }

  const db = adqAdmin()
  const skus = Array.from(new Set(selectedItems.map(item => item.sku)))
  const [{ data: products, error: productsError }, { data: mappings, error: mappingsError }] = await Promise.all([
    db.from('products')
      .select('id, sku, description, unit_of_measure, tax_rate, bsale_variant_id')
      .eq('company_id', companyId)
      .in('sku', skus),
    db.from('product_supplier_mappings')
      .select('id, sku, product_id, supplier_id, is_preferred')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .in('sku', skus),
  ])

  if (productsError || mappingsError) {
    return {
      success: false,
      code: 'UNRESOLVED_SUPPLIER',
      items: selectedItems.map(item => ({ sku: item.sku, product_name: item.product_name })),
    }
  }

  const productRows = (products ?? []) as Array<{
    id: string
    sku: string
    description: string | null
    unit_of_measure: string | null
    tax_rate: number | null
    bsale_variant_id: number | null
  }>
  const mappingRows = (mappings ?? []) as Array<{
    id: string
    sku: string
    product_id: string | null
    supplier_id: string | null
    is_preferred: boolean
  }>
  const productsBySku = new Map<string, typeof productRows>()
  for (const product of productRows) {
    productsBySku.set(product.sku, [...(productsBySku.get(product.sku) ?? []), product])
  }
  const mappingsBySku = new Map<string, typeof mappingRows>()
  for (const mapping of mappingRows) {
    mappingsBySku.set(mapping.sku, [...(mappingsBySku.get(mapping.sku) ?? []), mapping])
  }

  const unresolvedItems: ReplenishmentPurchaseOrderUnresolvedItem[] = []
  const resolved = new Array<{
    input: ReplenishmentPurchaseOrderPreparationItem
    product: (typeof productRows)[number]
    mapping: (typeof mappingRows)[number]
    realSupplierId: string
  }>()
  const rawSupplierIds = new Set<string>()

  for (const item of selectedItems) {
    const matchingProducts = productsBySku.get(item.sku) ?? []
    const product = matchingProducts.length === 1 ? matchingProducts[0] : null
    const productMappings = product
      ? (mappingsBySku.get(item.sku) ?? []).filter(mapping => mapping.product_id === product.id)
      : []
    const preferredMappings = productMappings.filter(mapping => mapping.is_preferred)
    const selectedMapping = preferredMappings.length === 1
      ? preferredMappings[0]
      : preferredMappings.length === 0 && productMappings.length === 1
        ? productMappings[0]
        : null
    if (!product || !selectedMapping?.product_id || !selectedMapping.supplier_id) {
      unresolvedItems.push({ sku: item.sku, product_name: item.product_name })
      continue
    }
    rawSupplierIds.add(selectedMapping.supplier_id)
    resolved.push({ input: item, product, mapping: selectedMapping, realSupplierId: '' })
  }

  const { data: suppliers } = rawSupplierIds.size > 0
    ? await db.from('suppliers')
      .select('id, supplier_kind, business_name, parent_supplier_id')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .eq('status', 'ACTIVE')
      .in('id', Array.from(rawSupplierIds))
    : { data: [] }
  const supplierById = new Map((suppliers ?? []).map(s => [s.id, s]))
  const parentIds = Array.from(new Set((suppliers ?? []).map(s => s.parent_supplier_id).filter(Boolean)))
  const { data: parents } = parentIds.length > 0
    ? await db.from('suppliers')
      .select('id, supplier_kind, business_name')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .eq('status', 'ACTIVE')
      .in('id', parentIds)
    : { data: [] }
  const parentById = new Map((parents ?? []).map(s => [s.id, s]))
  const realSupplierById = new Map<string, { id: string; name: string }>()

  for (const entry of resolved) {
    const supplier = supplierById.get(entry.mapping.supplier_id!)
    const realSupplier = supplier?.supplier_kind === 'REAL'
      ? supplier
      : supplier?.supplier_kind === 'BSALE_OPERATIVE' && supplier.parent_supplier_id
        ? parentById.get(supplier.parent_supplier_id)
        : null
    if (!realSupplier || realSupplier.supplier_kind !== 'REAL' || !realSupplier.business_name) {
      unresolvedItems.push({ sku: entry.input.sku, product_name: entry.input.product_name })
      continue
    }
    entry.realSupplierId = realSupplier.id
    realSupplierById.set(realSupplier.id, { id: realSupplier.id, name: realSupplier.business_name })
  }

  if (unresolvedItems.length > 0) {
    return { success: false, code: 'UNRESOLVED_SUPPLIER', items: unresolvedItems }
  }

  const canonicalCostByVariant = new Map<number, number>()
  const variantIds = Array.from(new Set(
    resolved
      .map(entry => entry.product.bsale_variant_id)
      .filter((variantId): variantId is number =>
        typeof variantId === 'number' && Number.isFinite(variantId)),
  ))
  const integrations = db.schema('integraciones')
  for (let offset = 0; offset < variantIds.length; offset += 500) {
    const ids = variantIds.slice(offset, offset + 500)
    const { data: canonicalCosts, error: canonicalCostsError } = await integrations
      .from('vw_bsale_variant_last_purchase_cost')
      .select('bsale_variant_id, last_purchase_cost')
      .eq('company_id', companyId)
      .in('bsale_variant_id', ids)
    if (canonicalCostsError) {
      return {
        success: false,
        code: 'CANONICAL_COST_LOOKUP_FAILED',
        items: selectedItems.map(item => ({ sku: item.sku, product_name: item.product_name })),
      }
    }
    for (const row of canonicalCosts ?? []) {
      const variantId = Number(row.bsale_variant_id)
      const cost = row.last_purchase_cost === null || row.last_purchase_cost === undefined
        ? NaN
        : Number(row.last_purchase_cost)
      if (Number.isFinite(variantId) && Number.isFinite(cost) && cost > 0) {
        canonicalCostByVariant.set(variantId, cost)
      }
    }
  }

  const groups = new Map<string, typeof resolved>()
  for (const entry of resolved) {
    groups.set(entry.realSupplierId, [...(groups.get(entry.realSupplierId) ?? []), entry])
  }
  if (groups.size !== 1) {
    return {
      success: false,
      code: 'MULTIPLE_SUPPLIERS',
      suppliers: Array.from(groups, ([supplierId, entries]) => ({
        supplier_id: supplierId,
        supplier_name: realSupplierById.get(supplierId)!.name,
        items: entries.map(entry => ({ sku: entry.input.sku, product_name: entry.input.product_name })),
      })),
    }
  }

  const [supplierId, entries] = Array.from(groups)[0]
  return {
    success: true,
    supplier: realSupplierById.get(supplierId)!,
    items: entries.map(entry => ({
      product_id: entry.product.id,
      sku: entry.product.sku,
      product_description: entry.product.description ?? entry.input.product_name,
      unit: entry.product.unit_of_measure ?? '',
      quantity: entry.input.quantity,
      unit_price: entry.product.bsale_variant_id === null ? 0 : canonicalCostByVariant.get(entry.product.bsale_variant_id) ?? 0,
      reference_unit_cost: entry.product.bsale_variant_id === null ? 0 : canonicalCostByVariant.get(entry.product.bsale_variant_id) ?? 0,
      discount_percent: 0,
      tax_rate: entry.product.tax_rate ?? 19,
    })),
  }
}

export async function generateReplenishmentPurchaseOrders(req: ReplenishmentOrderRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' }

  const db = adqAdmin()

  const validItems = req.items.filter(i => i.confirmed_qty > 0)
  if (validItems.length === 0) return { error: 'No hay ítems con cantidad mayor a 0' }

  const skus = validItems.map(i => i.sku)

  const { data: mappings } = await db
    .from('product_supplier_mappings')
    .select('id, sku, product_id, supplier_id')
    .eq('company_id', companyId)
    .eq('is_preferred', true)
    .eq('is_active', true)
    .in('sku', skus)

  const mappingMap = new Map((mappings || []).map(m => [m.sku, m]))
  const rawSupplierIds = Array.from(new Set((mappings || []).map(m => m.supplier_id).filter(Boolean)))
  
  let suppliersMap = new Map()
  if (rawSupplierIds.length > 0) {
    const { data: sups } = await db
      .from('suppliers')
      .select('id, supplier_kind, parent_supplier_id')
      .eq('company_id', companyId)
      .in('id', rawSupplierIds)
    suppliersMap = new Map((sups || []).map(s => [s.id, s]))
  }

  const grouped = new Map<string, Array<ReplenishmentOrderItem & { product_id: string; mapping_id: string }>>()
  const blockedNoSupplier: string[] = []
  const blockedNoProduct: string[] = []

  for (const item of validItems) {
    const mapping = mappingMap.get(item.sku)
    
    if (!mapping?.product_id) {
      blockedNoProduct.push(item.sku)
      continue
    }

    if (!mapping?.supplier_id) {
      blockedNoSupplier.push(item.sku)
      continue
    }

    const sup = suppliersMap.get(mapping.supplier_id)
    if (!sup) {
      blockedNoSupplier.push(item.sku)
      continue
    }

    let realSupplierId = null
    if (sup.supplier_kind === 'REAL') {
      realSupplierId = sup.id
    } else if (sup.supplier_kind === 'BSALE_OPERATIVE' && sup.parent_supplier_id) {
      const { data: parentSup } = await db.from('suppliers').select('id, supplier_kind').eq('id', sup.parent_supplier_id).single()
      if (parentSup && parentSup.supplier_kind === 'REAL') {
        realSupplierId = parentSup.id
      }
    }

    if (!realSupplierId) {
      blockedNoSupplier.push(item.sku)
      continue
    }

    if (!grouped.has(realSupplierId)) {
      grouped.set(realSupplierId, [])
    }
    grouped.get(realSupplierId)!.push({
      ...item,
      product_id: mapping.product_id,
      mapping_id: mapping.id
    })
  }

  if (grouped.size === 0) {
    return { error: 'No se encontraron proveedores reales válidos para los productos seleccionados', blockedNoSupplier, blockedNoProduct }
  }

  const { data: analysis, error: anError } = await db.from('purchase_replenishment_analyses').insert({
    company_id: companyId,
    name: `Análisis ${new Date().toLocaleDateString('es-CL')}`,
    status: 'BORRADOR',
    period_days: req.period_days,
    coverage_weeks: req.coverage_weeks,
    created_by: user.id
  }).select('id').single()

  if (anError || !analysis) {
    console.error('Error insertando analisis:', anError)
    return { error: 'Error al registrar cabecera de análisis' }
  }

  const analysisId = analysis.id
  const generatedPOs: { supplier_id: string, po_id: string, correlative: string }[] = []

  for (const [supplierId, items] of grouped.entries()) {
    const poItems = items.map(i => ({
      item_type: 'PRODUCT' as const,
      product_id: i.product_id,
      product_description: i.product_name,
      quantity: i.confirmed_qty,
      unit_price: i.unit_cost,
      discount_percent: 0,
      tax_rate: 19
    }))

    const { data: rpcRes, error: rpcErr } = await db.rpc('create_purchase_order', {
      p_data: { 
        issue_date: new Date().toISOString().split('T')[0],
        supplier_id: supplierId,
        currency: 'CLP',
        notes: 'Generado automáticamente desde Análisis de Reposición',
        items: poItems,
        status: 'BORRADOR'
      },
      p_user_id: user.id,
      p_company_id: companyId
    })

    if (rpcErr) {
      console.error('Error creating PO for supplier', supplierId, rpcErr)
      continue
    }
    
    const r = rpcRes as unknown as { success?: boolean; po_id: string; correlative: string } | null
    if (!r?.success) {
      console.error('Error in RPC create_purchase_order', r)
      continue
    }

    const poId = r.po_id
    const correlative = r.correlative
    generatedPOs.push({ supplier_id: supplierId, po_id: poId, correlative })

    const dbItems = items.map(i => ({
      analysis_id: analysisId,
      company_id: companyId,
      product_supplier_mapping_id: i.mapping_id,
      product_id: i.product_id,
      supplier_id: supplierId,
      sku: i.sku,
      product_name: i.product_name,
      current_stock: i.stock_available,
      weekly_avg_sales: i.avg_per_7,
      suggested_quantity: i.suggested_qty,
      unit_cost: i.unit_cost,
      total_cost: i.confirmed_qty * i.unit_cost,
      selected: true,
      ordered_quantity: i.confirmed_qty,
      purchase_order_id: poId,
      ordered_at: new Date().toISOString()
    }))

    await db.from('purchase_replenishment_analysis_items').insert(dbItems)

    await db.from('purchase_replenishment_analysis_orders').insert({
      analysis_id: analysisId,
      company_id: companyId,
      supplier_id: supplierId,
      purchase_order_id: poId,
      item_count: items.length,
      total_units: items.reduce((a, b) => a + b.confirmed_qty, 0),
      total_cost: items.reduce((a, b) => a + (b.confirmed_qty * b.unit_cost), 0),
      created_by: user.id
    })
  }

  return {
    success: true,
    analysisId,
    generatedPOs,
    blockedNoSupplier,
    blockedNoProduct
  }
}
