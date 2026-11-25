import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllPages } from '@/modules/adquisiciones/unidades-compra/catalog-data'

export type BsaleBrandSupplier = {
  id: string
  business_name: string
  rut: string | null
  supplier_kind: string
  is_active: boolean
  status: string
}

/** Canonical brand → real supplier links, shared by the catalog and purchase units. */
// The untyped Supabase client is shared with the existing adquisiciones actions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadBsaleBrandSuppliers(db: SupabaseClient<any, 'public', 'adquisiciones'>, companyId: string, brandIds: number[]) {
  const ids = Array.from(new Set(brandIds))
  const chunks = Array.from({ length: Math.ceil(ids.length / 500) }, (_, i) => ids.slice(i * 500, (i + 1) * 500))
  const linkPages = await Promise.all(chunks.map(chunk => fetchAllPages((from, to) => db.schema('integraciones').from('bsale_brand_supplier_links')
    .select('company_id, bsale_brand_id, supplier_id', { count: 'exact' })
    .eq('company_id', companyId).in('bsale_brand_id', chunk).order('bsale_brand_id').order('supplier_id').range(from, to))))
  const links = linkPages.flat()
  const supplierIds = Array.from(new Set(links.map(link => link.supplier_id as string)))
  const supplierChunks = Array.from({ length: Math.ceil(supplierIds.length / 500) }, (_, i) => supplierIds.slice(i * 500, (i + 1) * 500))
  const supplierPages = await Promise.all(supplierChunks.map(chunk => fetchAllPages((from, to) => db.from('suppliers')
    .select('id, business_name, rut, supplier_kind, is_active, status', { count: 'exact' })
    .eq('company_id', companyId).eq('supplier_kind', 'REAL').eq('is_active', true).eq('status', 'ACTIVE')
    .in('id', chunk).order('id').range(from, to))))
  const suppliers = new Map(supplierPages.flat().map(supplier => [supplier.id, supplier as BsaleBrandSupplier]))
  const result = new Map<number, BsaleBrandSupplier>()
  for (const link of links) {
    const supplier = suppliers.get(link.supplier_id)
    if (supplier) result.set(Number(link.bsale_brand_id), supplier)
  }
  return result
}
