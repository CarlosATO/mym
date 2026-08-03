'use server'

import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { getActiveCompanyId } from '@/app/actions/companies'
import type { InventoryParticipant, InventorySessionSetupResult, InventorySessionTask, InventorySessionZone } from '@/app/actions/inventarios/sessions'

export interface TasksSetup {
  zones: InventorySessionZone[]
  tasks: InventorySessionTask[]
  participants: InventoryParticipant[]
  indicators: InventorySessionSetupResult['indicators']
}

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

export async function createInventoryTask(
  companyId: string,
  sessionId: string,
  sessionZoneId: string,
  counterUserId: string
): Promise<{ data: { task_id: string } | null; error: string | null }> {
  try {
    const db = inventariosAdmin()
    const { error } = await db.rpc('create_inventory_task', {
      p_company_id: companyId,
      p_session_id: sessionId,
      p_session_zone_id: sessionZoneId,
      p_counter_user_id: counterUserId,
      p_idempotency_key: makeKey(),
    })
    if (error) {
      console.error('create_inventory_task error:', error.message)
      return { data: null, error: 'No se pudo crear la tarea.' }
    }
    return { data: { task_id: '' }, error: null }
  } catch (err) {
    console.error('create_inventory_task exception:', err)
    return { data: null, error: 'No se pudo crear la tarea.' }
  }
}

export async function reassignInventoryTask(
  companyId: string,
  taskId: string,
  expectedVersion: number,
  expectedCycle: number,
  newUserId: string,
  reason: string
): Promise<{ data: { task_id: string } | null; error: string | null }> {
  try {
    const db = inventariosAdmin()
    const { error } = await db.rpc('reassign_inventory_task', {
      p_company_id: companyId,
      p_task_id: taskId,
      p_expected_version: expectedVersion,
      p_expected_cycle: expectedCycle,
      p_new_user_id: newUserId,
      p_reason: reason,
      p_idempotency_key: makeKey(),
    })
    if (error) {
      console.error('reassign_inventory_task error:', error.message)
      return { data: null, error: 'No se pudo reasignar la tarea.' }
    }
    return { data: { task_id: taskId }, error: null }
  } catch (err) {
    console.error('reassign_inventory_task exception:', err)
    return { data: null, error: 'No se pudo reasignar la tarea.' }
  }
}

export async function cancelInventoryTask(
  companyId: string,
  taskId: string,
  expectedVersion: number,
  expectedCycle: number,
  reason: string
): Promise<{ data: { task_id: string } | null; error: string | null }> {
  try {
    const db = inventariosAdmin()
    const { error } = await db.rpc('cancel_inventory_task', {
      p_company_id: companyId,
      p_task_id: taskId,
      p_expected_version: expectedVersion,
      p_expected_cycle: expectedCycle,
      p_reason: reason,
      p_idempotency_key: makeKey(),
    })
    if (error) {
      console.error('cancel_inventory_task error:', error.message)
      return { data: null, error: 'No se pudo cancelar la tarea.' }
    }
    return { data: { task_id: taskId }, error: null }
  } catch (err) {
    console.error('cancel_inventory_task exception:', err)
    return { data: null, error: 'No se pudo cancelar la tarea.' }
  }
}

export async function getActiveCompanyTasksSetup(
  sessionId: string
): Promise<{ data: TasksSetup | null; error: string | null; companyId: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  try {
    const db = inventariosAdmin()
    const { data, error } = await db.rpc('get_inventory_session_setup', {
      p_company_id: companyId,
      p_session_id: sessionId,
    })
    if (error) {
      console.error('get_inventory_session_setup error:', error.message)
      return { data: null, error: 'No se pudo cargar la configuración de la jornada.', companyId }
    }
    const setup = data as InventorySessionSetupResult
    return {
      data: {
        zones: setup.zones ?? [],
        tasks: setup.tasks ?? [],
        participants: setup.participants ?? [],
        indicators: setup.indicators,
      },
      error: null,
      companyId,
    }
  } catch (err) {
    console.error('get_inventory_session_setup exception:', err)
    return { data: null, error: 'No se pudo cargar la configuración de la jornada.', companyId }
  }
}
