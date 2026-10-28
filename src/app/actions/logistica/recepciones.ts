'use server'

/* Supabase's generated query types cannot represent the permission-dependent projections below. */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createClient } from '@/lib/supabase/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { hasWmsPermission, requireWmsPermission, type WmsAuthorization } from './authorization'
import { getPurchaseReceiptOperation, getPurchaseReceiptSyncSettings, reconcilePurchaseReceiptOperation, syncPurchaseReceipt } from '@/lib/integraciones/bsale-purchase-receipt-orchestrator'
import { enrichReceiptItemsWithProducts } from '@/lib/logistica/receipt-display'

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

function coreDb() {
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
    db: { schema: 'core' }, auth: { autoRefreshToken: false, persistSession: false },
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
  receipt_documents: ReceiptDocumentSummary[]
}

export interface ReceiptDocumentSummary {
  id: string
  document_type: string | null
  document_number: string | null
  file_name: string | null
}

export interface ReceiptWarehouseOption {
  id: string
  name: string
}

const PO_OPERATIONAL_FIELDS = 'id, company_id, correlative, issue_date, required_date, supplier_id, source_type, warehouse_id, po_type, requested_by, notes, status, receipt_status, invoice_status, cancel_reason, created_at, updated_at'
const PO_ECONOMIC_FIELDS = 'net_total, discount_total, tax_total, exempt_total, grand_total'
const PO_ITEM_OPERATIONAL_FIELDS = 'id, po_id, line_number, item_type, product_id, product_description, unit, quantity, warehouse_id, required_date, notes, quantity_received, lot_number, expiration_date'
const PO_ITEM_ECONOMIC_FIELDS = 'unit_price, discount_percent, discount_amount, tax_rate, tax_amount, line_total'
const PO_ITEM_RECEIPT_AMOUNT_FIELDS = 'unit_price'
const RECEIPT_OPERATIONAL_FIELDS = 'id, company_id, purchase_order_id, receipt_number, receiving_type, warehouse_id, status, received_at, received_by, notes, created_by, created_at'
const RECEIPT_ECONOMIC_FIELDS = 'receipt_total_gross'
const RECEIPT_DOCUMENT_BUCKET = 'recepciones'
const RECEIPT_DOCUMENT_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])

function inferReceiptDocumentMimeType(fileName: string | null, storagePath: string): string | null {
  const extension = (fileName || storagePath).split('.').pop()?.toLowerCase()
  return extension === 'pdf' ? 'application/pdf'
    : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg'
      : extension === 'png' ? 'image/png'
        : extension === 'webp' ? 'image/webp'
          : null
}

async function authorizeReception(): Promise<{ authorization: WmsAuthorization; canViewEconomics: boolean }> {
  const authorization = await requireWmsPermission('logistica.receptions.create')
  const canViewEconomics = await hasWmsPermission(authorization.user.id, 'adquisiciones.po.view')
  return { authorization, canViewEconomics }
}

async function authorizeReceiptForm(): Promise<{ authorization: WmsAuthorization; canViewEconomics: boolean; canViewReceiptAmounts: boolean }> {
  const { authorization, canViewEconomics } = await authorizeReception()
  const canViewReceiptAmounts = canViewEconomics || await hasWmsPermission(authorization.user.id, 'logistica.receptions.amounts.view')
  return { authorization, canViewEconomics, canViewReceiptAmounts }
}

export async function getActiveReceiptWarehouses(): Promise<ReceiptWarehouseOption[]> {
  const { authorization } = await authorizeReception()
  const { data, error } = await adqDb()
    .from('warehouses')
    .select('id, name')
    .eq('company_id', authorization.companyId)
    .eq('is_active', true)
    .order('name')
  if (error) throw new Error('No se pudieron cargar las bodegas activas.')
  return (data ?? []) as ReceiptWarehouseOption[]
}

function redactBsaleStatus<T extends { payload?: unknown }>(status: T, canViewEconomics: boolean) {
  return canViewEconomics ? status : { ...status, payload: null }
}

