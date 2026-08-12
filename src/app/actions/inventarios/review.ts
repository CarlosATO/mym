'use server'

import { revalidatePath } from 'next/cache'
import { createInventariosClient } from '@/lib/supabase/inventarios'
import { getActiveCompanyId } from '@/app/actions/companies'

async function inventariosAdmin() {
  return createInventariosClient()
}

function makeKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export async function validateInventoryTask(
  companyId: string,
  taskId: string,
  expectedVersion: number,
  expectedCycle: number
): Promise<{ data: { task_id: string } | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { error } = await db.rpc('validate_inventory_task', {
      p_company_id: companyId,
      p_task_id: taskId,
      p_expected_version: expectedVersion,
      p_expected_cycle: expectedCycle,
      p_idempotency_key: makeKey(),
    })
    if (error) {
      console.error('validate_inventory_task error:', error.message)
      return { data: null, error: 'No se pudo validar la tarea.' }
    }
    return { data: { task_id: taskId }, error: null }
  } catch (err) {
    console.error('validate_inventory_task exception:', err)
    return { data: null, error: 'No se pudo validar la tarea.' }
  }
}

export async function invalidateInventoryTask(
  companyId: string,
  taskId: string,
  expectedVersion: number,
  expectedCycle: number,
  reason: string
): Promise<{ data: { task_id: string } | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { error } = await db.rpc('invalidate_inventory_task', {
      p_company_id: companyId,
      p_task_id: taskId,
      p_expected_version: expectedVersion,
      p_expected_cycle: expectedCycle,
      p_reason: reason,
      p_idempotency_key: makeKey(),
    })
    if (error) {
      console.error('invalidate_inventory_task error:', error.message)
      return { data: null, error: 'No se pudo invalidar la tarea.' }
    }
    return { data: { task_id: taskId }, error: null }
  } catch (err) {
    console.error('invalidate_inventory_task exception:', err)
    return { data: null, error: 'No se pudo invalidar la tarea.' }
  }
}

export async function reopenInventoryTask(
  companyId: string,
  taskId: string,
  expectedVersion: number,
  expectedCycle: number,
  reason: string
): Promise<{ data: { task_id: string } | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { error } = await db.rpc('reopen_inventory_task', {
      p_company_id: companyId,
      p_task_id: taskId,
      p_expected_version: expectedVersion,
      p_expected_cycle: expectedCycle,
      p_reason: reason,
      p_idempotency_key: makeKey(),
    })
    if (error) {
      console.error('reopen_inventory_task error:', error.message)
      return { data: null, error: 'No se pudo reabrir la tarea.' }
    }
    return { data: { task_id: taskId }, error: null }
  } catch (err) {
    console.error('reopen_inventory_task exception:', err)
    return { data: null, error: 'No se pudo reabrir la tarea.' }
  }
}

export async function getActiveCompanyReviewFor(
  sessionId: string
): Promise<{ data: import('@/app/actions/inventarios/sessions').InventorySessionReview | null; error: string | null; companyId: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('get_inventory_session_review', {
      p_company_id: companyId,
      p_session_id: sessionId,
    })
    if (error) {
      console.error('get_inventory_session_review error:', error.message)
      return { data: null, error: 'No se pudo cargar la revisión de la jornada.', companyId }
    }
    return { data: data as import('@/app/actions/inventarios/sessions').InventorySessionReview, error: null, companyId }
  } catch (err) {
    console.error('get_inventory_session_review exception:', err)
    return { data: null, error: 'No se pudo cargar la revisión de la jornada.', companyId }
  }
}

export async function resolveInventoryIncident(
  companyId: string,
  incidentId: string,
  expectedStatus: string,
  nextStatus: string,
  expectedResolutionId: string | null,
  resolutionType: string,
  description: string
): Promise<{ data: { incident_id: string } | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { error } = await db.rpc('resolve_inventory_incident', {
      p_company_id: companyId,
      p_incident_id: incidentId,
      p_next_status: nextStatus,
      p_expected_current_status: expectedStatus,
      p_expected_current_resolution_id: expectedResolutionId,
      p_resolution_type: resolutionType,
      p_description: description,
      p_idempotency_key: makeKey(),
    })
    if (error) {
      console.error('resolve_inventory_incident error:', error.message)
      return { data: null, error: 'No se pudo resolver la incidencia.' }
    }
    return { data: { incident_id: incidentId }, error: null }
  } catch (err) {
    console.error('resolve_inventory_incident exception:', err)
    return { data: null, error: 'No se pudo resolver la incidencia.' }
  }
}

export async function requestInventoryRecount(
  companyId: string,
  taskId: string,
  expectedCycle: number,
  snapshotProductId: string,
  sourceCountEntryId: string,
  reason: string
): Promise<{ data: { recount_id: string } | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { error } = await db.rpc('request_inventory_recount', {
      p_company_id: companyId,
      p_task_id: taskId,
      p_expected_cycle: expectedCycle,
      p_snapshot_product_id: snapshotProductId,
      p_source_count_entry_id: sourceCountEntryId,
      p_reason: reason,
      p_idempotency_key: makeKey(),
    })
    if (error) {
      console.error('request_inventory_recount error:', error.message)
      return { data: null, error: 'No se pudo solicitar el recuento.' }
    }
    return { data: { recount_id: '' }, error: null }
  } catch (err) {
    console.error('request_inventory_recount exception:', err)
    return { data: null, error: 'No se pudo solicitar el recuento.' }
  }
}

