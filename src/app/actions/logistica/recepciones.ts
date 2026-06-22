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

export interface PurchaseOrderPending {
  id: string
  correlative: string
  issue_date: string
  supplier_name: string
  warehouse_name: string | null
  po_type: string
  grand_total: number
  receipt_status: string
  status: string
  qty_ordered: number
  qty_received: number
  qty_pending: number
  amount_received: number
  latest_receipt_number: string | null
  latest_receipt_date: string | null
  latest_receipt_doc: string | null
}

export async function getPendingReceivablePOs(): Promise<PurchaseOrderPending[]> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const companyId = await getActiveCompanyId()
  if (!companyId) return []

  const db = adqDb()
  const { data, error } = await db
    .from('purchase_orders')
    .select('id, correlative, issue_date, po_type, grand_total, status, receipt_status, supplier_id, warehouse_id')
    .eq('company_id', companyId)
    .in('status', ['EMITIDA', 'RECEPCION_PARCIAL', 'RECEPCION_TOTAL'])
    .order('created_at', { ascending: false })

  if (error) {
    console.error('getPendingReceivablePOs error:', error)
    return []
  }

  if (!data || data.length === 0) return []

  // Fetch supplier names and warehouse names in parallel
  const supplierIds = Array.from(new Set(data.map(d => d.supplier_id)))
  const warehouseIds = Array.from(new Set(data.map(d => d.warehouse_id).filter(Boolean)))

  const [suppliersRes, warehousesRes] = await Promise.all([
    db.from('suppliers').select('id, business_name').in('id', supplierIds),
    db.from('warehouses').select('id, name').in('id', warehouseIds)
  ])

  const supplierMap = new Map(suppliersRes.data?.map(s => [s.id, s.business_name]) ?? [])
  const warehouseMap = new Map(warehousesRes.data?.map(w => [w.id, w.name]) ?? [])

  // Additional Fetch: Quantities
  const poIds = data.map(d => d.id)
  const { data: itemsData } = await db
    .from('purchase_order_items')
    .select('po_id, quantity, quantity_received')
    .in('po_id', poIds)

  // Additional Fetch: Receipts (from logistica schema)
  const { data: { session } } = await supabase.auth.getSession()
  const logDbClient = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    db: { schema: 'logistica' },
    global: { headers: { Authorization: `Bearer ${session?.access_token}` } }
  })
  
  const { data: receiptsData } = await logDbClient
    .from('purchase_receipts')
    .select('id, purchase_order_id, receipt_number, received_at, status, receipt_total_gross, receipt_documents(id, document_type, document_number, file_name)')
    .in('purchase_order_id', poIds)
    .order('received_at', { ascending: false })

  return data.map(po => {
    // Quantities
    const poItems = itemsData?.filter(i => i.po_id === po.id) || []
    const qtyOrdered = poItems.reduce((acc, i) => acc + Number(i.quantity || 0), 0)
    const qtyReceived = poItems.reduce((acc, i) => acc + Number(i.quantity_received || 0), 0)
    const qtyPending = Math.max(0, qtyOrdered - qtyReceived)

    // Receipts
    const poReceipts = receiptsData?.filter(r => r.purchase_order_id === po.id) || []
    const amountReceived = poReceipts.reduce((acc, r) => acc + Number(r.receipt_total_gross || 0), 0)
    
    let latestReceiptNumber = null
    let latestReceiptDate = null
    let latestReceiptDoc = null
    
    if (poReceipts.length > 0) {
      const latest = poReceipts[0]
      latestReceiptNumber = latest.receipt_number
      latestReceiptDate = latest.received_at
      if (latest.receipt_documents && latest.receipt_documents.length > 0) {
        const doc = latest.receipt_documents[0]
        latestReceiptDoc = `${doc.document_type} ${doc.document_number || ''}`.trim() || doc.file_name
      }
    }

    return {
      id: po.id,
      correlative: po.correlative,
      issue_date: po.issue_date,
      supplier_name: supplierMap.get(po.supplier_id) || 'Proveedor Desconocido',
      warehouse_name: po.warehouse_id ? warehouseMap.get(po.warehouse_id) || null : null,
      po_type: po.po_type,
      grand_total: po.grand_total,
      receipt_status: po.receipt_status || 'PENDIENTE',
      status: po.status,
      qty_ordered: qtyOrdered,
      qty_received: qtyReceived,
      qty_pending: qtyPending,
      amount_received: amountReceived,
      latest_receipt_number: latestReceiptNumber,
      latest_receipt_date: latestReceiptDate,
      latest_receipt_doc: latestReceiptDoc
    }
  })
}

