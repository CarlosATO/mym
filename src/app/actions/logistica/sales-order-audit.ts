'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getActiveCompanyId } from '@/app/actions/companies'
import { isAuditIncidentType, type AuditIncidentType } from '@/modules/logistica/auditoria/audit-policy'
import { AUDIT_EVIDENCE_BUCKET, auditEvidenceExtension, resolveAuditEvidenceMime } from '@/modules/logistica/auditoria/audit-ui-utils'

export type SalesOrderAudit = {
  id: string
  company_id: string
  card_id: string
  bsale_nv_id: number
  bsale_nv_folio: string | null
  cycle_no: number
  status: 'OPEN' | 'CLOSED' | 'COMPLETED'
  assigned_auditor_user_id: string | null
  locked_by_user_id: string | null
  locked_at: string | null
  prepared_by_user_id_snapshot: string | null
  package_count: number | null
  started_at: string
  completed_at: string | null
  created_by: string
  created_at: string
  updated_at: string
  preparer_name?: string | null
  auditor_name?: string | null
  locked_by_name?: string | null
}

export type SalesOrderAuditLine = {
  id: string
  company_id: string
  audit_id: string
  card_id: string
  preparation_line_id: string
  bsale_detail_id: number
  bsale_variant_id: number | null
  sku: string | null
  product_name: string
  requested_quantity_snapshot: number
  prepared_quantity_snapshot: number
  excluded_from_dispatch_snapshot: boolean
  audit_quantity: number | null
  line_status: 'PENDING' | 'CONFIRMED' | 'INCIDENT'
  confirmed_by: string | null
  confirmed_at: string | null
  created_at: string
  updated_at: string
}

export type SalesOrderAuditIncident = {
  id: string
  company_id: string
  audit_id: string
  audit_line_id: string
  card_id: string
  preparation_line_id: string
  requested_quantity_snapshot: number
  prepared_quantity_snapshot: number
  audit_quantity: number
  difference_vs_prepared: number
  incident_type: AuditIncidentType
  observation: string | null
  status: 'OPEN' | 'RESOLVED' | 'SUPERSEDED'
  detected_by: string
  detected_at: string
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type SalesOrderAuditAttachment = {
  id: string
  company_id: string
  audit_id: string
  audit_line_id: string | null
  incident_id: string | null
  attachment_type: 'INCIDENT_EVIDENCE' | 'GLOBAL_DISPATCH_PHOTO'
  storage_bucket: string
  storage_path: string
  file_name: string
  mime_type: string
  file_size: number
  uploaded_by: string
  uploaded_at: string
  metadata: Record<string, unknown>
  created_at: string
}

export type SalesOrderAuditDetail = {
  audit: SalesOrderAudit | null
  lines: SalesOrderAuditLine[]
  incidents: SalesOrderAuditIncident[]
  attachments: SalesOrderAuditAttachment[]
}

export type SalesOrderAuditTakeResult = {
  audit_id: string
  card_id: string
  company_id: string
  status: string
  cycle_no: number
  assigned_auditor_user_id: string | null
  auditor_name: string | null
  locked_by_user_id: string | null
  locked_at: string | null
  prepared_by_user_id: string | null
  preparer_name: string | null
  line_count: number
  package_count: number | null
  event: 'AUDIT_LOCK_CLAIM' | 'AUDIT_LOCK_TAKEOVER' | 'AUDIT_LOCK_ALREADY_OWNED'
}

export type SalesOrderAuditConfirmResult = {
  line: SalesOrderAuditLine
  incident: SalesOrderAuditIncident | null
  incident_type: AuditIncidentType | null
  difference_vs_prepared: number
}

export type SalesOrderAuditFinalizationBlocker = {
  code: string
  message: string
  count?: number
}

export type SalesOrderAuditFinalization = {
  can_finalize: boolean
  audit_id: string
  package_count: number | null
  blockers: SalesOrderAuditFinalizationBlocker[]
}

export type SalesOrderAuditFinalizeResult = {
  audit_id: string
  card_id: string
  company_id: string
  audit_status: 'COMPLETED'
  card_status: 'AUDITED'
  completed_at: string
  package_count: number
  assigned_auditor_user_id: string | null
  auditor_name: string | null
  prepared_by_user_id: string | null
  locked_by_user_id: null
  locked_at: null
  has_global_dispatch_photo: boolean
}

async function requireAuditUser(companyIdOverride?: string | null) {
  const supabase = await createClient()

  // Fast path para mutaciones de Auditoría: el cliente ya conoce la empresa
  // de la tarjeta. El RPC SECURITY DEFINER revalida auth.uid(),
  // core.has_company_access, tarjeta IN_AUDIT, sesión OPEN y ownership del lock.
  // Evita auth.getUser() + getActiveCompanyId() en el camino caliente.
  if (companyIdOverride) {
    return { supabase, companyId: companyIdOverride, error: null }
  }

  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) {
    return { supabase, companyId: null, error: 'No autorizado' }
  }
  const companyId = await getActiveCompanyId(user)
  if (!companyId) {
    return { supabase, companyId: null, error: 'No se pudo determinar la empresa activa' }
  }
  return { supabase, companyId, error: null }
}

