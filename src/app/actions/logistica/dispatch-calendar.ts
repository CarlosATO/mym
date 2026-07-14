'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient as logisticaAdmin } from '@/lib/supabase/admin'

import { getActiveCompanyId } from '@/app/actions/companies'

// Utils
async function requireSuperUsuario() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }
  const { data: profile } = await supabase.from('users').select('role_id, roles:role_id(name)').eq('id', user.id).single()
  const roleName = (profile?.roles as any)?.name
  if (roleName !== 'SUPER_USUARIO') return { error: 'Se requiere rol SUPER_USUARIO' }
  return { user }
}

export type DispatchCity = { id: string, name: string, active: boolean }
export type DispatchCalendar = { id: string, name: string, active: boolean, created_at: string, updated_at: string }
export type DispatchCalendarCity = { id: string, calendar_id: string, city_id: string, weekday: number, normalized_city: string, route_label: string | null, priority: number, active: boolean }

export async function getDispatchCities(): Promise<{ data: DispatchCity[] | null, error: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: null, error: 'No company active' }
  const { data, error } = await logisticaAdmin().schema('logistica').from('dispatch_cities').select('*').eq('company_id', companyId).eq('active', true).order('name', { ascending: true })
  if (error) return { data: null, error: error.message }
  return { data: data as DispatchCity[], error: null }
}

export async function getDispatchCalendars(): Promise<{ data: DispatchCalendar[] | null, error: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: null, error: 'No company active' }
  const { data, error } = await logisticaAdmin().schema('logistica').from('dispatch_calendars').select('*').eq('company_id', companyId).order('name', { ascending: true })
  if (error) return { data: null, error: error.message }
  return { data: data as DispatchCalendar[], error: null }
}

export async function getDispatchCalendarCities(calendarId: string): Promise<{ data: DispatchCalendarCity[] | null, error: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: null, error: 'No company active' }
  const { data, error } = await logisticaAdmin().schema('logistica').from('dispatch_calendar_cities').select('*').eq('company_id', companyId).eq('calendar_id', calendarId).order('weekday', { ascending: true }).order('priority', { ascending: true }).order('normalized_city', { ascending: true })
  if (error) return { data: null, error: error.message }
  return { data: data as DispatchCalendarCity[], error: null }
}

export async function createDispatchCalendar(name: string): Promise<{ data: DispatchCalendar | null, error: string | null }> {
  const auth = await requireSuperUsuario(); if (auth.error) return { data: null, error: auth.error }
  const companyId = await getActiveCompanyId(); if (!companyId) return { data: null, error: 'No company active' }
  const admin = logisticaAdmin()
  const { data: existing } = await admin.schema('logistica').from('dispatch_calendars').select('id').eq('company_id', companyId).limit(1)
  const isFirst = !existing || existing.length === 0
  const { data, error } = await admin.schema('logistica').from('dispatch_calendars').insert({ company_id: companyId, name, active: isFirst }).select().single()
  if (error) return { data: null, error: error.message }
  return { data: data as DispatchCalendar, error: null }
}

export type DispatchCalendarConfigPayload = { name: string, active: boolean, assignments: Array<{ id?: string, weekday: number, city_id: string, normalized_city: string, route_label?: string | null, priority?: number }> }

export async function saveDispatchCalendarConfig(calendarId: string, payload: DispatchCalendarConfigPayload): Promise<{ success: boolean; error: string | null }> {
  const auth = await requireSuperUsuario(); if (auth.error) return { success: false, error: auth.error }
  const companyId = await getActiveCompanyId(); if (!companyId) return { success: false, error: 'No company active' }
  const admin = logisticaAdmin()

  const { data: calendar, error: calError } = await admin.schema('logistica').from('dispatch_calendars').select('id').eq('id', calendarId).eq('company_id', companyId).single()
  if (calError || !calendar) return { success: false, error: 'Calendario no pertenece a la empresa activa o no existe.' }

  if (payload.active) {
    await admin.schema('logistica').from('dispatch_calendars').update({ active: false }).eq('company_id', companyId).neq('id', calendarId)
  }
  const { error: updateError } = await admin.schema('logistica').from('dispatch_calendars').update({ name: payload.name, active: payload.active }).eq('id', calendarId).eq('company_id', companyId)
  if (updateError) return { success: false, error: updateError.message }

  const cityIds = [...new Set(payload.assignments.map(a => a.city_id))]
  if (cityIds.length > 0) {
    const { data: cities, error: citiesError } = await admin.schema('logistica').from('dispatch_cities').select('id, name').in('id', cityIds).eq('company_id', companyId).eq('active', true)
    if (citiesError || !cities || cities.length !== cityIds.length) return { success: false, error: 'Algunas comunas no existen o están inactivas.' }
  }

  const { data: existingRecords } = await admin.schema('logistica').from('dispatch_calendar_cities').select('id, city_id, weekday').eq('calendar_id', calendarId).eq('company_id', companyId)
  const existingMap = new Map((existingRecords || []).map((e: any) => [`${e.city_id}-${e.weekday}`, e]))
  
  const toDeleteIds: string[] = []; const toInsert: any[] = []; const toUpdate: any[] = []; const payloadMap = new Map()

  for (const a of payload.assignments) {
    if (a.weekday < 1 || a.weekday > 7) return { success: false, error: `Día inválido: ${a.weekday}` }
    const key = `${a.city_id}-${a.weekday}`
    if (payloadMap.has(key)) return { success: false, error: `La comuna ${a.normalized_city} está duplicada en el mismo día.` }
    payloadMap.set(key, true)
    if (existingMap.has(key)) {
      toUpdate.push({ id: (existingMap.get(key) as any).id, route_label: a.route_label || null, priority: a.priority || 0 })
      existingMap.delete(key)
    } else {
      toInsert.push({ company_id: companyId, calendar_id: calendarId, city_id: a.city_id, weekday: a.weekday, normalized_city: a.normalized_city, route_label: a.route_label || null, priority: a.priority || 0, active: true })
    }
  }

  for (const ex of existingMap.values() as any) toDeleteIds.push(ex.id)

  if (toDeleteIds.length > 0) await admin.schema('logistica').from('dispatch_calendar_cities').delete().in('id', toDeleteIds).eq('company_id', companyId)
  for (const up of toUpdate) await admin.schema('logistica').from('dispatch_calendar_cities').update({ route_label: up.route_label, priority: up.priority }).eq('id', up.id).eq('company_id', companyId)
  if (toInsert.length > 0) {
    const { error: insError } = await admin.schema('logistica').from('dispatch_calendar_cities').insert(toInsert)
    if (insError) return { success: false, error: insError.code === '23505' ? 'Comuna duplicada' : insError.message }
  }
  return { success: true, error: null }
}