export async function getPurchaseOrderForReceipt(poId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const companyId = await getActiveCompanyId()
  if (!companyId) return null

  const db = adqDb()

  // 1. Fetch Purchase Order
  const { data: po, error: poError } = await db
    .from('purchase_orders')
    .select('*')
    .eq('id', poId)
    .eq('company_id', companyId)
    .single()

  if (poError || !po) {
    console.error('getPurchaseOrderForReceipt PO error:', poError)
    return null
  }

  // 2. Fetch Supplier
  const { data: supplier } = await db
    .from('suppliers')
    .select('*')
    .eq('id', po.supplier_id)
    .single()

  // 3. Fetch Warehouse details
  let warehouseName = null
  if (po.warehouse_id) {
    const { data: wh } = await db.from('warehouses').select('name').eq('id', po.warehouse_id).single()
    warehouseName = wh?.name || null
  }

  // 4. Fetch User profile (requester name)
  const { data: requester } = await supabase
    .from('users')
    .select('nombre, apellido')
    .eq('id', po.requested_by)
    .single()

  // 5. Fetch Items
  const { data: items, error: itemsError } = await db
    .from('purchase_order_items')
    .select('*')
    .eq('po_id', poId)
    .order('line_number')

  if (itemsError) {
    console.error('getPurchaseOrderForReceipt Items error:', itemsError)
    return null
  }

  return {
    po: {
      ...po,
      supplier_name: supplier?.business_name || 'Proveedor Desconocido',
      supplier_rut: supplier?.rut || null,
      supplier_contact: supplier?.contact_name || null,
      supplier_email: supplier?.contact_email || null,
      supplier_phone: supplier?.contact_phone || null,
      supplier_address: supplier?.address || null,
      warehouse_name: warehouseName,
      requester_name: requester ? `${requester.nombre} ${requester.apellido}` : 'Usuario'
    },
    items: (items ?? []).map(item => ({
      ...item,
      quantity_received: Number(item.quantity_received || 0),
      quantity_pending: Number(item.quantity || 0) - Number(item.quantity_received || 0)
    }))
  }
}

export async function getPurchaseOrderReceiptDetails(poId: string) {
  const baseData = await getPurchaseOrderForReceipt(poId)
  if (!baseData) return null

  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  
  const logDbClient = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    db: { schema: 'logistica' },
    global: { headers: { Authorization: `Bearer ${session?.access_token}` } }
  })

  // 1. Fetch Receipts
  const { data: receipts } = await logDbClient
    .from('purchase_receipts')
    .select('*, receipt_documents(*)')
    .eq('purchase_order_id', poId)
    .order('received_at', { ascending: false })

  // 2. Fetch Receipt Items
  const receiptIds = receipts?.map(r => r.id) || []
  let receiptItems: any[] = []
  if (receiptIds.length > 0) {
    const { data: rItems } = await logDbClient
      .from('purchase_receipt_items')
      .select('*, locations(name, code)')
      .in('receipt_id', receiptIds)
    receiptItems = rItems || []
  }

  // Calculate totals
  const totalOrdered = baseData.items.reduce((acc, i) => acc + Number(i.quantity || 0), 0)
  const totalReceived = baseData.items.reduce((acc, i) => acc + Number(i.quantity_received || 0), 0)
  const totalPending = Math.max(0, totalOrdered - totalReceived)
  const amountReceived = receipts?.reduce((acc, r) => acc + Number(r.receipt_total_gross || 0), 0) || 0

  return {
    po: baseData.po,
    items: baseData.items,
    receipts: receipts || [],
    receiptItems: receiptItems,
    totals: {
      qtyOrdered: totalOrdered,
      qtyReceived: totalReceived,
      qtyPending: totalPending,
      amountReceived: amountReceived
    }
  }
}


export interface ReceiptItemInput {
  purchase_order_item_id: string
  quantity_received: number
  quantity_rejected?: number
  quantity_missing?: number
  location_id?: string | null
  lot_number?: string | null
  expiration_date?: string | null
  condition?: 'CONFORME' | 'DANADO' | 'RECHAZADO' | 'FALTANTE'
  notes?: string | null
  rejection_reason?: string | null
  difference_reason?: string | null
}