export async function getSalesOrderAuditDetail(
  cardId: string,
  companyIdOverride?: string | null,
): Promise<{ data: SalesOrderAuditDetail | null; error: string | null }> {
  try {
    const { supabase, companyId, error: authError } = await requireAuditUser(companyIdOverride)
    if (authError || !companyId) return { data: null, error: authError }

    const { data, error } = await supabase
      .schema('logistica')
      .rpc('get_sales_order_audit_detail', {
        p_company_id: companyId,
        p_card_id: cardId,
        p_cycle_no: 1,
      })

    if (error) {
      console.error('[getSalesOrderAuditDetail] RPC error', { cardId, message: error.message })
      return { data: null, error: error.message }
    }

    return { data: data as SalesOrderAuditDetail, error: null }
  } catch (err: unknown) {
    console.error('[getSalesOrderAuditDetail] Exception:', err)
    return { data: null, error: err instanceof Error ? err.message : 'Error desconocido' }
  }
}

export async function takeSalesOrderAudit(params: {
  cardId: string
  reason?: string | null
}): Promise<{ data: SalesOrderAuditTakeResult | null; error: string | null }> {
  try {
    const { supabase, companyId, error: authError } = await requireAuditUser()
    if (authError || !companyId) return { data: null, error: authError }

    const { data, error } = await supabase
      .schema('logistica')
      .rpc('take_sales_order_audit', {
        p_company_id: companyId,
        p_card_id: params.cardId,
        p_reason: params.reason?.trim() || null,
      })

    if (error) {
      console.error('[takeSalesOrderAudit] RPC error', { cardId: params.cardId, message: error.message })
      return { data: null, error: error.message }
    }

    return { data: data as SalesOrderAuditTakeResult, error: null }
  } catch (err: unknown) {
    console.error('[takeSalesOrderAudit] Exception:', err)
    return { data: null, error: err instanceof Error ? err.message : 'Error desconocido' }
  }
}

export async function confirmSalesOrderAuditLine(params: {
  auditLineId: string
  auditQuantity: number
  incidentType?: AuditIncidentType | string | null
  observation?: string | null
  companyId?: string | null
}): Promise<{ data: SalesOrderAuditConfirmResult | null; error: string | null }> {
  const startedAt = performance.now()
  try {
    if (!Number.isFinite(params.auditQuantity) || params.auditQuantity < 0) {
      return { data: null, error: 'La cantidad auditada debe ser mayor o igual a 0.' }
    }

    const rawIncidentType = typeof params.incidentType === 'string'
      ? params.incidentType.trim().toUpperCase()
      : ''
    if (rawIncidentType && !isAuditIncidentType(rawIncidentType)) {
      return { data: null, error: 'Tipo de incidencia de auditoría inválido.' }
    }
    if (rawIncidentType === 'PRODUCT_NOT_FOUND' && params.auditQuantity > 0) {
      return { data: null, error: 'PRODUCT_NOT_FOUND sólo es válido con cantidad auditada 0.' }
    }
    if (rawIncidentType === 'OTHER' && !params.observation?.trim()) {
      return { data: null, error: 'La observación es obligatoria para la incidencia OTRO.' }
    }

    const contextStartedAt = performance.now()
    const { supabase, companyId, error: authError } = await requireAuditUser(params.companyId)
    const contextMs = performance.now() - contextStartedAt
    if (authError || !companyId) return { data: null, error: authError }

    const rpcStartedAt = performance.now()
    const { data, error } = await supabase
      .schema('logistica')
      .rpc('confirm_sales_order_audit_line', {
        p_company_id: companyId,
        p_audit_line_id: params.auditLineId,
        p_audit_quantity: params.auditQuantity,
        p_incident_type: rawIncidentType || null,
        p_observation: params.observation?.trim() || null,
      })

    const rpcMs = performance.now() - rpcStartedAt
    if (process.env.NODE_ENV !== 'production') {
      console.debug('[audit-confirm][server]', {
        contextMs: Math.round(contextMs * 10) / 10,
        rpcMs: Math.round(rpcMs * 10) / 10,
        totalMs: Math.round((performance.now() - startedAt) * 10) / 10,
        fastPath: Boolean(params.companyId),
        ok: !error,
      })
    }

    if (error) {
      console.error('[confirmSalesOrderAuditLine] RPC error', {
        auditLineId: params.auditLineId,
        message: error.message,
      })
      return { data: null, error: error.message }
    }

    return { data: data as SalesOrderAuditConfirmResult, error: null }
  } catch (err: unknown) {
    console.error('[confirmSalesOrderAuditLine] Exception:', err)
    return { data: null, error: err instanceof Error ? err.message : 'Error desconocido' }
  }
}

