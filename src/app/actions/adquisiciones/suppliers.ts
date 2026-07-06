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
  supplier_kind: 'REAL' | 'BSALE_OPERATIVE'
  parent_supplier_id: string | null
  bsale_product_type_id: string | null
  bsale_product_type_name: string | null
  source: 'MANUAL' | 'BSALE' | null
}

export interface BsalePseudoStat {
  id: string
  display_name: string
  business_name: string
  bsale_product_type_name: string | null
  suggested_root: string
  parent_supplier_id: string | null
  parent_supplier_name: string | null
  total_products: number
  active_products: number
  inactive_products: number
  mappings_with_cost: number
  mappings_without_cost: number
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

export async function getSuppliers(search?: string, kind: 'REAL' | 'BSALE_OPERATIVE' = 'REAL', includeGlobal: boolean = false) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const companyId = await getActiveCompanyId()
  if (!companyId) return []

  const db = adqAdmin()
  let query = db.from('suppliers')
    .select('*')
    .eq('supplier_kind', kind)
    .order('business_name')

  if (includeGlobal) {
    query = query.or(`company_id.is.null,company_id.eq.${companyId}`)
  } else {
    query = query.eq('company_id', companyId)
  }

  if (search) {
    const n = normalizeRut(search)
    query = query.or(
      `rut.ilike.%${search}%,rut_normalized.ilike.%${n}%,business_name.ilike.%${search}%,fantasy_name.ilike.%${search}%,contact_email.ilike.%${search}%`
    )
  }

  const { data } = await query
  const filtered = ((data ?? []) as Supplier[]).filter(s => s.supplier_kind === kind)

  console.log('[getSuppliers]', {
    supplierKind: kind,
    rawCount: data?.length ?? 0,
    filteredCount: filtered.length,
    sample: filtered.slice(0, 5).map(s => ({
      name: s.business_name,
      kind: s.supplier_kind,
    })),
  })

  return filtered
}

export async function getSupplier(id: string) {
  const companyId = await getActiveCompanyId()
  if (!companyId) return null

  const db = adqAdmin()
  const { data } = await db.from('suppliers')
    .select('*')
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle()
  return data as Supplier | null
}

export async function getBsalePseudoStats(): Promise<BsalePseudoStat[]> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return []

  const db = adqAdmin()
  const { data: pseudos } = await db.from('suppliers')
    .select(`
      id, business_name, bsale_product_type_name, parent_supplier_id,
      parent:parent_supplier_id(business_name)
    `)
    .eq('company_id', companyId)
    .eq('supplier_kind', 'BSALE_OPERATIVE')
    .order('business_name')

  if (!pseudos) return []

  const pseudoIds = pseudos.map(p => p.id)
  
  const mappings: { supplier_id: string; unit_cost: number | null; product_id: string }[] = []
  const limit = 1000
  const pseudoChunkSize = 50

  for (let i = 0; i < pseudoIds.length; i += pseudoChunkSize) {
    const chunk = pseudoIds.slice(i, i + pseudoChunkSize)
    let offset = 0
    let hasMore = true

    while (hasMore) {
      const { data: page } = await db.from('product_supplier_mappings')
        .select('supplier_id, unit_cost, product_id')
        .eq('company_id', companyId)
        .in('supplier_id', chunk)
        .range(offset, offset + limit - 1)

      if (page && page.length > 0) {
        mappings.push(...page)
        offset += limit
        if (page.length < limit) hasMore = false
      } else {
        hasMore = false
      }
    }
  }

  const productIds = Array.from(new Set(mappings.map(m => m.product_id)))
  const products: { id: string; is_active: boolean }[] = []
  const chunkSize = 200

  for (let i = 0; i < productIds.length; i += chunkSize) {
    const chunk = productIds.slice(i, i + chunkSize)
    const { data: pPage } = await db.from('products')
      .select('id, is_active')
      .eq('company_id', companyId)
      .in('id', chunk)
    
    if (pPage && pPage.length > 0) {
      products.push(...pPage)
    }
  }

  const productMap = new Map((products || []).map(p => [p.id, p.is_active]))

  const statsMap = new Map<string, { total: number, active: number, inactive: number, withCost: number, withoutCost: number }>()
  for (const id of pseudoIds) {
    statsMap.set(id, { total: 0, active: 0, inactive: 0, withCost: 0, withoutCost: 0 })
  }

  for (const m of (mappings || [])) {
    const s = statsMap.get(m.supplier_id)
    if (!s) continue
    s.total++
    const isActive = productMap.get(m.product_id)
    if (isActive) s.active++
    else s.inactive++
    if (m.unit_cost && m.unit_cost > 0) s.withCost++
    else s.withoutCost++
  }

  const stats = pseudos.map(p => {
    const s = statsMap.get(p.id)!
    const suggestedRoot = p.business_name.split('/')[0] || p.business_name
    return {
      id: p.id,
      display_name: p.bsale_product_type_name ?? p.business_name,
      business_name: p.business_name,
      bsale_product_type_name: p.bsale_product_type_name,
      suggested_root: suggestedRoot,
      parent_supplier_id: p.parent_supplier_id,
      parent_supplier_name: (p.parent as any)?.business_name || null,
      total_products: s.total,
      active_products: s.active,
      inactive_products: s.inactive,
      mappings_with_cost: s.withCost,
      mappings_without_cost: s.withoutCost
    }
  })

  console.log('[getBsalePseudoStats]', {
    pseudos: pseudos.length,
    mappings: mappings?.length ?? 0,
    products: products?.length ?? 0,
    sample: stats.slice(0, 10).map(s => ({
      name: s.display_name,
      totalProducts: s.total_products,
      activeProducts: s.active_products,
      inactiveProducts: s.inactive_products,
      withCost: s.mappings_with_cost,
      withoutCost: s.mappings_without_cost,
    })),
  })

  return stats
}

