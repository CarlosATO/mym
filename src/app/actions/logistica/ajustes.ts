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

function portalDb() {
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
    db: { schema: 'portal' }, auth: { autoRefreshToken: false, persistSession: false },
  })
}

export interface StockAdjustment {
  id: string
  company_id: string
  adjustment_number: string
  adjustment_type: 'INITIAL' | 'POSITIVE' | 'NEGATIVE'
  reason: string
  adjustment_date: string
  warehouse_id: string
  warehouse_name?: string
  notes?: string
  status: 'DRAFT' | 'COMPLETED' | 'CANCELLED'
  created_by: string
  created_at: string
  // Campos enriquecidos (sin N+1) — disponibles en bandeja y detalle
  item_count?: number
  total_units?: number
  total_value?: number
  created_by_name?: string | null
}

export interface StockAdjustmentItem {
  id: string
  adjustment_id: string
  product_id: string
  product_sku?: string
  product_description?: string
  warehouse_id: string
  location_id: string
  location_code?: string
  lot_number?: string
  expiration_date?: string
  quantity: number
  unit_cost?: number
  total_cost?: number
  notes?: string
}

// ─── getStockAdjustments ──────────────────────────────────────────────────────
// Patrón sin N+1 — mismo que traspasos.ts:
//   Query 1 → stock_adjustments (todos los ajustes de la empresa)
//   Query 2 → stock_adjustment_items de todos los IDs (agrupar en memoria)
//   Query 3 → adquisiciones.warehouses para nombres de bodega
//   Query 4 → portal.users para nombres de usuario
// Queries 2-4 en Promise.all (paralelas)
// ─────────────────────────────────────────────────────────────────────────────
export async function getStockAdjustments(): Promise<StockAdjustment[]> {
  if (process.env.NODE_ENV === 'development') console.time('getStockAdjustments')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    if (process.env.NODE_ENV === 'development') console.timeEnd('getStockAdjustments')
    return []
  }

  const companyId = await getActiveCompanyId()
  if (!companyId) {
    if (process.env.NODE_ENV === 'development') console.timeEnd('getStockAdjustments')
    return []
  }

  const db = logDb()

  // Query 1 — Ajustes
  if (process.env.NODE_ENV === 'development') console.time('getStockAdjustments:base')
  const { data, error } = await db
    .from('stock_adjustments')
    .select('*')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
  if (process.env.NODE_ENV === 'development') console.timeEnd('getStockAdjustments:base')

  if (error) {
    console.error('Error fetching stock adjustments:', error)
    if (process.env.NODE_ENV === 'development') console.timeEnd('getStockAdjustments')
    return []
  }

  if (!data || data.length === 0) {
    if (process.env.NODE_ENV === 'development') console.timeEnd('getStockAdjustments')
    return []
  }

  const adjustmentIds = data.map((d: any) => d.id)
  const warehouseIds = Array.from(new Set(data.map((d: any) => d.warehouse_id).filter(Boolean))) as string[]
  const userIds = Array.from(new Set(data.map((d: any) => d.created_by).filter(Boolean))) as string[]

  // Queries 2, 3, 4 en paralelo — sin N+1
  if (process.env.NODE_ENV === 'development') console.time('getStockAdjustments:lookups')
  const [itemsRes, warehousesRes, usersRes] = await Promise.all([
    // Todos los items de todos los ajustes en una sola query
    db
      .from('stock_adjustment_items')
      .select('adjustment_id, quantity, total_cost')
      .in('adjustment_id', adjustmentIds),

    // Bodegas
    warehouseIds.length > 0
      ? adqDb().from('warehouses').select('id, name').in('id', warehouseIds)
      : Promise.resolve({ data: [] as any[], error: null }),

    // Nombres de usuario desde portal.users (mismo patrón que traspasos.ts)
    userIds.length > 0
      ? portalDb().from('users').select('id, nombre, apellido').in('id', userIds)
      : Promise.resolve({ data: [] as any[], error: null }),
  ])
  if (process.env.NODE_ENV === 'development') console.timeEnd('getStockAdjustments:lookups')

  if (itemsRes.error) console.error('Error fetching adjustment items for list:', itemsRes.error)
  if (warehousesRes.error) console.error('Error fetching warehouses:', warehousesRes.error)
  if (usersRes.error) console.error('Error fetching portal users:', usersRes.error)

  // Agrupar items en memoria — no hay N+1
  type ItemAgg = { item_count: number; total_units: number; total_value: number }
  const itemAggMap = new Map<string, ItemAgg>()
  for (const item of itemsRes.data ?? []) {
    const prev = itemAggMap.get(item.adjustment_id) ?? { item_count: 0, total_units: 0, total_value: 0 }
    prev.item_count += 1
    prev.total_units += Number(item.quantity || 0)
    prev.total_value += Number(item.total_cost || 0)
    itemAggMap.set(item.adjustment_id, prev)
  }

  const warehouseMap = new Map<string, string>(
    (warehousesRes.data ?? []).map((w: any) => [w.id, w.name])
  )
  const userMap = new Map<string, string>(
    (usersRes.data ?? []).map((u: any) => {
      const name = [u.nombre, u.apellido].filter(Boolean).join(' ').trim()
      return [u.id, name]
    })
  )

  if (process.env.NODE_ENV === 'development') {
    console.log('[adjustments:list]', {
      companyId,
      count: data.length,
      adjustments: data.map((a: any) => ({
        adjustment_number: a.adjustment_number,
        status: a.status,
        company_id: a.company_id,
      })),
    })
  }

  const result = data.map((d: any) => {
    const agg = itemAggMap.get(d.id) ?? { item_count: 0, total_units: 0, total_value: 0 }
    const rawName = d.created_by ? (userMap.get(d.created_by) ?? null) : null
    return {
      ...d,
      warehouse_name: warehouseMap.get(d.warehouse_id) || 'Bodega desconocida',
      item_count: agg.item_count,
      total_units: agg.total_units,
      total_value: agg.total_value,
      created_by_name: rawName,
    } as StockAdjustment
  })
  if (process.env.NODE_ENV === 'development') console.timeEnd('getStockAdjustments')
  return result
}

