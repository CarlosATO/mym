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

function normalize(s: string) { return s.toUpperCase().trim().replace(/\s+/g, ' ') }
function v(s: string | null | undefined) { return s ? normalize(s) : null }

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

export interface Product {
  id: string; sku: string; barcode: string | null; internal_code: string | null
  description: string; short_description: string | null; brand: string | null
  category: string | null; subcategory: string | null; product_type: string | null
  species: string | null; presentation: string | null; unit_of_measure: string | null
  net_weight: number | null; weight_unit: string | null; package_quantity: number | null
  package_unit: string | null; purchase_unit: string | null; sales_unit: string | null
  min_stock: number; max_stock: number; reorder_point: number; tax_rate: number
  is_perishable: boolean; requires_lot: boolean; requires_expiration: boolean
  image_url: string | null; notes: string | null; status: string; is_active: boolean
  created_at: string; updated_at: string
}

async function validateClassifier(type: string, name: string | null, companyId: string): Promise<string | null> {
  if (!name) return null
  const db = adqAdmin()
  const normalized = normalize(name)
  const { data } = await db.from('product_classifiers')
    .select('name')
    .eq('classifier_type', type)
    .eq('normalized_name', normalized)
    .or(`company_id.is.null,company_id.eq.${companyId}`)
    .maybeSingle()
  if (!data) return `"${name}" no existe en catálogo maestro (${type})`
  return null
}

export async function getClassifiers(type: string) {
  const companyId = await getActiveCompanyId()
  const db = adqAdmin()
  let query = db.from('product_classifiers')
    .select('id, name, normalized_name')
    .eq('classifier_type', type)
    .eq('is_active', true)
  
  if (companyId) {
    query = query.or(`company_id.is.null,company_id.eq.${companyId}`)
  } else {
    query = query.is('company_id', null)
  }
  const { data } = await query.order('name')
  return (data ?? []) as { id: string; name: string; normalized_name: string }[]
}

export interface ProductFilters {
  search?: string
  brand?: string
  category?: string
  subcategory?: string
  product_type?: string
  status?: string
  is_active?: string
  is_perishable?: string
  requires_lot?: string
  requires_expiration?: string
  page?: number
  pageSize?: number
}

export async function getProducts(filters: ProductFilters = {}): Promise<{ data: Product[]; total: number }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: [], total: 0 }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: [], total: 0 }

  const db = adqAdmin()
  let query = db.from('products')
    .select('*', { count: 'exact' })
    .or(`company_id.is.null,company_id.eq.${companyId}`)

  if (filters.search) {
    const s = filters.search
    query = query.or(`sku.ilike.%${s}%,barcode.ilike.%${s}%,description.ilike.%${s}%,brand.ilike.%${s}%,category.ilike.%${s}%`)
  }
  if (filters.brand) query = query.eq('brand', filters.brand)
  if (filters.category) query = query.eq('category', filters.category)
  if (filters.subcategory) query = query.eq('subcategory', filters.subcategory)
  if (filters.product_type) query = query.eq('product_type', filters.product_type)
  if (filters.status) query = query.eq('status', filters.status)
  if (filters.is_active === 'true') query = query.eq('is_active', true)
  else if (filters.is_active === 'false') query = query.eq('is_active', false)
  if (filters.is_perishable === 'true') query = query.eq('is_perishable', true)
  else if (filters.is_perishable === 'false') query = query.eq('is_perishable', false)
  if (filters.requires_lot === 'true') query = query.eq('requires_lot', true)
  else if (filters.requires_lot === 'false') query = query.eq('requires_lot', false)
  if (filters.requires_expiration === 'true') query = query.eq('requires_expiration', true)
  else if (filters.requires_expiration === 'false') query = query.eq('requires_expiration', false)

  const page = filters.page ?? 1
  const pageSize = filters.pageSize ?? 50
  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  query = query.order('sku').range(from, to)
  const { data, error, count } = await query
  if (error) return { data: [], total: 0 }
  return { data: (data ?? []) as Product[], total: count ?? 0 }
}