export async function createSupplier(formData: FormData, pseudoIds: string[] = []) {
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
      .eq('company_id', companyId)
      .maybeSingle()
    if (existing) return { error: 'Ya existe un proveedor con ese RUT en el catálogo maestro' }
  }

  // Verificar si hay choque de nombre exacto (evitar choque con pseudoproveedores u otros)
  const { data: existingName } = await db.from('suppliers')
    .select('id')
    .eq('business_name', business_name)
    .eq('company_id', companyId)
    .maybeSingle()
  if (existingName) {
    return { error: `Ya existe un proveedor (o pseudoproveedor) con la razón social exacta "${business_name}".` }
  }

  if (contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact_email)) {
    return { error: 'Correo electrónico inválido' }
  }

  // Create as REAL supplier
  const { data, error } = await db.from('suppliers').insert({
    company_id: companyId,
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
    supplier_kind: 'REAL',
    source: 'MANUAL',
    created_by: userId,
  }).select()

  if (error) return { error: error.message }
  if (!data || data.length === 0) return { error: 'No se insertó el registro en la base de datos.' }
  const newSupplierId = data[0].id

  // Associate pseudos
  if (pseudoIds.length > 0) {
    await db.from('suppliers')
      .update({ parent_supplier_id: newSupplierId, updated_by: userId })
      .in('id', pseudoIds)
      .eq('supplier_kind', 'BSALE_OPERATIVE')
  }

  return { success: true }
}

export async function updateSupplier(supplierId: string, formData: FormData, pseudoIds: string[] = []) {
  const authRes = await verifyWriteAccess()
  if (authRes.error) return { error: authRes.error }
  const userId = authRes.userId!

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' }

  const db = adqAdmin()
  const { data: existingTarget } = await db.from('suppliers').select('supplier_kind').eq('id', supplierId).single()
  if (!existingTarget) return { error: 'Proveedor no encontrado' }
  if (existingTarget.supplier_kind !== 'REAL') return { error: 'Solo se pueden editar asociaciones en proveedores reales' }

  const business_name = (formData.get('business_name') as string ?? '').trim()
  if (!business_name) return { error: 'La razón social es obligatoria' }

  // Verificar si hay choque de nombre exacto con otro id
  const { data: existingName } = await db.from('suppliers')
    .select('id')
    .eq('business_name', business_name)
    .neq('id', supplierId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (existingName) {
    return { error: `Ya existe otro proveedor con la razón social exacta "${business_name}".` }
  }

  const contact_email = (formData.get('contact_email') as string ?? '').trim()
  if (contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact_email)) {
    return { error: 'Correo electrónico inválido' }
  }

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

  // Handle pseudo associations
  // 1. Get currently associated pseudos
  const { data: currentPseudos } = await db.from('suppliers')
    .select('id')
    .eq('parent_supplier_id', supplierId)
  
  const currentIds = new Set((currentPseudos || []).map(p => p.id))
  const newIds = new Set(pseudoIds)

  const toUnlink = [...currentIds].filter(id => !newIds.has(id))
  const toLink = [...newIds].filter(id => !currentIds.has(id))

  if (toUnlink.length > 0) {
    await db.from('suppliers')
      .update({ parent_supplier_id: null, updated_by: userId })
      .in('id', toUnlink)
  }

  if (toLink.length > 0) {
    await db.from('suppliers')
      .update({ parent_supplier_id: supplierId, updated_by: userId })
      .in('id', toLink)
      .eq('supplier_kind', 'BSALE_OPERATIVE')
  }

  return { success: true }
}

export async function deactivateSupplier(supplierId: string) {
  const authRes = await verifyWriteAccess()
  if (authRes.error) return { error: authRes.error }
  const userId = authRes.userId!

  const db = adqAdmin()
  const { data: supplier } = await db.from('suppliers').select('is_active, status, supplier_kind').eq('id', supplierId).single()
  if (!supplier) return { error: 'Proveedor no encontrado' }
  if (supplier.supplier_kind !== 'REAL') return { error: 'No se puede desactivar un pseudoproveedor directamente' }

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
        .eq('company_id', companyId)
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
      company_id: companyId,
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
      supplier_kind: 'REAL',
      source: 'MANUAL',
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
