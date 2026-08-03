'use server'

import { createInventariosClient } from '@/lib/supabase/inventarios'
import { getActiveCompanyId } from '@/app/actions/companies'

async function inventariosAdmin() {
  return createInventariosClient()
}

export async function startInventorySession(
  companyId: string,
  sessionId: string,
  idempotencyKey: string
): Promise<{ data: { session_id: string; state: string } | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { error } = await db.rpc('start_inventory_session', {
      p_company_id: companyId,
      p_session_id: sessionId,
      p_idempotency_key: idempotencyKey,
    })
    if (error) {
      console.error('start_inventory_session error:', error.message)
      return { data: null, error: 'No se pudo abrir la jornada.' }
    }
    return { data: { session_id: sessionId, state: 'COUNTING' }, error: null }
  } catch (err) {
    console.error('start_inventory_session exception:', err)
    return { data: null, error: 'No se pudo abrir la jornada.' }
  }
}

export async function closeInventorySession(
  companyId: string,
  sessionId: string,
  idempotencyKey: string
): Promise<{ data: { session_id: string; state: string } | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { error } = await db.rpc('close_inventory_session', {
      p_company_id: companyId,
      p_session_id: sessionId,
      p_idempotency_key: idempotencyKey,
    })
    if (error) {
      console.error('close_inventory_session error:', error.message)
      return { data: null, error: 'No se pudo cerrar el conteo. Verifica que todas las tareas estén completas.' }
    }
    return { data: { session_id: sessionId, state: 'UNDER_REVIEW' }, error: null }
  } catch (err) {
    console.error('close_inventory_session exception:', err)
    return { data: null, error: 'No se pudo cerrar el conteo.' }
  }
}

export async function getActiveCompanyIdForOperation(): Promise<string | null> {
  return getActiveCompanyId()
}