export async function setSalesOrderAuditPackageCount(params: {
  auditId: string
  packageCount: number
}): Promise<{ data: SalesOrderAudit | null; error: string | null }> {
  try {
    if (!Number.isInteger(params.packageCount) || params.packageCount < 0) {
      return { data: null, error: 'La cantidad de bultos no puede ser negativa.' }
    }

    const { supabase, companyId, error: authError } = await requireAuditUser()
    if (authError || !companyId) return { data: null, error: authError }

    const { data, error } = await supabase
      .schema('logistica')
      .rpc('set_sales_order_audit_package_count', {
        p_company_id: companyId,
        p_audit_id: params.auditId,
        p_package_count: params.packageCount,
      })

    if (error) {
      console.error('[setSalesOrderAuditPackageCount] RPC error', {
        auditId: params.auditId,
        message: error.message,
      })
      return { data: null, error: error.message }
    }

    return { data: data as SalesOrderAudit, error: null }
  } catch (err: unknown) {
    console.error('[setSalesOrderAuditPackageCount] Exception:', err)
    return { data: null, error: err instanceof Error ? err.message : 'Error desconocido' }
  }
}

export async function registerSalesOrderAuditAttachment(params: {
  auditId: string
  attachmentType: 'INCIDENT_EVIDENCE' | 'GLOBAL_DISPATCH_PHOTO'
  storagePath: string
  fileName: string
  mimeType: string
  fileSize: number
  incidentId?: string | null
  auditLineId?: string | null
}): Promise<{ data: SalesOrderAuditAttachment | null; error: string | null }> {
  try {
    if (!Number.isInteger(params.fileSize) || params.fileSize <= 0 || params.fileSize > 10485760) {
      return { data: null, error: 'El tamaño del archivo debe estar entre 1 byte y 10 MB.' }
    }

    const { supabase, companyId, error: authError } = await requireAuditUser()
    if (authError || !companyId) return { data: null, error: authError }

    const { data, error } = await supabase
      .schema('logistica')
      .rpc('register_sales_order_audit_attachment', {
        p_company_id: companyId,
        p_audit_id: params.auditId,
        p_attachment_type: params.attachmentType,
        p_storage_path: params.storagePath,
        p_file_name: params.fileName,
        p_mime_type: params.mimeType,
        p_file_size: params.fileSize,
        p_incident_id: params.incidentId ?? null,
        p_audit_line_id: params.auditLineId ?? null,
      })

    if (error) {
      console.error('[registerSalesOrderAuditAttachment] RPC error', {
        auditId: params.auditId,
        attachmentType: params.attachmentType,
        message: error.message,
      })
      return { data: null, error: error.message }
    }

    return { data: data as SalesOrderAuditAttachment, error: null }
  } catch (err: unknown) {
    console.error('[registerSalesOrderAuditAttachment] Exception:', err)
    return { data: null, error: err instanceof Error ? err.message : 'Error desconocido' }
  }
}

export async function getSalesOrderAuditFinalizationStatus(
  auditId: string,
): Promise<{ data: SalesOrderAuditFinalization | null; error: string | null }> {
  try {
    const { supabase, companyId, error: authError } = await requireAuditUser()
    if (authError || !companyId) return { data: null, error: authError }

    const { data, error } = await supabase
      .schema('logistica')
      .rpc('can_finalize_sales_order_audit', {
        p_company_id: companyId,
        p_audit_id: auditId,
      })

    if (error) {
      console.error('[getSalesOrderAuditFinalizationStatus] RPC error', {
        auditId,
        message: error.message,
      })
      return { data: null, error: error.message }
    }

    return { data: data as SalesOrderAuditFinalization, error: null }
  } catch (err: unknown) {
    console.error('[getSalesOrderAuditFinalizationStatus] Exception:', err)
    return { data: null, error: err instanceof Error ? err.message : 'Error desconocido' }
  }
}

