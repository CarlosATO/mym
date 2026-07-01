const fs = require('fs');
let code = fs.readFileSync('src/app/actions/logistica/recepciones.ts', 'utf8');

// 1. Fix getKardexMovements
code = code.replace(
\`export async function getKardexMovements(): Promise<KardexMovement[]> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const companyId = await getActiveCompanyId()
  if (!companyId) return []

  const db = logDb()
  const { data, error } = await db
    .from('kardex_movements')
    .select('*')
    .eq('company_id', companyId)
    .order('movement_date', { ascending: false })\`,
\`export async function getKardexMovements(productId?: string): Promise<KardexMovement[]> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const companyId = await getActiveCompanyId()
  if (!companyId) return []

  const db = logDb()
  let query = db
    .from('kardex_movements')
    .select('*')
    .eq('company_id', companyId)
    .order('movement_date', { ascending: true })

  if (productId) {
    query = query.eq('product_id', productId)
  }

  const { data, error } = await query\`
);

// 2. Fix StockItem
code = code.replace(
\`export interface StockItem {
  product_id: string
  product_sku: string
  product_description: string
  warehouse_id: string
  warehouse_name: string
  location_id: string | null
  location_code: string | null
  lot_number: string | null
  expiration_date: string | null
  quantity: number
}\`,
\`export interface StockItem {
  product_id: string
  product_sku: string
  product_description: string
  warehouse_id: string
  warehouse_name: string
  location_id: string | null
  location_code: string | null
  lot_number: string | null
  expiration_date: string | null
  quantity: number
  unit_cost: number | null
}\`
);

// 3. Fix getStockSummary
code = code.replace(
\`export async function getStockSummary(): Promise<StockItem[]> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const companyId = await getActiveCompanyId()
  if (!companyId) return []

  const db = logDb()
  const { data: movements, error } = await db
    .from('kardex_movements')
    .select('product_id, warehouse_id, location_id, lot_number, expiration_date, quantity, movement_type')
    .eq('company_id', companyId)

  if (error) {
    console.error('getStockSummary error:', error)
    return []
  }

  if (!movements || movements.length === 0) return []

  // Group and sum in memory
  const stockMap = new Map<string, {
    product_id: string
    warehouse_id: string
    location_id: string | null
    lot_number: string | null
    expiration_date: string | null
    quantity: number
  }>()

  for (const m of movements) {
    const key = \\\`\\\${m.product_id}_\\\${m.warehouse_id}_\\\${m.location_id || 'null'}_\\\\${m.lot_number || 'null'}_\\\\${m.expiration_date || 'null'}\\\`
    const qty = Number(m.quantity)
    const sign = ['IN', 'TRANSFER_IN', 'ADJUSTMENT'].includes(m.movement_type) ? 1 : -1
    const delta = qty * sign

    const existing = stockMap.get(key)
    if (existing) {
      existing.quantity += delta
    } else {
      stockMap.set(key, {
        product_id: m.product_id,
        warehouse_id: m.warehouse_id,
        location_id: m.location_id,
        lot_number: m.lot_number,
        expiration_date: m.expiration_date,
        quantity: delta
      })
    }
  }

  // Filter out zero/negative stock items to show active inventory only
  let stockItems = Array.from(stockMap.values()).filter(item => item.quantity > 0)

  if (stockItems.length === 0) return []

  // Join product and warehouse details
  const productIds = Array.from(new Set(stockItems.map(d => d.product_id)))
  const warehouseIds = Array.from(new Set(stockItems.map(d => d.warehouse_id)))
  const locationIds = Array.from(new Set(stockItems.map(d => d.location_id).filter(Boolean)))

  const adq = adqDb()
  const [productsRes, warehousesRes, locationsRes] = await Promise.all([
    adq.from('products').select('id, sku, description').in('id', productIds),
    adq.from('warehouses').select('id, name').in('id', warehouseIds),
    db.from('locations').select('id, code').in('id', locationIds)
  ])

  const productMap = new Map(productsRes.data?.map(p => [p.id, p]) ?? [])
  const warehouseMap = new Map(warehousesRes.data?.map(w => [w.id, w.name]) ?? [])
  const locationMap = new Map(locationsRes.data?.map(l => [l.id, l.code]) ?? [])

  return stockItems.map(item => {
    const prod = productMap.get(item.product_id)
    return {
      product_id: item.product_id,
      product_sku: prod?.sku || 'SKU Desconocido',
      product_description: prod?.description || 'Producto Desconocido',
      warehouse_id: item.warehouse_id,
      warehouse_name: warehouseMap.get(item.warehouse_id) || 'Almacén Desconocido',
      location_id: item.location_id,
      location_code: item.location_id ? locationMap.get(item.location_id) || null : null,
      lot_number: item.lot_number,
      expiration_date: item.expiration_date,
      quantity: item.quantity
    }
  })
}\`,
\`export async function getStockSummary(): Promise<StockItem[]> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const companyId = await getActiveCompanyId()
  if (!companyId) return []

  const db = logDb()
  const { data: movements, error } = await db
    .from('kardex_movements')
    .select('product_id, warehouse_id, location_id, lot_number, expiration_date, quantity, movement_type, unit_cost')
    .eq('company_id', companyId)
    .order('movement_date', { ascending: true })

  if (error) {
    console.error('getStockSummary error:', error)
    return []
  }

  if (!movements || movements.length === 0) return []

  // Group and sum in memory
  const stockMap = new Map<string, {
    product_id: string
    warehouse_id: string
    location_id: string | null
    lot_number: string | null
    expiration_date: string | null
    quantity: number
    unit_cost: number | null
  }>()

  for (const m of movements) {
    const key = \\\`\\\${m.product_id}_\\\${m.warehouse_id}_\\\${m.location_id || 'null'}_\\\\${m.lot_number || 'null'}_\\\\${m.expiration_date || 'null'}\\\`
    const qty = Number(m.quantity)
    const sign = ['IN', 'TRANSFER_IN', 'ADJUSTMENT'].includes(m.movement_type) ? 1 : -1
    const delta = qty * sign

    const existing = stockMap.get(key)
    if (existing) {
      existing.quantity += delta
      if (['IN', 'PURCHASE_RECEIPT', 'ADJUSTMENT'].includes(m.movement_type) && m.unit_cost !== null && m.unit_cost > 0) {
        existing.unit_cost = Number(m.unit_cost)
      }
    } else {
      stockMap.set(key, {
        product_id: m.product_id,
        warehouse_id: m.warehouse_id,
        location_id: m.location_id,
        lot_number: m.lot_number,
        expiration_date: m.expiration_date,
        quantity: delta,
        unit_cost: m.unit_cost !== null ? Number(m.unit_cost) : null
      })
    }
  }

  // Filter out zero/negative stock items to show active inventory only
  let stockItems = Array.from(stockMap.values()).filter(item => item.quantity > 0)

  if (stockItems.length === 0) return []

  // Join product and warehouse details
  const productIds = Array.from(new Set(stockItems.map(d => d.product_id)))
  const warehouseIds = Array.from(new Set(stockItems.map(d => d.warehouse_id)))
  const locationIds = Array.from(new Set(stockItems.map(d => d.location_id).filter(Boolean)))

  const adq = adqDb()
  const [productsRes, warehousesRes, locationsRes] = await Promise.all([
    adq.from('products').select('id, sku, description').in('id', productIds),
    adq.from('warehouses').select('id, name').in('id', warehouseIds),
    db.from('locations').select('id, code').in('id', locationIds)
  ])

  const productMap = new Map(productsRes.data?.map(p => [p.id, p]) ?? [])
  const warehouseMap = new Map(warehousesRes.data?.map(w => [w.id, w.name]) ?? [])
  const locationMap = new Map(locationsRes.data?.map(l => [l.id, l.code]) ?? [])

  return stockItems.map(item => {
    const prod = productMap.get(item.product_id)
    return {
      product_id: item.product_id,
      product_sku: prod?.sku || 'SKU Desconocido',
      product_description: prod?.description || 'Producto Desconocido',
      warehouse_id: item.warehouse_id,
      warehouse_name: warehouseMap.get(item.warehouse_id) || 'Almacén Desconocido',
      location_id: item.location_id,
      location_code: item.location_id ? locationMap.get(item.location_id) || null : null,
      lot_number: item.lot_number,
      expiration_date: item.expiration_date,
      quantity: item.quantity,
      unit_cost: item.unit_cost
    }
  })
}\`
);

fs.writeFileSync('src/app/actions/logistica/recepciones.ts', code, 'utf8');
