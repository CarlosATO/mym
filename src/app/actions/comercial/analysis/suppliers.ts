'use server'

import type { AnalysisSupplierOption, SupplierCatalogRow, SupplierPurchaseSales360, SupplierWeeklyPoint, SupplierWeeklyDetail, SupplierWeeklyDocumentDetail, SupplierWeeklyProductDetail, SupplierDocumentDetail, SupplierDocumentLineDetail, SupplierPurchaseRow } from './types'
import { adqQuery, fetchAll, getAuthedCompany, integQuery, toNum } from './utils'

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

type SupplierRow = {
  id: string
  business_name: string
  supplier_kind: string
  parent_supplier_id: string | null
  bsale_product_type_name?: string | null
}

type MappingRow = {
  product_id: string
  sku: string | null
  unit_cost: number | string | null
  supplier_id: string
  bsale_variant_id: number | string | null
  is_preferred: boolean | null
  product_name?: string | null
}

type ProductRow = {
  id: string
  sku: string | null
  description: string | null
  bsale_variant_id: number | string | null
}

type StockRow = {
  variant_id: number | string | null
  quantity_available: number | string | null
}

type DocumentRow = {
  bsale_id: number
  total_amount: number | string | null
  net_amount: number | string | null
  emission_date: string
}

type DetailRow = {
  variant_code: string | null
  quantity: number | string | null
  net_amount: number | string | null
  bsale_document_id: number
}

type ReceptionDetailRow = {
  bsale_reception_id: number | string | null
  variant_code: string | null
  quantity: number | string | null
  cost: number | string | null
}

type ReceptionRow = {
  bsale_id: number | string | null
  raw_admission_date: string | null
  admission_date: string | null
  document: string | null
  document_number: string | number | null
}

function uniqueSkuPreview(values: Set<string>) {
  const items = Array.from(values).filter(Boolean).sort((a, b) => a.localeCompare(b, 'es'))
  const preview = items.slice(0, 3)
  const remaining = Math.max(0, items.length - preview.length)
  const productsSummary = items.length === 0
    ? 'Sin detalle de productos'
    : items.length <= 3
      ? preview.join(', ')
      : `${items.length} SKUs · ${preview.join(', ')} +${remaining} más`

  return {
    preview,
    count: items.length,
    productsSummary,
  }
}

function formatWeekLabel(weekStart: string, weekEnd: string) {
  const format = (value: string) => {
    const [year, month, day] = value.split('-')
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    return `${day} ${monthNames[Math.max(0, Number(month) - 1)] || month} ${year}`
  }
  return `${format(weekStart)} - ${format(weekEnd)}`
}

function startOfIsoWeek(date: Date) {
  const current = new Date(date)
  const day = current.getUTCDay() || 7
  current.setUTCDate(current.getUTCDate() - day + 1)
  current.setUTCHours(0, 0, 0, 0)
  return current
}

