'use server'

import { createClient } from '@/lib/supabase/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { getActiveCompanyId } from '@/app/actions/companies'

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

export async function getAisleSummary(warehouseId: string, aisle: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'Empresa inactiva' }

  const db = logDb()
  const { data: locations, error: locErr } = await db.from('locations')
    .select('id, code, is_active, rack, level, position')
    .eq('warehouse_id', warehouseId)
    .eq('company_id', companyId)
    .eq('aisle', aisle)

  if (locErr || !locations) return { error: 'Error obteniendo ubicaciones' }
  if (locations.length === 0) return { error: 'Pasillo no encontrado' }

  const locIds = locations.map(l => l.id)
  
  // Stock activo
  const { data: stock } = await db.from('v_stock_by_location')
    .select('location_id, quantity')
    .in('location_id', locIds)
    .gt('quantity', 0)

  // Movimientos
  const { data: moves } = await db.from('kardex_movements')
    .select('location_id')
    .in('location_id', locIds)
    .limit(1)

  const activeLocations = locations.filter(l => l.is_active).length
  const inactiveLocations = locations.filter(l => !l.is_active).length
  const stockLocationIds = new Set((stock || []).map(s => s.location_id))
  
  const hasHistory = (moves && moves.length > 0) || stockLocationIds.size > 0
  const hasStock = stockLocationIds.size > 0

  return {
    success: true,
    data: {
      totalLocations: locations.length,
      activeLocations,
      inactiveLocations,
      locationsWithStock: stockLocationIds.size,
      emptyLocations: locations.length - stockLocationIds.size,
      hasHistory,
      hasStock
    }
  }
}

export async function deactivateAisle(warehouseId: string, aisle: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'Empresa inactiva' }

  const summaryRes = await getAisleSummary(warehouseId, aisle)
  if (summaryRes.error) return summaryRes
  if (summaryRes.data?.hasStock) {
    return { error: 'No se puede desactivar este pasillo porque tiene ubicaciones con stock activo.' }
  }

  const db = logDb()
  const { error } = await db.from('locations')
    .update({ is_active: false, updated_by: user.id })
    .eq('warehouse_id', warehouseId)
    .eq('company_id', companyId)
    .eq('aisle', aisle)

  if (error) return { error: error.message }
  return { success: true }
}

export async function renameAisleIfSafe(warehouseId: string, oldAisle: string, newAisle: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'Empresa inactiva' }

  const newAisleTrimmed = newAisle.trim().toUpperCase()
  if (!newAisleTrimmed || oldAisle === newAisleTrimmed) return { error: 'Nombre de pasillo inválido o sin cambios' }

  const summaryRes = await getAisleSummary(warehouseId, oldAisle)
  if (summaryRes.error) return summaryRes
  if (summaryRes.data?.hasHistory) {
    return { error: 'Este pasillo tiene historial o stock asociado. Para mantener trazabilidad, no se puede renombrar el código físico. Puede crear un nuevo pasillo y desactivar el anterior cuando quede sin stock.' }
  }

  const db = logDb()
  const { data: locations } = await db.from('locations')
    .select('id, code, rack, level, position')
    .eq('warehouse_id', warehouseId)
    .eq('company_id', companyId)
    .eq('aisle', oldAisle)
    
  if (!locations || locations.length === 0) return { error: 'Pasillo no encontrado' }

  const { data: existingNew } = await db.from('locations')
    .select('id')
    .eq('warehouse_id', warehouseId)
    .eq('company_id', companyId)
    .eq('aisle', newAisleTrimmed)
    .limit(1)
  
  if (existingNew && existingNew.length > 0) return { error: 'Ya existe un pasillo con el nombre destino' }

  for (const loc of locations) {
    const rackStr = loc.rack ? `-R${loc.rack}` : ''
    const levelStr = loc.level ? `-N${loc.level}` : ''
    const posStr = loc.position ? `-U${loc.position}` : ''
    const newCode = `P${newAisleTrimmed}${rackStr}${levelStr}${posStr}`

    await db.from('locations').update({
      aisle: newAisleTrimmed,
      code: newCode,
      updated_by: user.id
    }).eq('id', loc.id)
  }

  return { success: true }
}

function getNextStringSequence(items: (string | null)[], quantity: number): string[] {
  const validItems = items.filter(Boolean) as string[]
  if (validItems.length === 0) return Array.from({ length: quantity }).map((_, i) => String(i + 1))
  
  // Custom numeric sort to find the max
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  const sorted = [...validItems].sort((a, b) => collator.compare(a, b))
  const maxItem = sorted[sorted.length - 1]
  
  const results: string[] = []
  let currentMaxStr = maxItem

  for (let i = 0; i < quantity; i++) {
    const num = parseInt(currentMaxStr, 10)
    if (isNaN(num)) {
      // If it's a letter or something else, just append a number, though this is fallback
      currentMaxStr = currentMaxStr + '1'
    } else {
      const nextNum = num + 1
      currentMaxStr = nextNum.toString().padStart(currentMaxStr.length, '0')
    }
    results.push(currentMaxStr)
  }

  return results
}

