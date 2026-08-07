'use server'

import { createClient } from '@supabase/supabase-js'
import { getActiveCompanyId } from '@/app/actions/companies'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

function adqDb() {
  return createClient(supabaseUrl, serviceKey, {
    db: { schema: 'adquisiciones' },
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

export interface ReplenishmentFilterPair {
  real_supplier_name: string
  pseudo_supplier_name: string
}

export interface ReplenishmentFilterCatalog {
  suppliers: string[]
  pairs: ReplenishmentFilterPair[]
}

export async function getReplenishmentFilterCatalog(): Promise<{ success: boolean, data?: ReplenishmentFilterCatalog, error?: string }> {
  try {
    const companyId = await getActiveCompanyId()
    if (!companyId) throw new Error('No hay empresa activa')

    const aq = adqDb()

    // 1. Fetch active mappings
    const { data: mappingsData, error: mapErr } = await aq.from('product_supplier_mappings')
      .select('supplier_id, product_id, is_preferred, is_active')
      .eq('company_id', companyId)
      .eq('is_active', true)
    
    if (mapErr) throw new Error(`Error loading mappings: ${mapErr.message}`)
    if (!mappingsData || mappingsData.length === 0) return { success: true, data: { suppliers: [], pairs: [] } }

    // Dedup mappings by product_id (preferred wins, else last wins)
    const mappingByProductId = new Map<string, any>()
    for (const mapping of mappingsData) {
      if (!mapping.product_id) continue
      const current = mappingByProductId.get(mapping.product_id)
      if (!current || (!current.is_preferred && mapping.is_preferred)) {
        mappingByProductId.set(mapping.product_id, mapping)
      }
    }

    const uniqueProductIds = Array.from(mappingByProductId.keys())
    const uniqueSupplierIds = Array.from(new Set(Array.from(mappingByProductId.values()).map(m => m.supplier_id).filter(Boolean)))

    // 2. Fetch products
    // Note: Due to PostgREST limits, if uniqueProductIds > 1000 we should chunk, but we'll try a single query first or chunk it.
    const products: any[] = []
    const chunkSize = 1000
    for (let i = 0; i < uniqueProductIds.length; i += chunkSize) {
      const chunk = uniqueProductIds.slice(i, i + chunkSize)
      const { data: prodData } = await aq.from('products')
        .select('id, bsale_product_type_name, product_type')
        .eq('company_id', companyId)
        .in('id', chunk)
      if (prodData) products.push(...prodData)
    }
    const productById = new Map(products.map(p => [p.id, p]))

    // 3. Fetch suppliers & parents
    const suppliersList: any[] = []
    for (let i = 0; i < uniqueSupplierIds.length; i += chunkSize) {
      const chunk = uniqueSupplierIds.slice(i, i + chunkSize)
      const { data: suppData } = await aq.from('suppliers')
        .select('id, supplier_kind, business_name, bsale_product_type_name, parent_supplier_id')
        .eq('company_id', companyId)
        .in('id', chunk)
      if (suppData) suppliersList.push(...suppData)
    }
    const supplierById = new Map(suppliersList.map(s => [s.id, s]))

    const parentIds = Array.from(new Set(suppliersList.map(s => s.parent_supplier_id).filter(Boolean)))
    const parents: any[] = []
    for (let i = 0; i < parentIds.length; i += chunkSize) {
      const chunk = parentIds.slice(i, i + chunkSize)
      const { data: parentData } = await aq.from('suppliers')
        .select('id, business_name')
        .eq('company_id', companyId)
        .in('id', chunk)
      if (parentData) parents.push(...parentData)
    }
    const parentById = new Map(parents.map(p => [p.id, p]))

    // 4. Resolve pairs
    const pairsSet = new Set<string>()

    for (const [productId, mapping] of mappingByProductId.entries()) {
      const product = productById.get(productId)
      const supplier = mapping.supplier_id ? supplierById.get(mapping.supplier_id) : null
      
      let real_supplier_name = 'Sin proveedor'
      let pseudo_supplier_name = 'Sin pseudoproveedor'

      if (supplier) {
        if (supplier.supplier_kind === 'REAL') {
          real_supplier_name = supplier.business_name || 'Sin proveedor'
          pseudo_supplier_name = 'Directo'
        } else if (supplier.supplier_kind === 'BSALE_OPERATIVE') {
          const parent = supplier.parent_supplier_id ? parentById.get(supplier.parent_supplier_id) : null
          real_supplier_name = parent?.business_name || 'Sin proveedor real'
          pseudo_supplier_name = supplier.business_name || supplier.bsale_product_type_name || 'Sin pseudoproveedor'
        }
      }

      // Check fallback (from deriveRows / dataset logic: "si pseudo se resolvió pero coincide con tipo_producto (bsale_product_type_name)")
      // Wait, in dataset it also resolves type from catalog Product.
      // We are just extracting the valid catalog names. The exact pairs used.
      const pairKey = JSON.stringify({ real_supplier_name, pseudo_supplier_name })
      pairsSet.add(pairKey)
    }

    const pairs: ReplenishmentFilterPair[] = Array.from(pairsSet).map(s => JSON.parse(s))
    
    // Sort pairs
    pairs.sort((a, b) => {
      const cmp = a.real_supplier_name.localeCompare(b.real_supplier_name, 'es')
      if (cmp !== 0) return cmp
      return a.pseudo_supplier_name.localeCompare(b.pseudo_supplier_name, 'es')
    })

    // 5. Fetch all independent active REAL suppliers
    const { data: allRealSuppliersData } = await aq.from('suppliers')
      .select('business_name')
      .eq('company_id', companyId)
      .eq('supplier_kind', 'REAL')
      .eq('is_active', true)
      .eq('status', 'ACTIVE')

    const uniqueRealSuppliers = new Set<string>()
    if (allRealSuppliersData) {
      for (const s of allRealSuppliersData) {
        if (s.business_name && s.business_name.trim()) {
          uniqueRealSuppliers.add(s.business_name.trim())
        }
      }
    }
    const suppliers = Array.from(uniqueRealSuppliers).sort((a, b) => a.localeCompare(b, 'es'))

    return { success: true, data: { suppliers, pairs } }

  } catch (e) {
    console.error('[getReplenishmentFilterCatalog] Error:', e)
    return { success: false, error: e instanceof Error ? e.message : 'Error desconocido' }
  }
}
