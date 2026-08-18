'use server'

import { createInventariosClient } from '@/lib/supabase/inventarios'
import { getActiveCompanyId } from '@/app/actions/companies'

async function inventariosAdmin() {
  return createInventariosClient()
}

// ---------- Tipos del flujo "Revisar diferencias" / Auditoría ----------

export type AuditVarianceStatus = 'FALTANTE' | 'SOBRANTE'
export type AuditCoverageStatus = 'COUNTED' | 'NOT_COUNTED' | 'OUT_OF_SNAPSHOT'
export type AuditScopeStatus = 'LOCATIONS_RESOLVED' | 'NO_PREVIOUS_LOCATION'

export interface AuditCandidateItem {
  product_key: string
  bsale_variant_id: number
  product_id: string | null
  sku: string | null
  name: string | null
  theoretical_quantity: number
  physical_quantity: number
  difference_quantity: number
  unit_cost: number | null
  difference_value: number | null
  variance_status: AuditVarianceStatus
  coverage_status: AuditCoverageStatus
  scope_status: AuditScopeStatus
  audit_id: string | null
  audit_number: number | null
  audit_status: string | null
  auditor_user_id: string | null
  auditor_name: string | null
  selectable: boolean
}

export interface AuditCandidateSummary {
  total_differences: number
  faltantes: number
  sobrantes: number
  audited_products: number
}

export interface ActiveAuditSummary {
  audit_id: string
  audit_number: number
  status: string
  assigned_user_id: string
  auditor_name: string | null
  product_count: number
  location_count: number
  search_scope_count: number
  created_at: string
  created_by: string
}

export interface InventoryAuditDetailLocation {
  audit_location_id: string
  location_code: string | null
  location_name: string | null
  status: 'PENDING' | 'COUNTED'
  physical_quantity: number | null
  captured_at: string | null
}

export interface InventoryAuditDetailProduct {
  audit_product_id: string
  bsale_variant_id: number
  sku: string | null
  name: string | null
  status: string
  scope_status: string
  variance_status: string
  theoretical_quantity: number
  physical_quantity: number
  difference_quantity: number
  difference_value: number | null
  counted_location_count: number
  location_count: number
  locations: InventoryAuditDetailLocation[]
}

export interface InventoryAuditDetail {
  audit: {
    audit_id: string
    audit_number: number
    campaign_id: string
    status: string
    assigned_user_id: string
    auditor_name: string | null
    created_at: string
    started_at: string | null
    submitted_at: string | null
  }
  product_count: number
  location_count: number
  counted_location_count: number
  pending_location_count: number
  products: InventoryAuditDetailProduct[]
}

export interface AuditCandidatesResult {
  campaign_id: string
  campaign_status: string
  summary: AuditCandidateSummary
  total: number
  page: number
  page_size: number
  has_more: boolean
  items: AuditCandidateItem[]
  active_audits: ActiveAuditSummary[]
}

export interface EligibleAuditParticipant {
  participant_id: string
  user_id: string
  user_name: string | null
  email: string | null
  participant_role: string
  active_from: string
  created_by: string
}

export interface EligibleAuditParticipantsResult {
  campaign_id: string
  participants: EligibleAuditParticipant[]
}

export interface AuditProductCreationMeta {
  bsale_variant_id: number
  variance_status: AuditVarianceStatus
  difference_quantity: number
  scope_status: AuditScopeStatus
  location_count: number
  search_scope_count: number
}

// Ambito administrativo de busqueda para productos NO_PREVIOUS_LOCATION:
// seccion (session) del Inventario + una o varias zonas de esa seccion.
export interface AuditSearchScopeInput {
  bsale_variant_id: number
  session_id: string
  zone_ids: string[]
}

// Seccion/zona disponible para elegir un ambito de busqueda (contrato read-only).
export interface AuditSearchScopeSection {
  session_id: string
  session_number: number
  session_name: string
  inventory_site_id: string | null
  site_name: string | null
  zones: {
    zone_id: string
    zone_code: string
    zone_name: string
  }[]
}

export interface AuditSearchScopesResult {
  campaign_id: string
  sections: AuditSearchScopeSection[]
}

export interface AuditCreateResult {
  audit_id: string
  audit_number: number
  campaign_id: string
  assigned_participant_id: string
  assigned_user_id: string
  products: AuditProductCreationMeta[]
}

export type AuditSortBy =
  | 'SKU'
  | 'NAME'
  | 'VARIANCE_STATUS'
  | 'THEORETICAL'
  | 'PHYSICAL'
  | 'DIFFERENCE'

