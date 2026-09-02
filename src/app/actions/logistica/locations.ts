'use server'

import { createClient } from '@/lib/supabase/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { getActiveCompanyId } from '@/app/actions/companies'
import { requireWmsPermission } from './authorization'

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

function logDb() {
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
    db: { schema: 'logistica' }, auth: { autoRefreshToken: false, persistSession: false },
  })
}

function adqDb() {
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
    db: { schema: 'adquisiciones' }, auth: { autoRefreshToken: false, persistSession: false },
  })
}

export interface Location {
  id: string
  company_id: string
  warehouse_id: string
  warehouse_name?: string
  code: string
  name: string | null
  aisle: string | null
  rack: string | null
  level: string | null
  position: string | null
  description: string | null
  is_active: boolean
  created_at: string
}

export interface LocationFilters {
  search?: string
  warehouse_id?: string
  page?: number
  pageSize?: number
  is_active?: boolean
}

export interface LocationLifecycle {
  found: boolean
  location_id: string
  has_stock: boolean
  has_history: boolean
  has_inventory_reference: boolean
  has_active_operation: boolean
  can_edit_structure: boolean
  can_deactivate: boolean
  can_delete: boolean
  blocking_reasons: { code: string; message: string }[]
}

export async function getLocationLifecycle(locId: string): Promise<LocationLifecycle | { error: string }> {
  const authorization = await requireWmsPermission('logistica.locations.view')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const companyId = authorization.companyId
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' }

  const { data, error } = await logDb().rpc('evaluate_location_lifecycle', {
    p_company_id: companyId,
    p_location_id: locId,
  })
  if (error) return { error: error.message }
  return data as LocationLifecycle
}

export async function getLocations(filters: LocationFilters = {}): Promise<{
  data: Location[]
  total: number
  stats: { total: number; active: number; inactive: number }
}> {
  const authorization = await requireWmsPermission('logistica.locations.view')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: [], total: 0, stats: { total: 0, active: 0, inactive: 0 } }

  const companyId = authorization.companyId
  if (!companyId) return { data: [], total: 0, stats: { total: 0, active: 0, inactive: 0 } }

  const d = logDb()
  const { data, error } = await d
    .from('locations')
    .select('*')
    .eq('company_id', companyId)
    .order('code')

  if (error) {
    console.error('getLocations error:', error)
    return { data: [], total: 0, stats: { total: 0, active: 0, inactive: 0 } }
  }

  // Consultar bodegas por separado desde el schema adquisiciones
  const { data: warehouses, error: whError } = await adqDb()
    .from('warehouses')
    .select('id, name')
    .eq('company_id', companyId)

  const whMap = new Map()
  if (warehouses && !whError) {
    warehouses.forEach(wh => {
      whMap.set(wh.id, wh.name)
    })
  }

  const filteredData = (data ?? []).map(loc => ({
    ...loc,
    warehouse_name: whMap.get(loc.warehouse_id) || 'Bodega Desconocida'
  })) as Location[]

  // Compute stats based on company and selected warehouse (before search query is applied)
  let statsFiltered = filteredData
  if (filters.warehouse_id) {
    statsFiltered = filteredData.filter(loc => loc.warehouse_id === filters.warehouse_id)
  }
  const stats = {
    total: statsFiltered.length,
    active: statsFiltered.filter(loc => loc.is_active).length,
    inactive: statsFiltered.filter(loc => !loc.is_active).length
  }

  // Apply active/inactive filter
  let displayData = statsFiltered
  if (typeof filters.is_active === 'boolean') {
    displayData = displayData.filter(loc => loc.is_active === filters.is_active)
  }

  // Apply search query filter
  if (filters.search) {
    const s = filters.search.toLowerCase()
    displayData = displayData.filter(loc => 
      loc.code.toLowerCase().includes(s) || 
      (loc.name && loc.name.toLowerCase().includes(s)) ||
      (loc.description && loc.description.toLowerCase().includes(s))
    )
  }

  const total = displayData.length
  const page = filters.page ?? 1
  const pageSize = filters.pageSize ?? 50
  const paginatedData = displayData.slice((page - 1) * pageSize, page * pageSize)

  return { data: paginatedData, total, stats }
}

