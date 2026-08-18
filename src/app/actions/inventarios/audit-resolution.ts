'use server'

import { createInventariosClient } from '@/lib/supabase/inventarios'
import { getActiveCompanyId } from '@/app/actions/companies'

async function inventariosAdmin() {
  return createInventariosClient()
}

// ---------- Tipos del flujo "Resolución administrativa de auditorías" ----------

export type AuditDecision = 'APPROVE' | 'REJECT'
export type AuditProductResolutionStatus = 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | string

export interface AuditResolvableProduct {
  audit_product_id: string
  bsale_variant_id: number
  product_id: string | null
  sku: string | null
  name: string | null
  product_status: AuditProductResolutionStatus
  scope_status: string
}

export interface AuditResolvableProductsResult {
  company_id: string
  audit_id: string
  audit_number: number
  audit_status: string
  campaign_id: string
  campaign_status: string
  total: number
  items: AuditResolvableProduct[]
}

export interface ResolvableAuditSummary {
  audit_id: string
  audit_number: number
  status: string
  assigned_user_id: string | null
  auditor_name: string | null
  product_count: number
  pending_count: number
  location_count: number
  created_at: string
}

export interface AuditResolvableAuditsResult {
  company_id: string
  campaign_id: string
  campaign_status: string
  total: number
  items: ResolvableAuditSummary[]
}

export interface AuditResolutionLocation {
  audit_location_id: string
  location_code: string | null
  location_name: string | null
  current_effective_quantity: number
  audited_quantity: number | null
  delta: number | null
  replaced_count_entry_ids: string[]
  context_error: string | null
}

export interface AuditResolutionPreview {
  company_id: string
  audit_id: string
  audit_number: number
  audit_status: string
  campaign_id: string
  campaign_status: string
  audit_product_id: string
  bsale_variant_id: number
  sku: string | null
  name: string | null
  product_status: AuditProductResolutionStatus
  scope_status: string
  snapshot: {
    theoretical_quantity: number
    physical_quantity: number
    difference_quantity: number
  }
  auditor: { user_id: string | null; name: string | null }
  submitted_at: string | null
  current_effective_quantity: number
  audited_total: number
  delta: number
  result_if_approved: number
  locations: AuditResolutionLocation[]
  applicable: boolean
  blocking_reason: string | null
}

export interface AuditResolutionResult {
  audit_id: string
  audit_product_id: string
  decision: 'APPROVED' | 'REJECTED'
  reason: string
  resolution_id?: string
  item_count?: number
  synthetic_count_entry_count?: number
  total_audited?: number
  resolved_by: string
  resolved_at: string
  physical_unchanged?: boolean
  affected_official_versions: Array<{ session_id: string; official_version_id: string }>
}

export type AuditResolutionBusinessCode =
  | 'NO_CONTEXT'
  | 'AMBIGUOUS_CONTEXT'
  | 'PERMISSION_REQUIRED'
  | 'ALREADY_RESOLVED'
  | 'SCOPE_UNSUPPORTED'
  | 'CAMPAIGN_STATE'
  | 'RESULTS_INCOMPLETE'
  | 'RECOUNT_PENDING'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_REASON'
  | 'NOT_FOUND'

// ---------- Contrato read-only: productos resolubles de una auditoría ----------

export async function listAuditResolvableProducts(
  companyId: string,
  auditId: string
): Promise<{ data: AuditResolvableProductsResult | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('list_inventory_audit_resolvable_products', {
      p_company_id: companyId,
      p_audit_id: auditId,
    })
    if (error) {
      console.error('list_inventory_audit_resolvable_products error:', error.message)
      if (error.message.toLowerCase().includes('inv_permission_required')) {
        return { data: null, error: 'No tienes permisos para revisar la resolución de auditorías.' }
      }
      return { data: null, error: 'No se pudieron cargar los productos de la auditoría.' }
    }
    return { data: data as AuditResolvableProductsResult, error: null }
  } catch (err) {
    console.error('list_inventory_audit_resolvable_products exception:', err)
    return { data: null, error: 'No se pudieron cargar los productos de la auditoría.' }
  }
}

export async function getActiveCompanyAuditResolvableProducts(
  auditId: string
): Promise<{ data: AuditResolvableProductsResult | null; error: string | null; companyId: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  const result = await listAuditResolvableProducts(companyId, auditId)
  return { ...result, companyId }
}

