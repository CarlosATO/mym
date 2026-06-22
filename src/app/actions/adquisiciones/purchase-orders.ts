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
}

export interface PurchaseOrderDetail {
  po: {
    id: string
    correlative: string
    issue_date: string
    required_date: string | null
    supplier_id: string
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
  warehouse_id?: string | null
  payment_terms?: string
  authorized_by?: string | null
  notes?: string
  currency?: string
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
      warehouse_id: data.warehouse_id || null,
      payment_terms: data.payment_terms || null,
      authorized_by: data.authorized_by || null,
      notes: data.notes || null,
      currency: data.currency || 'CLP',
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
