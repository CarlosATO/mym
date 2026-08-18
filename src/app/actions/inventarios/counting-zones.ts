'use server'

import { createInventariosClient } from '@/lib/supabase/inventarios'

async function inventariosAdmin() {
  return createInventariosClient()
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface InventorySessionScopeLocation {
  location_id: string
  code: string
  name: string | null
  aisle: string | null
  rack: string | null
  level: string | null
  position: string | null
  is_active: boolean
  warehouse_id: string | null
  assigned_zone_id: string | null
  assigned_zone_name: string | null
}

export interface InventorySessionScopesResult {
  session_id: string
  warehouse_id: string | null
  total_locations: number
  assigned_locations: number
  pending_locations: number
  locations: InventorySessionScopeLocation[]
}

export interface InventoryCountingZoneCoverage {
  total: number
  assigned: number
  pending: number
  percent: number
  zone_count: number
}

export interface InventoryCountingZoneAssignEnvelope {
  operation: string
  entity_id: string
  state: string
  version: number | null
  cycle_number: number | null
  assignment_id: string | null
  event_id: string | null
  replayed: boolean
  occurred_at: string
  data: {
    campaign_id: string
    session_id: string
    zone_id: string
    zone_code: string
    zone_name: string
    session_participant_id: string
    campaign_participant_id: string
    user_id: string
    task_id: string
    task_assignment_id: string
    location_ids: string[]
    location_count: number
    coverage: InventoryCountingZoneCoverage
  }
}

export interface InventoryCountingZoneCancelEnvelope {
  operation: string
  entity_id: string
  state: string
  version: number | null
  cycle_number: number | null
  assignment_id: string | null
  event_id: string | null
  replayed: boolean
  occurred_at: string
  data: {
    campaign_id: string
    session_id: string
    zone_id: string
    task_id: string
    task_assignment_id: string
    reason: string
    coverage: InventoryCountingZoneCoverage
  }
}

export async function listInventorySessionScopes(
  companyId: string,
  sessionId: string
): Promise<{ data: InventorySessionScopesResult | null; error: string | null }> {
  if (!UUID_PATTERN.test(companyId) || !UUID_PATTERN.test(sessionId)) {
    return { data: null, error: 'Los identificadores de la jornada no son válidos.' }
  }
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('list_inventory_session_scopes', {
      p_company_id: companyId,
      p_session_id: sessionId,
    })
    if (error) {
      console.error('list_inventory_session_scopes error:', error.message)
      return { data: null, error: safeZoneError(error.message, 'No se pudo cargar el alcance de la jornada.') }
    }
    const payload = data as InventorySessionScopesResult | null
    if (!payload || !Array.isArray(payload.locations)) {
      return { data: null, error: 'El alcance de la jornada no se pudo cargar correctamente.' }
    }
    return {
      data: {
        session_id: payload.session_id,
        warehouse_id: payload.warehouse_id,
        total_locations: Number(payload.total_locations ?? 0),
        assigned_locations: Number(payload.assigned_locations ?? 0),
        pending_locations: Number(payload.pending_locations ?? 0),
        locations: payload.locations,
      },
      error: null,
    }
  } catch (err) {
    console.error('listInventorySessionScopes exception:', err)
    return { data: null, error: 'No se pudo cargar el alcance de la jornada.' }
  }
}

export async function assignInventoryCountingZone(input: {
  companyId: string
  campaignId: string
  sessionId: string
  campaignParticipantId: string
  zoneName: string
  locationIds: string[]
  idempotencyKey: string
}): Promise<{ data: InventoryCountingZoneAssignEnvelope | null; error: string | null }> {
  const fallback = 'No se pudo crear la zona y asignarla.'
  if (
    !UUID_PATTERN.test(input.companyId) ||
    !UUID_PATTERN.test(input.campaignId) ||
    !UUID_PATTERN.test(input.sessionId) ||
    !UUID_PATTERN.test(input.campaignParticipantId) ||
    !UUID_PATTERN.test(input.idempotencyKey)
  ) {
    return { data: null, error: 'Los identificadores de la solicitud no son válidos.' }
  }
  const zoneName = input.zoneName.trim()
  if (zoneName.length === 0 || zoneName.length > 200) {
    return { data: null, error: 'El nombre de la zona debe tener entre 1 y 200 caracteres.' }
  }
  const locationIds = Array.from(new Set(input.locationIds.filter(id => UUID_PATTERN.test(id))))
  if (locationIds.length === 0) {
    return { data: null, error: 'Selecciona al menos una ubicación para la zona.' }
  }
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('assign_inventory_counting_zone', {
      p_company_id: input.companyId,
      p_campaign_id: input.campaignId,
      p_session_id: input.sessionId,
      p_campaign_participant_id: input.campaignParticipantId,
      p_zone_name: zoneName,
      p_location_ids: locationIds,
      p_idempotency_key: input.idempotencyKey,
    })
    if (error) {
      console.error('assign_inventory_counting_zone error:', error.message)
      return { data: null, error: safeZoneError(error.message, fallback) }
    }
    const envelope = data as InventoryCountingZoneAssignEnvelope | null
    if (!envelope?.entity_id) {
      return { data: null, error: 'La zona no se pudo crear correctamente.' }
    }
    return { data: envelope, error: null }
  } catch (err) {
    console.error('assignInventoryCountingZone exception:', err)
    return { data: null, error: fallback }
  }
}