async function receiptBelongsToCompany(receiptId: string, companyId: string) {
  const { data, error } = await logDb()
    .from('purchase_receipts')
    .select('id')
    .eq('id', receiptId)
    .eq('company_id', companyId)
    .maybeSingle()
  return !error && Boolean(data)
}

export async function getPendingReceivablePOs(): Promise<PurchaseOrderPending[]> {
  if (process.env.NODE_ENV === 'development') console.time('getPendingReceivablePOs')
  const { authorization, canViewEconomics } = await authorizeReception()
  const supabase = await createClient()
  if (!authorization.user) {
    if (process.env.NODE_ENV === 'development') console.timeEnd('getPendingReceivablePOs')
    return []
  }

  const companyId = authorization.companyId

  const db = adqDb()
  if (process.env.NODE_ENV === 'development') console.time('getPendingReceivablePOs:base')
  const pendingOrdersQuery: any = db
    .from('purchase_orders')
    .select(`id, correlative, issue_date, po_type, status, receipt_status, supplier_id, warehouse_id${canViewEconomics ? ', grand_total' : ''}`)
    .eq('company_id', companyId)
    .in('status', ['CONFIRMADA', 'RECEPCION_PARCIAL', 'RECEPCION_TOTAL'])
    .order('created_at', { ascending: false })
    .limit(200)
  const { data, error } = await pendingOrdersQuery
  if (process.env.NODE_ENV === 'development') console.timeEnd('getPendingReceivablePOs:base')

  if (error) {
    console.error('getPendingReceivablePOs error:', error)
    if (process.env.NODE_ENV === 'development') console.timeEnd('getPendingReceivablePOs')
    return []
  }

  if (!data || data.length === 0) {
    if (process.env.NODE_ENV === 'development') console.timeEnd('getPendingReceivablePOs')
    return []
  }

  // Fetch supplier names and warehouse names in parallel
  const supplierIds = Array.from(new Set(data.map((d: any) => d.supplier_id)))
  const warehouseIds = Array.from(new Set(data.map((d: any) => d.warehouse_id).filter(Boolean)))

  if (process.env.NODE_ENV === 'development') console.time('getPendingReceivablePOs:lookups')
  const [suppliersRes, warehousesRes] = await Promise.all([
    db.from('suppliers').select('id, business_name').in('id', supplierIds),
    db.from('warehouses').select('id, name').in('id', warehouseIds)
  ])
  if (process.env.NODE_ENV === 'development') console.timeEnd('getPendingReceivablePOs:lookups')

  const supplierMap = new Map(suppliersRes.data?.map(s => [s.id, s.business_name]) ?? [])
  const warehouseMap = new Map(warehousesRes.data?.map(w => [w.id, w.name]) ?? [])

  // Additional Fetch: Quantities
  const poIds = data.map((d: any) => d.id)
  if (process.env.NODE_ENV === 'development') console.time('getPendingReceivablePOs:items')
  const { data: itemsData } = await db
    .from('purchase_order_items')
    .select('po_id, quantity, quantity_received')
    .in('po_id', poIds)
  if (process.env.NODE_ENV === 'development') console.timeEnd('getPendingReceivablePOs:items')

  // Additional Fetch: Receipts (from logistica schema)
  const { data: { session } } = await supabase.auth.getSession()
  const logDbClient = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    db: { schema: 'logistica' },
    global: { headers: { Authorization: `Bearer ${session?.access_token}` } }
  })
  
  if (process.env.NODE_ENV === 'development') console.time('getPendingReceivablePOs:receipts')
  const receiptsQuery: any = logDbClient
    .from('purchase_receipts')
    .select(`id, purchase_order_id, receipt_number, received_at, status${canViewEconomics ? ', receipt_total_gross' : ''}, receipt_documents(id, document_type, document_number, file_name)`)
    .in('purchase_order_id', poIds)
    .order('received_at', { ascending: false })
  const { data: receiptsData } = await receiptsQuery
  if (process.env.NODE_ENV === 'development') console.timeEnd('getPendingReceivablePOs:receipts')

  const result = data.map((po: any) => {
    // Quantities
    const poItems = itemsData?.filter(i => i.po_id === po.id) || []
    const qtyOrdered = poItems.reduce((acc, i) => acc + Number(i.quantity || 0), 0)
    const qtyReceived = poItems.reduce((acc, i) => acc + Number(i.quantity_received || 0), 0)
    const qtyPending = Math.max(0, qtyOrdered - qtyReceived)

    // Receipts
    const poReceipts = receiptsData?.filter((r: any) => r.purchase_order_id === po.id) || []
    const receiptDocuments = Array.from(new Map(
      poReceipts
        .filter((receipt: any) => !['CANCELADA', 'CANCELLED'].includes(receipt.status))
        .flatMap((receipt: any) => Array.isArray(receipt.receipt_documents) ? receipt.receipt_documents : [])
        .filter((document: any) => document.document_type === 'FA')
        .map((document: any) => [document.id, {
          id: document.id,
          document_type: document.document_type,
          document_number: document.document_number,
          file_name: document.file_name,
        } as ReceiptDocumentSummary])
    ).values())
    const amountReceived = canViewEconomics
       ? poReceipts.reduce((acc: number, r: any) => acc + Number(r.receipt_total_gross || 0), 0)
      : undefined
    
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
       ...(canViewEconomics ? { grand_total: po.grand_total } : {}),
      receipt_status: po.receipt_status || 'PENDIENTE',
      status: po.status,
      qty_ordered: qtyOrdered,
      qty_received: qtyReceived,
      qty_pending: qtyPending,
       ...(canViewEconomics ? { amount_received: amountReceived } : {}),
      latest_receipt_number: latestReceiptNumber,
      latest_receipt_date: latestReceiptDate,
      latest_receipt_doc: latestReceiptDoc,
      receipt_documents: receiptDocuments,
    }
  })
  if (process.env.NODE_ENV === 'development') console.timeEnd('getPendingReceivablePOs')
  return result as PurchaseOrderPending[]
}

