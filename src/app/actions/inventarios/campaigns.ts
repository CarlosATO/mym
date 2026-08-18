'use server'

import crypto from 'crypto'
import { createInventariosClient } from '@/lib/supabase/inventarios'
import { getActiveCompanyId } from '@/app/actions/companies'
import { getActiveCompanySites, type InventorySite } from '@/app/actions/inventarios/sites'

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
  active_zone_count: number | null
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
    const detail = data as InventoryCampaignDetail
    const sites = await Promise.all(detail.sites.map(async site => {
      if (!site.session_id) return { ...site, active_zone_count: 0 }
      const setupResult = await db.rpc('get_inventory_session_setup', {
        p_company_id: companyId,
        p_session_id: site.session_id,
      })
      if (setupResult.error) {
        console.error('get_inventory_session_setup for campaign site error:', setupResult.error.message)
        return { ...site, active_zone_count: null }
      }
      const setup = setupResult.data as { indicators?: { zone_count?: number } } | null
      return { ...site, active_zone_count: Number(setup?.indicators?.zone_count ?? 0) }
    }))
    return { data: { ...detail, sites }, error: null, companyId }
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

export async function getCampaignManagePermission(): Promise<{
  canManage: boolean
  companyId: string | null
  error: string | null
}> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { canManage: false, companyId: null, error: 'No tienes una empresa activa seleccionada.' }
  }
  try {
    const db = await inventariosAdmin()
    const { data: userData } = await db.auth.getUser()
    const userId = userData.user?.id
    if (!userId) {
      return { canManage: false, companyId, error: 'Debes iniciar sesión para realizar esta operación.' }
    }
    const { data, error } = await db.rpc('get_company_permissions', {
      p_user_id: userId,
      p_company_id: companyId,
    })
    if (error) {
      console.error('get_company_permissions error:', error.message)
      return { canManage: false, companyId, error: 'No se pudieron cargar los permisos.' }
    }
    const codes: string[] = (data ?? []).map((p: { permission_code: string }) => p.permission_code)
    return { canManage: codes.includes('inventarios.campaigns.manage'), companyId, error: null }
  } catch (err) {
    console.error('getCampaignManagePermission exception:', err)
    return { canManage: false, companyId, error: 'No se pudieron cargar los permisos.' }
  }
}

export interface InventoryCampaignCreationResult {
  campaign_id: string
  units_materialized: number
}

export async function setInventoryCampaignSites(params: {
  campaignId: string
  siteIds: string[]
}): Promise<{ data: { campaign_id: string; units_materialized: number } | null; error: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.' }
  }
  try {
    const db = await inventariosAdmin()
    const { error } = await db.rpc('set_inventory_campaign_sites', {
      p_company_id: companyId,
      p_campaign_id: params.campaignId,
      p_site_ids: params.siteIds,
      p_location_scopes: [],
    })
    if (error) {
      console.error('set_inventory_campaign_sites error:', error.message)
      return { data: null, error: safeCampaignScopeError(error.message) }
    }
    return {
      data: {
        campaign_id: params.campaignId,
        units_materialized: params.siteIds.length,
      },
      error: null,
    }
  } catch (err) {
    console.error('setInventoryCampaignSites exception:', err)
    return { data: null, error: 'No se pudieron materializar las unidades de la campaña.' }
  }
}

