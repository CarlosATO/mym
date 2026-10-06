import { createClient } from '@supabase/supabase-js'

export type OperativeParentResolution =
  | 'NO_ACTIVE_PRODUCTS'
  | 'WITHOUT_BRAND'
  | 'MULTIPLE_BRANDS'
  | 'BRAND_WITHOUT_LINK'
  | 'INVALID_REAL_SUPPLIER'
  | 'ALREADY_CORRECT'
  | 'ASSIGN'
  | 'UPDATE'

export interface OperativeParentDecisionInput {
  activeProductCount: number
  brandIds: string[]
  hasProductWithoutBrand: boolean
  linkedSupplierId?: string | null
  validRealSupplierId?: string | null
  currentParentSupplierId?: string | null
}

export function decideOperativeSupplierParent(input: OperativeParentDecisionInput): OperativeParentResolution {
  if (input.activeProductCount === 0) return 'NO_ACTIVE_PRODUCTS'
  if (input.hasProductWithoutBrand) return 'WITHOUT_BRAND'
  if (input.brandIds.length !== 1) return 'MULTIPLE_BRANDS'
  if (!input.linkedSupplierId) return 'BRAND_WITHOUT_LINK'
  if (!input.validRealSupplierId) return 'INVALID_REAL_SUPPLIER'
  if (input.currentParentSupplierId === input.validRealSupplierId) return 'ALREADY_CORRECT'
  return input.currentParentSupplierId ? 'UPDATE' : 'ASSIGN'
}

export interface OperativeParentSyncResult {
  scanned: number
  alreadyCorrect: number
  assigned: number
  updated: number
  noActiveProducts: number
  withoutBrand: number
  multipleBrands: number
  brandWithoutLink: number
  invalidRealSupplier: number
  errors: string[]
  pending: Array<{ supplierId: string; reason: Exclude<OperativeParentResolution, 'ASSIGN' | 'UPDATE' | 'ALREADY_CORRECT'> }>
}

interface OperativeSupplier {
  id: string
  bsale_product_type_id: string | null
  bsale_product_type_name: string | null
  parent_supplier_id: string | null
  is_active: boolean
  status: string | null
}

interface Product {
  bsale_product_type_id: string | number | null
  bsale_product_type_name: string | null
  bsale_brand_id: string | number | null
}

const emptyResult = (): OperativeParentSyncResult => ({
  scanned: 0,
  alreadyCorrect: 0,
  assigned: 0,
  updated: 0,
  noActiveProducts: 0,
  withoutBrand: 0,
  multipleBrands: 0,
  brandWithoutLink: 0,
  invalidRealSupplier: 0,
  errors: [],
  pending: [],
})

interface PagedQuery<T> {
  range(from: number, to: number): PromiseLike<{ data: T[] | null; error: { message: string } | null }>
}

async function readAll<T>(query: PagedQuery<T>): Promise<T[]> {
  const rows: T[] = []
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await query.range(offset, offset + 999)
    if (error) throw error
    rows.push(...((data || []) as T[]))
    if (!data || data.length < 1000) return rows
  }
}

function normalized(value: string | null | undefined): string {
  return (value || '').trim().toLocaleLowerCase()
}

function incrementPending(result: OperativeParentSyncResult, supplierId: string, reason: Exclude<OperativeParentResolution, 'ASSIGN' | 'UPDATE' | 'ALREADY_CORRECT'>) {
  const counterByReason: Record<Exclude<OperativeParentResolution, 'ASSIGN' | 'UPDATE' | 'ALREADY_CORRECT'>, 'noActiveProducts' | 'withoutBrand' | 'multipleBrands' | 'brandWithoutLink' | 'invalidRealSupplier'> = {
    NO_ACTIVE_PRODUCTS: 'noActiveProducts',
    WITHOUT_BRAND: 'withoutBrand',
    MULTIPLE_BRANDS: 'multipleBrands',
    BRAND_WITHOUT_LINK: 'brandWithoutLink',
    INVALID_REAL_SUPPLIER: 'invalidRealSupplier',
  }
  result[counterByReason[reason]]++
  result.pending.push({ supplierId, reason })
}