export async function createLocation(data: {
  warehouse_id: string
  code: string
  name?: string
  aisle?: string
  rack?: string
  level?: string
  position?: string
  description?: string
}) {
  const authorization = await requireWmsPermission('logistica.locations.create')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const companyId = authorization.companyId
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' }

  const code = (data.code ?? '').trim().toUpperCase()
  if (!code) return { error: 'El código de ubicación es obligatorio' }

  // Verify warehouse belongs to the active company
  const { data: warehouse, error: whError } = await adqDb()
    .from('warehouses')
    .select('id, is_active')
    .eq('id', data.warehouse_id)
    .eq('company_id', companyId)
    .maybeSingle()

  if (whError) {
    return { error: 'Error al verificar la bodega: ' + whError.message }
  }
  if (!warehouse || !warehouse.is_active) {
    return { error: 'La bodega seleccionada no existe, está inactiva o no pertenece a la empresa activa' }
  }

  const d = logDb()
  
  // Verify uniqueness
  const { data: dup, error: checkError } = await d
    .from('locations')
    .select('id')
    .eq('company_id', companyId)
    .eq('warehouse_id', data.warehouse_id)
    .eq('code', code)
    .maybeSingle()

  if (checkError) return { error: checkError.message }
  if (dup) return { error: `La ubicación con código "${code}" ya existe en esta bodega` }

  const { error } = await d
    .from('locations')
    .insert({
      company_id: companyId,
      warehouse_id: data.warehouse_id,
      code,
      name: data.name?.trim().toUpperCase() || null,
      aisle: data.aisle?.trim().toUpperCase() || null,
      rack: data.rack?.trim().toUpperCase() || null,
      level: data.level?.trim().toUpperCase() || null,
      position: data.position?.trim().toUpperCase() || null,
      description: data.description?.trim().toUpperCase() || null,
      is_active: true,
      created_by: user.id,
      updated_by: user.id
    })

  if (error) return { error: error.message }
  return { success: true }
}

export async function deactivateLocation(locId: string) {
  const authorization = await requireWmsPermission('logistica.locations.deactivate')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const companyId = authorization.companyId
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' }

  const { data, error } = await logDb().rpc('toggle_location_lifecycle', {
    p_company_id: companyId,
    p_location_id: locId,
    p_user_id: user.id,
  })

  if (error) return { error: error.message }
  const result = data as { success?: boolean; error?: string; new_active?: boolean; blocking_reasons?: unknown }
  if (!result.success) return { error: result.error || 'No se pudo cambiar el estado de la ubicación' }
  return { success: true, newActive: result.new_active }
}

// Helpers for bulk location creation
function padIfNumeric(val: string): string {
  const num = parseInt(val, 10)
  if (!isNaN(num)) {
    return val.length >= 2 ? val : val.padStart(2, '0')
  }
  return val
}

function generateRange(from: string, to: string): string[] {
  const f = (from ?? '').trim()
  const t = (to ?? '').trim()

  if (!f && !t) return ['']
  if (!f) return [padIfNumeric(t)]
  if (!t) return [padIfNumeric(f)]

  const numFrom = parseInt(f, 10)
  const numTo = parseInt(t, 10)
  if (!isNaN(numFrom) && !isNaN(numTo)) {
    const list: string[] = []
    const min = Math.min(numFrom, numTo)
    const max = Math.max(numFrom, numTo)
    const padLength = Math.max(f.length, t.length, 2)
    
    for (let i = min; i <= max; i++) {
      list.push(i.toString().padStart(padLength, '0'))
    }
    return list
  }

  if (f.length === 1 && t.length === 1) {
    const list: string[] = []
    const charCodeFrom = f.charCodeAt(0)
    const charCodeTo = t.charCodeAt(0)
    const min = Math.min(charCodeFrom, charCodeTo)
    const max = Math.max(charCodeFrom, charCodeTo)
    for (let i = min; i <= max; i++) {
      list.push(String.fromCharCode(i).toUpperCase())
    }
    return list
  }

  return [f.toUpperCase()]
}

function formatCode(
  formatStr: string,
  prefix: string,
  aisle: string,
  rack: string,
  level: string,
  position: string
): string {
  let res = formatStr
    .replace(/{prefix}/gi, prefix)
    .replace(/{aisle}/gi, aisle)
    .replace(/{rack}/gi, rack)
    .replace(/{level}/gi, level)
    .replace(/{position}/gi, position)
  
  if (!aisle) res = res.replace(/P(?=-|$)/gi, '').replace(/PAS-/gi, '')
  if (!rack) res = res.replace(/-R(?=-|$)/gi, '').replace(/RACK-/gi, '')
  if (!level) res = res.replace(/-N(?=-|$)/gi, '').replace(/NIV-/gi, '')
  if (!position) res = res.replace(/-U(?=-|$)/gi, '').replace(/UBI-/gi, '')

  res = res.replace(/[-_+/]{2,}/g, (match) => match[0])
  res = res.replace(/^[-_+/]+|[-_+/]+$/g, '')
  return res.toUpperCase()
}

