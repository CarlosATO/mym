'use server'

import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { getActiveCompanyId } from '@/app/actions/companies'

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

function inventariosAdmin() {
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
    db: { schema: 'inventarios' },
    auth: { autoRefreshToken: false, persistSession: false },
  })
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
    const db = inventariosAdmin()
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
    const db = inventariosAdmin()
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
    const db = inventariosAdmin()
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
    const db = inventariosAdmin()
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
