'use server'

/* eslint-disable @typescript-eslint/no-explicit-any */

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

const COMPANY_ID = 'd1000000-0000-0000-0000-000000000001'

function toNum(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') return parseFloat(v) || 0
  return 0
}

async function getAuthedUser() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) throw new Error('No autenticado')
  return user
}

function integQuery(tbl: string) {
  const admin = createAdminClient()
  return admin.schema('integraciones').from(tbl as any)
}

function adqQuery(tbl: string) {
  const admin = createAdminClient()
  return admin.schema('adquisiciones').from(tbl as any)
}

async function fetchAll<T>(qb: any, pageSize = 1000): Promise<T[]> {
  const all: T[] = []
  let offset = 0
  while (true) {
    const { data, error } = await qb.range(offset, offset + pageSize - 1)
    if (error) throw new Error(`Error fetching page at offset ${offset}: ${error.message}`)
    if (!data || data.length === 0) break
    all.push(...data)
    offset += pageSize
    if (data.length < pageSize) break
  }
  return all
}

export async function getCommercialAnalysisOverview(params: {
  dateFrom?: string
  dateTo?: string
}) {
  await getAuthedUser()
  const { dateFrom, dateTo } = params

  const allDocs5forRange = await fetchAll<any>(
    integQuery('bsale_documents')
      .select('emission_date')
      .eq('company_id', COMPANY_ID)
      .eq('document_type_id', 5)
      .order('bsale_id')
  )
  let globalMin = ''
  let globalMax = ''
  allDocs5forRange.forEach((d: any) => {
    if (d.emission_date) {
      if (!globalMin || d.emission_date < globalMin) globalMin = d.emission_date
      if (!globalMax || d.emission_date > globalMax) globalMax = d.emission_date
    }
  })
  const frm = dateFrom || globalMin
  const t = dateTo || globalMax

  const docs5 = await fetchAll<any>(
    integQuery('bsale_documents')
      .select('bsale_id, net_amount, total_amount, emission_date, client_id')
      .eq('company_id', COMPANY_ID)
      .eq('document_type_id', 5)
      .gte('emission_date', frm)
      .lte('emission_date', t)
      .order('bsale_id')
  )

  const facturaIds: number[] = docs5.map(d => d.bsale_id)
  const docs5ByClient = docs5 as Array<{ client_id: number | null }>
  const uniqueClients = new Set(docs5ByClient.map(d => d.client_id).filter(Boolean))

  let netSales = 0
  let grossSalesFE = 0
  docs5.forEach(d => {
    netSales += toNum(d.net_amount)
    grossSalesFE += toNum(d.total_amount)
  })

  const docClientMap: Record<number, number> = {}
  docs5.forEach(d => { if (d.client_id) docClientMap[d.bsale_id] = d.client_id })

  let totalUnits = 0
  const productSalesMap: Record<string, { qty: number; net: number }> = {}
  const clientSalesMap: Record<string, { net: number; qty: number; invoices: Set<number> }> = {}
  if (facturaIds.length > 0) {
    const CHUNK = 200
    for (let idx = 0; idx < facturaIds.length; idx += CHUNK) {
      const chunk = facturaIds.slice(idx, idx + CHUNK)
      const { data: details } = await integQuery('bsale_document_details')
        .select('variant_code, quantity, net_amount, bsale_document_id')
        .eq('company_id', COMPANY_ID)
        .in('bsale_document_id', chunk)
      if (details) {
        for (const d of details) {
          const qty = toNum(d.quantity)
          const net = toNum(d.net_amount)
          totalUnits += qty
          if (d.variant_code) {
            if (!productSalesMap[d.variant_code]) productSalesMap[d.variant_code] = { qty: 0, net: 0 }
            productSalesMap[d.variant_code].qty += qty
            productSalesMap[d.variant_code].net += net
          }
          const cId = docClientMap[d.bsale_document_id]
          if (cId) {
            const ck = String(cId)
            if (!clientSalesMap[ck]) clientSalesMap[ck] = { net: 0, qty: 0, invoices: new Set() }
            clientSalesMap[ck].net += net
            clientSalesMap[ck].qty += qty
            clientSalesMap[ck].invoices.add(d.bsale_document_id)
          }
        }
      }
    }
  }

  const productsSold = Object.keys(productSalesMap).length

  const { data: mappings } = await adqQuery('product_supplier_mappings')
    .select('supplier_id, sku')
    .eq('company_id', COMPANY_ID)

  const { data: suppliers } = await adqQuery('suppliers')
    .select('id, business_name, supplier_kind, parent_supplier_id')
    .eq('company_id', COMPANY_ID)

  type SupRow = { id: string; business_name: string; supplier_kind: string; parent_supplier_id: string | null }
  const supMap: Record<string, SupRow> = {}
  suppliers?.forEach((s: any) => { supMap[s.id] = s })

  const skuToRealSupplier: Record<string, string> = {}
  mappings?.forEach((m: any) => {
    const s = supMap[m.supplier_id]
    const realId = s?.parent_supplier_id || (s?.supplier_kind === 'REAL' ? m.supplier_id : null)
    if (realId && supMap[realId]) {
      skuToRealSupplier[m.sku] = realId
    }
  })

  const supplierSales: Record<string, { net: number; qty: number }> = {}
  for (const [sku, info] of Object.entries(productSalesMap)) {
    const realId = skuToRealSupplier[sku]
    if (realId) {
      if (!supplierSales[realId]) supplierSales[realId] = { net: 0, qty: 0 }
      supplierSales[realId].net += info.net
      supplierSales[realId].qty += info.qty
    }
  }

  const topSuppliers = Object.entries(supplierSales)
    .sort((a, b) => b[1].net - a[1].net)
    .slice(0, 5)
    .map(([id, info]) => ({
      supplier_id: id,
      business_name: supMap[id]?.business_name || 'Desconocido',
      net_sales: Math.round(info.net),
      units: Math.round(info.qty),
    }))

  const topProducts = Object.entries(productSalesMap)
    .sort((a, b) => b[1].net - a[1].net)
    .slice(0, 5)
    .map(([sku, info]) => ({
      sku,
      quantity: Math.round(info.qty),
      net_sales: Math.round(info.net),
    }))

  const suppliersWithSales = Object.keys(supplierSales).length

  const ncDocs = await fetchAll<any>(
    integQuery('bsale_documents')
      .select('net_amount, total_amount')
      .eq('company_id', COMPANY_ID)
      .eq('document_type_id', 2)
      .gte('emission_date', frm)
      .lte('emission_date', t)
      .order('bsale_id')
  )
  const ncNet = ncDocs.reduce((a: number, d: any) => a + toNum(d.net_amount), 0)
  const grossNC = ncDocs.reduce((a: number, d: any) => a + toNum(d.total_amount), 0)

  const { data: stockData } = await integQuery('bsale_stock_current')
    .select('variant_code, quantity')
    .eq('company_id', COMPANY_ID)
    .gt('quantity', 0)

  const { data: costData } = await integQuery('bsale_variant_costs')
    .select('variant_code, average_cost')
    .eq('company_id', COMPANY_ID)

  const costMap: Record<string, number> = {}
  costData?.forEach(c => { if (c.variant_code) costMap[c.variant_code] = toNum(c.average_cost) })

  const skuStockMap: Record<string, number> = {}
  let stockValue = 0
  let stockUnits = 0
  stockData?.forEach(s => {
    const qty = toNum(s.quantity)
    const vc = s.variant_code || ''
    skuStockMap[vc] = qty
    stockUnits += qty
    stockValue += qty * (costMap[vc] || 0)
  })

  const overviewTopClientsArr = Object.entries(clientSalesMap)
    .sort((a, b) => b[1].net - a[1].net)
    .slice(0, 5)
    .map(([cId, info]) => ({ client_id: Number(cId), net_sales: Math.round(info.net), units: Math.round(info.qty), invoice_count: info.invoices.size }))
  let topClientsOverview: Array<{ client_id: number; client_name: string; net_sales: number; units: number; invoice_count: number }> = []
  if (overviewTopClientsArr.length > 0) {
    const { data: overviewClients } = await integQuery('bsale_clients')
      .select('bsale_client_id, business_name, first_name, last_name')
      .eq('company_id', COMPANY_ID)
      .in('bsale_client_id', overviewTopClientsArr.map(c => c.client_id))
    const overviewClientNameMap: Record<number, string> = {}
    overviewClients?.forEach(c => { overviewClientNameMap[c.bsale_client_id] = c.business_name || `${c.first_name || ''} ${c.last_name || ''}`.trim() })
    topClientsOverview = overviewTopClientsArr.map(c => ({ ...c, client_name: overviewClientNameMap[c.client_id] || `Cliente #${c.client_id}` }))
  }

  const stockValProducts = Object.entries(skuStockMap)
    .map(([sku, qty]) => ({ sku, stock_qty: Math.round(qty), stock_value: Math.round(qty * (costMap[sku] || 0)) }))
    .filter(p => p.stock_value > 0)
    .sort((a, b) => b.stock_value - a.stock_value)
    .slice(0, 5)

  const ventasBsale = Math.round(grossSalesFE - grossNC)

  return {
    grossSalesFE: Math.round(grossSalesFE),
    netSales: Math.round(netSales),
    grossNC: Math.round(grossNC),
    ncNet: Math.round(ncNet),
    ventasBsale,
    netSalesAfterNC: Math.round(netSales - ncNet),
    totalUnits: Math.round(totalUnits),
    uniqueClients: uniqueClients.size,
    productsSold,
    suppliersWithSales,
    stockUnits: Math.round(stockUnits),
    stockValue: Math.round(stockValue),
    topSuppliers,
    topProducts,
    topClients: topClientsOverview,
    stockValProducts,
    metadata: {
      source: 'Facturas electrónicas tipo 5 (Bsale)',
      ncSource: 'Notas de Crédito tipo 2',
      documentType: 'FE (5)',
      includesNC: true,
      ncIncludedInNet: false,
      bsaleCriterion: 'Ventas Bsale = FE total_amount - NC total_amount (con IVA)',
      dateMin: globalMin,
      dateMax: globalMax,
      dateFrom: frm,
      dateTo: t,
      totalDocs5: docs5.length,
      totalDocsNC: ncDocs.length,
    },
  }
}