export async function syncOperativeSupplierParents(companyId: string, options: { dryRun?: boolean } = {}): Promise<OperativeParentSyncResult> {
  const result = emptyResult()
  const dryRun = options.dryRun === true
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  try {
    const [operatives, products, links, realSuppliers, productTypes] = await Promise.all([
      readAll<OperativeSupplier>(admin.schema('adquisiciones').from('suppliers').select('id,bsale_product_type_id,bsale_product_type_name,parent_supplier_id,is_active,status').eq('company_id', companyId).eq('supplier_kind', 'BSALE_OPERATIVE')),
      readAll<Product>(admin.schema('adquisiciones').from('products').select('bsale_product_type_id,bsale_product_type_name,bsale_brand_id').eq('company_id', companyId).eq('is_active', true).eq('status', 'ACTIVE').eq('source', 'BSALE')),
      readAll<{ bsale_brand_id: number; supplier_id: string }>(admin.schema('integraciones').from('bsale_brand_supplier_links').select('bsale_brand_id,supplier_id').eq('company_id', companyId)),
      readAll<{ id: string; company_id: string; supplier_kind: string; is_active: boolean; status: string | null }>(admin.schema('adquisiciones').from('suppliers').select('id,company_id,supplier_kind,is_active,status').eq('company_id', companyId).eq('supplier_kind', 'REAL')),
      readAll<{ id: string; bsale_id: number }>(admin.schema('integraciones').from('bsale_product_types').select('id,bsale_id').eq('company_id', companyId)),
    ])

    const bsaleIdByTypeUuid = new Map(productTypes.map(type => [type.id, String(type.bsale_id)]))
    const linksByBrand = new Map(links.map(link => [String(link.bsale_brand_id), link.supplier_id]))
    const realSupplierIds = new Set(realSuppliers.filter(supplier => supplier.is_active && supplier.status === 'ACTIVE').map(supplier => supplier.id))
    const activeOperatives = operatives.filter(supplier => supplier.is_active && supplier.status === 'ACTIVE')
    result.scanned = activeOperatives.length

    for (const operative of activeOperatives) {
      const bsaleTypeId = operative.bsale_product_type_id ? bsaleIdByTypeUuid.get(operative.bsale_product_type_id) : null
      let matchingProducts = bsaleTypeId
        ? products.filter(product => String(product.bsale_product_type_id) === bsaleTypeId)
        : []
      if (matchingProducts.length === 0 && operative.bsale_product_type_name) {
        matchingProducts = products.filter(product => normalized(product.bsale_product_type_name) === normalized(operative.bsale_product_type_name))
      }

      const brandIds = [...new Set(matchingProducts.map(product => product.bsale_brand_id).filter(id => id !== null && id !== undefined).map(String))]
      const brandId = brandIds.length === 1 ? brandIds[0] : null
      const linkedSupplierId = brandId ? linksByBrand.get(brandId) : null
      const decision = decideOperativeSupplierParent({
        activeProductCount: matchingProducts.length,
        brandIds,
        hasProductWithoutBrand: matchingProducts.some(product => product.bsale_brand_id === null || product.bsale_brand_id === undefined),
        linkedSupplierId,
        validRealSupplierId: linkedSupplierId && realSupplierIds.has(linkedSupplierId) ? linkedSupplierId : null,
        currentParentSupplierId: operative.parent_supplier_id,
      })

      if (decision === 'ALREADY_CORRECT') {
        result.alreadyCorrect++
      } else if (decision === 'ASSIGN' || decision === 'UPDATE') {
        if (!dryRun) {
          const { error } = await admin.schema('adquisiciones').from('suppliers').update({ parent_supplier_id: linkedSupplierId }).eq('id', operative.id).eq('company_id', companyId).eq('supplier_kind', 'BSALE_OPERATIVE')
          if (error) {
            result.errors.push(`${operative.id}: ${error.message}`)
            continue
          }
        }
        result[decision === 'ASSIGN' ? 'assigned' : 'updated']++
      } else {
        incrementPending(result, operative.id, decision)
      }
    }
  } catch (error: unknown) {
    result.errors.push(error instanceof Error ? error.message : String(error))
  }

  return result
}