// ---------- Contrato read-only: auditorías todavía resolubles (SUBMITTED / PARTIALLY_RESOLVED) ----------

export async function listAuditResolvableAudits(
  companyId: string,
  campaignId: string
): Promise<{ data: AuditResolvableAuditsResult | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('list_inventory_audit_resolvable_audits', {
      p_company_id: companyId,
      p_campaign_id: campaignId,
    })
    if (error) {
      console.error('list_inventory_audit_resolvable_audits error:', error.message)
      if (error.message.toLowerCase().includes('inv_permission_required')) {
        return { data: null, error: 'No tienes permisos para revisar la resolución de auditorías.' }
      }
      return { data: null, error: 'No se pudieron cargar las auditorías pendientes de decisión.' }
    }
    return { data: data as AuditResolvableAuditsResult, error: null }
  } catch (err) {
    console.error('list_inventory_audit_resolvable_audits exception:', err)
    return { data: null, error: 'No se pudieron cargar las auditorías pendientes de decisión.' }
  }
}

export async function getActiveCompanyAuditResolvableAudits(
  campaignId: string
): Promise<{ data: AuditResolvableAuditsResult | null; error: string | null; companyId: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  const result = await listAuditResolvableAudits(companyId, campaignId)
  return { ...result, companyId }
}

// ---------- Contrato read-only: preview de resolución por producto ----------

export async function getAuditProductResolutionPreview(
  companyId: string,
  auditId: string,
  auditProductId: string
): Promise<{ data: AuditResolutionPreview | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('preview_inventory_audit_product_resolution', {
      p_company_id: companyId,
      p_audit_id: auditId,
      p_audit_product_id: auditProductId,
    })
    if (error) {
      console.error('preview_inventory_audit_product_resolution error:', error.message)
      if (error.message.toLowerCase().includes('inv_permission_required')) {
        return { data: null, error: 'No tienes permisos para revisar la resolución de auditorías.' }
      }
      return { data: null, error: 'No se pudo cargar la vista previa del producto.' }
    }
    return { data: data as AuditResolutionPreview, error: null }
  } catch (err) {
    console.error('preview_inventory_audit_product_resolution exception:', err)
    return { data: null, error: 'No se pudo cargar la vista previa del producto.' }
  }
}

export async function getActiveCompanyAuditProductResolutionPreview(
  auditId: string,
  auditProductId: string
): Promise<{ data: AuditResolutionPreview | null; error: string | null; companyId: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  const result = await getAuditProductResolutionPreview(companyId, auditId, auditProductId)
  return { ...result, companyId }
}

// ---------- Contrato de mutación: resolver producto (APPROVE / REJECT) ----------

export async function resolveAuditProduct(input: {
  companyId: string
  auditId: string
  auditProductId: string
  decision: AuditDecision
  reason: string | null
  idempotencyKey: string
}): Promise<{ data: AuditResolutionResult | null; error: string | null; businessCode?: AuditResolutionBusinessCode }> {
  if (input.decision === 'REJECT' && (input.reason?.trim().length ?? 0) < 5) {
    return { data: null, error: 'El motivo del rechazo debe tener al menos 5 caracteres.', businessCode: 'INVALID_REASON' }
  }
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('resolve_inventory_audit_product', {
      p_company_id: input.companyId,
      p_audit_id: input.auditId,
      p_audit_product_id: input.auditProductId,
      p_decision: input.decision,
      p_reason: input.decision === 'REJECT' ? input.reason?.trim() : null,
      p_idempotency_key: input.idempotencyKey,
    })
    if (error) {
      console.error('resolve_inventory_audit_product error:', error.message)
      const businessCode = resolutionBusinessCode(error.message)
      return {
        data: null,
        error: resolutionUserMessage(error.message, businessCode, input.decision),
        businessCode,
      }
    }
    const envelope = data as
      | { entity_id?: string; state?: string; data?: AuditResolutionResult }
      | undefined
    if (!envelope?.entity_id || !envelope?.data?.audit_id) {
      return { data: null, error: 'La resolución no se pudo registrar correctamente.' }
    }
    return { data: envelope.data, error: null }
  } catch (err) {
    console.error('resolve_inventory_audit_product exception:', err)
    return {
      data: null,
      error: input.decision === 'APPROVE' ? 'No se pudo aprobar el producto.' : 'No se pudo rechazar el producto.',
    }
  }
}