export async function addInventoryCountingZoneProgressive(input: {
  companyId: string
  campaignId: string
  sessionId: string
  campaignParticipantId: string
  zoneName: string
  locationIds: string[]
  idempotencyKey: string
}): Promise<{ data: InventoryCountingZoneAssignEnvelope | null; error: string | null }> {
  const fallback = 'No se pudo crear la zona progresiva y asignarla.'
  if (
    !UUID_PATTERN.test(input.companyId) ||
    !UUID_PATTERN.test(input.campaignId) ||
    !UUID_PATTERN.test(input.sessionId) ||
    !UUID_PATTERN.test(input.campaignParticipantId) ||
    !UUID_PATTERN.test(input.idempotencyKey)
  ) {
    return { data: null, error: 'Los identificadores de la solicitud no son válidos.' }
  }
  const zoneName = input.zoneName.trim()
  if (zoneName.length === 0 || zoneName.length > 200) {
    return { data: null, error: 'El nombre de la zona debe tener entre 1 y 200 caracteres.' }
  }
  const locationIds = Array.from(new Set(input.locationIds.filter(id => UUID_PATTERN.test(id))))
  if (locationIds.length === 0) {
    return { data: null, error: 'Selecciona al menos una ubicación para la zona.' }
  }
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('add_inventory_counting_zone_progressive', {
      p_company_id: input.companyId,
      p_campaign_id: input.campaignId,
      p_session_id: input.sessionId,
      p_campaign_participant_id: input.campaignParticipantId,
      p_zone_name: zoneName,
      p_location_ids: locationIds,
      p_idempotency_key: input.idempotencyKey,
    })
    if (error) {
      console.error('add_inventory_counting_zone_progressive error:', error.message)
      return { data: null, error: safeZoneError(error.message, fallback) }
    }
    const envelope = data as InventoryCountingZoneAssignEnvelope | null
    if (!envelope?.entity_id) return { data: null, error: 'La zona no se pudo crear correctamente.' }
    return { data: envelope, error: null }
  } catch (err) {
    console.error('add_inventory_counting_zone_progressive exception:', err)
    return { data: null, error: fallback }
  }
}

export async function cancelInventoryCountingZone(input: {
  companyId: string
  campaignId: string
  sessionId: string
  zoneId: string
  reason: string
  idempotencyKey: string
}): Promise<{ data: InventoryCountingZoneCancelEnvelope | null; error: string | null }> {
  const fallback = 'No se pudo cancelar la zona.'
  if (
    !UUID_PATTERN.test(input.companyId) ||
    !UUID_PATTERN.test(input.campaignId) ||
    !UUID_PATTERN.test(input.sessionId) ||
    !UUID_PATTERN.test(input.zoneId) ||
    !UUID_PATTERN.test(input.idempotencyKey)
  ) {
    return { data: null, error: 'Los identificadores de la solicitud no son válidos.' }
  }
  const reason = input.reason.trim()
  if (reason.length < 5 || reason.length > 500) {
    return { data: null, error: 'El motivo de la cancelación debe tener entre 5 y 500 caracteres.' }
  }
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('cancel_inventory_counting_zone', {
      p_company_id: input.companyId,
      p_campaign_id: input.campaignId,
      p_session_id: input.sessionId,
      p_zone_id: input.zoneId,
      p_reason: reason,
      p_idempotency_key: input.idempotencyKey,
    })
    if (error) {
      console.error('cancel_inventory_counting_zone error:', error.message)
      return { data: null, error: safeZoneError(error.message, fallback) }
    }
    const envelope = data as InventoryCountingZoneCancelEnvelope | null
    if (!envelope?.entity_id) {
      return { data: null, error: 'La zona no se pudo cancelar correctamente.' }
    }
    return { data: envelope, error: null }
  } catch (err) {
    console.error('cancelInventoryCountingZone exception:', err)
    return { data: null, error: fallback }
  }
}

function safeZoneError(message: string, fallback: string): string {
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
  if (normalized.includes('inv_zone_name_already_exists')) {
    return 'Ya existe una zona con este nombre en esta sección del inventario.'
  }
  if (normalized.includes('inv_campaign_not_draft') || normalized.includes('inv_campaign_already_prepared')) {
    return 'La campaña ya fue preparada y no admite cambios de zonas.'
  }
  if (normalized.includes('inv_campaign_not_open')) {
    return 'El inventario ya no admite nuevas zonas.'
  }
  if (normalized.includes('inv_session_not_draft')) {
    return 'La jornada ya no está en borrador y no admite cambios de zonas.'
  }
  if (normalized.includes('inv_counter_not_found')) {
    return 'El contador seleccionado ya no está activo en la campaña. Actualiza el equipo e inténtalo de nuevo.'
  }
  if (normalized.includes('inv_participant_not_found')) {
    return 'El responsable seleccionado no tiene un rol de Contador activo en esta campaña. Actualiza el equipo e inténtalo de nuevo.'
  }
  if (normalized.includes('inv_location_already_assigned')) {
    return 'Una de las ubicaciones seleccionadas ya pertenece a una zona de la jornada.'
  }
  if (normalized.includes('inv_location_not_in_scope') || normalized.includes('inv_location_inactive')) {
    return 'Una de las ubicaciones seleccionadas ya no pertenece al alcance de la jornada.'
  }
  if (normalized.includes('inv_task_already_started')) {
    return 'La zona ya inició su conteo y no puede cancelarse.'
  }
  if (normalized.includes('inv_idempotency_conflict')) {
    return 'La solicitud ya fue procesada con un resultado distinto.'
  }
  if (normalized.includes('inv_snapshot_required')) {
    return 'La jornada aún no tiene un snapshot vigente para asignar zonas.'
  }
  if (normalized.includes('permission') || normalized.includes('autoriz')) {
    return 'No tienes permisos para asignar zonas en esta jornada.'
  }
  return fallback
}
