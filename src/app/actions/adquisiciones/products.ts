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

async function verifyPermission(permissionCode: string): Promise<{ error?: string; userId?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const { data: allowed, error } = await supabase.rpc('has_permission', {
    p_permission_code: permissionCode,
  })
  if (error || allowed !== true) {
    return { error: 'Permisos insuficientes para esta operación.' }
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
  source?: string | null; bsale_product_id?: number | null; bsale_variant_id?: number | null;
  bsale_product_type_id?: number | null; bsale_product_type_name?: string | null;
  bsale_product_state?: number | null; bsale_variant_state?: number | null;
  last_bsale_sync_at?: string | null; bsale_sync_hash?: string | null;
  bsale_status_conflict?: boolean | null; bsale_status_conflict_reason?: string | null;
  bsale_status_conflict_detected_at?: string | null;
  supplier_mapping_id?: string;
  supplier_id?: string;
  supplier_kind?: string;
  pseudo_supplier_id?: string;
  pseudo_supplier_name?: string;
  real_supplier_id?: string;
  real_supplier_name?: string;
  supplier_resolution_status?: 'DIRECTO' | 'ASOCIADO' | 'PENDIENTE_ASOCIACION' | 'SIN_PROVEEDOR';
  supplier_origin_label?: string;
  bsale_brand_id?: number | null;
  bsale_brand_href?: string | null;
  bsale_supplier_link_status?: 'LINKED' | 'PENDING' | 'NO_BRAND' | 'NOT_APPLICABLE';
  bsale_supplier_id?: string | null;
  bsale_supplier_name?: string | null;
  bsale_supplier_rut?: string | null;
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
  const authRes = await verifyPermission('adquisiciones.products.view')
  if (authRes.error) return []

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
  source?: string
  bsale_status_conflict?: string
  bsale_inactive?: string
  no_barcode?: string
  no_bsale_type?: string
  sortBy?: ProductSortKey
  sortDirection?: 'asc' | 'desc'
  page?: number
  pageSize?: number
}

export type ProductSortKey = 'sku' | 'barcode' | 'description' | 'category' | 'presentation' | 'unit_of_measure' | 'min_stock' | 'reorder_point' | 'is_active'

const PRODUCT_SORT_COLUMNS: Record<ProductSortKey, string> = {
  sku: 'sku',
  barcode: 'barcode',
  description: 'description',
  category: 'category',
  presentation: 'presentation',
  unit_of_measure: 'unit_of_measure',
  min_stock: 'min_stock',
  reorder_point: 'reorder_point',
  is_active: 'is_active',
}

type BsaleBrandSupplierLink = {
  company_id: string
  bsale_brand_id: number
  supplier_id: string
  supplier?: { id: string; business_name: string; rut: string | null; supplier_kind: string; is_active: boolean; status: string } | null
}

export interface ProductCatalogLookup {
  sku: string
  description: string | null
  barcode: string | null
  product_type: string | null
  bsale_variant_id: number | null
  bsale_product_type_name: string | null
}

export async function getProductCatalogBySkus(skus: string[]): Promise<ProductCatalogLookup[]> {
  const authRes = await verifyPermission('adquisiciones.products.view')
  if (authRes.error) return []

  const companyId = await getActiveCompanyId()
  if (!companyId) return []

  const normalizedSkus = Array.from(new Set(
    skus
      .map(sku => String(sku || '').trim().toUpperCase())
      .filter(Boolean)
  ))

  if (normalizedSkus.length === 0) return []

  const db = adqAdmin()
  const rows: ProductCatalogLookup[] = []
  const chunkSize = 400

  for (let i = 0; i < normalizedSkus.length; i += chunkSize) {
    const chunk = normalizedSkus.slice(i, i + chunkSize)
    const { data, error } = await db.from('products')
      .select('sku, description, barcode, product_type, bsale_variant_id, bsale_product_type_name')
      .eq('company_id', companyId)
      .in('sku', chunk)

    if (error) continue
    rows.push(...((data ?? []) as ProductCatalogLookup[]))
  }

  return rows
}

export interface PurchaseOrderProductSearchRequest {
  real_supplier_id: string
  search?: string
  page?: number
  limit?: number
}

export interface PurchaseOrderProductSearchResult {
  data: Product[]
  page: number
  has_more: boolean
  total?: number
  error?: string
}

export async function searchPurchaseOrderProducts({
  real_supplier_id,
  search = '',
  page = 1,
  limit = 40,
}: PurchaseOrderProductSearchRequest): Promise<PurchaseOrderProductSearchResult> {
  const safePage = Math.max(Number.isFinite(page) ? Math.floor(page) : 1, 1)
  const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? Math.floor(limit) : 40, 1), 50)
  const authRes = await verifyPermission('adquisiciones.products.view')
  if (authRes.error) return { data: [], page: safePage, has_more: false, error: authRes.error }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: [], page: safePage, has_more: false, error: 'Proveedor no válido para la empresa activa.' }

  const query = search.trim()
  const db = adqAdmin()

  const { data: realSupplier } = await db.from('suppliers')
    .select('id')
    .eq('id', real_supplier_id)
    .eq('company_id', companyId)
    .eq('supplier_kind', 'REAL')
    .eq('is_active', true)
    .eq('status', 'ACTIVE')
    .maybeSingle()

  if (!realSupplier) return { data: [], page: safePage, has_more: false, error: 'Proveedor no válido para la empresa activa.' }

  const { data: operativeSuppliers, error: operativeError } = await db.from('suppliers')
    .select('id')
    .eq('company_id', companyId)
    .eq('supplier_kind', 'BSALE_OPERATIVE')
    .eq('parent_supplier_id', real_supplier_id)
    .eq('is_active', true)
    .eq('status', 'ACTIVE')

  if (operativeError) return { data: [], page: safePage, has_more: false, error: operativeError.message }

  const supplierIds = [real_supplier_id, ...(operativeSuppliers ?? []).map(supplier => supplier.id)]
  const { data: candidateMappings, error: candidateError } = await db.from('product_supplier_mappings')
    .select('product_id')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .in('supplier_id', supplierIds)

  if (candidateError) return { data: [], page: safePage, has_more: false, error: candidateError.message }

  const candidateProductIds = Array.from(new Set(
    (candidateMappings ?? []).map(mapping => mapping.product_id).filter(Boolean)
  ))
  if (candidateProductIds.length === 0) return { data: [], page: safePage, has_more: false }

  // Resolve the preferred active mapping before the product query is paginated.
  const { data: activeMappings, error: mappingError } = await db.from('product_supplier_mappings')
    .select('id, product_id, supplier_id, is_preferred')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .in('product_id', candidateProductIds)
    .order('is_preferred', { ascending: false })
    .order('id', { ascending: true })

  if (mappingError) return { data: [], page: safePage, has_more: false, error: mappingError.message }

  const canonicalSupplierIds = new Set(supplierIds)
  const preferredMappingByProduct = new Map<string, { supplier_id: string; is_preferred: boolean }>()
  for (const mapping of activeMappings ?? []) {
    if (!mapping.product_id || preferredMappingByProduct.has(mapping.product_id)) continue
    preferredMappingByProduct.set(mapping.product_id, mapping)
  }
  const canonicalProductIds = Array.from(preferredMappingByProduct.entries())
    .filter(([, mapping]) => canonicalSupplierIds.has(mapping.supplier_id))
    .map(([productId]) => productId)
  if (canonicalProductIds.length === 0) return { data: [], page: safePage, has_more: false }

  let productsQuery = db.from('products')
    .select('*')
    .or(`company_id.is.null,company_id.eq.${companyId}`)
    .eq('is_active', true)
    .in('id', canonicalProductIds)
  if (query) {
    const searchPattern = `%${query}%`
    productsQuery = productsQuery.or(`sku.ilike.${searchPattern},barcode.ilike.${searchPattern},description.ilike.${searchPattern},brand.ilike.${searchPattern},category.ilike.${searchPattern}`)
  }
  const from = (safePage - 1) * safeLimit
  const { data, error } = await productsQuery
    .order('description', { ascending: true, nullsFirst: false })
    .order('sku', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true })
    .range(from, from + safeLimit)

  if (error) return { data: [], page: safePage, has_more: false, error: error.message }
  const rows = (data ?? []) as Product[]
  return {
    data: rows.slice(0, safeLimit),
    page: safePage,
    has_more: rows.length > safeLimit,
  }
}