export async function finalizeSalesOrderAudit(params: {
  auditId: string
  cardId: string
  companyId?: string | null
}): Promise<{ data: SalesOrderAuditFinalizeResult | null; error: string | null }> {
  try {
    const { supabase, companyId, error: authError } = await requireAuditUser(params.companyId)
    if (authError || !companyId) return { data: null, error: authError }

    const { data, error } = await supabase
      .schema('logistica')
      .rpc('finalize_sales_order_audit', {
        p_company_id: companyId,
        p_card_id: params.cardId,
        p_audit_id: params.auditId,
      })

    if (error) {
      console.error('[finalizeSalesOrderAudit] RPC error', {
        auditId: params.auditId,
        cardId: params.cardId,
        message: error.message,
      })
      return { data: null, error: error.message }
    }

    return { data: data as SalesOrderAuditFinalizeResult, error: null }
  } catch (err: unknown) {
    console.error('[finalizeSalesOrderAudit] Exception:', err)
    return { data: null, error: err instanceof Error ? err.message : 'Error desconocido' }
  }
}

export type AuditBoardLock = {
  card_id: string
  assigned_auditor_user_id: string | null
  assigned_auditor_user_name: string | null
  locked_by_user_id: string | null
  locked_by_user_name: string | null
  locked_at: string | null
}

export async function getSalesOrderAuditBoardLocks(
  cardIds: string[],
): Promise<{ data: Record<string, AuditBoardLock>; error: string | null }> {
  const ids = [...new Set(cardIds.filter(Boolean))]
  if (ids.length === 0) return { data: {}, error: null }

  try {
    const { supabase, companyId, error: authError } = await requireAuditUser()
    if (authError || !companyId) return { data: {}, error: authError }

    const { data, error } = await supabase
      .schema('logistica')
      .from('sales_order_audits')
      .select('card_id, assigned_auditor_user_id, locked_by_user_id, locked_at')
      .eq('company_id', companyId)
      .eq('status', 'OPEN')
      .in('card_id', ids)

    if (error) {
      console.error('[getSalesOrderAuditBoardLocks] query error', error.message)
      return { data: {}, error: error.message }
    }

    const rows = (data ?? []) as Array<{
      card_id: string
      assigned_auditor_user_id: string | null
      locked_by_user_id: string | null
      locked_at: string | null
    }>

    const userIds = [...new Set(rows.flatMap(row => [row.assigned_auditor_user_id, row.locked_by_user_id]).filter((id): id is string => Boolean(id)))]
    const nameById = new Map<string, string>()

    if (userIds.length > 0) {
      const { data: users, error: usersError } = await createAdminClient()
        .from('users')
        .select('id, nombre, apellido')
        .in('id', userIds)

      if (usersError) {
        console.error('[getSalesOrderAuditBoardLocks] users error', usersError)
      } else {
        for (const user of users ?? []) {
          const name = `${user.nombre ?? ''} ${user.apellido ?? ''}`.trim()
          if (name) nameById.set(String(user.id), name)
        }
      }
    }

    const result: Record<string, AuditBoardLock> = {}
    for (const row of rows) {
      result[row.card_id] = {
        card_id: row.card_id,
        assigned_auditor_user_id: row.assigned_auditor_user_id,
        assigned_auditor_user_name: row.assigned_auditor_user_id ? nameById.get(row.assigned_auditor_user_id) ?? null : null,
        locked_by_user_id: row.locked_by_user_id,
        locked_by_user_name: row.locked_by_user_id ? nameById.get(row.locked_by_user_id) ?? null : null,
        locked_at: row.locked_at,
      }
    }

    return { data: result, error: null }
  } catch (err: unknown) {
    console.error('[getSalesOrderAuditBoardLocks] Exception:', err)
    return { data: {}, error: err instanceof Error ? err.message : 'Error desconocido' }
  }
}

export type SalesOrderAuditEvidenceSignedUrl = {
  signedUrl: string | null
  fileName: string
  mimeType: string
  uploadedAt: string | null
}