export type AuditSortDirection = 'ASC' | 'DESC'

// ---------- Llamadas RPC ----------

export async function getAuditCandidates(
  companyId: string,
  campaignId: string,
  filters: {
    search?: string
    variance_status?: AuditVarianceStatus | ''
    page?: number
    page_size?: number
    sort_by?: AuditSortBy | ''
    sort_direction?: AuditSortDirection | ''
  } = {}
): Promise<{ data: AuditCandidatesResult | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('list_inventory_audit_candidates', {
      p_company_id: companyId,
      p_campaign_id: campaignId,
      p_search: filters.search ?? '',
      p_variance_status: filters.variance_status ?? '',
      p_page: filters.page ?? 1,
      p_page_size: filters.page_size ?? 50,
      p_sort_by: filters.sort_by ?? 'SKU',
      p_sort_direction: filters.sort_direction ?? 'ASC',
    })
    if (error) {
      console.error('list_inventory_audit_candidates error:', error.message)
      return { data: null, error: 'No se pudieron cargar los productos con diferencia.' }
    }
    return { data: data as AuditCandidatesResult, error: null }
  } catch (err) {
    console.error('list_inventory_audit_candidates exception:', err)
    return { data: null, error: 'No se pudieron cargar los productos con diferencia.' }
  }
}

export async function getActiveCompanyAuditCandidates(
  campaignId: string,
  filters: {
    search?: string
    variance_status?: AuditVarianceStatus | ''
    page?: number
    page_size?: number
    sort_by?: AuditSortBy | ''
    sort_direction?: AuditSortDirection | ''
  } = {}
): Promise<{ data: AuditCandidatesResult | null; error: string | null; companyId: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  const result = await getAuditCandidates(companyId, campaignId, filters)
  return { ...result, companyId }
}

export async function getInventoryAuditDetail(
  companyId: string,
  campaignId: string,
  auditId: string
): Promise<{ data: InventoryAuditDetail | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('get_inventory_audit_detail', {
      p_company_id: companyId,
      p_campaign_id: campaignId,
      p_audit_id: auditId,
    })
    if (error) {
      console.error('get_inventory_audit_detail error:', error.message)
      return { data: null, error: 'No se pudo cargar el detalle de la auditoría.' }
    }
    return { data: data as InventoryAuditDetail, error: null }
  } catch (err) {
    console.error('get_inventory_audit_detail exception:', err)
    return { data: null, error: 'No se pudo cargar el detalle de la auditoría.' }
  }
}

export async function getAuditEligibleParticipants(
  companyId: string,
  campaignId: string
): Promise<{ data: EligibleAuditParticipantsResult | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('list_inventory_audit_eligible_participants', {
      p_company_id: companyId,
      p_campaign_id: campaignId,
    })
    if (error) {
      console.error('list_inventory_audit_eligible_participants error:', error.message)
      return { data: null, error: 'No se pudieron cargar los participantes aptos.' }
    }
    return { data: data as EligibleAuditParticipantsResult, error: null }
  } catch (err) {
    console.error('list_inventory_audit_eligible_participants exception:', err)
    return { data: null, error: 'No se pudieron cargar los participantes aptos.' }
  }
}

export async function getActiveCompanyAuditEligibleParticipants(
  campaignId: string
): Promise<{ data: EligibleAuditParticipantsResult | null; error: string | null; companyId: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  const result = await getAuditEligibleParticipants(companyId, campaignId)
  return { ...result, companyId }
}

export async function getAuditSearchScopes(
  companyId: string,
  campaignId: string
): Promise<{ data: AuditSearchScopesResult | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('list_inventory_audit_search_scopes', {
      p_company_id: companyId,
      p_campaign_id: campaignId,
    })
    if (error) {
      console.error('list_inventory_audit_search_scopes error:', error.message)
      return { data: null, error: 'No se pudieron cargar las secciones y zonas disponibles.' }
    }
    return { data: data as AuditSearchScopesResult, error: null }
  } catch (err) {
    console.error('list_inventory_audit_search_scopes exception:', err)
    return { data: null, error: 'No se pudieron cargar las secciones y zonas disponibles.' }
  }
}

export async function getActiveCompanyAuditSearchScopes(
  campaignId: string
): Promise<{ data: AuditSearchScopesResult | null; error: string | null; companyId: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  const result = await getAuditSearchScopes(companyId, campaignId)
  return { ...result, companyId }
}