export async function getSupplierAnalysisOverview(params: {
  supplierId: string
  dateFrom?: string
  dateTo?: string
}) {
  await getAuthedUser()
  const { supplierId, dateFrom, dateTo } = params

  const { data: supplier } = await adqQuery('suppliers')
    .select('id, business_name, supplier_kind, parent_supplier_id')
    .eq('company_id', COMPANY_ID)
    .eq('id', supplierId)
    .single()

  if (!supplier) throw new Error('Proveedor no encontrado')

  const childIds: string[] = [supplierId]
  if (supplier.supplier_kind === 'REAL') {
    const { data: children } = await adqQuery('suppliers')
      .select('id')
      .eq('company_id', COMPANY_ID)
      .eq('parent_supplier_id', supplierId)
    if (children) childIds.push(...children.map(c => c.id))
  }

  const { data: mappings } = await adqQuery('product_supplier_mappings')
    .select('sku, unit_cost, supplier_id')
    .eq('company_id', COMPANY_ID)
    .in('supplier_id', childIds)

  const skus: string[] = []
  const skuCostMap: Record<string, number> = {}
  mappings?.forEach(m => {
    if (m.sku) {
      skus.push(m.sku)
      skuCostMap[m.sku] = toNum(m.unit_cost)
    }
  })

  const { data: pseudoSuppliers } = await adqQuery('suppliers')
    .select('id, business_name, bsale_product_type_name')
    .eq('company_id', COMPANY_ID)
    .in('id', childIds.filter(id => id !== supplierId))

  const skuToPseudo: Record<string, string> = {}
  if (mappings) {
    for (const m of mappings) {
      if (m.sku && childIds.includes(m.supplier_id) && m.supplier_id !== supplierId) {
        const ps = pseudoSuppliers?.find(p => p.id === m.supplier_id)
        skuToPseudo[m.sku] = ps?.business_name || ps?.bsale_product_type_name || ''
      }
    }
  }

  const { data: products } = await adqQuery('products')
    .select('sku, description')
    .eq('company_id', COMPANY_ID)
    .in('sku', skus.slice(0, 500))
  const productDescMap: Record<string, string> = {}
  products?.forEach(p => { if (p.sku) productDescMap[p.sku] = p.description || '' })

  const allDocs5forRange = await fetchAll<any>(
    integQuery('bsale_documents')
      .select('emission_date')
      .eq('company_id', COMPANY_ID)
      .eq('document_type_id', 5)
      .order('bsale_id')
  )
  let globalMin = ''
  let globalMax = ''
  allDocs5forRange.forEach((d: any) => {
    if (d.emission_date) {
      if (!globalMin || d.emission_date < globalMin) globalMin = d.emission_date
      if (!globalMax || d.emission_date > globalMax) globalMax = d.emission_date
    }
  })
  const frm = dateFrom || globalMin
  const t = dateTo || globalMax

  const docs5 = await fetchAll<any>(
    integQuery('bsale_documents')
      .select('bsale_id, net_amount, emission_date, client_id')
      .eq('company_id', COMPANY_ID)
      .eq('document_type_id', 5)
      .gte('emission_date', frm)
      .lte('emission_date', t)
      .order('bsale_id')
  )

  const facturaIds: number[] = docs5.map(d => d.bsale_id)
  const docClientMap: Record<number, number> = {}
  docs5.forEach(d => { if (d.client_id) docClientMap[d.bsale_id] = d.client_id })

  let netSales = 0
  let totalUnits = 0
  const skuSalesMap: Record<string, { qty: number; net: number; lastDate: string }> = {}
  const clientSalesMap: Record<string, { net: number; qty: number; invoices: Set<number>; lastDate: string }> = {}

  if (facturaIds.length > 0 && skus.length > 0) {
    const CHUNK = 200
    for (let idx = 0; idx < facturaIds.length; idx += CHUNK) {
      const chunk = facturaIds.slice(idx, idx + CHUNK)
      const { data: details } = await integQuery('bsale_document_details')
        .select('variant_code, quantity, net_amount, bsale_document_id')
        .eq('company_id', COMPANY_ID)
        .in('bsale_document_id', chunk)
      if (details) {
        for (const d of details) {
          if (!d.variant_code || !skus.includes(d.variant_code)) continue
          const qty = toNum(d.quantity)
          const net = toNum(d.net_amount)
          totalUnits += qty
          netSales += net
          const doc = docs5.find(doc => doc.bsale_id === d.bsale_document_id)
          const docDate = doc?.emission_date || ''
          if (!skuSalesMap[d.variant_code]) skuSalesMap[d.variant_code] = { qty: 0, net: 0, lastDate: '' }
          skuSalesMap[d.variant_code].qty += qty
          skuSalesMap[d.variant_code].net += net
          if (docDate > (skuSalesMap[d.variant_code].lastDate || '')) skuSalesMap[d.variant_code].lastDate = docDate

          const clientId = docClientMap[d.bsale_document_id]
          if (clientId) {
            const ck = String(clientId)
            if (!clientSalesMap[ck]) clientSalesMap[ck] = { net: 0, qty: 0, invoices: new Set(), lastDate: '' }
            clientSalesMap[ck].net += net
            clientSalesMap[ck].qty += qty
            clientSalesMap[ck].invoices.add(d.bsale_document_id)
            if (docDate > clientSalesMap[ck].lastDate) clientSalesMap[ck].lastDate = docDate
          }
        }
      }
    }
  }

  const { data: stockData } = await integQuery('bsale_stock_current')
    .select('variant_code, quantity')
    .eq('company_id', COMPANY_ID)
    .in('variant_code', skus.slice(0, 500))

  let stockUnits = 0
  let stockValue = 0
  const skuStockMap: Record<string, number> = {}
  stockData?.forEach(s => {
    const qty = toNum(s.quantity)
    skuStockMap[s.variant_code || ''] = qty
    stockUnits += qty
    stockValue += qty * (skuCostMap[s.variant_code || ''] || 0)
  })

  const productsSold = Object.keys(skuSalesMap).length
  const uniqueClients = Object.keys(clientSalesMap).length

  const clientIds = Object.keys(clientSalesMap).map(k => Number(k))
  const { data: bsaleClients } = await integQuery('bsale_clients')
    .select('bsale_client_id, business_name, first_name, last_name')
    .eq('company_id', COMPANY_ID)
    .in('bsale_client_id', clientIds.slice(0, 500))

  const clientNameMap: Record<string, string> = {}
  bsaleClients?.forEach(c => {
    clientNameMap[String(c.bsale_client_id)] = c.business_name || `${c.first_name || ''} ${c.last_name || ''}`.trim()
  })

  const topProducts = Object.entries(skuSalesMap)
    .sort((a, b) => b[1].net - a[1].net)
    .slice(0, 50)
    .map(([sku, info]) => ({
      sku,
      product_name: productDescMap[sku] || '',
      pseudo_supplier: skuToPseudo[sku] || '',
      units: Math.round(info.qty),
      net_sales: Math.round(info.net),
      stock: Math.round(skuStockMap[sku] || 0),
      unit_cost: skuCostMap[sku] || 0,
      margin_percent: skuCostMap[sku] ? Math.round(((info.net / (info.qty || 1)) - skuCostMap[sku]) / (info.net / (info.qty || 1)) * 100) : null,
      last_sale_date: info.lastDate,
    }))

  const topClients = Object.entries(clientSalesMap)
    .sort((a, b) => b[1].net - a[1].net)
    .slice(0, 20)
    .map(([clientId, info]) => ({
      client_id: Number(clientId),
      client_name: clientNameMap[clientId] || `Cliente #${clientId}`,
      net_sales: Math.round(info.net),
      units: Math.round(info.qty),
      invoice_count: info.invoices.size,
      last_purchase: info.lastDate,
    }))

  return {
    supplier: {
      id: supplier.id,
      business_name: supplier.business_name,
      supplier_kind: supplier.supplier_kind,
    },
    netSales: Math.round(netSales),
    totalUnits: Math.round(totalUnits),
    uniqueClients,
    productsSold,
    stockUnits: Math.round(stockUnits),
    stockValue: Math.round(stockValue),
    topProducts,
    topClients,
  }
}

