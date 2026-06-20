'use server'

import { createClient } from '@/lib/supabase/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { getActiveCompanyId } from '@/app/actions/companies'

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

function adqAdmin() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey,
    { db: { schema: 'adquisiciones' }, auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export interface Supplier {
  id: string
  rut: string | null
  rut_normalized: string | null
  business_name: string
  fantasy_name: string | null
  business_activity: string | null
  contact_name: string | null
  contact_email: string | null
  contact_phone: string | null
  address: string | null
  city: string | null
  region: string | null
  payment_terms: string | null
  credit_days: number
  discount_percent: number
  notes: string | null
  status: string
  is_active: boolean
  created_at: string
  updated_at: string
}

function normalizeRut(rut: string): string {
  return rut.replace(/[.-]/g, '').replace(/\s/g, '').toUpperCase()
}

async function verifyWriteAccess(): Promise<{ error?: string; userId?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const { data: profile } = await supabase
    .from('users')
    .select('role_id')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile) return { error: 'Usuario no encontrado' }

  const { data: role } = await supabase
    .from('roles')
    .select('name')
    .eq('id', profile.role_id)
    .single()

  if (!role || !['SUPER_USUARIO', 'GERENCIA', 'BODEGA'].includes(role.name)) {
    return { error: 'Permisos insuficientes. No tiene autorización para modificar el catálogo global.' }
  }

  return { userId: user.id }
}

export async function getSuppliers(search?: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const companyId = await getActiveCompanyId()
  if (!companyId) return []

  const db = adqAdmin()
  let query = db.from('suppliers')
    .select('*')
    .or(`company_id.is.null,company_id.eq.${companyId}`)
    .order('business_name')

  if (search) {
    const n = normalizeRut(search)
    query = query.or(
      `rut.ilike.%${search}%,rut_normalized.ilike.%${n}%,business_name.ilike.%${search}%,fantasy_name.ilike.%${search}%,contact_email.ilike.%${search}%`
    )
  }

  const { data } = await query
  return (data ?? []) as Supplier[]
}

export async function getSupplier(id: string) {
  const companyId = await getActiveCompanyId()
  if (!companyId) return null

  const db = adqAdmin()
  const { data } = await db.from('suppliers')
    .select('*')
    .eq('id', id)
    .or(`company_id.is.null,company_id.eq.${companyId}`)
    .maybeSingle()
  return data as Supplier | null
}

export async function createSupplier(formData: FormData) {
  const authRes = await verifyWriteAccess()
  if (authRes.error) return { error: authRes.error }
  const userId = authRes.userId!

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' }

  const business_name = (formData.get('business_name') as string ?? '').trim()
  if (!business_name) return { error: 'La razón social es obligatoria' }

  const rut = (formData.get('rut') as string ?? '').trim()
  const contact_email = (formData.get('contact_email') as string ?? '').trim()

  const db = adqAdmin()
  if (rut) {
    const normalized = normalizeRut(rut)
    const { data: existing } = await db.from('suppliers')
      .select('id')
      .eq('rut_normalized', normalized)
      .or(`company_id.is.null,company_id.eq.${companyId}`)
      .maybeSingle()
    if (existing) return { error: 'Ya existe un proveedor con ese RUT en el catálogo maestro' }
  }

  if (contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact_email)) {
    return { error: 'Correo electrónico inválido' }
  }

  // Create as global supplier (company_id: null)
  const { data, error } = await db.from('suppliers').insert({
    company_id: null,
    rut: rut || null,
    rut_normalized: rut ? normalizeRut(rut) : null,
    business_name,
    fantasy_name: (formData.get('fantasy_name') as string)?.trim() || null,
    business_activity: (formData.get('business_activity') as string)?.trim() || null,
    contact_name: (formData.get('contact_name') as string)?.trim() || null,
    contact_email: contact_email || null,
    contact_phone: (formData.get('contact_phone') as string)?.trim() || null,
    address: (formData.get('address') as string)?.trim() || null,
    city: (formData.get('city') as string)?.trim() || null,
    region: (formData.get('region') as string)?.trim() || null,
    payment_terms: (formData.get('payment_terms') as string)?.trim() || null,
    credit_days: parseInt(formData.get('credit_days') as string) || 0,
    discount_percent: parseFloat(formData.get('discount_percent') as string) || 0,
    notes: (formData.get('notes') as string)?.trim() || null,
    created_by: userId,
  }).select()

  if (error) return { error: error.message }
  if (!data || data.length === 0) return { error: 'No se insertó el registro en la base de datos.' }
  return { success: true }
}

