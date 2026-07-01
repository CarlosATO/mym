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

export interface LocationLayout {
  id: string
  company_id: string
  warehouse_id: string
  location_id: string
  floor: number
  x: number
  y: number
  width: number
  height: number
  rotation: number
  layout_group: string | null
}

export interface LocationWithLayout {
  id: string
  code: string
  name: string | null
  aisle: string | null
  rack: string | null
  level: string | null
  position: string | null
  description: string | null
  is_active: boolean
  layout: LocationLayout | null
}

export interface WarehouseStats {
  warehouse_id: string
  warehouse_code: string
  warehouse_name: string
  total_locations: number
  active_locations: number
  inactive_locations: number
  locations_with_stock: number
  total_aisles: number
}

export async function getWarehouseLocationStats(): Promise<WarehouseStats[]> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const companyId = await getActiveCompanyId()
  if (!companyId) return []

  const logDatabase = logDb()
  const adqDatabase = adqDb()

  // 1. Get warehouses
  const { data: warehouses, error: wErr } = await adqDatabase
    .from('warehouses')
    .select('id, code, name')
    .eq('company_id', companyId)

  if (wErr || !warehouses) return []

  // 2. Get locations
  const { data: locations, error: lErr } = await logDatabase
    .from('locations')
    .select('id, warehouse_id, is_active, aisle')
    .eq('company_id', companyId)

  if (lErr || !locations) return []

  // 3. Get stock
  const { data: stock, error: sErr } = await logDatabase
    .from('v_stock_by_location')
    .select('location_id, quantity')
    .eq('company_id', companyId)

  if (sErr) console.error('Error fetching stock:', sErr)

  // Map stock to locations
  const locationsWithStock = new Set(
    (stock || []).filter(s => s.quantity > 0).map(s => s.location_id)
  )

  const stats: WarehouseStats[] = warehouses.map(w => {
    const wLocations = locations.filter(l => l.warehouse_id === w.id)
    const active = wLocations.filter(l => l.is_active).length
    const withStock = wLocations.filter(l => locationsWithStock.has(l.id)).length
    const aisles = new Set(wLocations.map(l => l.aisle).filter(Boolean))

    return {
      warehouse_id: w.id,
      warehouse_code: w.code,
      warehouse_name: w.name,
      total_locations: wLocations.length,
      active_locations: active,
      inactive_locations: wLocations.length - active,
      locations_with_stock: withStock,
      total_aisles: aisles.size
    }
  })

  return stats
}

export async function getWarehouseVisualData(warehouseId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const companyId = await getActiveCompanyId()
  if (!companyId) return null

  const logDatabase = logDb()
  const adqDatabase = adqDb()

  console.log('[WMS SERVER] warehouseId recibido:', warehouseId)
  console.log('[WMS SERVER] companyId:', companyId)

  const { data: warehouse } = await adqDatabase
    .from('warehouses')
    .select('*')
    .eq('id', warehouseId)
    .eq('company_id', companyId)
    .single()

  console.log('[WMS SERVER] warehouse encontrada:', warehouse?.name)

  const { data: locations } = await logDatabase
    .from('locations')
    .select('*')
    .eq('company_id', companyId)
    .eq('warehouse_id', warehouseId)

  console.log('[WMS SERVER] locations encontradas:', locations?.length || 0)

  const { data: layouts } = await logDatabase
    .from('location_layouts')
    .select('*')
    .eq('company_id', companyId)
    .eq('warehouse_id', warehouseId)

  const { data: stockByLocation } = await logDatabase
    .from('v_stock_by_location')
    .select('*')
    .eq('company_id', companyId)
    .eq('warehouse_id', warehouseId)

  return {
    warehouse: warehouse || null,
    locations: locations || [],
    layouts: layouts || [],
    stockByLocation: stockByLocation || []
  }
}

export async function saveLocationLayout(
  warehouseId: string, 
  layouts: Omit<LocationLayout, 'id' | 'company_id' | 'warehouse_id'>[]
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('No autorizado')

  const companyId = await getActiveCompanyId()
  if (!companyId) throw new Error('Empresa inactiva')

  const db = logDb()

  const upsertData = layouts.map(lay => ({
    company_id: companyId,
    warehouse_id: warehouseId,
    location_id: lay.location_id,
    floor: lay.floor ?? 1,
    x: lay.x,
    y: lay.y,
    width: lay.width,
    height: lay.height,
    rotation: lay.rotation,
    layout_group: lay.layout_group,
    updated_by: user.id,
    updated_at: new Date().toISOString()
  }))

  const { error } = await db
    .from('location_layouts')
    .upsert(upsertData, { onConflict: 'company_id,location_id' })

  if (error) {
    console.error('saveLocationLayout error:', error)
    return { success: false, error: error.message }
  }

  return { success: true }
}

export interface StockByLocation {
  location_id: string
  product_id: string
  lot_number: string | null
  expiration_date: string | null
  quantity: number
}

// Usamos la nueva vista SQL optimizada
export async function getStockByLocation(warehouseId: string): Promise<StockByLocation[]> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const companyId = await getActiveCompanyId()
  if (!companyId) return []

  const db = logDb()
  const { data, error } = await db
    .from('v_stock_by_location')
    .select('location_id, product_id, lot_number, expiration_date, quantity')
    .eq('company_id', companyId)
    .eq('warehouse_id', warehouseId)
    .not('location_id', 'is', null)

  if (error) {
    console.error('getStockByLocation error:', error)
    return []
  }

  return data as StockByLocation[]
}

export interface LocationDetailItem {
  product_id: string
  product_sku: string
  product_description: string
  lot_number: string | null
  expiration_date: string | null
  quantity: number
}

export async function getLocationDetail(locationId: string): Promise<LocationDetailItem[]> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const companyId = await getActiveCompanyId()
  if (!companyId) return []

  const db = logDb()
  const adq = adqDb()

  const { data: stock, error: stockError } = await db
    .from('v_stock_by_location')
    .select('product_id, lot_number, expiration_date, quantity')
    .eq('company_id', companyId)
    .eq('location_id', locationId)

  if (stockError) {
    console.error('getLocationDetail stockError:', stockError)
    return []
  }

  if (!stock || stock.length === 0) return []

  const productIds = Array.from(new Set(stock.map(s => s.product_id)))
  const { data: products } = await adq
    .from('products')
    .select('id, sku, description')
    .in('id', productIds)

  const productMap = new Map(products?.map(p => [p.id, p]) ?? [])

  return stock.map(s => {
    const p = productMap.get(s.product_id)
    return {
      product_id: s.product_id,
      product_sku: p?.sku || 'SKU Desconocido',
      product_description: p?.description || 'Producto Desconocido',
      lot_number: s.lot_number,
      expiration_date: s.expiration_date,
      quantity: Number(s.quantity)
    }
  })
}
