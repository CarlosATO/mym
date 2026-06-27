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

export interface TransferStockOption {
  product_id: string
  product_sku: string
  product_description: string
  warehouse_id: string
  warehouse_name: string
  location_id: string
  location_code: string
  lot_number: string | null
  expiration_date: string | null
  quantity: number
  unit_cost: number | null
}

export interface TransferDestinationLocation {
  id: string
  code: string
  name: string | null
  warehouse_id: string
  warehouse_name: string
}

export interface TransferWarehouse {
  id: string
  name: string
}

export interface StockTransferSummary {
  id: string
  transfer_number: string
  date: string
  from_warehouse_id: string
  from_warehouse: string
  to_warehouse_id: string
  to_warehouse: string
  to_location_id: string
  to_location: string
  line_count: number
  total_quantity: number
  status: string
  notes: string | null
  created_by_name: string | null
}

export interface StockTransferDetail extends StockTransferSummary {
  items: Array<{
    id: string
    product_id: string
    product_sku: string
    product_description: string
    from_location_id: string
    from_location: string
    lot_number: string | null
    expiration_date: string | null
    quantity: number
    unit_cost: number | null
    total_cost: number | null
    notes: string | null
  }>
}

export interface CreateStockTransferLineInput {
  product_id: string
  from_location_id: string
  lot_number?: string | null
  expiration_date?: string | null
  quantity: number
  notes?: string | null
}

type StockGroup = {
  product_id: string
  warehouse_id: string
  location_id: string | null
  lot_number: string | null
  expiration_date: string | null
  quantity: number
  cost_balance: number
}

async function getUserAndCompany() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' as const }

  const companyId = await getActiveCompanyId(user)
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' as const }

  return { user, companyId, supabase }
}

async function getAvailableStockGroups(companyId: string): Promise<StockGroup[]> {
  const db = logDb()
  const { data: movements, error } = await db
    .from('kardex_movements')
    .select('product_id, warehouse_id, location_id, lot_number, expiration_date, quantity, movement_type, unit_cost, total_cost')
    .eq('company_id', companyId)

  if (error || !movements) return []

  const map = new Map<string, StockGroup>()
  for (const movement of movements) {
    const key = `${movement.product_id}_${movement.warehouse_id}_${movement.location_id || 'null'}_${movement.lot_number || 'null'}_${movement.expiration_date || 'null'}`
    const sign = ['IN', 'TRANSFER_IN', 'ADJUSTMENT'].includes(movement.movement_type) ? 1 : -1
    const quantity = Number(movement.quantity || 0) * sign
    const unitCost = movement.unit_cost === null ? 0 : Number(movement.unit_cost || 0)
    const totalCost = movement.total_cost === null ? Math.abs(Number(movement.quantity || 0)) * unitCost : Number(movement.total_cost || 0)
    const costDelta = totalCost * sign
    const existing = map.get(key)

    if (existing) {
      existing.quantity += quantity
      existing.cost_balance += costDelta
    } else {
      map.set(key, {
        product_id: movement.product_id,
        warehouse_id: movement.warehouse_id,
        location_id: movement.location_id,
        lot_number: movement.lot_number,
        expiration_date: movement.expiration_date,
        quantity,
        cost_balance: costDelta,
      })
    }
  }

  return Array.from(map.values()).filter(item => item.location_id && item.quantity > 0)
}

export async function getTransferStockOptions(): Promise<TransferStockOption[]> {
  const auth = await getUserAndCompany()
  if ('error' in auth) return []

  const stockGroups = await getAvailableStockGroups(auth.companyId)
  if (stockGroups.length === 0) return []

  const productIds = Array.from(new Set(stockGroups.map(item => item.product_id)))
  const warehouseIds = Array.from(new Set(stockGroups.map(item => item.warehouse_id)))
  const locationIds = Array.from(new Set(stockGroups.map(item => item.location_id).filter(Boolean))) as string[]
  const adq = adqDb()
  const logistica = logDb()

  const [productsRes, warehousesRes, locationsRes] = await Promise.all([
    adq.from('products').select('id, sku, description').in('id', productIds),
    adq.from('warehouses').select('id, name').in('id', warehouseIds),
    logistica.from('locations').select('id, code').in('id', locationIds),
  ])

  const productMap = new Map(productsRes.data?.map(product => [product.id, product]) ?? [])
  const warehouseMap = new Map(warehousesRes.data?.map(warehouse => [warehouse.id, warehouse.name]) ?? [])
  const locationMap = new Map(locationsRes.data?.map(location => [location.id, location.code]) ?? [])

  return stockGroups.map(item => {
    const product = productMap.get(item.product_id)
    const unitCost = item.quantity > 0 && item.cost_balance > 0 ? item.cost_balance / item.quantity : null
    return {
      product_id: item.product_id,
      product_sku: product?.sku || 'SKU Desconocido',
      product_description: product?.description || 'Producto Desconocido',
      warehouse_id: item.warehouse_id,
      warehouse_name: warehouseMap.get(item.warehouse_id) || 'Bodega Desconocida',
      location_id: item.location_id!,
      location_code: locationMap.get(item.location_id!) || 'Sin ubicación',
      lot_number: item.lot_number,
      expiration_date: item.expiration_date,
      quantity: item.quantity,
      unit_cost: unitCost,
    }
  }).sort((a, b) => `${a.product_sku}${a.warehouse_name}${a.location_code}`.localeCompare(`${b.product_sku}${b.warehouse_name}${b.location_code}`))
}