export async function updateSupplier(supplierId: string, formData: FormData) {
  const authRes = await verifyWriteAccess()
  if (authRes.error) return { error: authRes.error }
  const userId = authRes.userId!

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' }

  const business_name = (formData.get('business_name') as string ?? '').trim()
  if (!business_name) return { error: 'La razón social es obligatoria' }

  const contact_email = (formData.get('contact_email') as string ?? '').trim()
  if (contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact_email)) {
    return { error: 'Correo electrónico inválido' }
  }

  const db = adqAdmin()
  const { error } = await db.from('suppliers').update({
    business_name,
    fantasy_name: (formData.get('fantasy_name') as string)?.trim() || null,
    business_activity: (formData.get('business_activity') as string)?.trim() || null,
    contact_name: (formData.get('contact_name') as string)?.trim() || null,
    contact_email: contact_email || null,
    contact_phone: (formData.get('contact_phone') as string)?.trim() || null,
    address: (formData.get('address') as string)?.trim() || null,
    city: (formData.get('city') as string)?.trim() || null,
    region: (formData.get('region') as string)?.trim() || null,
    payment_terms: (formData.get('payment_terms') as string)?.trim() || null,
    credit_days: parseInt(formData.get('credit_days') as string) || 0,
    discount_percent: parseFloat(formData.get('discount_percent') as string) || 0,
    notes: (formData.get('notes') as string)?.trim() || null,
    updated_by: userId,
  }).eq('id', supplierId)

  if (error) return { error: error.message }
  return { success: true }
}

export async function deactivateSupplier(supplierId: string) {
  const authRes = await verifyWriteAccess()
  if (authRes.error) return { error: authRes.error }
  const userId = authRes.userId!

  const db = adqAdmin()
  const { data: supplier } = await db.from('suppliers').select('is_active, status').eq('id', supplierId).single()
  if (!supplier) return { error: 'Proveedor no encontrado' }

  const newActive = !supplier.is_active
  const newStatus = newActive ? 'ACTIVE' : 'INACTIVE'

  const { error } = await db.from('suppliers').update({
    is_active: newActive, status: newStatus, updated_by: userId,
  }).eq('id', supplierId)

  if (error) return { error: error.message }
  return { success: true, newActive }
}

export async function importSuppliers(suppliers: Record<string, unknown>[]) {
  const authRes = await verifyWriteAccess()
  if (authRes.error) return { error: authRes.error }
  const userId = authRes.userId!

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' }

  const db = adqAdmin()
  let created = 0
  const errors: { row: number; message: string }[] = []

  for (let i = 0; i < suppliers.length; i++) {
    const row = suppliers[i]
    const idx = i + 1

    const businessName = ((row.razon_social as string) ?? '').trim()
    if (!businessName) {
      errors.push({ row: idx, message: 'Razón social obligatoria' })
      continue
    }

    const rut = ((row.rut as string) ?? '').trim()
    const email = ((row.correo as string) ?? '').trim()

    if (rut) {
      const normalized = normalizeRut(rut)
      const { data: dup } = await db.from('suppliers')
        .select('id')
        .eq('rut_normalized', normalized)
        .or(`company_id.is.null,company_id.eq.${companyId}`)
        .maybeSingle()
      if (dup) {
        errors.push({ row: idx, message: `RUT ${rut} ya existe en el catálogo maestro` })
        continue
      }
    }

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push({ row: idx, message: `Correo inválido: ${email}` })
      continue
    }

    const creditDays = parseInt(String(row.dias_credito ?? '0')) || 0
    if (creditDays < 0) {
      errors.push({ row: idx, message: 'Días crédito debe ser número >= 0' })
      continue
    }

    const discount = parseFloat(String(row.descuento_porcentaje ?? '0')) || 0
    if (discount < 0 || discount > 100) {
      errors.push({ row: idx, message: 'Descuento debe estar entre 0 y 100' })
      continue
    }

    const { data, error: insertErr } = await db.from('suppliers').insert({
      company_id: null,
      rut: rut || null,
      rut_normalized: rut ? normalizeRut(rut) : null,
      business_name: businessName,
      fantasy_name: ((row.nombre_fantasia as string) ?? '').trim() || null,
      business_activity: ((row.giro as string) ?? '').trim() || null,
      contact_name: ((row.contacto as string) ?? '').trim() || null,
      contact_email: email || null,
      contact_phone: ((row.telefono as string) ?? '').trim() || null,
      address: ((row.direccion as string) ?? '').trim() || null,
      city: ((row.ciudad as string) ?? '').trim() || null,
      region: ((row.region as string) ?? '').trim() || null,
      payment_terms: ((row.condicion_pago as string) ?? '').trim() || null,
      credit_days: creditDays,
      discount_percent: discount,
      notes: ((row.observacion as string) ?? '').trim() || null,
      created_by: userId,
    }).select()

    if (insertErr) {
      errors.push({ row: idx, message: insertErr.message })
    } else if (!data || data.length === 0) {
      errors.push({ row: idx, message: 'No se insertó el registro (resultado vacío)' })
    } else {
      created += data.length
    }
  }

  return { created, errors, total: suppliers.length }
}

