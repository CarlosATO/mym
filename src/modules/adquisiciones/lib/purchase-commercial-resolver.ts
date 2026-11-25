import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllPages } from '@/modules/adquisiciones/unidades-compra/catalog-data'
import { loadBsaleBrandSuppliers } from '@/modules/adquisiciones/lib/bsale-brand-suppliers'

type Supplier = { id: string; business_name: string; supplier_kind: string; parent_supplier_id: string | null; is_active: boolean; status: string }
type Product = { id: string; source: string | null; bsale_brand_id: number | null }
type Mapping = { id: string; supplier_id: string; purchase_unit: string | null; purchase_unit_factor: number }

export type PurchaseCommercialResult =
  | { success: true; real_supplier: { id: string; business_name: string }; mapping_id: string | null; purchase_unit: string | null; purchase_unit_factor: number; configuration_status: 'CONFIGURED' | 'PENDING' }
  | { success: false; code: 'PRODUCT_NOT_FOUND' | 'INVALID_SUPPLIER' | 'BRAND_UNRESOLVED' | 'AMBIGUOUS_BRAND' | 'SUPPLIER_MISMATCH' | 'AMBIGUOUS_MAPPING' | 'INVALID_MAPPING'; message: string }

type Evidence = { product: Product | null; realSupplier: Supplier | null; brandSupplierId: string | null; brandLinkCount: number; mappings: Mapping[]; suppliers: Supplier[] }

/** Bsale brand is authoritative; operative supplier parent/status can be stale. */
export function resolvePurchaseCommercialEvidence(e: Evidence): PurchaseCommercialResult {
  const fail = (code: Extract<PurchaseCommercialResult, { success: false }>['code'], message: string): PurchaseCommercialResult => ({ success: false, code, message })
  if (!e.product) return fail('PRODUCT_NOT_FOUND', 'Producto activo no encontrado en la empresa.')
  const real = e.realSupplier
  if (!real || real.supplier_kind !== 'REAL' || !real.is_active || real.status !== 'ACTIVE') return fail('INVALID_SUPPLIER', 'Proveedor real activo no encontrado en la empresa.')
  const suppliers = new Map(e.suppliers.map(s => [s.id, s]))
  let candidates: Mapping[]
  if (e.product.source === 'BSALE') {
    if (e.brandLinkCount > 1) return fail('AMBIGUOUS_BRAND', 'La marca Bsale tiene más de un proveedor asociado.')
    if (e.product.bsale_brand_id == null || !e.brandSupplierId) return fail('BRAND_UNRESOLVED', 'La marca Bsale no tiene un proveedor real activo resoluble.')
    if (e.brandSupplierId !== real.id) return fail('SUPPLIER_MISMATCH', 'El proveedor real no coincide con el proveedor de la marca Bsale.')
    // Mappings to real suppliers cannot be attributed to a different real supplier by brand.
    if (e.mappings.some(m => suppliers.get(m.supplier_id)?.supplier_kind === 'REAL' && m.supplier_id !== real.id)) return fail('SUPPLIER_MISMATCH', 'Un mapeo directo contradice el proveedor de la marca Bsale.')
    if (e.mappings.some(m => !suppliers.has(m.supplier_id))) return fail('INVALID_MAPPING', 'El proveedor de un mapeo no pertenece a la empresa o no existe.')
    candidates = e.mappings
  } else {
    if (e.mappings.some(m => !suppliers.has(m.supplier_id))) return fail('INVALID_MAPPING', 'El proveedor de un mapeo no pertenece a la empresa o no existe.')
    candidates = e.mappings.filter(m => {
      const supplier = suppliers.get(m.supplier_id)!
      return supplier.id === real.id || (supplier.supplier_kind === 'BSALE_OPERATIVE' && supplier.parent_supplier_id === real.id)
    })
  }
  if (candidates.length > 1) return fail('AMBIGUOUS_MAPPING', 'Existe más de un mapeo comercial para el producto y proveedor.')
  const mapping = candidates[0]
  if (mapping && (!Number.isInteger(mapping.purchase_unit_factor) || mapping.purchase_unit_factor < 1 || (!mapping.purchase_unit?.trim() && mapping.purchase_unit_factor !== 1))) return fail('INVALID_MAPPING', 'La configuración comercial del mapeo es inválida.')
  const unit = mapping?.purchase_unit?.trim() || null
  return { success: true, real_supplier: { id: real.id, business_name: real.business_name }, mapping_id: mapping?.id ?? null, purchase_unit: unit, purchase_unit_factor: unit ? mapping!.purchase_unit_factor : 1, configuration_status: unit ? 'CONFIGURED' : 'PENDING' }
}

/** Read-only server-side helper. Caller must authorize the company and user. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function resolvePurchaseCommercial(db: SupabaseClient<any, 'public', 'adquisiciones'>, companyId: string, productId: string, realSupplierId: string): Promise<PurchaseCommercialResult> {
  const [productResult, realResult, mappings] = await Promise.all([
    db.from('products').select('id, source, bsale_brand_id').eq('company_id', companyId).eq('id', productId).eq('is_active', true).maybeSingle(),
    db.from('suppliers').select('id, business_name, supplier_kind, parent_supplier_id, is_active, status').eq('company_id', companyId).eq('id', realSupplierId).maybeSingle(),
    fetchAllPages((from, to) => db.from('product_supplier_mappings').select('id, supplier_id, purchase_unit, purchase_unit_factor', { count: 'exact' }).eq('company_id', companyId).eq('product_id', productId).eq('is_active', true).order('id').range(from, to)),
  ])
  if (productResult.error) throw productResult.error
  if (realResult.error) throw realResult.error
  const product = productResult.data as Product | null
  const ids = [...new Set(mappings.map(m => m.supplier_id as string))]
  const suppliers = ids.length ? await fetchAllPages((from, to) => db.from('suppliers').select('id, business_name, supplier_kind, parent_supplier_id, is_active, status', { count: 'exact' }).eq('company_id', companyId).in('id', ids).order('id').range(from, to)) as Supplier[] : []
  let brandSupplierId: string | null = null
  let brandLinkCount = 0
  if (product?.source === 'BSALE' && product.bsale_brand_id != null) {
    const brandId = Number(product.bsale_brand_id)
    const [links, brands] = await Promise.all([
      fetchAllPages((from, to) => db.schema('integraciones').from('bsale_brand_supplier_links').select('supplier_id', { count: 'exact' }).eq('company_id', companyId).eq('bsale_brand_id', brandId).order('supplier_id').range(from, to)),
      loadBsaleBrandSuppliers(db, companyId, [brandId]),
    ])
    brandLinkCount = links.length
    brandSupplierId = brands.get(brandId)?.id ?? null
  }
  return resolvePurchaseCommercialEvidence({ product, realSupplier: realResult.data as Supplier | null, brandSupplierId, brandLinkCount, mappings: mappings as Mapping[], suppliers })
}
