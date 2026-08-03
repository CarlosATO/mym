'use server'

import { createInventariosClient } from '@/lib/supabase/inventarios'
import { getActiveCompanyId } from '@/app/actions/companies'

async function inventariosAdmin() {
  return createInventariosClient()
}

export interface InventoryCampaign {
  id: string
  name: string
  campaign_type: 'GENERAL' | 'SELECTIVE' | 'EXTERNAL'
  status: 'DRAFT' | 'IN_PROGRESS' | 'UNDER_REVIEW' | 'APPROVED' | 'CANCELLED'
  site_scope: 'ALL_INTERNAL' | 'SELECTED'
  product_scope: 'ALL' | 'SELECTED'
  planned_at: string | null
  started_at: string | null
  completed_at: string | null
  approved_at: string | null
  cancelled_at: string | null
  created_at: string
  site_count: number
  product_count: number
  session_count: number
}

export async function getActiveCompanyCampaigns(): Promise<{
  data: InventoryCampaign[] | null
  error: string | null
  companyId: string | null
}> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('list_inventory_campaigns', {
      p_company_id: companyId,
    })
    if (error) {
      console.error('list_inventory_campaigns error:', error.message)
      return { data: null, error: 'No se pudieron cargar las campañas.', companyId }
    }
    const campaigns = (data as { campaigns?: InventoryCampaign[] } | null)?.campaigns ?? []
    return { data: campaigns, error: null, companyId }
  } catch (err) {
    console.error('list_inventory_campaigns exception:', err)
    return { data: null, error: 'No se pudieron cargar las campañas.', companyId }
  }
}

export async function createInventoryCampaign(input: {
  name: string
  campaign_type: 'GENERAL' | 'SELECTIVE' | 'EXTERNAL'
  planned_at?: string | null
  site_scope: 'ALL_INTERNAL' | 'SELECTED'
  product_scope: 'ALL' | 'SELECTED'
}): Promise<{ data: { campaign_id: string } | null; error: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.' }
  }
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('create_inventory_campaign', {
      p_company_id: companyId,
      p_name: input.name,
      p_campaign_type: input.campaign_type,
      p_planned_at: input.planned_at ?? null,
      p_site_scope: input.site_scope,
      p_product_scope: input.product_scope,
    })
    if (error) {
      console.error('create_inventory_campaign error:', error.message)
      return { data: null, error: 'No se pudo crear la campaña.' }
    }
    const campaignId = (data as { entity_id?: string } | null)?.entity_id
    if (!campaignId) {
      return { data: null, error: 'La campaña no se pudo crear correctamente.' }
    }
    return { data: { campaign_id: campaignId }, error: null }
  } catch (err) {
    console.error('create_inventory_campaign exception:', err)
    return { data: null, error: 'No se pudo crear la campaña.' }
  }
}
