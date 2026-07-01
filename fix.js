const fs = require('fs');

const file = 'src/app/actions/logistica/recepciones.ts';
let code = fs.readFileSync(file, 'utf8');

const targetStr = `export interface StockItem {
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
}

export async function getStockSummary(): Promise<StockItem[]> {
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
    const key = \`\${m.product_id}_\${m.warehouse_id}_\${m.location_id || 'null'}_\${m.lot_number || 'null'}_\${m.expiration_date || 'null'}\`
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
}`;

const replacementStr = `export interface StockItem {
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
}

export async function getStockSummary(): Promise<StockItem[]> {
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
    const key = \`\${m.product_id}_\${m.warehouse_id}_\${m.location_id || 'null'}_\${m.lot_number || 'null'}_\${m.expiration_date || 'null'}\`
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
}`;

code = code.replace(targetStr, replacementStr);
fs.writeFileSync(file, code, 'utf8');

const contentToAppend = `
export async function getReceiptDocumentSignedUrl(document: any) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' }

  const logistica = logDb()
  
  if (!document.storage_path) return { error: 'Documento sin ruta de almacenamiento' }

  const { data: receipt, error: receiptError } = await logistica
    .from('purchase_receipts')
    .select('id, company_id, purchase_order_id')
    .eq('id', document.receipt_id)
    .maybeSingle()

  if (receiptError) {
    console.error('getReceiptDocumentSignedUrl receipt error:', receiptError)
    return { error: 'Error al validar la recepción' }
  }

  if (!receipt) return { error: 'Recepción no encontrada' }
  if (receipt.company_id !== companyId) return { error: 'Acceso denegado a la recepción' }

  const adquisiciones = adqDb()
  const { data: purchaseOrder, error: poError } = await adquisiciones
    .from('purchase_orders')
    .select('id, company_id')
    .eq('id', receipt.purchase_order_id)
    .maybeSingle()

  if (poError) {
    console.error('getReceiptDocumentSignedUrl purchase order error:', poError)
    return { error: 'Error al validar la orden de compra' }
  }

  if (!purchaseOrder || purchaseOrder.company_id !== companyId) {
    return { error: 'Acceso denegado a la orden de compra' }
  }

  const expiresIn = 300
  const { data: signedData, error: signedError } = await logistica.storage
    .from(document.storage_bucket || 'recepciones')
    .createSignedUrl(document.storage_path, expiresIn)

  if (signedError || !signedData?.signedUrl) {
    console.error('getReceiptDocumentSignedUrl storage error:', signedError)
    return { error: 'No se pudo generar la previsualización del documento' }
  }

  return {
    signedUrl: signedData.signedUrl,
    fileName: document.file_name || 'Documento de recepción',
    mimeType: document.mime_type || null,
    expiresIn
  }
}
`;
fs.appendFileSync(file, contentToAppend, 'utf8');