export async function getPurchaseOrderForReceipt(poId: string) {
  const { authorization, canViewEconomics, canViewReceiptAmounts } = await authorizeReceiptForm()
  return getPurchaseOrderForReceiptAuthorized(poId, authorization, canViewEconomics, canViewReceiptAmounts)
}

export interface OperationalPurchaseOrderPdfData {
  company: {
    name: string
    rut: string | null
    phone: string | null
    email: string | null
    address: string | null
    logo_url: string | null
  }
  po: {
    correlative: string
    issue_date: string
    required_date: string | null
    supplier_name: string
    warehouse_name: string | null
    po_type: string
    requester_name: string
    notes: string | null
    status: string
  }
  items: Array<{
    line_number: number
    item_type: string
    sku: string | null
    product_description: string
    unit: string | null
    quantity: number
    notes: string | null
  }>
}

/** Returns the intentionally economic-free document used by warehouse staff. */
export async function getOperationalPurchaseOrderPdfData(poId: string): Promise<OperationalPurchaseOrderPdfData | null> {
  const authorization = await requireWmsPermission('logistica.receptions.create')
  const [baseData, companyResult] = await Promise.all([
    getPurchaseOrderForReceiptAuthorized(poId, authorization, false),
    coreDb().from('companies').select('business_name, trade_name, rut, phone, email, address, logo_url').eq('id', authorization.companyId).eq('is_active', true).maybeSingle(),
  ])

  if (!baseData || companyResult.error || !companyResult.data) return null

  const company = companyResult.data
  return {
    company: {
      name: company.trade_name || company.business_name || authorization.companyName,
      rut: company.rut || null,
      phone: company.phone || null,
      email: company.email || null,
      address: company.address || null,
      logo_url: company.logo_url || null,
    },
    po: {
      correlative: baseData.po.correlative,
      issue_date: baseData.po.issue_date,
      required_date: baseData.po.required_date || null,
      supplier_name: baseData.po.supplier_name,
      warehouse_name: baseData.po.warehouse_name || null,
      po_type: baseData.po.po_type,
      requester_name: baseData.po.requester_name,
      notes: baseData.po.notes || null,
      status: baseData.po.status,
    },
    items: baseData.items.map((item: any) => ({
      line_number: Number(item.line_number),
      item_type: item.item_type,
      sku: item.sku || null,
      product_description: item.product_description,
      unit: item.unit || null,
      quantity: Number(item.quantity || 0),
      notes: item.notes || null,
    })),
  }
}