async function createLocationsBulkLegacy(data: {
  warehouse_id: string
  prefix?: string
  aisleFrom?: string
  aisleTo?: string
  rackFrom?: string
  rackTo?: string
  levelFrom?: string
  levelTo?: string
  posFrom?: string
  posTo?: string
  codeFormat: string
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' }

  if (!data.warehouse_id) return { error: 'La bodega es obligatoria' }

  const prefix = (data.prefix ?? '').trim()
  
  const aisles = generateRange((data.aisleFrom ?? '').trim(), (data.aisleTo ?? '').trim())
  const racks = generateRange((data.rackFrom ?? '').trim(), (data.rackTo ?? '').trim())
  const levels = generateRange((data.levelFrom ?? '').trim(), (data.levelTo ?? '').trim())
  const positions = generateRange((data.posFrom ?? '').trim(), (data.posTo ?? '').trim())

  const combinationsCount = aisles.length * racks.length * levels.length * positions.length
  if (combinationsCount > 2000) {
    return { error: `El número de ubicaciones estimadas (${combinationsCount}) supera el límite máximo de 2000 por operación.` }
  }

  const d = logDb()
  
  // Verify warehouse belongs to the active company
  const { data: warehouse, error: whError } = await adqDb()
    .from('warehouses')
    .select('id, is_active')
    .eq('id', data.warehouse_id)
    .eq('company_id', companyId)
    .maybeSingle()

  if (whError) {
    return { error: 'Error al verificar la bodega: ' + whError.message }
  }
  if (!warehouse || !warehouse.is_active) {
    return { error: 'La bodega seleccionada no existe, está inactiva o no pertenece a la empresa activa' }
  }

  // Get existing locations for this warehouse and company to skip duplicates
  const { data: existingLocs, error: existingError } = await d
    .from('locations')
    .select('code')
    .eq('company_id', companyId)
    .eq('warehouse_id', data.warehouse_id)

  if (existingError) {
    return { error: 'Error al verificar ubicaciones existentes: ' + existingError.message }
  }

  const existingCodesSet = new Set((existingLocs ?? []).map(l => l.code.toUpperCase()))

  const toInsert: Array<{
    company_id: string
    warehouse_id: string
    code: string
    name: string
    aisle: string | null
    rack: string | null
    level: string | null
    position: string | null
    description: string
    is_active: boolean
    created_by: string
    updated_by: string
  }> = []
  let skippedDuplicates = 0
  const errors: string[] = []

  for (const aisle of aisles) {
    for (const rack of racks) {
      for (const level of levels) {
        for (const position of positions) {
          const code = formatCode(data.codeFormat, prefix, aisle, rack, level, position)
          if (!code) continue

          if (existingCodesSet.has(code)) {
            skippedDuplicates++
            continue
          }

          const parts = []
          if (aisle) parts.push(`PASIL ${aisle}`)
          if (rack) parts.push(`RACK ${rack}`)
          if (level) parts.push(`NIVEL ${level}`)
          if (position) parts.push(`POS ${position}`)
          const name = parts.join(' ') || `UBICACION ${code}`

          toInsert.push({
            company_id: companyId,
            warehouse_id: data.warehouse_id,
            code,
            name,
            aisle: aisle || null,
            rack: rack || null,
            level: level || null,
            position: position || null,
            description: `GENERADA MASIVAMENTE - ${name}`,
            is_active: true,
            created_by: user.id,
            updated_by: user.id
          })
        }
      }
    }
  }

  if (process.env.NODE_ENV === 'development') {
    console.log('--- DEBUG BULK INSERT ---')
    console.log('Parameters received:', {
      warehouse_id: data.warehouse_id,
      prefix,
      aisles,
      rackFrom: data.rackFrom, rackTo: data.rackTo,
      levelFrom: data.levelFrom, levelTo: data.levelTo,
      posFrom: data.posFrom, posTo: data.posTo,
      codeFormat: data.codeFormat
    })
    console.log('Ranges generated:', { aisles, racks, levels, positions })
    console.log('Total generated combinations (toInsert):', toInsert.length)
    console.log('First 10 codes:', toInsert.slice(0, 10).map(x => x.code))
    console.log('Skipped duplicates:', skippedDuplicates)
  }

  if (toInsert.length === 0) {
    return {
      success: true,
      created: 0,
      skipped_duplicates: skippedDuplicates,
      errors: []
    }
  }

  let createdCount = 0
  const chunkSize = 100
  for (let i = 0; i < toInsert.length; i += chunkSize) {
    const chunk = toInsert.slice(i, i + chunkSize)
    const { error: insertError } = await d
      .from('locations')
      .insert(chunk)
    
    if (insertError) {
      console.error('Bulk insert error chunk:', insertError)
      errors.push(insertError.message)
    } else {
      createdCount += chunk.length
    }
  }

  if (process.env.NODE_ENV === 'development') {
    console.log('Total inserted:', createdCount)
    console.log('Errors:', errors)
    console.log('-------------------------')
  }

  return {
    success: true,
    created: createdCount,
    skipped_duplicates: skippedDuplicates,
    errors
  }
}

export interface LocationBulkRequest {
  warehouse_id: string
  prefix?: string
  code_format?: string
  aisles?: string[]
  racks?: string[]
  levels?: string[]
  positions?: string[]
}

type LocationBulkInput = Omit<LocationBulkRequest, 'aisles' | 'racks' | 'levels' | 'positions'> & {
  codeFormat?: string
  aisles?: string[] | string
  racks?: string[] | string
  levels?: string[] | string
  positions?: string[] | string
  aisleFrom?: string
  aisleTo?: string
  rackFrom?: string
  rackTo?: string
  levelFrom?: string
  levelTo?: string
  posFrom?: string
  posTo?: string
  positionFrom?: string
  positionTo?: string
}

function dimensionValues(values: string[] | string | undefined, from?: string, to?: string) {
  if (Array.isArray(values)) return values.map(value => value.trim().toUpperCase())
  if (typeof values === 'string') return values.split(',').map(value => value.trim().toUpperCase()).filter(Boolean)
  return generateRange(from ?? '', to ?? '')
}

function normalizeLocationBulkRequest(data: LocationBulkInput): LocationBulkRequest {
  return {
    warehouse_id: data.warehouse_id,
    prefix: data.prefix?.trim() ?? '',
    code_format: data.code_format ?? data.codeFormat,
    aisles: dimensionValues(data.aisles, data.aisleFrom, data.aisleTo),
    racks: dimensionValues(data.racks, data.rackFrom, data.rackTo),
    levels: dimensionValues(data.levels, data.levelFrom, data.levelTo),
    positions: dimensionValues(data.positions, data.posFrom ?? data.positionFrom, data.posTo ?? data.positionTo),
  }
}

export async function previewLocationsBulk(data: LocationBulkInput) {
  const authorization = await requireWmsPermission('logistica.locations.create_bulk')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'No autorizado' }
  const companyId = authorization.companyId
  if (!companyId) return { success: false, error: 'No se ha seleccionado una empresa activa' }

  const request = normalizeLocationBulkRequest(data)
  const { data: result, error } = await logDb().rpc('preview_location_bulk', {
    p_company_id: companyId,
    p_request: request,
  })
  if (error) return { success: false, error: error.message }
  return result as Record<string, unknown>
}