export async function getProducts(filters: ProductFilters = {}): Promise<{ data: Product[]; total: number; error?: string }> {
  const authRes = await verifyPermission('adquisiciones.products.view')
  if (authRes.error) return { data: [], total: 0, error: authRes.error }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: [], total: 0 }

  const db = adqAdmin()
  let linkedSearchBrandIds: number[] = []
  if (filters.search) {
    const { data: matchingSuppliers } = await db.from('suppliers')
      .select('id')
      .eq('company_id', companyId)
      .eq('supplier_kind', 'REAL')
      .ilike('business_name', `%${filters.search}%`)
    const supplierIds = (matchingSuppliers ?? []).map(s => s.id)
    if (supplierIds.length > 0) {
      const { data: matchingLinks } = await db.schema('integraciones').from('bsale_brand_supplier_links')
        .select('bsale_brand_id')
        .eq('company_id', companyId)
        .in('supplier_id', supplierIds)
      linkedSearchBrandIds = Array.from(new Set((matchingLinks ?? []).map(l => l.bsale_brand_id)))
    }
  }
  let query = db.from('products')
    .select('*', { count: 'exact' })
    .or(`company_id.is.null,company_id.eq.${companyId}`)

  if (filters.search) {
    const s = filters.search
    const searchClauses = [`sku.ilike.%${s}%`, `barcode.ilike.%${s}%`, `description.ilike.%${s}%`, `brand.ilike.%${s}%`, `category.ilike.%${s}%`]
    if (linkedSearchBrandIds.length > 0) searchClauses.push(`bsale_brand_id.in.(${linkedSearchBrandIds.join(',')})`)
    query = query.or(searchClauses.join(','))
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

  if (filters.source) query = query.eq('source', filters.source)
  if (filters.bsale_status_conflict === 'true') query = query.eq('bsale_status_conflict', true)
  if (filters.bsale_inactive === 'true') query = query.or('bsale_product_state.eq.1,bsale_variant_state.eq.1')
  if (filters.no_barcode === 'true') query = query.or('barcode.is.null,barcode.eq.""')
  if (filters.no_bsale_type === 'true') query = query.is('bsale_product_type_id', null)

  const page = filters.page ?? 1
  const pageSize = filters.pageSize ?? 50
  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  const sortBy = filters.sortBy && Object.prototype.hasOwnProperty.call(PRODUCT_SORT_COLUMNS, filters.sortBy) ? filters.sortBy : 'sku'
  const sortDirection = filters.sortDirection === 'desc' ? 'desc' : 'asc'
  query = query
    .order(PRODUCT_SORT_COLUMNS[sortBy], { ascending: sortDirection === 'asc', nullsFirst: false })
    .order('id', { ascending: true })
    .range(from, to)
  const { data, error, count } = await query
  if (error) return { data: [], total: 0, error: error.message }
  const products = (data ?? []) as Product[]

  if (products.length > 0) {
    const bsaleBrandIds = Array.from(new Set(products
      .filter(p => p.source === 'BSALE' && p.bsale_brand_id != null)
      .map(p => p.bsale_brand_id as number)))
    const bsaleLinks = new Map<number, BsaleBrandSupplierLink>()
    if (bsaleBrandIds.length > 0) {
      const { data: links } = await db.schema('integraciones').from('bsale_brand_supplier_links')
        .select('company_id, bsale_brand_id, supplier_id')
        .eq('company_id', companyId)
        .in('bsale_brand_id', bsaleBrandIds)
      const supplierIds = Array.from(new Set((links ?? []).map(l => l.supplier_id)))
      let suppliers: BsaleBrandSupplierLink['supplier'][] = []
      if (supplierIds.length > 0) {
        const { data: supplierRows } = await db.from('suppliers')
          .select('id, business_name, rut, supplier_kind, is_active, status')
          .eq('company_id', companyId)
          .eq('supplier_kind', 'REAL')
          .eq('is_active', true)
          .eq('status', 'ACTIVE')
          .in('id', supplierIds)
        suppliers = supplierRows ?? []
      }
      const supplierMap = new Map((suppliers ?? []).map(s => [s?.id, s]))
      for (const link of links ?? []) {
        const supplier = supplierMap.get(link.supplier_id)
        if (supplier) bsaleLinks.set(link.bsale_brand_id, { ...link, supplier })
      }
    }
    for (const p of products) {
      if (p.source !== 'BSALE') {
        p.bsale_supplier_link_status = 'NOT_APPLICABLE'
      } else if (p.bsale_brand_id == null) {
        p.bsale_supplier_link_status = 'NO_BRAND'
      } else {
        const link = bsaleLinks.get(p.bsale_brand_id)
        p.bsale_supplier_link_status = link ? 'LINKED' : 'PENDING'
        p.bsale_supplier_id = link?.supplier_id ?? null
        p.bsale_supplier_name = link?.supplier?.business_name ?? null
        p.bsale_supplier_rut = link?.supplier?.rut ?? null
      }
    }
    const productIds = products.map(p => p.id)
    const { data: mappings } = await db.from('product_supplier_mappings')
      .select('id, product_id, supplier_id, is_active')
      .in('product_id', productIds)

    if (mappings && mappings.length > 0) {
      // Preferred mapping (active first, or first encountered)
      const mappingByProduct = new Map<string, any>()
      for (const m of mappings) {
        if (!mappingByProduct.has(m.product_id)) {
          mappingByProduct.set(m.product_id, m)
        } else if (m.is_active && !mappingByProduct.get(m.product_id).is_active) {
          mappingByProduct.set(m.product_id, m)
        }
      }

      const supplierIds = Array.from(new Set(Array.from(mappingByProduct.values()).map(m => m.supplier_id)))
      const { data: suppliers } = await db.from('suppliers')
        .select('id, supplier_kind, business_name, bsale_product_type_name, parent_supplier_id')
        .in('id', supplierIds)

      const parentIds = Array.from(new Set(suppliers?.filter(s => s.parent_supplier_id).map(s => s.parent_supplier_id) || []))
      let parents: { id: string; business_name: string }[] = []
      if (parentIds.length > 0) {
        const { data: parentData } = await db.from('suppliers')
          .select('id, business_name')
          .in('id', parentIds)
        parents = parentData || []
      }

      const supplierMap = new Map((suppliers || []).map(s => [s.id, s]))
      const parentMap = new Map((parents || []).map(p => [p.id, p]))

      for (const p of products) {
        const m = mappingByProduct.get(p.id)
        if (!m) {
          p.supplier_resolution_status = 'SIN_PROVEEDOR'
          continue
        }
        p.supplier_mapping_id = m.id
        p.supplier_id = m.supplier_id
        
        const s = supplierMap.get(m.supplier_id)
        if (!s) {
          p.supplier_resolution_status = 'SIN_PROVEEDOR'
          continue
        }
        
        p.supplier_kind = s.supplier_kind
        if (s.supplier_kind === 'REAL') {
          p.supplier_resolution_status = 'DIRECTO'
          p.real_supplier_id = s.id
          p.real_supplier_name = s.business_name
          p.supplier_origin_label = 'DIRECTO'
        } else if (s.supplier_kind === 'BSALE_OPERATIVE') {
          p.pseudo_supplier_id = s.id
          p.pseudo_supplier_name = s.bsale_product_type_name ?? s.business_name
          p.supplier_origin_label = p.pseudo_supplier_name
          if (s.parent_supplier_id) {
            const parent = parentMap.get(s.parent_supplier_id)
            p.real_supplier_id = s.parent_supplier_id
            p.real_supplier_name = parent?.business_name
            p.supplier_resolution_status = 'ASOCIADO'
          } else {
            p.supplier_resolution_status = 'PENDIENTE_ASOCIACION'
          }
        }
      }
    } else {
      products.forEach(p => p.supplier_resolution_status = 'SIN_PROVEEDOR')
    }
  }

  return { data: products, total: count ?? 0 }
}

