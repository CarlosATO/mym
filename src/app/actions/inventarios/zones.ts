'use server'

import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { getActiveCompanyId } from '@/app/actions/companies'
import type { InventoryParticipant, InventorySessionSetupResult, InventorySessionTask, InventorySessionZone } from '@/app/actions/inventarios/sessions'

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

export interface SessionZonesSetupResult {
  session: InventorySessionSetupResult['session']
  zones: InventorySessionZone[]
  participants: InventoryParticipant[]
  tasks: InventorySessionTask[]
  indicators: InventorySessionSetupResult['indicators']
}

export async function getActiveCompanyZonesSetup(
  sessionId: string
): Promise<{ data: SessionZonesSetupResult | null; error: string | null; companyId: string | null }> {
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
        session: setup.session,
        zones: setup.zones ?? [],
        participants: setup.participants ?? [],
        tasks: setup.tasks ?? [],
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

export async function createSessionZone(
  companyId: string,
  sessionId: string,
  input: { zone_code: string; scan_code: string; display_name: string; priority: number }
): Promise<{ data: { session_zone_id: string } | null; error: string | null }> {
  try {
    const db = inventariosAdmin()
    const { error } = await db.rpc('create_inventory_session_zone', {
      p_company_id: companyId,
      p_session_id: sessionId,
      p_zone_code: input.zone_code,
      p_scan_code: input.scan_code,
      p_display_name: input.display_name,
      p_priority: input.priority,
      p_idempotency_key: makeKey(),
    })
    if (error) {
      console.error('create_inventory_session_zone error:', error.message)
      return { data: null, error: 'No se pudo crear la zona.' }
    }
    return { data: { session_zone_id: '' }, error: null }
  } catch (err) {
    console.error('create_inventory_session_zone exception:', err)
    return { data: null, error: 'No se pudo crear la zona.' }
  }
}

export async function addZoneLocation(
  companyId: string,
  sessionId: string,
  sessionZoneId: string,
  locationId: string
): Promise<{ data: { session_zone_id: string } | null; error: string | null }> {
  try {
    const db = inventariosAdmin()
    const { error } = await db.rpc('add_inventory_zone_location', {
      p_company_id: companyId,
      p_session_id: sessionId,
      p_session_zone_id: sessionZoneId,
      p_location_id: locationId,
      p_idempotency_key: makeKey(),
    })
    if (error) {
      console.error('add_inventory_zone_location error:', error.message)
      return { data: null, error: 'No se pudo asignar la ubicación.' }
    }
    return { data: { session_zone_id: sessionZoneId }, error: null }
  } catch (err) {
    console.error('add_inventory_zone_location exception:', err)
    return { data: null, error: 'No se pudo asignar la ubicación.' }
  }
}

export async function removeZoneLocation(
  companyId: string,
  sessionId: string,
  sessionZoneId: string,
  locationId: string
): Promise<{ data: { session_zone_id: string } | null; error: string | null }> {
  try {
    const db = inventariosAdmin()
    const { error } = await db.rpc('remove_inventory_zone_location', {
      p_company_id: companyId,
      p_session_id: sessionId,
      p_session_zone_id: sessionZoneId,
      p_location_id: locationId,
      p_idempotency_key: makeKey(),
    })
    if (error) {
      console.error('remove_inventory_zone_location error:', error.message)
      return { data: null, error: 'No se pudo quitar la ubicación.' }
    }
    return { data: { session_zone_id: sessionZoneId }, error: null }
  } catch (err) {
    console.error('remove_inventory_zone_location exception:', err)
    return { data: null, error: 'No se pudo quitar la ubicación.' }
  }
}

export async function deleteSessionZone(
  companyId: string,
  sessionId: string,
  sessionZoneId: string
): Promise<{ data: { session_zone_id: string } | null; error: string | null }> {
  try {
    const db = inventariosAdmin()
    const { error } = await db.rpc('delete_inventory_session_zone', {
      p_company_id: companyId,
      p_session_id: sessionId,
      p_session_zone_id: sessionZoneId,
      p_idempotency_key: makeKey(),
    })
    if (error) {
      console.error('delete_inventory_session_zone error:', error.message)
      return { data: null, error: 'No se pudo eliminar la zona.' }
    }
    return { data: { session_zone_id: sessionZoneId }, error: null }
  } catch (err) {
    console.error('delete_inventory_session_zone exception:', err)
    return { data: null, error: 'No se pudo eliminar la zona.' }
  }
}