/** Compatibility wrapper: both existing forms are normalized to the canonical request. */
export async function createLocationsBulk(data: LocationBulkInput) {
  const authorization = await requireWmsPermission('logistica.locations.create_bulk')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'No autorizado' }
  const companyId = authorization.companyId
  if (!companyId) return { success: false, error: 'No se ha seleccionado una empresa activa' }

  const request = normalizeLocationBulkRequest(data)
  const { data: result, error } = await logDb().rpc('create_location_bulk', {
    p_company_id: companyId,
    p_request: request,
    p_user_id: user.id,
  })
  if (error) return { success: false, error: error.message }
  const response = result as Record<string, unknown>
  return {
    ...response,
    created: Number(response.created_count ?? 0),
    skipped_duplicates: Number(response.existing_count ?? 0) + Number(response.duplicate_count ?? 0),
    errors: Array.isArray(response.conflicts) ? response.conflicts : [],
  }
}

export async function updateLocation(
  locId: string,
  data: {
    code: string
    name?: string
    aisle?: string
    rack?: string
    level?: string
    position?: string
    description?: string
    is_active?: boolean
  }
) {
  const authorization = await requireWmsPermission('logistica.locations.update')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const companyId = authorization.companyId
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' }

  const code = (data.code ?? '').trim().toUpperCase()
  if (!code) return { error: 'El código es obligatorio' }

  const { data: result, error } = await logDb().rpc('update_location_lifecycle', {
    p_company_id: companyId,
    p_location_id: locId,
    p_code: code,
    p_name: data.name ?? null,
    p_aisle: data.aisle ?? null,
    p_rack: data.rack ?? null,
    p_level: data.level ?? null,
    p_position: data.position ?? null,
    p_description: data.description ?? null,
    p_is_active: data.is_active ?? null,
    p_user_id: user.id,
  })

  if (error) return { error: error.message }
  const response = result as { success?: boolean; error?: string; blocking_reasons?: unknown }
  if (!response.success) return { error: response.error || 'No se pudo actualizar la ubicación' }
  return { success: true }
}

export async function deleteLocation(locId: string) {
  const authorization = await requireWmsPermission('logistica.locations.delete')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const companyId = authorization.companyId
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' }

  const { data, error } = await logDb().rpc('delete_location_lifecycle', {
    p_company_id: companyId,
    p_location_id: locId,
    p_user_id: user.id,
  })
  if (error) return { error: error.message }
  const result = data as { success?: boolean; error?: string; blocking_reasons?: unknown }
  if (!result.success) return { error: result.error || 'No se pudo eliminar la ubicación' }
  return { success: true }
}