function isoDate(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function buildWeeklySeries(from: string, to: string, salesByDate: Map<string, number>, purchasesByDate: Map<string, number>, marginByDate: Map<string, number>): SupplierWeeklyPoint[] {
  const fromDate = new Date(`${from}T00:00:00Z`)
  const toDate = new Date(`${to}T00:00:00Z`)
  const bucketMap = new Map<string, SupplierWeeklyPoint>()

  const cursor = new Date(fromDate)
  while (cursor <= toDate) {
    const weekStartDate = startOfIsoWeek(cursor)
    const weekStart = isoDate(weekStartDate)
    const weekEndDate = new Date(weekStartDate)
    weekEndDate.setUTCDate(weekEndDate.getUTCDate() + 6)
    const clampedEnd = weekEndDate > toDate ? toDate : weekEndDate
    if (!bucketMap.has(weekStart)) {
      bucketMap.set(weekStart, {
        label: formatWeekLabel(weekStart, isoDate(clampedEnd)),
        weekStart,
        weekEnd: isoDate(clampedEnd),
        purchases: 0,
        sales: 0,
        margin: 0,
      })
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  for (const [date, amount] of salesByDate.entries()) {
    const bucket = bucketMap.get(isoDate(startOfIsoWeek(new Date(`${date}T00:00:00Z`))))
    if (bucket) bucket.sales += Math.round(amount)
  }
  for (const [date, amount] of purchasesByDate.entries()) {
    const bucket = bucketMap.get(isoDate(startOfIsoWeek(new Date(`${date}T00:00:00Z`))))
    if (bucket) bucket.purchases += Math.round(amount)
  }
  for (const [date, amount] of marginByDate.entries()) {
    const bucket = bucketMap.get(isoDate(startOfIsoWeek(new Date(`${date}T00:00:00Z`))))
    if (bucket) {
      bucket.margin = (bucket.margin || 0) + Math.round(amount)
    }
  }

  return Array.from(bucketMap.values()).sort((a, b) => a.weekStart.localeCompare(b.weekStart))
}

export async function getAnalysisSuppliers(): Promise<AnalysisSupplierOption[]> {
  const { companyId } = await getAuthedCompany()
  const { data, error } = await adqQuery('suppliers')
    .select('id,business_name')
    .eq('company_id', companyId)
    .eq('supplier_kind', 'REAL')
    .eq('is_active', true)
    .order('business_name')
  if (error) throw error
  return (data || []) as AnalysisSupplierOption[]
}

export async function getSupplierPurchaseSales360(params: {
  supplierId: string
  dateFrom?: string
  dateTo?: string
}): Promise<SupplierPurchaseSales360> {
  const { companyId } = await getAuthedCompany()
  const { supplierId, dateFrom, dateTo } = params

  const { data: supplier, error: supplierError } = await adqQuery('suppliers')
    .select('id,business_name,supplier_kind,parent_supplier_id')
    .eq('company_id', companyId)
    .eq('id', supplierId)
    .single()
  if (supplierError) throw supplierError
  if (!supplier) throw new Error('Proveedor no encontrado')
  const typedSupplier = supplier as SupplierRow

  const childIds: string[] = [supplierId]
  const { data: children } = await adqQuery('suppliers')
    .select('id,business_name,bsale_product_type_name')
    .eq('company_id', companyId)
    .eq('parent_supplier_id', supplierId)
    .eq('is_active', true)
  if (children?.length) childIds.push(...(children as SupplierRow[]).map((c) => c.id))

  const { data: mappings, error: mappingsError } = await adqQuery('product_supplier_mappings')
    .select('product_id,sku,unit_cost,supplier_id,bsale_variant_id,is_preferred,product_name')
    .eq('company_id', companyId)
    .in('supplier_id', childIds)
    .eq('is_active', true)
  if (mappingsError) throw mappingsError

  const typedMappings = (mappings || []) as MappingRow[]
  const productIds = Array.from(new Set(typedMappings.map((m) => m.product_id).filter(Boolean)))
  const skus = Array.from(new Set(typedMappings.map((m) => m.sku).filter(Boolean))) as string[]
  const pseudoNameBySupplierId: Record<string, string> = {}
  ;(children as SupplierRow[] | null)?.forEach((child) => {
    pseudoNameBySupplierId[child.id] = child.business_name || child.bsale_product_type_name || ''
  })

  const typedProducts: ProductRow[] = []
  for (const skuChunk of chunkArray(skus, 150)) {
    const { data: products, error: productsError } = skuChunk.length
      ? await adqQuery('products')
          .select('id,sku,description,bsale_variant_id')
          .eq('company_id', companyId)
          .in('sku', skuChunk)
      : { data: [], error: null }
    if (productsError) throw productsError
    typedProducts.push(...((products || []) as ProductRow[]))
  }
  const productById = new Map(typedProducts.map((p) => [p.id, p]))
  const productBySku = new Map(typedProducts.map((p) => [String(p.sku || ''), p]))
  const preferredMappingByProductId = new Map<string, MappingRow>()
  for (const mapping of typedMappings) {
    const productId = String(mapping.product_id || '')
    if (!productId || preferredMappingByProductId.has(productId)) continue
    preferredMappingByProductId.set(productId, mapping)
  }

  const stockByVariantId = new Map<number, number>()
  const variantIds = Array.from(new Set(typedProducts.map((p) => Number(p.bsale_variant_id || 0)).filter((id) => Number.isFinite(id) && id > 0)))
  for (const variantChunk of chunkArray(variantIds, 150)) {
    const { data: stockRows, error: stockError } = variantChunk.length
      ? await integQuery('bsale_stock_current')
          .select('variant_id,quantity_available')
          .eq('company_id', companyId)
          .in('variant_id', variantChunk)
      : { data: [], error: null }
    if (stockError) throw stockError
    for (const row of (stockRows || []) as StockRow[]) {
      const variantId = Number(row.variant_id || 0)
      if (!variantId) continue
      stockByVariantId.set(variantId, (stockByVariantId.get(variantId) || 0) + toNum(row.quantity_available))
    }
  }

  const allDocs5forRange = await fetchAll<{ emission_date?: string }>(
    integQuery('bsale_documents')
      .select('emission_date')
      .eq('company_id', companyId)
      .eq('document_type_id', 5)
      .order('bsale_id')
  )
  let globalMin = ''
  let globalMax = ''
  allDocs5forRange.forEach((d: { emission_date?: string }) => {
    if (d.emission_date) {
      if (!globalMin || d.emission_date < globalMin) globalMin = d.emission_date
      if (!globalMax || d.emission_date > globalMax) globalMax = d.emission_date
    }
  })
  const from = dateFrom || globalMin
  const to = dateTo || globalMax

  const docs5 = await fetchAll<DocumentRow>(
    integQuery('bsale_documents')
      .select('bsale_id,total_amount,net_amount,emission_date')
      .eq('company_id', companyId)
      .eq('document_type_id', 5)
      .gte('emission_date', from)
      .lte('emission_date', to)
      .order('bsale_id')
  )
  const docsNc = await fetchAll<DocumentRow>(
    integQuery('bsale_documents')
      .select('bsale_id,total_amount,net_amount,emission_date')
      .eq('company_id', companyId)
      .eq('document_type_id', 2)
      .gte('emission_date', from)
      .lte('emission_date', to)
      .order('bsale_id')
  )

  const invoiceIds = docs5.map((d) => d.bsale_id)
  const ncIds = docsNc.map((d) => d.bsale_id)
  const skuSet = new Set(skus)
  const docsById = new Map(docs5.map((d) => [d.bsale_id as number, d]))
  const ncDocsById = new Map(docsNc.map((d) => [d.bsale_id as number, d]))

  const salesBySku: Record<string, { units: number; net: number; gross: number; lastSale: string | null }> = {}
  const salesByDate = new Map<string, number>()
  const marginByDate = new Map<string, number>()
  let totalSalesNet = 0
  let totalSalesGross = 0
  let totalEstimatedCost = 0

  const processDetailRows = (rows: DetailRow[], docMap: Map<number, { total_amount?: unknown; net_amount?: unknown; emission_date?: string }>, sign: 1 | -1) => {
    for (const row of rows) {
      const sku = String(row.variant_code || '')
      if (!skuSet.has(sku)) continue
      const qty = toNum(row.quantity) * sign
      const net = toNum(row.net_amount) * sign
      const doc = docMap.get(Number(row.bsale_document_id || 0))
      const docNet = toNum(doc?.net_amount)
      const docGross = toNum(doc?.total_amount)
      const gross = docNet > 0 ? net * (docGross / docNet) : net
      const date = String(doc?.emission_date || '')
      const mapping = typedMappings.find((m) => m.sku === sku && childIds.includes(m.supplier_id))
      const unitCost = toNum(mapping?.unit_cost)
      if (!salesBySku[sku]) salesBySku[sku] = { units: 0, net: 0, gross: 0, lastSale: null }
      salesBySku[sku].units += qty
      salesBySku[sku].net += net
      salesBySku[sku].gross += gross
      if (date && (!salesBySku[sku].lastSale || date > salesBySku[sku].lastSale!)) salesBySku[sku].lastSale = date
      totalSalesNet += net
      totalSalesGross += gross
      totalEstimatedCost += qty * unitCost
      if (date) {
        salesByDate.set(date, (salesByDate.get(date) || 0) + gross)
        marginByDate.set(date, (marginByDate.get(date) || 0) + (net - (qty * unitCost)))
      }
    }
  }

  const detailChunkSize = 200
  for (let idx = 0; idx < invoiceIds.length; idx += detailChunkSize) {
    const chunk = invoiceIds.slice(idx, idx + detailChunkSize)
      const { data: details, error } = await integQuery('bsale_document_details')
        .select('variant_code,quantity,net_amount,bsale_document_id')
        .eq('company_id', companyId)
        .in('bsale_document_id', chunk)
      if (error) throw error
      processDetailRows((details || []) as DetailRow[], docsById, 1)
  }

  for (let idx = 0; idx < ncIds.length; idx += detailChunkSize) {
    const chunk = ncIds.slice(idx, idx + detailChunkSize)
      const { data: details, error } = await integQuery('bsale_document_details')
        .select('variant_code,quantity,net_amount,bsale_document_id')
        .eq('company_id', companyId)
        .in('bsale_document_id', chunk)
      if (error) throw error
      processDetailRows((details || []) as DetailRow[], ncDocsById, -1)
  }

  const receptionCountResult = await integQuery('bsale_receptions').select('id', { count: 'exact', head: true }).eq('company_id', companyId)
  const receptionDetailCountResult = await integQuery('bsale_reception_details').select('id', { count: 'exact', head: true }).eq('company_id', companyId)
  const hasReceptionData = Boolean((receptionCountResult.count || 0) > 0 && (receptionDetailCountResult.count || 0) > 0)
  let purchasesAmount: number | null = null
  let lastPurchaseDate: string | null = null
  let lastPurchases: SupplierPurchaseRow[] = []
  const purchasesByDate = new Map<string, number>()

  if (hasReceptionData && skus.length > 0) {
    const typedReceptionDetails: ReceptionDetailRow[] = []
    for (const skuChunk of chunkArray(skus, 150)) {
      const { data: receptionDetails, error: receptionDetailsError } = await integQuery('bsale_reception_details')
        .select('bsale_reception_id,variant_code,quantity,cost')
        .eq('company_id', companyId)
        .in('variant_code', skuChunk)
      if (receptionDetailsError) throw receptionDetailsError
      typedReceptionDetails.push(...((receptionDetails || []) as ReceptionDetailRow[]))
    }

    const receptionIds = Array.from(new Set(typedReceptionDetails.map((row) => Number(row.bsale_reception_id || 0)).filter((id) => id > 0)))
    const { data: receptions, error: receptionsError } = receptionIds.length
        ? await integQuery('bsale_receptions')
          .select('bsale_id,raw_admission_date,admission_date,document,document_number')
          .eq('company_id', companyId)
          .gte('raw_admission_date', from)
          .lte('raw_admission_date', to)
          .in('bsale_id', receptionIds)
      : { data: [], error: null }
    if (receptionsError) throw receptionsError
    const typedReceptions = (receptions || []) as ReceptionRow[]

    const receptionById = new Map(typedReceptions.map((row) => [Number(row.bsale_id || 0), row]))
    const purchaseMap = new Map<number, { date: string; document: string; documentNumber?: string; products: Map<string, { sku: string; quantity: number; unitCost: number; amount: number }>; units: number; amount: number }>()
    purchasesAmount = 0

    for (const detail of typedReceptionDetails) {
      const receptionId = Number(detail.bsale_reception_id || 0)
      const header = receptionById.get(receptionId)
      if (!header) continue
      const date = String(header.raw_admission_date || String(header.admission_date || '').slice(0, 10) || '')
      const documentNumber = header.document_number ? String(header.document_number).trim() : ''
      const document = `${header.document || 'Sin Documento'}${documentNumber ? ` ${documentNumber}` : ''}`.trim()
      const qty = toNum(detail.quantity)
      const amount = qty * toNum(detail.cost)
      purchasesAmount += amount
      if (date) purchasesByDate.set(date, (purchasesByDate.get(date) || 0) + amount)
      if (!lastPurchaseDate || (date && date > lastPurchaseDate)) lastPurchaseDate = date || lastPurchaseDate
      if (!purchaseMap.has(receptionId)) {
        purchaseMap.set(receptionId, { date, document, documentNumber, products: new Map(), units: 0, amount: 0 })
      }
      const current = purchaseMap.get(receptionId)!
      const sku = detail.variant_code ? String(detail.variant_code) : ''
      if (sku) {
        if (!current.products.has(sku)) {
          current.products.set(sku, { sku, quantity: 0, unitCost: toNum(detail.cost), amount: 0 })
        }
        const p = current.products.get(sku)!
        p.quantity += qty
        p.amount += amount
      }
      current.units += qty
      current.amount += amount
    }

    lastPurchases = Array.from(purchaseMap.values())
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 10)
      .map((row) => {
        const skuSet = new Set(row.products.keys())
        const productPreview = uniqueSkuPreview(skuSet)

        const productsList = Array.from(row.products.values()).map(p => {
          const product = productBySku.get(p.sku)
          const name = String(product?.description || p.sku || 'Sin descripción')
          return {
            sku: p.sku,
            name,
            quantity: Math.round(p.quantity),
            unitCost: Math.round(p.unitCost),
            subtotal: Math.round(p.amount)
          }
        })

        return {
          date: row.date,
          document: row.document,
          documentNumber: row.documentNumber,
          productsSummary: productPreview.productsSummary,
          productSkusPreview: productPreview.preview,
          productCount: productPreview.count,
          units: Math.round(row.units),
          amount: Math.round(row.amount),
          products: productsList,
        }
      })
    purchasesAmount = Math.round(purchasesAmount)
  }

  const catalog: SupplierCatalogRow[] = productIds.map((productId) => {
    const preferred = preferredMappingByProductId.get(productId)
    const product = productById.get(productId) || productBySku.get(String(preferred?.sku || ''))
    const sku = String(product?.sku || preferred?.sku || '')
    const variantId = Number(product?.bsale_variant_id || preferred?.bsale_variant_id || 0)
    const stockCurrent = variantId ? Math.round(stockByVariantId.get(variantId) || 0) : 0
    const averageCost = Math.round(toNum(preferred?.unit_cost))
    const sales = salesBySku[sku] || { units: 0, net: 0, gross: 0, lastSale: null }
    return {
      product_id: productId,
      sku,
      product_name: String(product?.description || preferred?.product_name || sku || 'Sin descripción'),
      pseudo_supplier: preferred?.supplier_id && preferred.supplier_id !== supplierId ? pseudoNameBySupplierId[preferred.supplier_id] || '' : '',
      stock_current: stockCurrent,
      average_cost: averageCost,
      sales_amount: Math.round(sales.gross),
      units_sold: Math.round(sales.units),
      last_sale: sales.lastSale,
    }
  }).sort((a, b) => b.sales_amount - a.sales_amount || a.product_name.localeCompare(b.product_name, 'es'))

  const weekly = buildWeeklySeries(from, to, salesByDate, purchasesByDate, marginByDate)

  return {
    supplier: {
      id: typedSupplier.id,
      business_name: typedSupplier.business_name,
      supplier_kind: typedSupplier.supplier_kind,
    },
    source: {
      sales: 'Facturas electrónicas tipo 5 menos Notas de Crédito tipo 2 desde Bsale',
      purchases: hasReceptionData ? 'Recepciones Bsale sincronizadas' : 'integraciones.bsale_receptions pendiente de sincronización',
      stock: 'integraciones.bsale_stock_current',
      supplier_resolution: 'producto → product_supplier_mappings → proveedor operativo → parent_supplier_id → proveedor real',
    },
    period: { from, to },
    kpis: {
      purchases_amount: hasReceptionData ? purchasesAmount : null,
      sales_amount: Math.round(totalSalesGross),
      estimated_margin: Math.round(totalSalesNet - totalEstimatedCost),
      stock_value: Math.round(catalog.reduce((sum, row) => sum + row.stock_current * row.average_cost, 0)),
      last_purchase_date: hasReceptionData ? lastPurchaseDate : null,
    },
    hasReceptionData,
    weekly,
    lastPurchases,
    catalog,
  }
}

export async function getSupplierWeeklyDetail(params: {
  supplierId: string
  dateFrom: string
  dateTo: string
}): Promise<SupplierWeeklyDetail> {
  const { companyId } = await getAuthedCompany()
  const { supplierId, dateFrom, dateTo } = params

  const { data: supplier, error: supplierError } = await adqQuery('suppliers')
    .select('id,business_name,supplier_kind,parent_supplier_id')
    .eq('company_id', companyId)
    .eq('id', supplierId)
    .single()
  if (supplierError) throw supplierError
  if (!supplier) throw new Error('Proveedor no encontrado')

  const childIds: string[] = [supplierId]
  const { data: children } = await adqQuery('suppliers')
    .select('id,business_name')
    .eq('company_id', companyId)
    .eq('parent_supplier_id', supplierId)
    .eq('is_active', true)
  if (children?.length) childIds.push(...(children as SupplierRow[]).map((c) => c.id))

  const { data: mappings, error: mappingsError } = await adqQuery('product_supplier_mappings')
    .select('product_id,sku,unit_cost,supplier_id,bsale_variant_id,is_preferred,product_name')
    .eq('company_id', companyId)
    .in('supplier_id', childIds)
    .eq('is_active', true)
  if (mappingsError) throw mappingsError

  const typedMappings = (mappings || []) as MappingRow[]
  const skus = Array.from(new Set(typedMappings.map((m) => m.sku).filter(Boolean))) as string[]
  const skuSet = new Set(skus)

  const typedProducts: ProductRow[] = []
  for (const skuChunk of chunkArray(skus, 150)) {
    const { data: products } = skuChunk.length
      ? await adqQuery('products').select('id,sku,description,bsale_variant_id').eq('company_id', companyId).in('sku', skuChunk)
      : { data: [] }
    typedProducts.push(...((products || []) as ProductRow[]))
  }
  const productBySku = new Map(typedProducts.map((p) => [String(p.sku || ''), p]))
  const preferredMappingBySku = new Map<string, MappingRow>()
  for (const mapping of typedMappings) {
    if (mapping.sku && !preferredMappingBySku.has(mapping.sku)) preferredMappingBySku.set(mapping.sku, mapping)
  }

  function getProductName(sku: string) {
    const p = productBySku.get(sku)
    const m = preferredMappingBySku.get(sku)
    return String(p?.description || m?.product_name || sku || 'Sin descripción')
  }

  const docs5 = await fetchAll<DocumentRow>(
    integQuery('bsale_documents')
      .select('bsale_id,total_amount,net_amount,emission_date,client_organization,number')
      .eq('company_id', companyId)
      .eq('document_type_id', 5)
      .gte('emission_date', dateFrom)
      .lte('emission_date', dateTo)
      .order('bsale_id')
  )
  const docsNc = await fetchAll<DocumentRow>(
    integQuery('bsale_documents')
      .select('bsale_id,total_amount,net_amount,emission_date,client_organization,number')
      .eq('company_id', companyId)
      .eq('document_type_id', 2)
      .gte('emission_date', dateFrom)
      .lte('emission_date', dateTo)
      .order('bsale_id')
  )

  const saleDocuments: SupplierWeeklyDocumentDetail[] = []
  let totalSales = 0

  const topProductsMap = new Map<string, SupplierWeeklyProductDetail>()
  const ensureTopProduct = (sku: string) => {
    if (!topProductsMap.has(sku)) {
      topProductsMap.set(sku, { sku, description: getProductName(sku), units: 0, amount: 0 })
    }
    return topProductsMap.get(sku)!
  }

  const processSalesDetailRows = (rows: DetailRow[], docMap: Map<number, DocumentRow>, kind: 'SALE' | 'CREDIT_NOTE', sign: 1 | -1) => {
    const docSummaryMap = new Map<number, { doc: DocumentRow; amount: number; units: number; skus: Set<string> }>()

    for (const row of rows) {
      const sku = String(row.variant_code || '')
      if (!skuSet.has(sku)) continue

      const docId = Number(row.bsale_document_id || 0)
      const doc = docMap.get(docId)
      if (!doc) continue

      const qty = toNum(row.quantity) * sign
      const net = toNum(row.net_amount) * sign
      const docNet = toNum(doc.net_amount)
      const docGross = toNum(doc.total_amount)
      const gross = docNet > 0 ? net * (docGross / docNet) : net

      totalSales += gross
      const tp = ensureTopProduct(sku)
      tp.units += qty
      tp.amount += Math.abs(gross)

      if (!docSummaryMap.has(docId)) {
        docSummaryMap.set(docId, { doc, amount: 0, units: 0, skus: new Set() })
      }
      const s = docSummaryMap.get(docId)!
      s.amount += gross
      s.units += qty
      s.skus.add(sku)
    }

    for (const [docId, s] of docSummaryMap.entries()) {
      if (s.amount === 0 && s.units === 0) continue
      saleDocuments.push({
        id: `sale-${docId}`,
        date: String(s.doc.emission_date || ''),
        document: kind === 'SALE' ? 'Factura' : 'Nota Crédito',
        documentNumber: String((s.doc as any).number || docId),
        amount: Math.round(s.amount),
        units: Math.round(s.units),
        skuCount: s.skus.size,
        productsSummary: uniqueSkuPreview(s.skus).productsSummary,
        kind,
        customerName: (s.doc as any).client_organization || 'Sin Cliente',
        sellerName: sellerByDocId.get(docId) || null
      })
    }
  }

  const invoiceIds = docs5.map(d => d.bsale_id)
  const ncIds = docsNc.map(d => d.bsale_id)
  const docsById = new Map(docs5.map(d => [d.bsale_id, d]))
  const ncDocsById = new Map(docsNc.map(d => [d.bsale_id, d]))
  const allDocIds = [...invoiceIds, ...ncIds]

  let sellerByDocId = new Map<number, string>()
  if (allDocIds.length > 0) {
    const detailChunkSize = 200
    for (let idx = 0; idx < allDocIds.length; idx += detailChunkSize) {
      const chunk = allDocIds.slice(idx, idx + detailChunkSize)
      const { data: sellersData } = await integQuery('bsale_document_sellers')
        .select('bsale_document_id,seller_name')
        .eq('company_id', companyId)
        .in('bsale_document_id', chunk)
      if (sellersData) {
        for (const s of (sellersData as any[])) {
          if (s.seller_name) sellerByDocId.set(s.bsale_document_id, s.seller_name)
        }
      }
    }
  }

  const detailChunkSize = 200
  for (let idx = 0; idx < invoiceIds.length; idx += detailChunkSize) {
    const chunk = invoiceIds.slice(idx, idx + detailChunkSize)
    const { data: details } = await integQuery('bsale_document_details').select('variant_code,quantity,net_amount,bsale_document_id').eq('company_id', companyId).in('bsale_document_id', chunk)
    processSalesDetailRows((details || []) as DetailRow[], docsById, 'SALE', 1)
  }
  for (let idx = 0; idx < ncIds.length; idx += detailChunkSize) {
    const chunk = ncIds.slice(idx, idx + detailChunkSize)
    const { data: details } = await integQuery('bsale_document_details').select('variant_code,quantity,net_amount,bsale_document_id').eq('company_id', companyId).in('bsale_document_id', chunk)
    processSalesDetailRows((details || []) as DetailRow[], ncDocsById, 'CREDIT_NOTE', -1)
  }

  const purchaseDocuments: SupplierWeeklyDocumentDetail[] = []
  let totalPurchases = 0

  if (skus.length > 0) {
    const typedReceptionDetails: ReceptionDetailRow[] = []
    for (const skuChunk of chunkArray(skus, 150)) {
      const { data: receptionDetails } = await integQuery('bsale_reception_details').select('bsale_reception_id,variant_code,quantity,cost').eq('company_id', companyId).in('variant_code', skuChunk)
      typedReceptionDetails.push(...((receptionDetails || []) as ReceptionDetailRow[]))
    }

    const receptionIds = Array.from(new Set(typedReceptionDetails.map(row => Number(row.bsale_reception_id || 0)).filter(id => id > 0)))
    const { data: receptions } = receptionIds.length
      ? await integQuery('bsale_receptions')
          .select('bsale_id,raw_admission_date,admission_date,document,document_number,raw_json')
          .eq('company_id', companyId)
          .gte('raw_admission_date', dateFrom)
          .lte('raw_admission_date', dateTo)
          .in('bsale_id', receptionIds)
      : { data: [] }
    const typedReceptions = (receptions || []) as ReceptionRow[]
    const receptionById = new Map(typedReceptions.map(row => [Number(row.bsale_id || 0), row]))

    const docSummaryMap = new Map<number, { doc: ReceptionRow; amount: number; units: number; skus: Set<string> }>()

    for (const detail of typedReceptionDetails) {
      const receptionId = Number(detail.bsale_reception_id || 0)
      const header = receptionById.get(receptionId)
      if (!header) continue

      const sku = String(detail.variant_code || '')
      const qty = toNum(detail.quantity)
      const amount = qty * toNum(detail.cost)

      totalPurchases += amount
      const tp = ensureTopProduct(sku)
      tp.units += Math.abs(qty)
      tp.amount += Math.abs(amount)

      if (!docSummaryMap.has(receptionId)) {
        docSummaryMap.set(receptionId, { doc: header, amount: 0, units: 0, skus: new Set() })
      }
      const s = docSummaryMap.get(receptionId)!
      s.amount += amount
      s.units += qty
      s.skus.add(sku)
    }

    for (const [receptionId, s] of docSummaryMap.entries()) {
      if (s.amount === 0 && s.units === 0) continue
      const date = String(s.doc.raw_admission_date || String(s.doc.admission_date || '').slice(0, 10) || '')

      const rawJson = (s.doc as any).raw_json || {}
      const docNum = String(s.doc.document_number || rawJson.documentNumber || rawJson.document_number || rawJson.number || '').trim()

      purchaseDocuments.push({
        id: `purchase-${receptionId}`,
        date,
        document: String(s.doc.document || 'Sin Doc'),
        documentNumber: docNum || 'Sin número',
        amount: Math.round(s.amount),
        units: Math.round(s.units),
        skuCount: s.skus.size,
        productsSummary: uniqueSkuPreview(s.skus).productsSummary,
        kind: 'PURCHASE'
      })
    }
  }

  const topProducts = Array.from(topProductsMap.values())
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5)
    .map(p => ({ ...p, amount: Math.round(p.amount), units: Math.round(p.units) }))

  saleDocuments.sort((a, b) => b.date.localeCompare(a.date))
  purchaseDocuments.sort((a, b) => b.date.localeCompare(a.date))

  return {
    weekStart: dateFrom,
    weekEnd: dateTo,
    label: formatWeekLabel(dateFrom, dateTo),
    purchases: Math.round(totalPurchases),
    sales: Math.round(totalSales),
    difference: Math.round(totalSales) - Math.round(totalPurchases),
    purchaseDocuments,
    saleDocuments,
    topProducts
  }
}

type BsaleReceptionDetail = { variant_code: string; quantity: number; cost: number }
type BsaleDocumentDetail = { variant_code: string; quantity: number; net_amount: number; total_amount: number }
type SupplierMappingRow = { sku: string; supplier_id: string }

export async function getSupplierDocumentDetail({ supplierId, documentKind, documentId }: { supplierId: string; documentKind: 'PURCHASE' | 'SALE' | 'CREDIT_NOTE'; documentId: string }): Promise<SupplierDocumentDetail | null> {
  const { companyId } = await getAuthedCompany()

  const { data: children } = await adqQuery('product_suppliers').select('id').eq('parent_supplier_id', supplierId).eq('company_id', companyId)
  const childIds: string[] = [supplierId]
  if (children?.length) childIds.push(...(children as { id: string }[]).map((c) => c.id))

  if (documentKind === 'PURCHASE') {
    const { data } = await integQuery('bsale_receptions').select('id,bsale_id,raw_admission_date,document,document_number,raw_json,bsale_reception_details(id,variant_code,quantity,cost)').eq('company_id', companyId).eq('bsale_id', Number(documentId)).single()
    const reception = data as unknown as { raw_admission_date: string; document: string; document_number: string; raw_json: any; bsale_reception_details: BsaleReceptionDetail[] }
    if (!reception) return null

    // We must filter the lines to only those that map to this supplierId
    const skus = (reception.bsale_reception_details || []).map((d) => d.variant_code).filter(Boolean)
    const { data: mapData } = await adqQuery('product_supplier_mappings').select('sku,supplier_id').eq('company_id', companyId).in('sku', skus)
    const mappings = mapData as unknown as SupplierMappingRow[]

    const { data: productsData } = await adqQuery('products').select('sku,description').eq('company_id', companyId).in('sku', skus)
    const descMap = new Map((productsData as unknown as { sku: string; description: string }[])?.map(p => [p.sku, p.description]) || [])

    let totalAmount = 0
    let totalUnits = 0
    const lines: SupplierDocumentLineDetail[] = []
    let skuCount = 0

    for (const line of (reception.bsale_reception_details || [])) {
      const mapping = mappings?.find((m) => m.sku === line.variant_code && childIds.includes(m.supplier_id))
      if (mapping) {
        totalAmount += line.quantity * line.cost
        totalUnits += line.quantity
        skuCount++
        lines.push({
          sku: line.variant_code,
          description: descMap.get(line.variant_code) || line.variant_code,
          quantity: line.quantity,
          unitAmount: line.cost,
          totalAmount: line.quantity * line.cost,
          kind: 'PURCHASE'
        })
      }
    }

    const rawJson = reception.raw_json || {}
    const docNum = String(reception.document_number || rawJson.documentNumber || rawJson.document_number || rawJson.number || '').trim()

    if (lines.length === 0) return null
    return {
      id: documentId,
      date: String(reception.raw_admission_date || ''),
      document: String(reception.document || 'Recepción'),
      documentNumber: docNum || 'Sin número',
      totalAmount: Math.round(totalAmount),
      units: totalUnits,
      skuCount,
      lines
    }
  } else {
    const { data } = await integQuery('bsale_documents').select('id,bsale_id,emission_date,document_type_id,number,client_organization,bsale_document_details(id,variant_code,quantity,net_amount,total_amount)').eq('company_id', companyId).eq('bsale_id', Number(documentId)).single()
    const doc = data as unknown as { emission_date: string; number: string; client_organization: string; bsale_document_details: BsaleDocumentDetail[] }
    if (!doc) return null

    const skus = (doc.bsale_document_details || []).map((d) => d.variant_code).filter(Boolean)
    const { data: mapData } = await adqQuery('product_supplier_mappings').select('sku,supplier_id').eq('company_id', companyId).in('sku', skus)
    const mappings = mapData as unknown as MappingRow[]

    const { data: productsData } = await adqQuery('products').select('sku,description').eq('company_id', companyId).in('sku', skus)
    const descMap = new Map((productsData as unknown as { sku: string; description: string }[])?.map(p => [p.sku, p.description]) || [])

    let sellerName: string | null = null
    try {
      const { data: sellerData } = await integQuery('bsale_document_sellers').select('seller_name').eq('company_id', companyId).eq('bsale_document_id', Number(documentId)).maybeSingle()
      if (sellerData) sellerName = (sellerData as any).seller_name
    } catch (e) {
      // ignore
    }

    let totalAmount = 0
    let totalUnits = 0
    const lines: SupplierDocumentLineDetail[] = []
    let skuCount = 0

    for (const line of (doc.bsale_document_details || [])) {
      const mapping = mappings?.find((m) => m.sku === line.variant_code && childIds.includes(m.supplier_id))
      if (mapping) {
        totalAmount += line.total_amount
        totalUnits += line.quantity
        skuCount++
        lines.push({
          sku: line.variant_code,
          description: descMap.get(line.variant_code) || line.variant_code,
          quantity: line.quantity,
          unitAmount: line.quantity > 0 ? line.total_amount / line.quantity : 0,
          totalAmount: line.total_amount,
          kind: documentKind as 'SALE' | 'CREDIT_NOTE'
        })
      }
    }

    if (lines.length === 0) return null
    return {
      id: documentId,
      date: String(doc.emission_date || ''),
      document: documentKind === 'SALE' ? 'Factura' : 'Nota de Crédito',
      documentNumber: String(doc.number || documentId),
      customerName: String(doc.client_organization || 'Sin Cliente'),
      sellerName,
      totalAmount: Math.round(totalAmount),
      units: totalUnits,
      skuCount,
      lines
    }
  }
}