export async function getTransferWarehouses(): Promise<TransferWarehouse[]> {
  const auth = await getUserAndCompany()
  if ('error' in auth) return []

  const { data } = await adqDb()
    .from('warehouses')
    .select('id, name')
    .eq('company_id', auth.companyId)
    .eq('is_active', true)
    .eq('status', 'ACTIVE')
    .order('name')

  return (data ?? []).map(warehouse => ({ id: warehouse.id, name: warehouse.name }))
}

export async function getTransferDestinations(warehouseId?: string): Promise<TransferDestinationLocation[]> {
  const auth = await getUserAndCompany()
  if ('error' in auth) return []

  const adq = adqDb()
  const logistica = logDb()
  
  let warehouseQuery = adq
    .from('warehouses')
    .select('id, name')
    .eq('company_id', auth.companyId)
    .eq('is_active', true)
    .eq('status', 'ACTIVE')

  if (warehouseId) {
    warehouseQuery = warehouseQuery.eq('id', warehouseId)
  }

  const { data: warehouses } = await warehouseQuery

  if (!warehouses || warehouses.length === 0) return []

  const warehouseMap = new Map(warehouses.map(warehouse => [warehouse.id, warehouse.name]))
  
  let locationsQuery = logistica
    .from('locations')
    .select('id, code, name, warehouse_id')
    .eq('company_id', auth.companyId)
    .eq('is_active', true)

  if (warehouseId) {
    locationsQuery = locationsQuery.eq('warehouse_id', warehouseId)
  } else {
    locationsQuery = locationsQuery.in('warehouse_id', warehouses.map(warehouse => warehouse.id))
  }

  // Aumentar el límite por si hay muchas ubicaciones en una bodega
  const { data: locations } = await locationsQuery
    .order('code')
    .limit(5000)

  return (locations ?? []).map(location => ({
    id: location.id,
    code: location.code,
    name: location.name,
    warehouse_id: location.warehouse_id,
    warehouse_name: warehouseMap.get(location.warehouse_id) || 'Bodega Desconocida',
  }))
}

export async function createStockTransfer(input: {
  from_warehouse_id: string
  to_warehouse_id: string
  to_location_id: string
  notes?: string | null
  items: CreateStockTransferLineInput[]
}) {
  const auth = await getUserAndCompany()
  if ('error' in auth) return { error: auth.error }

  if (!input.from_warehouse_id || !input.to_warehouse_id || !input.to_location_id) return { error: 'Debe seleccionar bodega origen, bodega destino y ubicación destino' }
  if (input.from_warehouse_id === input.to_warehouse_id) return { error: 'El traspaso entre bodegas requiere una bodega destino distinta a la bodega origen' }
  if (!input.items || input.items.length === 0) return { error: 'Debe agregar al menos una línea al traspaso' }

  const { data: { session } } = await auth.supabase.auth.getSession()
  const rpcDb = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    db: { schema: 'logistica' },
    global: { headers: { Authorization: `Bearer ${session?.access_token}` } },
  })

  const payload = {
    company_id: auth.companyId,
    from_warehouse_id: input.from_warehouse_id,
    to_warehouse_id: input.to_warehouse_id,
    to_location_id: input.to_location_id,
    notes: input.notes || null,
    items: input.items.map(item => ({
      product_id: item.product_id,
      from_location_id: item.from_location_id,
      lot_number: item.lot_number || null,
      expiration_date: item.expiration_date || null,
      quantity: Number(item.quantity || 0),
      notes: item.notes || null,
    })),
  }

  const { data, error } = await rpcDb.rpc('create_stock_transfer', { p_payload: payload })
  if (error) {
    console.error('createStockTransfer RPC error:', error)
    return { error: error.message }
  }

  const result = data as { success?: boolean; error?: string; transfer_id?: string; transfer_number?: string }
  if (!result?.success) return { error: result?.error || 'No se pudo registrar el traspaso' }
  return { success: true, transfer_id: result.transfer_id, transfer_number: result.transfer_number }
}

