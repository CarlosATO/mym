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

function cleanRut(rut: string | null) {
  if (!rut) return null
  return rut.replace(/[^0-9kK]/g, '').toUpperCase()
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

  let updatePayload: any = {}

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