export async function createGeneralInventoryCampaign(input: {
  name: string
  plannedAt: string
}): Promise<{ data: InventoryCampaignCreationResult | null; error: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.' }
  }

  const sitesResult = await getActiveCompanySites()
  if (sitesResult.error) {
    return { data: null, error: sitesResult.error }
  }

  const eligibleSites = filterGeneralCampaignSites(sitesResult.data ?? [])
  if (eligibleSites.length === 0) {
    return { data: null, error: 'No hay bodegas internas habilitadas para crear la campaña.' }
  }

  const created = await createInventoryCampaign({
    name: input.name,
    campaign_type: 'GENERAL',
    planned_at: input.plannedAt,
    site_scope: 'ALL_INTERNAL',
    product_scope: 'ALL',
  })
  if (created.error || !created.data) {
    return { data: null, error: created.error ?? 'No se pudo crear la campaña.' }
  }

  const materialized = await setInventoryCampaignSites({
    campaignId: created.data.campaign_id,
    siteIds: eligibleSites.map(site => site.id),
  })
  if (materialized.error || !materialized.data) {
    return {
      data: null,
      error: 'No se pudo completar la materialización de las unidades. La campaña puede haber quedado en borrador; inténtalo nuevamente.',
    }
  }

  return {
    data: {
      campaign_id: created.data.campaign_id,
      units_materialized: materialized.data.units_materialized,
    },
    error: null,
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

function safeCampaignScopeError(message: string): string {
  const normalized = message.toLowerCase()
  if (normalized.includes('no hay bodegas internas')) {
    return 'No hay bodegas internas habilitadas para crear la campaña.'
  }
  if (normalized.includes('no existe') || normalized.includes('not found')) {
    return 'No se pudo materializar una de las bodegas seleccionadas.'
  }
  if (normalized.includes('permission') || normalized.includes('autoriz')) {
    return 'No tienes permisos para configurar la campaña.'
  }
  return 'No se pudieron materializar las unidades de la campaña.'
}

function filterGeneralCampaignSites(sites: InventorySite[]): InventorySite[] {
  return sites.filter(site => site.site_type === 'INTERNAL_WAREHOUSE' && site.is_active && site.inventory_enabled)
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type InventoryCampaignParticipantRole = 'COUNTER' | 'SUPERVISOR' | 'ADMINISTRATOR' | 'MANAGER'

export type InventoryCampaignParticipantState = 'ACTIVE' | 'REVOKED'

export interface InventoryCampaignParticipant {
  participantId: string
  userId: string
  userName: string | null
  email: string | null
  userIsActive: boolean
  participantRole: InventoryCampaignParticipantRole
  state: InventoryCampaignParticipantState
  activeFrom: string
  revokedAt: string | null
  revocationReason: string | null
  createdBy: string
}

export interface InventoryCampaignParticipantCounts {
  counter: number
  supervisor: number
  administrator: number
  manager: number
}

export interface InventoryCampaignParticipantsResult {
  participants: InventoryCampaignParticipant[]
  counts: InventoryCampaignParticipantCounts
}

export interface InventoryCampaignParticipantOperationEnvelope {
  operation: string
  entity_id: string
  state: InventoryCampaignParticipantState
  version: number | null
  cycle_number: number | null
  assignment_id: string | null
  event_id: string | null
  replayed: boolean
  occurred_at: string
  data: Record<string, unknown>
}

const CAMPAIGN_PARTICIPANT_ROLES: InventoryCampaignParticipantRole[] = [
  'COUNTER',
  'SUPERVISOR',
  'ADMINISTRATOR',
  'MANAGER',
]

function safeCampaignParticipantError(message: string, fallback: string): string {
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
  const normalized = message.toLowerCase()
  if (normalized.includes('inv_participant_duplicate') || normalized.includes('ya tiene un rol activo')) {
    return 'El usuario ya tiene un rol activo en esta campaña.'
  }
  if (normalized.includes('inv_campaign_prepared') || normalized.includes('no esta en draft')) {
    return 'La campaña ya fue preparada y no admite cambios de equipo.'
  }
  if (normalized.includes('inv_participant_last_administrator')) {
    return 'La campaña necesita al menos un administrador.'
  }
  if (normalized.includes('inv_participant_has_active_tasks')) {
    return 'El participante tiene tareas activas y no puede ser removido.'
  }
  if (normalized.includes('inv_participant_not_found') || normalized.includes('inv_not_found')) {
    return 'El participante no existe en esta campaña.'
  }
  if (normalized.includes('inv_idempotency_conflict')) {
    return 'La solicitud ya fue procesada con un resultado distinto.'
  }
  if (normalized.includes('permission') || normalized.includes('autoriz')) {
    return 'No tienes permisos para gestionar el equipo de la campaña.'
  }
  return fallback
}

function mapParticipantRow(row: Record<string, unknown>): InventoryCampaignParticipant {
  return {
    participantId: String(row.participant_id ?? ''),
    userId: String(row.user_id ?? ''),
    userName: row.user_name == null ? null : String(row.user_name),
    email: row.email == null ? null : String(row.email),
    userIsActive: Boolean(row.user_is_active),
    participantRole: (row.participant_role as InventoryCampaignParticipantRole) ?? 'COUNTER',
    state: (row.state as InventoryCampaignParticipantState) ?? 'ACTIVE',
    activeFrom: String(row.active_from ?? ''),
    revokedAt: row.revoked_at == null ? null : String(row.revoked_at),
    revocationReason: row.revocation_reason == null ? null : String(row.revocation_reason),
    createdBy: String(row.created_by ?? ''),
  }
}

export async function listInventoryCampaignParticipants(
  companyId: string,
  campaignId: string
): Promise<{ data: InventoryCampaignParticipantsResult | null; error: string | null }> {
  if (!UUID_PATTERN.test(companyId) || !UUID_PATTERN.test(campaignId)) {
    return { data: null, error: 'Los identificadores de la campaña no son válidos.' }
  }
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('list_inventory_campaign_participants', {
      p_company_id: companyId,
      p_campaign_id: campaignId,
    })
    if (error) {
      console.error('list_inventory_campaign_participants error:', error.message)
      return { data: null, error: safeCampaignParticipantError(error.message, 'No se pudo cargar el equipo de la campaña.') }
    }
    const payload = data as { participants?: Record<string, unknown>[]; counts?: Record<string, number> } | null
    const participants = (payload?.participants ?? []).map(mapParticipantRow)
    const counts = {
      counter: Number(payload?.counts?.COUNTER ?? 0),
      supervisor: Number(payload?.counts?.SUPERVISOR ?? 0),
      administrator: Number(payload?.counts?.ADMINISTRATOR ?? 0),
      manager: Number(payload?.counts?.MANAGER ?? 0),
    }
    return { data: { participants, counts }, error: null }
  } catch (err) {
    console.error('listInventoryCampaignParticipants exception:', err)
    return { data: null, error: 'No se pudo cargar el equipo de la campaña.' }
  }
}

export async function addInventoryCampaignParticipant(input: {
  companyId: string
  campaignId: string
  userId: string
  participantRole: InventoryCampaignParticipantRole
  idempotencyKey: string
}): Promise<{ data: InventoryCampaignParticipantOperationEnvelope | null; error: string | null }> {
  const fallback = 'No se pudo agregar al participante.'
  if (!UUID_PATTERN.test(input.companyId) || !UUID_PATTERN.test(input.campaignId) || !UUID_PATTERN.test(input.userId)) {
    return { data: null, error: 'Los identificadores de la campaña o el usuario no son válidos.' }
  }
  if (!CAMPAIGN_PARTICIPANT_ROLES.includes(input.participantRole)) {
    return { data: null, error: 'El rol seleccionado no es válido.' }
  }
  const idempotencyKey = input.idempotencyKey.trim()
  if (!UUID_PATTERN.test(idempotencyKey)) {
    return { data: null, error: 'La clave de idempotencia no es válida.' }
  }
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('add_inventory_campaign_participant', {
      p_company_id: input.companyId,
      p_campaign_id: input.campaignId,
      p_user_id: input.userId,
      p_participant_role: input.participantRole,
      p_idempotency_key: idempotencyKey,
    })
    if (error) {
      console.error('add_inventory_campaign_participant error:', error.message)
      return { data: null, error: safeCampaignParticipantError(error.message, fallback) }
    }
    return { data: data as InventoryCampaignParticipantOperationEnvelope | null, error: null }
  } catch (err) {
    console.error('addInventoryCampaignParticipant exception:', err)
    return { data: null, error: fallback }
  }
}