export async function createProduct(formData: FormData) {
  const authRes = await verifyWriteAccess()
  if (authRes.error) return { error: authRes.error }
  const userId = authRes.userId!

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' }

  const sku = normalize(formData.get('sku') as string ?? '')
  if (!sku) return { error: 'El SKU es obligatorio' }
  const description = normalize(formData.get('description') as string ?? '')
  if (!description) return { error: 'La descripción es obligatoria' }

  const db = adqAdmin()
  const { data: dup } = await db.from('products')
    .select('id')
    .eq('sku', sku)
    .or(`company_id.is.null,company_id.eq.${companyId}`)
    .maybeSingle()
  if (dup) return { error: `El SKU "${sku}" ya existe en el catálogo maestro` }

  const barcode = v(formData.get('barcode') as string)
  if (barcode) {
    const { data: dupBc } = await db.from('products')
      .select('id')
      .eq('barcode', barcode)
      .or(`company_id.is.null,company_id.eq.${companyId}`)
      .maybeSingle()
    if (dupBc) return { error: `El código de barra "${barcode}" ya existe en el catálogo maestro` }
  }

  const classifierFields = ['brand', 'category', 'subcategory', 'product_type', 'weight_unit', 'purchase_unit', 'sales_unit', 'unit_of_measure', 'package_unit'] as const
  const classifierTypes = ['BRAND', 'CATEGORY', 'SUBCATEGORY', 'PRODUCT_TYPE', 'WEIGHT_UNIT', 'PURCHASE_UNIT', 'SALES_UNIT', 'MEASURE_UNIT', 'PACKAGE_UNIT'] as const
  for (let i = 0; i < classifierFields.length; i++) {
    const val = v(formData.get(classifierFields[i]) as string)
    if (val) { const err = await validateClassifier(classifierTypes[i], val, companyId); if (err) return { error: err } }
  }

  function n(name: string) { const val = parseFloat(formData.get(name) as string); return isNaN(val) ? 0 : val }
  function b(name: string) { return ['SI', 'TRUE', '1'].includes((formData.get(name) as string ?? '').trim().toUpperCase()) }

  const imageFile = formData.get('image') as File

  // Create as global product (company_id: null)
  const { data, error } = await db.from('products').insert({
    company_id: null,
    sku, barcode, description,
    internal_code: v(formData.get('internal_code') as string), short_description: v(formData.get('short_description') as string),
    brand: v(formData.get('brand') as string), category: v(formData.get('category') as string),
    subcategory: v(formData.get('subcategory') as string), product_type: v(formData.get('product_type') as string),
    species: v(formData.get('species') as string), presentation: v(formData.get('presentation') as string),
    unit_of_measure: v(formData.get('unit_of_measure') as string),
    net_weight: n('net_weight'), weight_unit: v(formData.get('weight_unit') as string),
    package_quantity: n('package_quantity'), package_unit: v(formData.get('package_unit') as string),
    purchase_unit: v(formData.get('purchase_unit') as string), sales_unit: v(formData.get('sales_unit') as string),
    min_stock: n('min_stock'), max_stock: n('max_stock'), reorder_point: n('reorder_point'),
    tax_rate: n('tax_rate'), is_perishable: b('is_perishable'), requires_lot: b('requires_lot'),
    requires_expiration: b('requires_expiration'), notes: v(formData.get('notes') as string), created_by: userId,
  }).select()

  if (error) return { error: error.message }
  if (!data || data.length === 0) return { error: 'No se insertó el registro' }

  if (imageFile && imageFile.size > 0) {
    const ext = imageFile.name.split('.').pop()
    const path = `adquisiciones/products/${data[0].id}/image.${ext}`
    const sb = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey)
    const { error: uploadErr } = await sb.storage.from('product-images').upload(path, imageFile, { upsert: true })
    if (!uploadErr) { const { data: pubUrl } = sb.storage.from('product-images').getPublicUrl(path); await db.from('products').update({ image_url: pubUrl?.publicUrl }).eq('id', data[0].id) }
  }
  return { success: true }
}