export async function getSalesOrderAuditAttachmentSignedUrl(
  attachmentId: string,
): Promise<{ data: SalesOrderAuditEvidenceSignedUrl | null; error: string | null }> {
  try {
    const supabase = await createClient()

    // La RLS de la tabla revalida empresa + logistica.audit.manage.
    // No se expone storage_path como URL pública: se firma temporalmente.
    const { data, error } = await supabase
      .schema('logistica')
      .from('sales_order_audit_attachments')
      .select('storage_bucket, storage_path, file_name, mime_type, uploaded_at')
      .eq('id', attachmentId)
      .maybeSingle()

    if (error) {
      console.error('[getSalesOrderAuditAttachmentSignedUrl] query error', error.message)
      return { data: null, error: error.message }
    }
    if (!data) {
      return { data: null, error: 'Evidencia no encontrada o sin permiso.' }
    }

    const metadata = {
      fileName: data.file_name as string,
      mimeType: data.mime_type as string,
      uploadedAt: (data.uploaded_at as string | null) ?? null,
    }

    if (metadata.mimeType === 'image/heic' || /\.heic$/i.test(metadata.fileName)) {
      return { data: { signedUrl: null, ...metadata }, error: null }
    }

    const { data: signed, error: signedError } = await supabase.storage
      .from(AUDIT_EVIDENCE_BUCKET)
      .createSignedUrl(data.storage_path as string, 300)

    if (signedError || !signed?.signedUrl) {
      console.error('[getSalesOrderAuditAttachmentSignedUrl] sign error', signedError?.message)
      return { data: null, error: signedError?.message || 'No se pudo preparar la vista previa.' }
    }

    return { data: { signedUrl: signed.signedUrl, ...metadata }, error: null }
  } catch (err: unknown) {
    console.error('[getSalesOrderAuditAttachmentSignedUrl] Exception:', err)
    return { data: null, error: err instanceof Error ? err.message : 'Error desconocido' }
  }
}

export async function uploadSalesOrderAuditEvidence(params: {
  auditId: string
  cardId: string
  attachmentType: 'INCIDENT_EVIDENCE' | 'GLOBAL_DISPATCH_PHOTO'
  file: File
  incidentId?: string | null
  auditLineId?: string | null
  companyId?: string | null
}): Promise<{ data: SalesOrderAuditAttachment | null; error: string | null }> {
  try {
    const mimeType = resolveAuditEvidenceMime(params.file.type, params.file.name)
    if (!mimeType) {
      return { data: null, error: 'La fotografía debe ser JPEG, PNG, WEBP o HEIC.' }
    }
    if (!Number.isInteger(params.file.size) || params.file.size <= 0 || params.file.size > 10 * 1024 * 1024) {
      return { data: null, error: 'La fotografía debe pesar entre 1 byte y 10 MB.' }
    }

    const extension = auditEvidenceExtension(mimeType)
    if (!extension) {
      return { data: null, error: 'No se pudo determinar la extensión de la fotografía.' }
    }

    const { supabase, companyId, error: authError } = await requireAuditUser(params.companyId)
    if (authError || !companyId) return { data: null, error: authError }

    const storagePath = `${companyId}/${params.cardId}/${params.auditId}/${crypto.randomUUID()}.${extension}`
    const { error: uploadError } = await supabase.storage
      .from(AUDIT_EVIDENCE_BUCKET)
      .upload(storagePath, params.file, { contentType: mimeType, upsert: false })

    if (uploadError) {
      console.error('[uploadSalesOrderAuditEvidence] upload error', uploadError.message)
      return { data: null, error: uploadError.message }
    }

    const { data, error } = await supabase
      .schema('logistica')
      .rpc('register_sales_order_audit_attachment', {
        p_company_id: companyId,
        p_audit_id: params.auditId,
        p_attachment_type: params.attachmentType,
        p_storage_path: storagePath,
        p_file_name: params.file.name,
        p_mime_type: mimeType,
        p_file_size: params.file.size,
        p_incident_id: params.incidentId ?? null,
        p_audit_line_id: params.auditLineId ?? null,
      })

    if (error) {
      console.error('[uploadSalesOrderAuditEvidence] register error', error.message)
      await supabase.storage.from(AUDIT_EVIDENCE_BUCKET).remove([storagePath])
      return { data: null, error: error.message }
    }

    return { data: data as SalesOrderAuditAttachment, error: null }
  } catch (err: unknown) {
    console.error('[uploadSalesOrderAuditEvidence] Exception:', err)
    return { data: null, error: err instanceof Error ? err.message : 'Error desconocido' }
  }
}
