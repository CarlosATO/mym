'use server'

import crypto from 'crypto'
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

export interface InventoryCampaignSiteDetail {
  campaign_site_id: string
  site_id: string
  site_name: string
  site_code: string
  site_type: string
  is_required: boolean
  display_order: number
  location_scope: 'ALL' | 'SELECTED'
  location_count: number
  session_id: string | null
  session_number: number | null
  session_status: string | null
  stock_source: string | null
  stock_import_id: string | null
  import_status: string | null
  import_filename: string | null
}

export interface InventoryCampaignDetail {
  campaign: {
    id: string
    name: string
    campaign_type: string
    status: string
    site_scope: string
    product_scope: string
    planned_at: string | null
    created_at: string
  }
  site_count: number
  session_count: number
  sessions_pending: number
  sites: InventoryCampaignSiteDetail[]
  products: Array<{ product_id: string; sku: string; display_order: number }>
}

export async function getActiveCompanyCampaignDetail(
  campaignId: string
): Promise<{ data: InventoryCampaignDetail | null; error: string | null; companyId: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('get_inventory_campaign_detail', {
      p_company_id: companyId,
      p_campaign_id: campaignId,
    })
    if (error) {
      console.error('get_inventory_campaign_detail error:', error.message)
      return { data: null, error: 'No se pudo cargar el detalle de la campaña.', companyId }
    }
    return { data: data as InventoryCampaignDetail, error: null, companyId }
  } catch (err) {
    console.error('get_inventory_campaign_detail exception:', err)
    return { data: null, error: 'No se pudo cargar el detalle de la campaña.', companyId }
  }
}

export async function createInventorySessionFromCampaignSite(
  campaignSiteId: string
): Promise<{ data: { session_id: string; session_number: number } | null; error: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.' }
  }
  try {
    const db = await inventariosAdmin()
    const { data: userData } = await db.auth.getUser()
    const userId = userData.user?.id
    if (!userId) {
      return { data: null, error: 'Debes iniciar sesión para realizar esta operación.' }
    }
    const idempotencyKey = crypto.randomUUID()
    const { data, error } = await db.rpc('create_inventory_session_from_campaign_site', {
      p_company_id: companyId,
      p_campaign_site_id: campaignSiteId,
      p_responsible_user_id: userId,
      p_idempotency_key: idempotencyKey,
    })
    if (error) {
      console.error('create_inventory_session_from_campaign_site error:', error.message)
      return { data: null, error: safeCampaignError(error.message) }
    }
    const result = data as unknown as { entity_id?: string; data?: { session_number?: number } }
    if (!result?.entity_id) {
      return { data: null, error: 'La jornada no se pudo crear correctamente.' }
    }
    return {
      data: { session_id: result.entity_id, session_number: result.data?.session_number ?? 0 },
      error: null,
    }
  } catch (err) {
    console.error('createInventorySessionFromCampaignSite exception:', err)
    return { data: null, error: 'No se pudo crear la jornada para esta unidad.' }
  }
}

export interface InventoryCampaignSessionGenerationSummary {
  campaign_id: string
  stock_import_id: string
  total_units: number
  sessions_created: number
  sessions_existing: number
  sessions_pending: number
  session_ids: string[]
}

export async function generateInventoryCampaignSessions(params: {
  campaignId: string
  stockImportId: string
  idempotencyKey?: string
}): Promise<{ data: InventoryCampaignSessionGenerationSummary | null; error: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.' }
  }
  try {
    const db = await inventariosAdmin()
    const { data: userData } = await db.auth.getUser()
    const userId = userData.user?.id
    if (!userId) {
      return { data: null, error: 'Debes iniciar sesión para realizar esta operación.' }
    }

    const { data, error } = await db.rpc('generate_inventory_campaign_sessions', {
      p_company_id: companyId,
      p_campaign_id: params.campaignId,
      p_stock_import_id: params.stockImportId,
      p_idempotency_key: params.idempotencyKey ?? crypto.randomUUID(),
    })
    if (error) {
      console.error('generate_inventory_campaign_sessions error:', error.message)
      return { data: null, error: safeCampaignGenerationError(error.message) }
    }

    const envelope = data as unknown as { data?: InventoryCampaignSessionGenerationSummary } & Partial<InventoryCampaignSessionGenerationSummary>
    const payload = envelope.data ?? envelope
    if (!payload?.campaign_id || !payload.stock_import_id) {
      return { data: null, error: 'No se pudieron generar las jornadas.' }
    }

    return {
      data: {
        campaign_id: payload.campaign_id,
        stock_import_id: payload.stock_import_id,
        total_units: Number(payload.total_units ?? 0),
        sessions_created: Number(payload.sessions_created ?? 0),
        sessions_existing: Number(payload.sessions_existing ?? 0),
        sessions_pending: Number(payload.sessions_pending ?? 0),
        session_ids: Array.isArray(payload.session_ids) ? payload.session_ids : [],
      },
      error: null,
    }
  } catch (err) {
    console.error('generateInventoryCampaignSessions exception:', err)
    return { data: null, error: 'No se pudieron generar las jornadas de la campaña.' }
  }
}

export async function getCampaignSessionCreatePermission(): Promise<{
  canCreate: boolean
  companyId: string | null
  error: string | null
}> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { canCreate: false, companyId: null, error: 'No tienes una empresa activa seleccionada.' }
  }
  try {
    const db = await inventariosAdmin()
    const { data: userData } = await db.auth.getUser()
    const userId = userData.user?.id
    if (!userId) {
      return { canCreate: false, companyId, error: 'Debes iniciar sesión para realizar esta operación.' }
    }
    const { data, error } = await db.rpc('get_company_permissions', {
      p_user_id: userId,
      p_company_id: companyId,
    })
    if (error) {
      console.error('get_company_permissions error:', error.message)
      return { canCreate: false, companyId, error: 'No se pudieron cargar los permisos.' }
    }
    const codes: string[] = (data ?? []).map((p: { permission_code: string }) => p.permission_code)
    return { canCreate: codes.includes('inventarios.sessions.create'), companyId, error: null }
  } catch (err) {
    console.error('getCampaignSessionCreatePermission exception:', err)
    return { canCreate: false, companyId, error: 'No se pudieron cargar los permisos.' }
  }
}

function safeCampaignError(message: string): string {
  const idx = message.indexOf('DETAIL:')
  if (idx >= 0) {
    const raw = message.slice(idx + 'DETAIL:'.length).trim()
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw)
        if (parsed?.message) return parsed.message
      } catch {
        // ignore
      }
    }
  }
  return 'No se pudo crear la jornada para esta unidad.'
}

function safeCampaignGenerationError(message: string): string {
  const normalized = message.toLowerCase()
  if (normalized.includes('no esta en draft') || normalized.includes('campana no editable')) {
    return 'La campaña no está disponible para generar jornadas.'
  }
  if (normalized.includes('no pertenece a la campana')) {
    return 'La importación no pertenece a esta campaña.'
  }
  if (normalized.includes('no esta validada')) {
    return 'La importación no está validada.'
  }
  if (normalized.includes('ya fue consumida')) {
    return 'La importación ya fue consumida.'
  }
  if (normalized.includes('no existe') || normalized.includes('not found')) {
    return 'La campaña no se pudo encontrar.'
  }
  if (normalized.includes('permission') || normalized.includes('autoriz')) {
    return 'No tienes permisos para generar jornadas.'
  }
  return 'No se pudieron generar las jornadas de la campaña.'
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