export async function updateProduct(productId: string, formData: FormData) {
  const authRes = await verifyWriteAccess()
  if (authRes.error) return { error: authRes.error }
  const userId = authRes.userId!

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' }

  const description = normalize(formData.get('description') as string ?? '')
  if (!description) return { error: 'La descripción es obligatoria' }
  const db = adqAdmin()
  const classifierFields = ['brand', 'category', 'subcategory', 'product_type', 'weight_unit', 'purchase_unit', 'sales_unit', 'unit_of_measure', 'package_unit'] as const
  const classifierTypes = ['BRAND', 'CATEGORY', 'SUBCATEGORY', 'PRODUCT_TYPE', 'WEIGHT_UNIT', 'PURCHASE_UNIT', 'SALES_UNIT', 'MEASURE_UNIT', 'PACKAGE_UNIT'] as const
  for (let i = 0; i < classifierFields.length; i++) {
    const val = v(formData.get(classifierFields[i]) as string)
    if (val) { const err = await validateClassifier(classifierTypes[i], val, companyId); if (err) return { error: err } }
  }
  function n(name: string) { const val = parseFloat(formData.get(name) as string); return isNaN(val) ? 0 : val }
  function b(name: string) { return ['SI', 'TRUE', '1'].includes((formData.get(name) as string ?? '').trim().toUpperCase()) }
  const imageFile = formData.get('image') as File
  let image_url: string | null = (formData.get('existing_image') as string) || null
  if (imageFile && imageFile.size > 0) {
    const ext = imageFile.name.split('.').pop(); const path = `adquisiciones/products/${productId}/image.${ext}`
    const sb = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey)
    const { error: uploadErr } = await sb.storage.from('product-images').upload(path, imageFile, { upsert: true })
    if (!uploadErr) { const { data: pubUrl } = sb.storage.from('product-images').getPublicUrl(path); image_url = pubUrl?.publicUrl }
  }
  const { data, error } = await db.from('products').update({ description, short_description: v(formData.get('short_description') as string), barcode: v(formData.get('barcode') as string), internal_code: v(formData.get('internal_code') as string), brand: v(formData.get('brand') as string), category: v(formData.get('category') as string), subcategory: v(formData.get('subcategory') as string), product_type: v(formData.get('product_type') as string), species: v(formData.get('species') as string), presentation: v(formData.get('presentation') as string), unit_of_measure: v(formData.get('unit_of_measure') as string), net_weight: n('net_weight'), weight_unit: v(formData.get('weight_unit') as string), package_quantity: n('package_quantity'), package_unit: v(formData.get('package_unit') as string), purchase_unit: v(formData.get('purchase_unit') as string), sales_unit: v(formData.get('sales_unit') as string), min_stock: n('min_stock'), max_stock: n('max_stock'), reorder_point: n('reorder_point'), tax_rate: n('tax_rate'), is_perishable: b('is_perishable'), requires_lot: b('requires_lot'), requires_expiration: b('requires_expiration'), image_url, notes: v(formData.get('notes') as string), updated_by: userId }).eq('id', productId).select()
  if (error) return { error: error.message }
  if (!data || data.length === 0) return { error: 'No se actualizó el registro' }
  return { success: true }
}

export async function deactivateProduct(productId: string) {
  const authRes = await verifyWriteAccess()
  if (authRes.error) return { error: authRes.error }
  const userId = authRes.userId!

  const db = adqAdmin()
  const { data: prod } = await db.from('products').select('is_active, status').eq('id', productId).single()
  if (!prod) return { error: 'Producto no encontrado' }
  const { error } = await db.from('products').update({ is_active: !prod.is_active, status: !prod.is_active ? 'ACTIVE' : 'INACTIVE', updated_by: userId }).eq('id', productId)
  if (error) return { error: error.message }
  return { success: true, newActive: !prod.is_active }
}

export async function importProducts(products: Record<string, unknown>[]) {
  const authRes = await verifyWriteAccess()
  if (authRes.error) return { error: authRes.error }
  const userId = authRes.userId!

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' }

  const db = adqAdmin()
  const { data, error } = await db.rpc('import_products_bulk', {
    p_products: products,
    p_user_id: userId,
    p_company_id: companyId
  })

  if (error) {
    return { error: error.message }
  }

  const res = data as {
    created: number
    omitted_sku: number
    omitted_barcode: number
    omitted_duplicate_name: number
    created_classifiers: number
    errors: { row: number; message: string }[]
  }

  return {
    created: res.created,
    omitted_sku: res.omitted_sku,
    omitted_barcode: res.omitted_barcode,
    omitted_duplicate_name: res.omitted_duplicate_name,
    created_classifiers: res.created_classifiers,
    errors: res.errors,
    total: products.length
  }
}