async function getPurchaseOrderForReceiptAuthorized(poId: string, authorization: WmsAuthorization, canViewEconomics: boolean, canViewReceiptAmounts = canViewEconomics) {
  const supabase = await createClient()
  const companyId = authorization.companyId

  const db = adqDb()

  // 1. Fetch Purchase Order
  const purchaseOrderQuery: any = db
    .from('purchase_orders')
    .select(`${PO_OPERATIONAL_FIELDS}${canViewEconomics ? `, ${PO_ECONOMIC_FIELDS}` : ''}`)
    .eq('id', poId)
    .eq('company_id', companyId)
    .single()
  const { data: po, error: poError } = await purchaseOrderQuery

  if (poError || !po) {
    console.error('getPurchaseOrderForReceipt PO error:', poError)
    return null
  }

  // 2. Fetch dependencies in parallel
  const itemsQuery: any = db
    .from('purchase_order_items')
    .select(`${PO_ITEM_OPERATIONAL_FIELDS}${canViewEconomics ? `, ${PO_ITEM_ECONOMIC_FIELDS}` : canViewReceiptAmounts ? `, ${PO_ITEM_RECEIPT_AMOUNT_FIELDS}` : ''}`)
    .eq('po_id', poId)
    .eq('company_id', companyId)
    .order('line_number')
  const [supplierRes, warehouseRes, requesterRes, itemsRes] = await Promise.all([
    db.from('suppliers').select('business_name, rut, contact_name, contact_email, contact_phone, address').eq('id', po.supplier_id).eq('company_id', companyId).single(),
    po.warehouse_id ? db.from('warehouses').select('name').eq('id', po.warehouse_id).single() : Promise.resolve({ data: null }),
    po.requested_by ? supabase.from('users').select('nombre, apellido').eq('id', po.requested_by).single() : Promise.resolve({ data: null }),
    itemsQuery
  ]);

  const supplier = supplierRes.data;
  const warehouseName = warehouseRes.data?.name || null;
  const requester = requesterRes.data;
  const items = (itemsRes.data ?? []) as any[];
  const itemsError = itemsRes.error;

  if (itemsError) {
    console.error('getPurchaseOrderForReceipt Items error:', itemsError)
    return null
  }

  const productIds = Array.from(new Set(items.map((item: any) => item.product_id).filter(Boolean)))
  const { data: products, error: productsError } = productIds.length
    ? await db.from('products').select('id, sku').in('id', productIds)
    : { data: [], error: null }
  if (productsError) console.error('getPurchaseOrderForReceipt Products error:', productsError)

  const receiptDb = logDb()
  const { data: priorReceipts } = await receiptDb
    .from('purchase_receipts')
    .select('id')
    .eq('company_id', companyId)
    .eq('purchase_order_id', poId)
    .eq('status', 'COMPLETED')
  const receiptIds = (priorReceipts ?? []).map(receipt => receipt.id)
  const { data: priorItems } = receiptIds.length
    ? await receiptDb
      .from('purchase_receipt_items')
      .select('purchase_order_item_id, quantity_received, quantity_rejected, quantity_missing')
      .in('receipt_id', receiptIds)
    : { data: [] as Array<{ purchase_order_item_id: string; quantity_received: number; quantity_rejected: number; quantity_missing: number }> }
  const accountedByItem = new Map<string, number>()
  for (const receiptItem of priorItems ?? []) {
    accountedByItem.set(
      receiptItem.purchase_order_item_id,
      (accountedByItem.get(receiptItem.purchase_order_item_id) ?? 0)
        + Number(receiptItem.quantity_received || 0),
    )
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
     items: enrichReceiptItemsWithProducts(items, products ?? []).map((item: any) => ({
      ...item,
      quantity_received: Number(item.quantity_received || 0),
      quantity_pending: Math.max(0, Number(item.quantity || 0) - (accountedByItem.get(item.id) ?? Number(item.quantity_received || 0)))
    }))
  }
}

