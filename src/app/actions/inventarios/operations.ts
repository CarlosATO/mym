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

export async function startInventorySession(
  companyId: string,
  sessionId: string,
  idempotencyKey: string
): Promise<{ data: { session_id: string; state: string } | null; error: string | null }> {
  try {
    const db = inventariosAdmin()
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
    const db = inventariosAdmin()
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