export async function assignInventoryRecount(
  companyId: string,
  recountRequestId: string,
  expectedStatus: string,
  counterUserId: string
): Promise<{ data: { recount_id: string } | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { error } = await db.rpc('assign_inventory_recount', {
      p_company_id: companyId,
      p_recount_request_id: recountRequestId,
      p_expected_status: expectedStatus,
      p_counter_user_id: counterUserId,
      p_idempotency_key: makeKey(),
    })
    if (error) {
      console.error('assign_inventory_recount error:', error.message)
      return { data: null, error: 'No se pudo asignar el recuento.' }
    }
    return { data: { recount_id: recountRequestId }, error: null }
  } catch (err) {
    console.error('assign_inventory_recount exception:', err)
    return { data: null, error: 'No se pudo asignar el recuento.' }
  }
}

export async function cancelInventoryRecount(
  companyId: string,
  recountRequestId: string,
  expectedStatus: string,
  reason: string
): Promise<{ data: { recount_id: string } | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { error } = await db.rpc('cancel_inventory_recount', {
      p_company_id: companyId,
      p_recount_request_id: recountRequestId,
      p_expected_status: expectedStatus,
      p_reason: reason,
      p_idempotency_key: makeKey(),
    })
    if (error) {
      console.error('cancel_inventory_recount error:', error.message)
      return { data: null, error: 'No se pudo cancelar el recuento.' }
    }
    return { data: { recount_id: recountRequestId }, error: null }
  } catch (err) {
    console.error('cancel_inventory_recount exception:', err)
    return { data: null, error: 'No se pudo cancelar el recuento.' }
  }
}

export async function decideInventoryRecount(
  companyId: string,
  recountRequestId: string,
  selectedCountEntryId: string,
  justification: string,
  confidenceScore: number | null,
  expectedCurrentDecisionId: string | null
): Promise<{ data: { recount_id: string } | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { error } = await db.rpc('decide_inventory_recount', {
      p_company_id: companyId,
      p_recount_request_id: recountRequestId,
      p_expected_status: 'COMPLETED',
      p_selected_count_entry_id: selectedCountEntryId,
      p_justification: justification,
      p_confidence_score: confidenceScore,
      p_expected_current_decision_id: expectedCurrentDecisionId,
      p_idempotency_key: makeKey(),
    })
    if (error) {
      console.error('decide_inventory_recount error:', error.message)
      return { data: null, error: 'No se pudo decidir el recuento.' }
    }
    return { data: { recount_id: recountRequestId }, error: null }
  } catch (err) {
    console.error('decide_inventory_recount exception:', err)
    return { data: null, error: 'No se pudo decidir el recuento.' }
  }
}

export async function approveInventorySession(
  companyId: string,
  sessionId: string,
  idempotencyKey: string
): Promise<{ data: { session_id: string; state: string } | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { error } = await db.rpc('approve_inventory_session', {
      p_company_id: companyId,
      p_session_id: sessionId,
      p_idempotency_key: idempotencyKey,
    })
    if (error) {
      console.error('approve_inventory_session error:', error.message)
      return { data: null, error: 'No se pudo aprobar la jornada.' }
    }
    return { data: { session_id: sessionId, state: 'APPROVED' }, error: null }
  } catch (err) {
    console.error('approve_inventory_session exception:', err)
    return { data: null, error: 'No se pudo aprobar la jornada.' }
  }
}

export interface CancelSessionTechnicalError {
  code: string | null
  message: string | null
  details: string | null
  hint: string | null
}

export async function cancelInventorySession(
  companyId: string,
  sessionId: string,
  reason: string,
  idempotencyKey: string
): Promise<{
  data: { session_id: string; state: string } | null
  error: string | null
  errorTechnical?: CancelSessionTechnicalError | null
}> {
  try {
    const db = await inventariosAdmin()
    const { error } = await db.rpc('cancel_inventory_session', {
      p_company_id: companyId,
      p_session_id: sessionId,
      p_reason: reason,
      p_idempotency_key: idempotencyKey,
    })
    if (error) {
      const technical: CancelSessionTechnicalError = {
        code: typeof error.code === 'string' && error.code ? error.code : null,
        message: typeof error.message === 'string' && error.message ? error.message : null,
        details: typeof error.details === 'string' && error.details ? error.details : null,
        hint: typeof error.hint === 'string' && error.hint ? error.hint : null,
      }
      console.error('cancel_inventory_session error', {
        session_id: sessionId,
        company_id: companyId,
        code: technical.code,
        message: technical.message,
        details: technical.details,
        hint: technical.hint,
      })
      return { data: null, error: 'No se pudo cancelar la sección de conteo.', errorTechnical: technical }
    }
    revalidatePath('/dashboard/inventarios/jornadas')
    revalidatePath(`/dashboard/inventarios/jornadas/${sessionId}`)
    return { data: { session_id: sessionId, state: 'CANCELLED' }, error: null }
  } catch (err) {
    console.error('cancel_inventory_session exception:', err)
    return { data: null, error: 'No se pudo cancelar la sección de conteo.' }
  }
}