export async function getPurchaseOrderReceiptDetails(poId: string) {
  if (process.env.NODE_ENV === 'development') console.time(`getPurchaseOrderReceiptDetails_${poId}`)

  const { authorization, canViewEconomics } = await authorizeReception()
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()

  const logDbClient = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    db: { schema: 'logistica' },
    global: { headers: { Authorization: `Bearer ${session?.access_token}` } }
  })

  const receiptsQuery: any = logDbClient
    .from('purchase_receipts')
    .select(`${RECEIPT_OPERATIONAL_FIELDS}${canViewEconomics ? `, ${RECEIPT_ECONOMIC_FIELDS}` : ''}, receipt_documents(id, document_type, document_number, file_name, mime_type, storage_path), purchase_receipt_items(id, receipt_id, purchase_order_item_id, product_id, service_description, quantity_ordered, quantity_previously_received, quantity_received, quantity_pending_after, warehouse_id, location_id, lot_number, expiration_date, notes, locations(name, code))`)
    .eq('purchase_order_id', poId)
    .eq('company_id', authorization.companyId)
    .order('received_at', { ascending: false })
  const [baseData, receiptsResult] = await Promise.all([
    getPurchaseOrderForReceiptAuthorized(poId, authorization, canViewEconomics),
    receiptsQuery
  ]);

  if (!baseData) {
    if (process.env.NODE_ENV === 'development') console.timeEnd(`getPurchaseOrderReceiptDetails_${poId}`)
    return null
  }

  const receiptsData = receiptsResult.data || [];
  
  // Extract receipt items and format receipts
  let receiptItems: any[] = [];
  const receipts = receiptsData.map((r: any) => {
    const { purchase_receipt_items, receipt_documents, ...rest } = r;
    if (purchase_receipt_items && Array.isArray(purchase_receipt_items)) {
      receiptItems = receiptItems.concat(purchase_receipt_items);
    }
    return {
      ...rest,
      receipt_documents: Array.isArray(receipt_documents)
        ? receipt_documents.map((document: any) => ({
            id: document.id,
            document_type: document.document_type,
            document_number: document.document_number,
            file_name: document.file_name,
            mime_type: document.mime_type,
            has_file: Boolean(document.storage_path),
          }))
        : [],
    };
  });
  const receiptStatuses = await Promise.all(receipts.map((receipt: any) => getPurchaseReceiptOperation(authorization.companyId, receipt.id, authorization.user.id)))
  receipts.forEach((receipt: any, index: number) => { receipt.bsale = redactBsaleStatus(receiptStatuses[index], canViewEconomics) })

  // Calculate totals
  const totalOrdered = baseData.items.reduce((acc, i) => acc + Number(i.quantity || 0), 0)
  const totalReceived = baseData.items.reduce((acc, i) => acc + Number(i.quantity_received || 0), 0)
  const totalPending = Math.max(0, totalOrdered - totalReceived)
   const amountReceived = canViewEconomics
     ? receipts?.reduce((acc: number, r: any) => acc + Number(r.receipt_total_gross || 0), 0) || 0
     : undefined

  if (process.env.NODE_ENV === 'development') console.timeEnd(`getPurchaseOrderReceiptDetails_${poId}`)

  return {
    po: baseData.po,
    items: baseData.items,
    receipts: receipts,
    receiptItems: receiptItems,
    totals: {
      qtyOrdered: totalOrdered,
      qtyReceived: totalReceived,
      qtyPending: totalPending,
       ...(canViewEconomics ? { amountReceived } : {})
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
  idempotency_key: string
}) {
  const authorization = await requireWmsPermission('logistica.receptions.create')
  const user = authorization.user
  const companyId = authorization.companyId
  const canViewEconomics = await hasWmsPermission(user.id, 'adquisiciones.po.view')
  const supabase = await createClient()

  if (typeof data.document_number !== 'string' || !/^[0-9]+$/.test(data.document_number)) {
    return { error: 'Ingrese un solo número de documento, sin puntos, guiones ni espacios.' }
  }

  const { data: purchaseOrder, error: purchaseOrderError } = await adqDb()
    .from('purchase_orders')
    .select('warehouse_id')
    .eq('id', data.purchase_order_id)
    .eq('company_id', companyId)
    .single()
  if (purchaseOrderError || !purchaseOrder) return { error: 'Orden de Compra no encontrada.' }

  const effectiveWarehouseId = data.receiving_type === 'WAREHOUSE'
    ? data.warehouse_id || purchaseOrder.warehouse_id
    : null
  if (data.receiving_type === 'WAREHOUSE' && !effectiveWarehouseId) {
    return { error: 'Debe seleccionar una bodega de recepción.' }
  }
  if (effectiveWarehouseId) {
    const { data: warehouse, error: warehouseError } = await adqDb()
      .from('warehouses')
      .select('id')
      .eq('id', effectiveWarehouseId)
      .eq('company_id', companyId)
      .eq('is_active', true)
      .maybeSingle()
    if (warehouseError || !warehouse) return { error: 'La bodega seleccionada no existe, está inactiva o no pertenece a la empresa.' }
  }

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
     p_warehouse_id: effectiveWarehouseId,
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
     p_user_id: user.id,
     p_idempotency_key: data.idempotency_key,
     p_attachment: data.attachment ? {
       document_type: data.document_type,
       storage_bucket: data.attachment.storage_bucket || 'recepciones',
       storage_path: data.attachment.storage_path || null,
       file_name: data.attachment.file_name,
       file_size: data.attachment.file_size,
       mime_type: data.attachment.mime_type,
       notes: data.attachment.notes || null,
     } : null
   })

  if (error) {
    console.error('createPurchaseReceipt error:', error)
    return { error: error.message }
  }

  const r = result as { success: boolean; error?: string; receipt_id?: string; receipt_number?: string }
  if (!r.success) return { error: r.error || 'Error al guardar recepción' }

  const settings = await getPurchaseReceiptSyncSettings(companyId)
  if (settings.enabled && settings.autoSyncEnabled) {
    try {
      const bsale = await syncPurchaseReceipt(companyId, user.id, r.receipt_id!)
       return { success: true, receipt_id: r.receipt_id, receipt_number: r.receipt_number, bsale: redactBsaleStatus(bsale, canViewEconomics) }
    } catch (syncError) {
      return {
        success: true,
        receipt_id: r.receipt_id,
        receipt_number: r.receipt_number,
         bsale: { status: 'RECONCILIATION_REQUIRED' as const, operationId: '', receptionId: null, error: syncError instanceof Error ? syncError.message : 'No se pudo iniciar la sincronización BSale.', payload: null },
      }
    }
  }
  return {
    success: true,
    receipt_id: r.receipt_id,
    receipt_number: r.receipt_number,
    bsale: { status: 'PENDING' as const, operationId: null, receptionId: null, error: null, payload: null },
  }
}