// ─── getStockAdjustmentDetails ────────────────────────────────────────────────
export async function getStockAdjustmentDetails(id: string): Promise<{ adjustment: StockAdjustment | null, items: StockAdjustmentItem[] }> {
  if (process.env.NODE_ENV === 'development') console.time('getAdjustmentDetails')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    if (process.env.NODE_ENV === 'development') console.timeEnd('getAdjustmentDetails')
    return { adjustment: null, items: [] }
  }

  const companyId = await getActiveCompanyId()
  if (!companyId) {
    if (process.env.NODE_ENV === 'development') console.timeEnd('getAdjustmentDetails')
    return { adjustment: null, items: [] }
  }

  const db = logDb()
  if (process.env.NODE_ENV === 'development') console.time('getAdjustmentDetails:header')
  const { data: adj, error: err1 } = await db
    .from('stock_adjustments')
    .select('*')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()
  if (process.env.NODE_ENV === 'development') console.timeEnd('getAdjustmentDetails:header')

  if (err1 || !adj) {
    console.error('Error fetching stock adjustment:', err1)
    if (process.env.NODE_ENV === 'development') console.timeEnd('getAdjustmentDetails')
    return { adjustment: null, items: [] }
  }

  if (process.env.NODE_ENV === 'development') console.time('getAdjustmentDetails:items')
  const { data: items, error: err2 } = await db
    .from('stock_adjustment_items')
    .select('*')
    .eq('adjustment_id', id)
  if (process.env.NODE_ENV === 'development') console.timeEnd('getAdjustmentDetails:items')

  if (err2) {
    console.error('Error fetching adjustment items:', err2)
    if (process.env.NODE_ENV === 'development') console.timeEnd('getAdjustmentDetails')
    return { adjustment: null, items: [] }
  }

  const productIds = Array.from(new Set((items ?? []).map((i: any) => i.product_id).filter(Boolean)))
  const locationIds = Array.from(new Set((items ?? []).map((i: any) => i.location_id).filter(Boolean)))
  const warehouseIds = adj.warehouse_id ? [adj.warehouse_id] : []
  const userIds = adj.created_by ? [adj.created_by] : []

  if (process.env.NODE_ENV === 'development') console.time('getAdjustmentDetails:lookups')
  const [productsRes, locationsRes, warehousesRes, usersRes] = await Promise.all([
    productIds.length > 0
      ? adqDb().from('products').select('id, sku, description').in('id', productIds)
      : Promise.resolve({ data: [], error: null }),
    locationIds.length > 0
      ? db.from('locations').select('id, code').in('id', locationIds)
      : Promise.resolve({ data: [], error: null }),
    warehouseIds.length > 0
      ? adqDb().from('warehouses').select('id, name').in('id', warehouseIds)
      : Promise.resolve({ data: [], error: null }),
    userIds.length > 0
      ? portalDb().from('users').select('id, nombre, apellido').in('id', userIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (process.env.NODE_ENV === 'development') console.timeEnd('getAdjustmentDetails:lookups')

  if (productsRes.error) console.error('Error fetching adjustment products:', productsRes.error)
  if (locationsRes.error) console.error('Error fetching adjustment locations:', locationsRes.error)
  if (warehousesRes.error) console.error('Error fetching adjustment warehouse:', warehousesRes.error)
  if (usersRes.error) console.error('Error fetching adjustment user:', usersRes.error)

  const productMap = new Map((productsRes.data ?? []).map((p: any) => [p.id, p]))
  const locationMap = new Map((locationsRes.data ?? []).map((l: any) => [l.id, l.code]))
  const warehouseMap = new Map((warehousesRes.data ?? []).map((w: any) => [w.id, w.name]))
  const userMap = new Map(
    (usersRes.data ?? []).map((u: any) => {
      const name = [u.nombre, u.apellido].filter(Boolean).join(' ').trim()
      return [u.id, name]
    })
  )

  const enrichedItems = (items || []).map((i: any) => ({
    ...i,
    product_sku: productMap.get(i.product_id)?.sku,
    product_description: productMap.get(i.product_id)?.description,
    location_code: locationMap.get(i.location_id),
  })) as StockAdjustmentItem[]

  const total_units = enrichedItems.reduce((acc, i) => acc + Number(i.quantity || 0), 0)
  const total_value = enrichedItems.reduce((acc, i) => acc + Number(i.total_cost || 0), 0)
  const rawName = adj.created_by ? (userMap.get(adj.created_by) ?? null) : null

  const result = {
    adjustment: {
      ...adj,
      warehouse_name: warehouseMap.get(adj.warehouse_id) || 'Bodega desconocida',
      item_count: enrichedItems.length,
      total_units,
      total_value,
      created_by_name: rawName,
    } as StockAdjustment,
    items: enrichedItems,
  }
  if (process.env.NODE_ENV === 'development') console.timeEnd('getAdjustmentDetails')
  return result
}

// ─── createStockAdjustment ────────────────────────────────────────────────────
export async function createStockAdjustment(data: {
  type: 'INITIAL' | 'POSITIVE' | 'NEGATIVE'
  reason: string
  warehouse_id: string
  notes?: string
  items: Array<{
    product_id: string
    location_id: string
    lot_number?: string
    expiration_date?: string
    quantity: number
    unit_cost?: number
    notes?: string
  }>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Usuario no autenticado' }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { success: false, error: 'Empresa no seleccionada' }

  const db = logDb()
  if (process.env.NODE_ENV === 'development') {
    console.log('[adjustments:create:payload]', {
      companyId,
      userId: user.id,
      type: data.type,
      warehouse_id: data.warehouse_id,
      items: data.items.length,
    })
  }

  const { data: result, error } = await db.rpc('create_stock_adjustment_db', {
    p_company_id: companyId,
    p_adjustment_type: data.type,
    p_reason: data.reason,
    p_warehouse_id: data.warehouse_id,
    p_notes: data.notes || '',
    p_items: data.items,
    p_user_id: user.id
  })

  if (error) {
    console.error('Error creating stock adjustment:', error)
    return { success: false, error: error.message }
  }

  if (process.env.NODE_ENV === 'development') {
    console.log('[adjustments:create:result]', result)
  }

  if (result && result.success) {
    return { ...result, message: `Ajuste emitido correctamente ${result.adjustment_number || ''}`.trim() }
  }

  return { success: false, error: result?.error || 'Error desconocido al crear el ajuste' }
}