export async function revokeInventoryCampaignParticipant(input: {
  companyId: string
  campaignId: string
  participantId: string
  reason: string
  idempotencyKey: string
}): Promise<{ data: InventoryCampaignParticipantOperationEnvelope | null; error: string | null }> {
  const fallback = 'No se pudo revocar al participante.'
  if (!UUID_PATTERN.test(input.companyId) || !UUID_PATTERN.test(input.campaignId) || !UUID_PATTERN.test(input.participantId)) {
    return { data: null, error: 'Los identificadores de la campaña o el participante no son válidos.' }
  }
  const reason = input.reason.trim()
  if (reason.length < 5 || reason.length > 500) {
    return { data: null, error: 'El motivo de la revocación debe tener entre 5 y 500 caracteres.' }
  }
  const idempotencyKey = input.idempotencyKey.trim()
  if (!UUID_PATTERN.test(idempotencyKey)) {
    return { data: null, error: 'La clave de idempotencia no es válida.' }
  }
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('revoke_inventory_campaign_participant', {
      p_company_id: input.companyId,
      p_campaign_id: input.campaignId,
      p_participant_id: input.participantId,
      p_reason: reason,
      p_idempotency_key: idempotencyKey,
    })
    if (error) {
      console.error('revoke_inventory_campaign_participant error:', error.message)
      return { data: null, error: safeCampaignParticipantError(error.message, fallback) }
    }
    return { data: data as InventoryCampaignParticipantOperationEnvelope | null, error: null }
  } catch (err) {
    console.error('revokeInventoryCampaignParticipant exception:', err)
    return { data: null, error: fallback }
  }
}

export interface InventoryCampaignUserOption {
  userId: string
  nombre: string
  apellido: string | null
  email: string
}

export async function listInventoryCampaignUserCatalog(
  companyId: string
): Promise<{ data: InventoryCampaignUserOption[] | null; error: string | null }> {
  if (!UUID_PATTERN.test(companyId)) {
    return { data: null, error: 'El identificador de la empresa no es válido.' }
  }
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('list_inventory_campaign_user_catalog', {
      p_company_id: companyId,
    })
    if (error) {
      console.error('list_inventory_campaign_user_catalog error:', error.message)
      return { data: null, error: 'No se pudieron cargar los usuarios de la campaña.' }
    }
    const payload = data as { users?: Record<string, unknown>[] } | null
    const users = (payload?.users ?? []).map(row => ({
      userId: String(row.user_id ?? ''),
      nombre: String(row.nombre ?? ''),
      apellido: row.apellido == null ? null : String(row.apellido),
      email: String(row.email ?? ''),
    }))
    return { data: users, error: null }
  } catch (err) {
    console.error('listInventoryCampaignUserCatalog exception:', err)
    return { data: null, error: 'No se pudieron cargar los usuarios de la campaña.' }
  }
}