export async function getPurchaseReceiptBsaleStatus(receiptId: string) {
  const authorization = await requireWmsPermission('logistica.receptions.create')
  const status = await getPurchaseReceiptOperation(authorization.companyId, receiptId, authorization.user.id)
  return redactBsaleStatus(status, await hasWmsPermission(authorization.user.id, 'adquisiciones.po.view'))
}

export async function reconcilePurchaseReceiptBsale(operationId: string) {
  const authorization = await requireWmsPermission('logistica.receptions.create')
  const status = await reconcilePurchaseReceiptOperation(authorization.companyId, authorization.user.id, operationId)
  return redactBsaleStatus(status, await hasWmsPermission(authorization.user.id, 'adquisiciones.po.view'))
}

export async function syncPurchaseReceiptBsale(receiptId: string) {
  const authorization = await requireWmsPermission('logistica.receptions.create')
  if (!await receiptBelongsToCompany(receiptId, authorization.companyId)) {
    return { status: 'FAILED' as const, operationId: '', receptionId: null, error: 'Recepción no encontrada', payload: null }
  }
  const status = await syncPurchaseReceipt(authorization.companyId, authorization.user.id, receiptId)
  return redactBsaleStatus(status, await hasWmsPermission(authorization.user.id, 'adquisiciones.po.view'))
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

export async function getKardexMovements(productId?: string): Promise<KardexMovement[]> {
  const { companyId } = await requireWmsPermission('logistica.kardex.view')

  const db = logDb()
  let query = db
    .from('kardex_movements')
    .select(`
      id, product_id, warehouse_id, location_id,
      movement_type, source_type, source_id,
      quantity, unit_cost, total_cost,
      lot_number, expiration_date, movement_date, notes
    `)
    .eq('company_id', companyId)
    .order('movement_date', { ascending: true })

  if (productId) {
    query = query.eq('product_id', productId)
  }

  const { data, error } = await query.limit(500)

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
  location_name: string | null
  aisle: string | null
  rack: string | null
  level: string | null
  position: string | null
  lot_number: string | null
  expiration_date: string | null
  quantity: number
  unit_cost: number | null
}

export async function getStockSummary(): Promise<StockItem[]> {
  const { companyId } = await requireWmsPermission('logistica.stock.view')

  const db = logDb()
  const { data: stockItems, error } = await db
    .from('v_stock_by_location')
    .select('product_id, warehouse_id, location_id, lot_number, expiration_date, quantity, max_unit_cost')
    .eq('company_id', companyId)
    .limit(1000)

  if (error) {
    console.error('getStockSummary error:', error)
    return []
  }

  if (!stockItems || stockItems.length === 0) return []

  // Join product and warehouse details
  const productIds = Array.from(new Set(stockItems.map(d => d.product_id)))
  const warehouseIds = Array.from(new Set(stockItems.map(d => d.warehouse_id)))
  const locationIds = Array.from(new Set(stockItems.map(d => d.location_id).filter(Boolean)))

  const adq = adqDb()
  const [productsRes, warehousesRes, locationsRes] = await Promise.all([
    adq.from('products').select('id, sku, description').in('id', productIds),
    adq.from('warehouses').select('id, name').in('id', warehouseIds),
    db.from('locations').select('id, code, name, aisle, rack, level, position').in('id', locationIds)
  ])

  const productMap = new Map(productsRes.data?.map(p => [p.id, p]) ?? [])
  const warehouseMap = new Map(warehousesRes.data?.map(w => [w.id, w.name]) ?? [])
  const locationMap = new Map(locationsRes.data?.map(l => [l.id, l]) ?? [])

  return stockItems.map(item => {
    const prod = productMap.get(item.product_id)
    return {
      product_id: item.product_id,
      product_sku: prod?.sku || 'SKU Desconocido',
      product_description: prod?.description || 'Producto Desconocido',
      warehouse_id: item.warehouse_id,
      warehouse_name: warehouseMap.get(item.warehouse_id) || 'Almacén Desconocido',
      location_id: item.location_id,
      location_code: item.location_id ? locationMap.get(item.location_id)?.code || null : null,
      location_name: item.location_id ? locationMap.get(item.location_id)?.name || null : null,
      aisle: item.location_id ? locationMap.get(item.location_id)?.aisle || null : null,
      rack: item.location_id ? locationMap.get(item.location_id)?.rack || null : null,
      level: item.location_id ? locationMap.get(item.location_id)?.level || null : null,
      position: item.location_id ? locationMap.get(item.location_id)?.position || null : null,
      lot_number: item.lot_number,
      expiration_date: item.expiration_date,
      quantity: Number(item.quantity),
      unit_cost: item.max_unit_cost ? Number(item.max_unit_cost) : null
    }
  })
}

export async function getReceiptDocumentSignedUrl(documentId: string) {
  const startedAt = performance.now()
  const measure = (phase: string, phaseStartedAt: number) => {
    if (process.env.NODE_ENV === 'development') console.info(`[receipt-document] ${documentId} ${phase} ${Math.round(performance.now() - phaseStartedAt)}ms`)
  }
  const authStartedAt = performance.now()
  const authorization = await requireWmsPermission('logistica.receptions.create')
  measure('authorization', authStartedAt)
  const companyId = authorization.companyId

  const logistica = logDb()

  if (!documentId || typeof documentId !== 'string') return { error: 'Identificador de documento inválido' }

  const documentQueryStartedAt = performance.now()
  const { data: document, error: documentError } = await logistica
    .from('receipt_documents')
    .select('id, company_id, receipt_id, document_type, document_number, storage_bucket, storage_path, file_name, mime_type')
    .eq('id', documentId)
    .maybeSingle()
  measure('document-query', documentQueryStartedAt)

  if (documentError) {
    console.error('getReceiptDocumentSignedUrl document error:', documentError)
    return { error: 'Error al validar el documento' }
  }

  if (!document) return { error: 'Documento no encontrado' }
  if (document.company_id !== companyId) return { error: 'Acceso denegado al documento' }
  if (!document.storage_path) return { error: 'Este documento no tiene un archivo adjunto disponible' }
  if (document.storage_bucket !== RECEIPT_DOCUMENT_BUCKET) return { error: 'El documento no pertenece al bucket autorizado' }
  const mimeType = document.mime_type || inferReceiptDocumentMimeType(document.file_name, document.storage_path)
  if (!mimeType || !RECEIPT_DOCUMENT_MIME_TYPES.has(mimeType)) return { error: 'Tipo de archivo no permitido para previsualización' }

  const expectedPrefix = `${companyId}/`
  if (!document.storage_path.startsWith(expectedPrefix) || document.storage_path.includes('..') || document.storage_path.includes('//')) {
    return { error: 'Ruta de almacenamiento inválida' }
  }

  const receiptQueryStartedAt = performance.now()
  const { data: receipt, error: receiptError } = await logistica
    .from('purchase_receipts')
    .select('id, company_id, purchase_order_id')
    .eq('id', document.receipt_id)
    .maybeSingle()
  measure('receipt-query', receiptQueryStartedAt)

  if (receiptError) {
    console.error('getReceiptDocumentSignedUrl receipt error:', receiptError)
    return { error: 'Error al validar la recepción' }
  }

  if (!receipt) return { error: 'Recepción no encontrada' }
  if (receipt.company_id !== companyId) return { error: 'Acceso denegado a la recepción' }

  const adquisiciones = adqDb()
  const purchaseOrderQueryStartedAt = performance.now()
  const { data: purchaseOrder, error: poError } = await adquisiciones
    .from('purchase_orders')
    .select('id, company_id')
    .eq('id', receipt.purchase_order_id)
    .maybeSingle()
  measure('purchase-order-query', purchaseOrderQueryStartedAt)

  if (poError) {
    console.error('getReceiptDocumentSignedUrl purchase order error:', poError)
    return { error: 'Error al validar la orden de compra' }
  }

  if (!purchaseOrder || purchaseOrder.company_id !== companyId) {
    return { error: 'Acceso denegado a la orden de compra' }
  }

  const expiresIn = 300
  const storage = logistica.storage.from(RECEIPT_DOCUMENT_BUCKET)
  const signedUrlsStartedAt = performance.now()
  const [{ data: signedData, error: signedError }, { data: downloadData, error: downloadError }] = await Promise.all([
    storage.createSignedUrl(document.storage_path, expiresIn),
    storage.createSignedUrl(document.storage_path, expiresIn, { download: document.file_name || true }),
  ])
  measure('signed-urls', signedUrlsStartedAt)

  if (signedError || downloadError || !signedData?.signedUrl || !downloadData?.signedUrl) {
    console.error('getReceiptDocumentSignedUrl storage error:', signedError || downloadError)
    return { error: 'No se pudo generar el enlace temporal del documento' }
  }

  if (process.env.NODE_ENV === 'development') console.info(`[receipt-document] ${documentId} total ${Math.round(performance.now() - startedAt)}ms`)
  return {
    signedUrl: signedData.signedUrl,
    downloadUrl: downloadData.signedUrl,
    fileName: document.file_name || `documento-${document.id}`,
    mimeType,
    expiresIn
  }
}
