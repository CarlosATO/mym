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