export async function getProductAnalysisOverview(params: {
  sku: string
  dateFrom?: string
  dateTo?: string
}) {
  await getAuthedUser()
  const { sku, dateFrom, dateTo } = params

  const allDocs5forRange = await fetchAll<any>(
    integQuery('bsale_documents')
      .select('emission_date')
      .eq('company_id', COMPANY_ID)
      .eq('document_type_id', 5)
      .order('bsale_id')
  )
  let globalMin = ''
  let globalMax = ''
  allDocs5forRange.forEach((d: any) => {
    if (d.emission_date) {
      if (!globalMin || d.emission_date < globalMin) globalMin = d.emission_date
      if (!globalMax || d.emission_date > globalMax) globalMax = d.emission_date
    }
  })
  const frm = dateFrom || globalMin
  const t = dateTo || globalMax

  const docs5 = await fetchAll<any>(
    integQuery('bsale_documents')
      .select('bsale_id, net_amount, emission_date')
      .eq('company_id', COMPANY_ID)
      .eq('document_type_id', 5)
      .gte('emission_date', frm)
      .lte('emission_date', t)
      .order('bsale_id')
  )
  const { data: product } = await adqQuery('products')
    .select('sku, description, brand, category, is_active')
    .eq('company_id', COMPANY_ID)
    .eq('sku', sku)
    .maybeSingle()

  const { data: mappings } = await adqQuery('product_supplier_mappings')
    .select('supplier_id, unit_cost, is_preferred')
    .eq('company_id', COMPANY_ID)
    .eq('sku', sku)

  const preferredMapping = mappings?.find(m => m.is_preferred) || mappings?.[0]
  const supplierId = preferredMapping?.supplier_id
  const unitCost = toNum(preferredMapping?.unit_cost)

  let realSupplier: Record<string, unknown> | null = null
  let pseudoSupplier: Record<string, unknown> | null = null
  if (supplierId) {
    const { data: sup } = await adqQuery('suppliers')
      .select('id, business_name, supplier_kind, parent_supplier_id, bsale_product_type_name')
      .eq('company_id', COMPANY_ID)
      .eq('id', supplierId)
      .single()

    if (sup) {
      if (sup.supplier_kind === 'BSALE_OPERATIVE' && sup.parent_supplier_id) {
        const { data: real } = await adqQuery('suppliers')
          .select('id, business_name')
          .eq('company_id', COMPANY_ID)
          .eq('id', sup.parent_supplier_id)
          .single()
        realSupplier = real
        pseudoSupplier = sup
      } else if (sup.supplier_kind === 'REAL') {
        realSupplier = sup
      }
    }
  }

  const facturaIds: number[] = docs5.map(d => d.bsale_id)
  const docs5Map = docs5 as Array<{ bsale_id: number; net_amount: unknown; emission_date: string }>

  let netSales = 0
  let totalUnits = 0
  const clientSales: Record<string, { net: number; qty: number }> = {}
  const recentSales: Array<{ date: string; qty: number; net: number }> = []

  if (facturaIds.length > 0) {
    const CHUNK = 200
    for (let idx = 0; idx < facturaIds.length; idx += CHUNK) {
      const chunk = facturaIds.slice(idx, idx + CHUNK)
      const { data: details } = await integQuery('bsale_document_details')
        .select('variant_code, quantity, net_amount, bsale_document_id')
        .eq('company_id', COMPANY_ID)
        .eq('variant_code', sku)
        .in('bsale_document_id', chunk)
      if (details) {
        for (const d of details) {
          const qty = toNum(d.quantity)
          const net = toNum(d.net_amount)
          totalUnits += qty
          netSales += net

          const doc = docs5Map.find(doc => doc.bsale_id === d.bsale_document_id)
          if (doc?.emission_date) {
            recentSales.push({ date: doc.emission_date, qty, net })
          }

          const { data: docInfo } = await integQuery('bsale_documents')
            .select('client_id')
            .eq('company_id', COMPANY_ID)
            .eq('bsale_id', d.bsale_document_id)
            .maybeSingle()
          if (docInfo?.client_id) {
            const ck = String(docInfo.client_id)
            if (!clientSales[ck]) clientSales[ck] = { net: 0, qty: 0 }
            clientSales[ck].net += net
            clientSales[ck].qty += qty
          }
        }
      }
    }
  }

  const { data: stock } = await integQuery('bsale_stock_current')
    .select('quantity, quantity_available')
    .eq('company_id', COMPANY_ID)
    .eq('variant_code', sku)
    .maybeSingle()

  const stockQty = toNum(stock?.quantity)
  const stockAvail = toNum(stock?.quantity_available)

  const avgPrice = totalUnits > 0 ? netSales / totalUnits : 0
  const marginPerUnit = avgPrice - unitCost
  const marginPercent = avgPrice > 0 ? Math.round((marginPerUnit / avgPrice) * 100) : null

  const uniqueClients = Object.keys(clientSales).length

  const clientIds = Object.keys(clientSales).map(k => Number(k))
  const { data: bsaleClients } = await integQuery('bsale_clients')
    .select('bsale_client_id, business_name, first_name, last_name')
    .eq('company_id', COMPANY_ID)
    .in('bsale_client_id', clientIds)

  const clientNameMap: Record<string, string> = {}
  bsaleClients?.forEach(c => {
    clientNameMap[String(c.bsale_client_id)] = c.business_name || `${c.first_name || ''} ${c.last_name || ''}`.trim()
  })

  const topClients = Object.entries(clientSales)
    .sort((a, b) => b[1].net - a[1].net)
    .slice(0, 10)
    .map(([clientId, info]) => ({
      client_id: Number(clientId),
      client_name: clientNameMap[clientId] || `Cliente #${clientId}`,
      net_sales: Math.round(info.net),
      units: Math.round(info.qty),
    }))

  recentSales.sort((a, b) => b.date.localeCompare(a.date))

  return {
    product: product || { sku, description: sku, is_active: false },
    realSupplier: realSupplier || null,
    pseudoSupplier: pseudoSupplier || null,
    unitCost: Math.round(unitCost),
    netSales: Math.round(netSales),
    totalUnits: Math.round(totalUnits),
    avgPrice: Math.round(avgPrice),
    marginPercent,
    stockQty: Math.round(stockQty),
    stockAvail: Math.round(stockAvail),
    uniqueClients,
    topClients,
    recentSales: recentSales.slice(0, 20),
  }
}

export async function getSuppliersForSelector() {
  await getAuthedUser()
  const admin = createAdminClient()
  const { data } = await admin.schema('adquisiciones')
    .from('suppliers')
    .select('id, business_name')
    .eq('company_id', COMPANY_ID)
    .eq('supplier_kind', 'REAL')
    .eq('is_active', true)
    .order('business_name')
  return data || []
}

export async function getProductsForSearch(query: string) {
  await getAuthedUser()
  const admin = createAdminClient()
  const { data: bySku } = await admin.schema('adquisiciones')
    .from('products')
    .select('sku, description')
    .eq('company_id', COMPANY_ID)
    .ilike('sku', `%${query}%`)
    .limit(20)
  const { data: byDesc } = await admin.schema('adquisiciones')
    .from('products')
    .select('sku, description')
    .eq('company_id', COMPANY_ID)
    .ilike('description', `%${query}%`)
    .limit(20)
  const combined = [...(bySku || []), ...(byDesc || [])]
  const seen = new Set<string>()
  return combined.filter(p => {
    if (seen.has(p.sku || '')) return false
    seen.add(p.sku || '')
    return true
  }).slice(0, 20)
}
