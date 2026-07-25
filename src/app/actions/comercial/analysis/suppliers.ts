'use server'

import type { AnalysisSupplierOption, SupplierCatalogRow, SupplierMonthlyPoint, SupplierPurchaseSales360 } from './types'
import { adqQuery, fetchAll, getAuthedCompany, integQuery, monthKey, monthLabel, toNum } from './utils'

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

function fmtDocument(documentId: number) {
  return `Recepción #${documentId}`
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

  const { data: products, error: productsError } = productIds.length
    ? await adqQuery('products')
        .select('id,sku,description,bsale_variant_id')
        .eq('company_id', companyId)
        .in('id', productIds)
    : { data: [], error: null }
  if (productsError) throw productsError

  const typedProducts = (products || []) as ProductRow[]
  const productById = new Map(typedProducts.map((p) => [p.id, p]))
  const preferredMappingByProductId = new Map<string, MappingRow>()
  for (const mapping of typedMappings) {
    const productId = String(mapping.product_id || '')
    if (!productId || preferredMappingByProductId.has(productId)) continue
    preferredMappingByProductId.set(productId, mapping)
  }

  const variantIds = Array.from(new Set(typedProducts.map((p) => Number(p.bsale_variant_id || 0)).filter((id) => Number.isFinite(id) && id > 0)))
  const { data: stockRows, error: stockError } = variantIds.length
    ? await integQuery('bsale_stock_current')
        .select('variant_id,quantity_available')
        .eq('company_id', companyId)
        .in('variant_id', variantIds)
    : { data: [], error: null }
  if (stockError) throw stockError

  const stockByVariantId = new Map<number, number>()
  for (const row of (stockRows || []) as StockRow[]) {
    const variantId = Number(row.variant_id || 0)
    if (!variantId) continue
    stockByVariantId.set(variantId, (stockByVariantId.get(variantId) || 0) + toNum(row.quantity_available))
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
  const monthlySales = new Map<string, number>()
  let totalSalesGross = 0
  let totalSalesNet = 0
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
        const key = monthKey(date)
        monthlySales.set(key, (monthlySales.get(key) || 0) + gross)
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

  const catalog: SupplierCatalogRow[] = productIds.map((productId) => {
    const product = productById.get(productId)
    const preferred = preferredMappingByProductId.get(productId)
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

  const monthlyMap = new Map<string, SupplierMonthlyPoint>()
  for (const [month, sales] of monthlySales.entries()) {
    monthlyMap.set(month, { month: monthLabel(month), purchases: 0, sales: Math.round(sales) })
  }
  const monthly = Array.from(monthlyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, value]) => value)

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
      purchases_amount: hasReceptionData ? 0 : null,
      sales_amount: Math.round(totalSalesGross),
      estimated_margin: Math.round(totalSalesNet - totalEstimatedCost),
      stock_value: Math.round(catalog.reduce((sum, row) => sum + row.stock_current * row.average_cost, 0)),
      last_purchase_date: null,
    },
    hasReceptionData,
    monthly,
    lastPurchases: hasReceptionData ? [{ date: '', document: fmtDocument(0), products: 0, units: 0, amount: 0 }].filter(() => false) : [],
    catalog,
  }
}