function generateLocationCode(aisle: string, rack: string | null, level: string | null, position: string | null): string {
  const rackStr = rack ? `-R${rack}` : ''
  const levelStr = level ? `-N${level}` : ''
  const posStr = position ? `-U${position}` : ''
  return `P${aisle}${rackStr}${levelStr}${posStr}`
}

async function bulkInsertValidLocations(db: any, companyId: string, warehouseId: string, userId: string, toInsert: any[]) {
  if (toInsert.length === 0) return { success: true }

  const codes = toInsert.map(x => x.code)
  const { data: existingLocs } = await db.from('locations')
    .select('code')
    .eq('company_id', companyId)
    .eq('warehouse_id', warehouseId)
    .in('code', codes)
  
  const existingSet = new Set((existingLocs || []).map((l: any) => l.code))
  
  const validInsert = toInsert.filter(x => !existingSet.has(x.code))
  
  if (validInsert.length === 0) return { error: 'Todas las ubicaciones generadas ya existen.' }
  
  const { error } = await db.from('locations').insert(
    validInsert.map(loc => ({
      company_id: companyId,
      warehouse_id: warehouseId,
      code: loc.code,
      aisle: loc.aisle,
      rack: loc.rack,
      level: loc.level,
      position: loc.position,
      is_active: true,
      created_by: userId,
      updated_by: userId
    }))
  )
  
  if (error) return { error: error.message }
  return { success: true, count: validInsert.length, skipped: toInsert.length - validInsert.length }
}

export async function addRacksToAisle(warehouseId: string, aisle: string, quantity: number) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'Empresa inactiva' }

  const db = logDb()
  const { data: locations } = await db.from('locations')
    .select('id, rack, level, position')
    .eq('warehouse_id', warehouseId)
    .eq('company_id', companyId)
    .eq('aisle', aisle)

  if (!locations || locations.length === 0) return { error: 'Pasillo no encontrado' }

  const uniqueLevels = Array.from(new Set(locations.map(l => l.level).filter(Boolean) as string[]))
  const uniquePositions = Array.from(new Set(locations.map(l => l.position).filter(Boolean) as string[]))
  
  if (uniqueLevels.length === 0) uniqueLevels.push('01')
  if (uniquePositions.length === 0) uniquePositions.push('01')

  const newRacks = getNextStringSequence(locations.map(l => l.rack), quantity)
  
  const toInsert = []
  for (const rack of newRacks) {
    for (const level of uniqueLevels) {
      for (const pos of uniquePositions) {
        toInsert.push({
          code: generateLocationCode(aisle, rack, level, pos),
          aisle, rack, level, position: pos
        })
      }
    }
  }

  return bulkInsertValidLocations(db, companyId, warehouseId, user.id, toInsert)
}

export async function addLevelsToAisle(warehouseId: string, aisle: string, quantity: number) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'Empresa inactiva' }

  const db = logDb()
  const { data: locations } = await db.from('locations')
    .select('id, rack, level, position')
    .eq('warehouse_id', warehouseId)
    .eq('company_id', companyId)
    .eq('aisle', aisle)

  if (!locations || locations.length === 0) return { error: 'Pasillo no encontrado' }

  const uniqueRacks = Array.from(new Set(locations.map(l => l.rack).filter(Boolean) as string[]))
  const uniquePositions = Array.from(new Set(locations.map(l => l.position).filter(Boolean) as string[]))
  
  if (uniqueRacks.length === 0) uniqueRacks.push('01')
  if (uniquePositions.length === 0) uniquePositions.push('01')

  const newLevels = getNextStringSequence(locations.map(l => l.level), quantity)
  
  const toInsert = []
  for (const level of newLevels) {
    for (const rack of uniqueRacks) {
      for (const pos of uniquePositions) {
        toInsert.push({
          code: generateLocationCode(aisle, rack, level, pos),
          aisle, rack, level, position: pos
        })
      }
    }
  }

  return bulkInsertValidLocations(db, companyId, warehouseId, user.id, toInsert)
}

export async function addPositionsToAisle(warehouseId: string, aisle: string, quantity: number) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'Empresa inactiva' }

  const db = logDb()
  const { data: locations } = await db.from('locations')
    .select('id, rack, level, position')
    .eq('warehouse_id', warehouseId)
    .eq('company_id', companyId)
    .eq('aisle', aisle)

  if (!locations || locations.length === 0) return { error: 'Pasillo no encontrado' }

  const uniqueRacks = Array.from(new Set(locations.map(l => l.rack).filter(Boolean) as string[]))
  const uniqueLevels = Array.from(new Set(locations.map(l => l.level).filter(Boolean) as string[]))
  
  if (uniqueRacks.length === 0) uniqueRacks.push('01')
  if (uniqueLevels.length === 0) uniqueLevels.push('01')

  const newPositions = getNextStringSequence(locations.map(l => l.position), quantity)
  
  const toInsert = []
  for (const pos of newPositions) {
    for (const rack of uniqueRacks) {
      for (const level of uniqueLevels) {
        toInsert.push({
          code: generateLocationCode(aisle, rack, level, pos),
          aisle, rack, level, position: pos
        })
      }
    }
  }

  return bulkInsertValidLocations(db, companyId, warehouseId, user.id, toInsert)
}