export async function createPurchaseReceipt(data: {
  purchase_order_id: string
  receiving_type: 'WAREHOUSE' | 'OFFICE'
  warehouse_id?: string | null
  notes?: string | null
  document_type?: string | null
  document_number?: string | null
  document_date?: string | null
  items: ReceiptItemInput[]
  attachment?: {
    file_url?: string | null
    storage_bucket?: string | null
    storage_path?: string | null
    file_name: string
    file_size: number
    mime_type: string
    notes?: string
  } | null
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' }

  const { data: { session } } = await supabase.auth.getSession()

  const db = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    db: { schema: 'logistica' },
    global: {
      headers: {
        Authorization: `Bearer ${session?.access_token}`
      }
    }
  })

  // Map FOTO or EVIDENCIA document types to 'OTRO' for the header constraint
  let headerDocType = data.document_type
  if (headerDocType === 'FOTO' || headerDocType === 'EVIDENCIA') {
    headerDocType = 'OTRO'
  }

  const { data: result, error } = await db.rpc('create_purchase_receipt_db', {
    p_company_id: companyId,
    p_purchase_order_id: data.purchase_order_id,
    p_receiving_type: data.receiving_type,
    p_warehouse_id: data.warehouse_id || null,
    p_notes: data.notes || null,
    p_document_type: headerDocType || null,
    p_document_number: data.document_number || null,
    p_document_date: data.document_date || null,
    p_items: data.items.map(it => ({
      purchase_order_item_id: it.purchase_order_item_id,
      quantity_received: Number(it.quantity_received || 0),
      quantity_rejected: Number(it.quantity_rejected || 0),
      quantity_missing: Number(it.quantity_missing || 0),
      location_id: it.location_id || null,
      lot_number: it.lot_number || null,
      expiration_date: it.expiration_date || null,
      condition: it.condition || 'CONFORME',
      notes: it.notes || null,
      rejection_reason: it.rejection_reason || null,
      difference_reason: it.difference_reason || null
    })),
    p_user_id: user.id
  })

  if (error) {
    console.error('createPurchaseReceipt error:', error)
    return { error: error.message }
  }

  const r = result as { success: boolean; error?: string; receipt_id?: string; receipt_number?: string }
  if (!r.success) return { error: r.error || 'Error al guardar recepción' }

  // If there's an attachment, insert into logistica.receipt_documents
  if (data.attachment && r.receipt_id) {
    let docType = data.document_type || 'OTRO'
    if (docType === 'FOTO') {
      docType = 'EVIDENCIA'
    }

    const { error: docError } = await db
      .from('receipt_documents')
      .insert({
        company_id: companyId,
        receipt_id: r.receipt_id,
        document_type: docType as any,
        document_number: data.document_number || null,
        file_url: null, // Removed per request, use signed URLs from storage_path
        storage_bucket: data.attachment.storage_bucket || 'recepciones',
        storage_path: data.attachment.storage_path || null,
        document_date: data.document_date || null,
        file_name: data.attachment.file_name,
        file_size: data.attachment.file_size,
        mime_type: data.attachment.mime_type,
        notes: data.attachment.notes || null,
        created_by: user.id
      })

    if (docError) {
      console.error('Error inserting receipt document metadata:', docError)
      return { error: `Recepción creada, pero falló el registro del documento: ${docError.message}` }
    }
  }

  return { success: true, receipt_id: r.receipt_id, receipt_number: r.receipt_number }
}

export interface KardexMovement {
  id: string
  product_id: string
  product_sku: string
  product_description: string
  warehouse_id: string
  warehouse_name: string
  location_id: string | null
  location_code: string | null
  movement_type: 'IN' | 'OUT' | 'ADJUSTMENT' | 'TRANSFER_IN' | 'TRANSFER_OUT'
  source_type: string
  source_id: string
  quantity: number
  unit_cost: number | null
  total_cost: number | null
  lot_number: string | null
  expiration_date: string | null
  movement_date: string
  notes: string | null
}

export async function getKardexMovements(): Promise<KardexMovement[]> {
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
    .order('movement_date', { ascending: false })

  if (error) {
    console.error('getKardexMovements error:', error)
    return []
  }

  if (!data || data.length === 0) return []

  // Fetch products, warehouses, and locations to map descriptions
  const productIds = Array.from(new Set(data.map(d => d.product_id)))
  const warehouseIds = Array.from(new Set(data.map(d => d.warehouse_id)))
  const locationIds = Array.from(new Set(data.map(d => d.location_id).filter(Boolean)))

  const adq = adqDb()
  const [productsRes, warehousesRes, locationsRes] = await Promise.all([
    adq.from('products').select('id, sku, description').in('id', productIds),
    adq.from('warehouses').select('id, name').in('id', warehouseIds),
    db.from('locations').select('id, code').in('id', locationIds)
  ])

  const productMap = new Map(productsRes.data?.map(p => [p.id, p]) ?? [])
  const warehouseMap = new Map(warehousesRes.data?.map(w => [w.id, w.name]) ?? [])
  const locationMap = new Map(locationsRes.data?.map(l => [l.id, l.code]) ?? [])

  return data.map(m => {
    const prod = productMap.get(m.product_id)
    return {
      id: m.id,
      product_id: m.product_id,
      product_sku: prod?.sku || 'SKU Desconocido',
      product_description: prod?.description || 'Producto Desconocido',
      warehouse_id: m.warehouse_id,
      warehouse_name: warehouseMap.get(m.warehouse_id) || 'Almacén Desconocido',
      location_id: m.location_id,
      location_code: m.location_id ? locationMap.get(m.location_id) || null : null,
      movement_type: m.movement_type,
      source_type: m.source_type,
      source_id: m.source_id,
      quantity: Number(m.quantity),
      unit_cost: m.unit_cost ? Number(m.unit_cost) : null,
      total_cost: m.total_cost ? Number(m.total_cost) : null,
      lot_number: m.lot_number,
      expiration_date: m.expiration_date,
      movement_date: m.movement_date,
      notes: m.notes
    }
  })
}

export interface StockItem {
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
    const key = `${m.product_id}_${m.warehouse_id}_${m.location_id || 'null'}_${m.lot_number || 'null'}_${m.expiration_date || 'null'}`
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
}