export async function getStockTransfers(): Promise<StockTransferSummary[]> {
  if (process.env.NODE_ENV === 'development') console.time('getStockTransfers')
  const auth = await getUserAndCompany()
  if ('error' in auth) {
    if (process.env.NODE_ENV === 'development') console.timeEnd('getStockTransfers')
    return []
  }

  const logistica = logDb()
  if (process.env.NODE_ENV === 'development') console.time('getStockTransfers:base')
  const { data, error } = await logistica
    .from('stock_transfers')
    .select('id, transfer_number, transfer_date, from_warehouse_id, to_warehouse_id, to_location_id, status, notes, created_by, stock_transfer_items(id, quantity)')
    .eq('company_id', auth.companyId)
    .order('transfer_date', { ascending: false })
    .limit(50)
  if (process.env.NODE_ENV === 'development') console.timeEnd('getStockTransfers:base')

  if (error || !data || data.length === 0) {
    if (process.env.NODE_ENV === 'development') console.timeEnd('getStockTransfers')
    return []
  }

  const warehouseIds = Array.from(new Set(data.flatMap(transfer => [transfer.from_warehouse_id, transfer.to_warehouse_id])))
  const locationIds = Array.from(new Set(data.map(transfer => transfer.to_location_id).filter(Boolean))) as string[]
  const userIds = Array.from(new Set(data.map(transfer => transfer.created_by).filter(Boolean))) as string[]
  
  if (process.env.NODE_ENV === 'development') console.time('getStockTransfers:lookups')
  const [warehousesRes, locationsRes, usersRes] = await Promise.all([
    adqDb().from('warehouses').select('id, name').in('id', warehouseIds),
    locationIds.length > 0 ? logistica.from('locations').select('id, code').in('id', locationIds) : Promise.resolve({ data: [] as any[] }),
    userIds.length > 0 ? createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, { db: { schema: 'portal' }, auth: { autoRefreshToken: false, persistSession: false } }).from('users').select('id, nombre, apellido').in('id', userIds) : Promise.resolve({ data: [] as any[] }),
  ])
  if (process.env.NODE_ENV === 'development') console.timeEnd('getStockTransfers:lookups')

  const warehouseMap = new Map(warehousesRes.data?.map(warehouse => [warehouse.id, warehouse.name]) ?? [])
  const locationMap = new Map(locationsRes.data?.map(location => [location.id, location.code]) ?? [])
  const userMap = new Map(usersRes.data?.map(user => [user.id, `${user.nombre || ''} ${user.apellido || ''}`.trim()]) ?? [])

  const result = data.map((transfer: any) => ({
    id: transfer.id,
    transfer_number: transfer.transfer_number,
    date: transfer.transfer_date,
    from_warehouse_id: transfer.from_warehouse_id,
    from_warehouse: warehouseMap.get(transfer.from_warehouse_id) || 'Bodega Desconocida',
    to_warehouse_id: transfer.to_warehouse_id,
    to_warehouse: warehouseMap.get(transfer.to_warehouse_id) || 'Bodega Desconocida',
    to_location_id: transfer.to_location_id,
    to_location: locationMap.get(transfer.to_location_id) || 'Ubicación Desconocida',
    line_count: transfer.stock_transfer_items?.length || 0,
    total_quantity: (transfer.stock_transfer_items || []).reduce((acc: number, item: any) => acc + Number(item.quantity || 0), 0),
    status: transfer.status,
    notes: transfer.notes,
    created_by_name: transfer.created_by ? userMap.get(transfer.created_by) || null : null,
  }))
  if (process.env.NODE_ENV === 'development') console.timeEnd('getStockTransfers')
  return result
}