export async function resolveActiveCompanyAuditProduct(input: {
  auditId: string
  auditProductId: string
  decision: AuditDecision
  reason: string | null
  idempotencyKey: string
}): Promise<{ data: AuditResolutionResult | null; error: string | null; businessCode?: AuditResolutionBusinessCode; companyId: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  const result = await resolveAuditProduct({ ...input, companyId })
  return { ...result, companyId }
}

// ---------- Helpers de error ----------

function resolutionBusinessCode(message: string): AuditResolutionBusinessCode | undefined {
  const normalized = message.toLowerCase()
  if (normalized.includes('inv_audit_resolution_no_context')) return 'NO_CONTEXT'
  if (normalized.includes('inv_audit_resolution_ambiguous_context')) return 'AMBIGUOUS_CONTEXT'
  if (normalized.includes('inv_permission_required')) return 'PERMISSION_REQUIRED'
  if (normalized.includes('inv_audit_product_already_resolved')) return 'ALREADY_RESOLVED'
  if (normalized.includes('inv_audit_product_scope_unsupported')) return 'SCOPE_UNSUPPORTED'
  if (normalized.includes('inv_session_invalid_state')) return 'CAMPAIGN_STATE'
  if (normalized.includes('inv_audit_resolution_incomplete')) return 'RESULTS_INCOMPLETE'
  if (normalized.includes('inv_recount_pending')) return 'RECOUNT_PENDING'
  if (normalized.includes('inv_idempotency_conflict')) return 'IDEMPOTENCY_CONFLICT'
  if (normalized.includes('inv_invalid_request_payload')) return 'INVALID_REASON'
  if (normalized.includes('inv_audit_product_not_found') || normalized.includes('inv_not_found')) return 'NOT_FOUND'
  return undefined
}

function extractDetailMessage(message: string): string | null {
  const idx = message.indexOf('DETAIL:')
  if (idx >= 0) {
    const raw = message.slice(idx + 'DETAIL:'.length).trim()
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw)
        if (parsed?.message && typeof parsed.message === 'string' && parsed.message.trim()) {
          return parsed.message
        }
      } catch {
        // ignore
      }
    }
  }
  return null
}

function resolutionUserMessage(
  raw: string,
  code: AuditResolutionBusinessCode | undefined,
  decision: AuditDecision
): string {
  const detail = extractDetailMessage(raw)
  if (detail) return detail
  switch (code) {
    case 'NO_CONTEXT':
      return 'Este producto no tiene un contexto de ubicación resoluble para reemplazar el conteo. No se puede aprobar; puedes rechazarlo para conservar el físico.'
    case 'AMBIGUOUS_CONTEXT':
      return 'Las contribuciones a reemplazar abarcan más de un contexto de ubicación. No se puede aprobar; puedes rechazarlo para conservar el físico.'
    case 'PERMISSION_REQUIRED':
      return 'No tienes el permiso requerido para resolver esta auditoría (se requiere un usuario SUPER_USUARIO o un Administrador del Inventario).'
    case 'ALREADY_RESOLVED':
      return 'Este producto ya fue resuelto.'
    case 'SCOPE_UNSUPPORTED':
      return 'Este producto sin ubicación previa aún no admite resolución administrativa.'
    case 'CAMPAIGN_STATE':
      return 'El inventario no admite la resolución de auditorías en su estado actual.'
    case 'RESULTS_INCOMPLETE':
      return 'Faltan resultados auditados para este producto.'
    case 'RECOUNT_PENDING':
      return 'Hay un reconteo pendiente en la zona del producto; resuélvelo antes de aprobar.'
    case 'IDEMPOTENCY_CONFLICT':
      return 'La operación ya fue registrada con otra solicitud. Refresca e intenta nuevamente.'
    case 'INVALID_REASON':
      return 'El motivo del rechazo debe tener entre 5 y 1000 caracteres.'
    case 'NOT_FOUND':
      return 'El producto o la auditoría no existe o ya no está disponible.'
    default:
      if (raw.includes('INV_')) {
        return 'No se pudo completar la resolución.'
      }
      return (
        raw ||
        (decision === 'APPROVE' ? 'No se pudo aprobar el producto.' : 'No se pudo rechazar el producto.')
      )
  }
}