export async function createInventoryAudit(input: {
  companyId: string
  campaignId: string
  assignedParticipantId: string
  bsaleVariantIds: number[]
  idempotencyKey: string
  searchScopes?: AuditSearchScopeInput[]
}): Promise<{ data: AuditCreateResult | null; error: string | null; businessCode?: string }> {
  if (!input.assignedParticipantId || input.bsaleVariantIds.length === 0) {
    return { data: null, error: 'Debes seleccionar productos y un auditor.' }
  }
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('create_inventory_audit', {
      p_company_id: input.companyId,
      p_campaign_id: input.campaignId,
      p_assigned_participant_id: input.assignedParticipantId,
      p_bsale_variant_ids: input.bsaleVariantIds,
      p_idempotency_key: input.idempotencyKey,
      p_search_scopes: input.searchScopes ?? [],
    })
    if (error) {
      console.error('create_inventory_audit error:', error.message)
      return { data: null, error: safeAuditError(error.message), businessCode: auditBusinessCode(error.message) }
    }
    const envelope = data as
      | { entity_id?: string; state?: string; data?: AuditCreateResult }
      | undefined
    const payload = envelope?.data
    if (!envelope?.entity_id || !payload?.audit_id) {
      return { data: null, error: 'La auditoría no se pudo crear correctamente.' }
    }
    return { data: payload, error: null }
  } catch (err) {
    console.error('create_inventory_audit exception:', err)
    return { data: null, error: 'No se pudo crear la auditoría.' }
  }
}

export async function getActiveCompanyCreateAudit(input: {
  campaignId: string
  assignedParticipantId: string
  bsaleVariantIds: number[]
  idempotencyKey: string
  searchScopes?: AuditSearchScopeInput[]
}): Promise<{ data: AuditCreateResult | null; error: string | null; businessCode?: string }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.' }
  }
  return createInventoryAudit({
    companyId,
    campaignId: input.campaignId,
    assignedParticipantId: input.assignedParticipantId,
    bsaleVariantIds: input.bsaleVariantIds,
    idempotencyKey: input.idempotencyKey,
    searchScopes: input.searchScopes,
  })
}

// ---------- Helpers de error ----------

function auditBusinessCode(message: string): string | undefined {
  const normalized = message.toLowerCase()
  if (normalized.includes('inv_audit_product_already_assigned')) return 'PRODUCT_ALREADY_ASSIGNED'
  if (normalized.includes('inv_audit_participant_not_eligible')) return 'PARTICIPANT_NOT_ELIGIBLE'
  if (normalized.includes('inv_audit_product_no_difference')) return 'PRODUCT_NO_DIFFERENCE'
  if (normalized.includes('inv_audit_product_not_found')) return 'PRODUCT_NOT_FOUND'
  if (normalized.includes('inv_audit_search_scope_required')) return 'SEARCH_SCOPE_REQUIRED'
  if (normalized.includes('inv_audit_search_scope_invalid')) return 'SEARCH_SCOPE_INVALID'
  if (normalized.includes('inv_campaign_cancelled')) return 'CAMPAIGN_CANCELLED'
  if (normalized.includes('inv_permission_required')) return 'PERMISSION_REQUIRED'
  if (normalized.includes('inv_idempotency_conflict')) return 'IDEMPOTENCY_CONFLICT'
  return undefined
}

function safeAuditError(message: string): string {
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
  if (normalized.includes('inv_audit_product_already_assigned')) {
    return 'Uno de los productos seleccionados ya tiene una auditoría activa.'
  }
  if (normalized.includes('inv_audit_participant_not_eligible')) {
    return 'El participante seleccionado no está activo o no es apto para realizar el conteo.'
  }
  if (normalized.includes('inv_audit_product_no_difference')) {
    return 'Uno de los productos seleccionados no tiene diferencia y no puede auditarse.'
  }
  if (normalized.includes('inv_audit_product_not_found')) {
    return 'Uno de los productos seleccionados no existe en el resultado del inventario.'
  }
  if (normalized.includes('inv_audit_search_scope_required')) {
    return 'El producto sin ubicación previa requiere definir un ámbito de búsqueda (sección y zona).'
  }
  if (normalized.includes('inv_audit_search_scope_invalid')) {
    return 'El ámbito de búsqueda seleccionado no pertenece al inventario o no es válido.'
  }
  if (normalized.includes('inv_campaign_cancelled')) {
    return 'El inventario está cancelado y no admite nuevas auditorías.'
  }
  if (normalized.includes('inv_permission_required')) {
    return 'No tienes permisos para crear auditorías en este inventario.'
  }
  return 'No se pudo crear la auditoría.'
}