export async function createProduct(formData: FormData) {
  const authRes = await verifyPermission('adquisiciones.products.create')
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
  if (imageFile && imageFile.size > 0) {
    const imageAuthRes = await verifyPermission('adquisiciones.products.upload_image')
    if (imageAuthRes.error) return { error: imageAuthRes.error }
  }

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

  const realSupplierId = formData.get('real_supplier_id') as string
  if (realSupplierId) {
    await db.from('product_supplier_mappings').insert({
      product_id: data[0].id,
      supplier_id: realSupplierId,
      company_id: companyId,
      unit_cost: 0,
      is_active: true
    })
  }

  return { success: true }
}

export async function updateProduct(productId: string, formData: FormData) {
  const authRes = await verifyPermission('adquisiciones.products.update')
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
  if (imageFile && imageFile.size > 0) {
    const imageAuthRes = await verifyPermission('adquisiciones.products.upload_image')
    if (imageAuthRes.error) return { error: imageAuthRes.error }
  }
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

  // Update supplier mapping only if source is not BSALE
  if (data[0].source !== 'BSALE') {
    const realSupplierId = formData.get('real_supplier_id') as string
    if (realSupplierId) {
      const { data: existingMapping } = await db.from('product_supplier_mappings')
        .select('id')
        .eq('product_id', productId)
        .eq('supplier_id', realSupplierId)
        .maybeSingle()
        
      if (!existingMapping) {
        // Find existing mappings to deactivate or delete? For simplicity, we just add the new one or update the existing.
        // Actually it's better to update the existing REAL mapping if it exists.
        const { data: realMappings } = await db.from('product_supplier_mappings')
          .select('id')
          .eq('product_id', productId)
          
        if (realMappings && realMappings.length > 0) {
          await db.from('product_supplier_mappings').update({ supplier_id: realSupplierId }).eq('id', realMappings[0].id)
        } else {
          await db.from('product_supplier_mappings').insert({
            product_id: productId,
            supplier_id: realSupplierId,
            company_id: companyId,
            unit_cost: 0,
            is_active: true
          })
        }
      }
    }
  }

  return { success: true }
}

export async function deactivateProduct(productId: string) {
  const authRes = await verifyPermission('adquisiciones.products.deactivate')
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
  const authRes = await verifyPermission('adquisiciones.products.import')
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
