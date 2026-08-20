'use server'

import { createClient } from '@/lib/supabase/server'
import { getActiveCompanyId } from '@/app/actions/companies'

export interface BsaleBrandSupplierCandidate {
  company_id: string
  bsale_brand_id: number
  active_products: number
  resolved_preferred_products: number
  unresolved_preferred_products: number
  active_fallback_products: number
  real_supplier_count: number
  candidate_supplier_id: string | null
  candidate_supplier_name: string | null
  candidate_supplier_rut: string | null
  classification: 'INEQUIVOCO' | 'CASI_INEQUIVOCO' | 'MIXTO' | 'SIN_RESOLVER'
  link_id: string | null
  linked_supplier_id: string | null
  linked_supplier_name: string | null
  linked_supplier_rut: string | null
  linked_source: string | null
  linked_at: string | null
  linked_by: string | null
  derived_status: 'LINKED' | 'PENDING' | 'CONFLICT'
}

export interface BsaleBrandProductDetail {
  id: string
  sku: string
  description: string
  is_active: boolean
  bsale_product_id: number | null
  bsale_variant_id: number | null
  bsale_brand_id: number | null
  bsale_product_type_id: number | null
  family: string | null
  resolved_supplier_name: string | null
  supplier_resolution: 'VINCULADO' | 'BRAND SIN LINK'
}

async function authenticatedCompany() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return { supabase, companyId: null, user: null, error: 'No autorizado' as string | null }
  const companyId = await getActiveCompanyId()
  if (!companyId) return { supabase, companyId: null, user, error: 'Empresa activa requerida' as string | null }
  return { supabase, companyId, user, error: null as string | null }
}

export async function listBsaleBrandSupplierCandidates(): Promise<
  { data: BsaleBrandSupplierCandidate[]; error: string | null }
> {
  const auth = await authenticatedCompany()
  if (auth.error || !auth.companyId) return { data: [], error: auth.error || 'Empresa activa requerida' }

  const { data, error } = await auth.supabase
    .schema('integraciones')
    .from('vw_bsale_brand_supplier_candidates')
    .select('*')
    .eq('company_id', auth.companyId)
    .order('bsale_brand_id')

  return { data: (data || []) as BsaleBrandSupplierCandidate[], error: error?.message || null }
}

export async function listBsaleBrandProducts(
  bsaleBrandId: number,
): Promise<{ data: BsaleBrandProductDetail[]; error: string | null }> {
  const auth = await authenticatedCompany()
  if (auth.error || !auth.companyId) return { data: [], error: auth.error || 'Empresa activa requerida' }

  const db = auth.supabase
  const [{ data: products, error: productsError }, { data: brandLink, error: linkError }] = await Promise.all([
    db.schema('adquisiciones')
      .from('products')
      .select('id, sku, description, is_active, bsale_product_id, bsale_variant_id, bsale_brand_id, bsale_product_type_id, bsale_product_type_name')
      .eq('company_id', auth.companyId)
      .eq('bsale_brand_id', bsaleBrandId)
      .order('sku'),
    db.schema('integraciones')
      .from('bsale_brand_supplier_links')
      .select('supplier_id')
      .eq('company_id', auth.companyId)
      .eq('bsale_brand_id', bsaleBrandId)
      .maybeSingle(),
  ])

  if (productsError) return { data: [], error: productsError.message }
  if (linkError) return { data: [], error: linkError.message }

  const productRows = products || []
  const { data: linkedSupplier, error: supplierError } = await (
    brandLink?.supplier_id
      ? db.schema('adquisiciones')
        .from('suppliers')
        .select('id, business_name, supplier_kind, is_active, status')
        .eq('company_id', auth.companyId)
        .eq('id', brandLink.supplier_id)
        .maybeSingle()
      : Promise.resolve({ data: null, error: null })
  )

  if (supplierError) return { data: [], error: supplierError.message }

  const supplierResolution = !brandLink
    ? 'BRAND SIN LINK' as const
    : linkedSupplier?.supplier_kind === 'REAL' && linkedSupplier.is_active && linkedSupplier.status === 'ACTIVE'
      ? 'VINCULADO' as const
      : 'BRAND SIN LINK' as const

  return {
    data: productRows.map(product => {
      return {
        id: product.id,
        sku: product.sku,
        description: product.description,
        is_active: product.is_active,
        bsale_product_id: product.bsale_product_id,
        bsale_variant_id: product.bsale_variant_id,
        bsale_brand_id: product.bsale_brand_id,
        bsale_product_type_id: product.bsale_product_type_id,
        family: product.bsale_product_type_name || null,
        resolved_supplier_name: supplierResolution === 'VINCULADO' && linkedSupplier ? linkedSupplier.business_name : null,
        supplier_resolution: supplierResolution,
      }
    }),
    error: null,
  }
}

export async function linkBsaleBrandSupplier(
  bsaleBrandId: number,
  supplierId: string,
  source = 'MANUAL',
) {
  const auth = await authenticatedCompany()
  if (auth.error || !auth.companyId) return { data: null, error: auth.error || 'Empresa activa requerida' }

  const { data, error } = await auth.supabase.schema('integraciones').rpc('link_bsale_brand_supplier', {
    p_company_id: auth.companyId,
    p_bsale_brand_id: bsaleBrandId,
    p_supplier_id: supplierId,
    p_source: source,
  })
  return { data, error: error?.message || null }
}

export async function unlinkBsaleBrandSupplier(bsaleBrandId: number) {
  const auth = await authenticatedCompany()
  if (auth.error || !auth.companyId) return { data: null, error: auth.error || 'Empresa activa requerida' }

  const { data, error } = await auth.supabase.schema('integraciones').rpc('unlink_bsale_brand_supplier', {
    p_company_id: auth.companyId,
    p_bsale_brand_id: bsaleBrandId,
  })
  return { data, error: error?.message || null }
}