export async function getStockTransferDetail(transferId: string): Promise<StockTransferDetail | null> {
  if (process.env.NODE_ENV === 'development') console.time('getStockTransferDetail')
  const auth = await getUserAndCompany()
  if ('error' in auth || !transferId) {
    if (process.env.NODE_ENV === 'development') console.timeEnd('getStockTransferDetail')
    return null
  }

  const logistica = logDb()
  if (process.env.NODE_ENV === 'development') console.time('getStockTransferDetail:base')
  const { data: transfer, error } = await logistica
    .from('stock_transfers')
    .select('id, transfer_number, transfer_date, from_warehouse_id, to_warehouse_id, to_location_id, status, notes, created_by, stock_transfer_items(*)')
    .eq('company_id', auth.companyId)
    .eq('id', transferId)
    .maybeSingle()
  if (process.env.NODE_ENV === 'development') console.timeEnd('getStockTransferDetail:base')

  if (error || !transfer) {
    if (process.env.NODE_ENV === 'development') console.timeEnd('getStockTransferDetail')
    return null
  }

  const items = (transfer as any).stock_transfer_items || []
  const productIds = Array.from(new Set(items.map((item: any) => item.product_id))) as string[]
  const locationIds = Array.from(new Set([transfer.to_location_id, ...items.map((item: any) => item.from_location_id)])).filter(Boolean) as string[]
  const warehouseIds = [transfer.from_warehouse_id, transfer.to_warehouse_id]
  const userIds = transfer.created_by ? [transfer.created_by] : []

  if (process.env.NODE_ENV === 'development') console.time('getStockTransferDetail:lookups')
  const [productsRes, warehousesRes, locationsRes, usersRes] = await Promise.all([
    productIds.length > 0 ? adqDb().from('products').select('id, sku, description').in('id', productIds) : Promise.resolve({ data: [] as any[] }),
    adqDb().from('warehouses').select('id, name').in('id', warehouseIds),
    locationIds.length > 0 ? logistica.from('locations').select('id, code').in('id', locationIds) : Promise.resolve({ data: [] as any[] }),
    userIds.length > 0 ? createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, { db: { schema: 'portal' }, auth: { autoRefreshToken: false, persistSession: false } }).from('users').select('id, nombre, apellido').in('id', userIds) : Promise.resolve({ data: [] as any[] }),
  ])
  if (process.env.NODE_ENV === 'development') console.timeEnd('getStockTransferDetail:lookups')

  const productMap = new Map(productsRes.data?.map(product => [product.id, product]) ?? [])
  const warehouseMap = new Map(warehousesRes.data?.map(warehouse => [warehouse.id, warehouse.name]) ?? [])
  const locationMap = new Map(locationsRes.data?.map(location => [location.id, location.code]) ?? [])
  const userMap = new Map(usersRes.data?.map(user => [user.id, `${user.nombre || ''} ${user.apellido || ''}`.trim()]) ?? [])

  const result = {
    id: transfer.id,
    transfer_number: transfer.transfer_number,
    date: transfer.transfer_date,
    from_warehouse_id: transfer.from_warehouse_id,
    from_warehouse: warehouseMap.get(transfer.from_warehouse_id) || 'Bodega Desconocida',
    to_warehouse_id: transfer.to_warehouse_id,
    to_warehouse: warehouseMap.get(transfer.to_warehouse_id) || 'Bodega Desconocida',
    to_location_id: transfer.to_location_id,
    to_location: locationMap.get(transfer.to_location_id) || 'Ubicación Desconocida',
    line_count: items.length,
    total_quantity: items.reduce((acc: number, item: any) => acc + Number(item.quantity || 0), 0),
    status: transfer.status,
    notes: transfer.notes,
    created_by_name: transfer.created_by ? userMap.get(transfer.created_by) || null : null,
    items: items.map((item: any) => {
      const product = productMap.get(item.product_id)
      return {
        id: item.id,
        product_id: item.product_id,
        product_sku: product?.sku || 'SKU Desconocido',
        product_description: product?.description || 'Producto Desconocido',
        from_location_id: item.from_location_id,
        from_location: locationMap.get(item.from_location_id) || '—',
        lot_number: item.lot_number,
        expiration_date: item.expiration_date,
        quantity: Number(item.quantity || 0),
        unit_cost: item.unit_cost === null ? null : Number(item.unit_cost),
        total_cost: item.total_cost === null ? null : Number(item.total_cost),
        notes: item.notes,
      }
    }),
  }
  if (process.env.NODE_ENV === 'development') console.timeEnd('getStockTransferDetail')
  return result
}
