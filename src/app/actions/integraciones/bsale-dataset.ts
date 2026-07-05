'use server'

import { createClient } from '@supabase/supabase-js'
import { normalizeSku } from '@/lib/bsale/client'
import { SALE_DOCUMENT_TYPE_IDS } from '@/lib/bsale/config'
import type { NormalizedSale, NormalizedStock } from '@/modules/adquisiciones/analisis-ventas/utils/analytics'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

function db() {
  return createClient(supabaseUrl, serviceKey, {
    db: { schema: 'integraciones' },
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function adqDb() {
  return createClient(supabaseUrl, serviceKey, {
    db: { schema: 'adquisiciones' },
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

// ─── Interfaces del dataset ───────────────────────────────────────

export interface ReplenishmentDataset {
  sales: NormalizedSale[]
  stock: NormalizedStock[]
  productsCount: number
  variantsCount: number
  docsCount: number
  detailsCount: number
  dateFrom: string
  dateTo: string
  diagnostics: Record<string, any>
}

export interface ReplenishmentOptions {
  periodDays?: number
  documentTypeIds?: number[]
}

// ─── Pagination helper ────────────────────────────────────────────

async function fetchAll(
  schema: string,
  table: string,
  select: string,
  filters?: Record<string, any>,
  maxRows = 10000
): Promise<any[]> {
  const c = createClient(supabaseUrl, serviceKey, {
    db: { schema }, auth: { autoRefreshToken: false, persistSession: false },
  })
  const result: any[] = []
  const pageSize = 500
  for (let off = 0; off < maxRows; off += pageSize) {
    let q = c.from(table).select(select).range(off, off + pageSize - 1)
    if (filters) {
      for (const [k, v] of Object.entries(filters)) {
        if (v !== undefined && v !== null) {
          if (Array.isArray(v)) q = q.in(k, v as any[])
          else q = q.eq(k, v)
        }
      }
    }
    const { data, error } = await q
    if (error) break
    if (!data || data.length === 0) break
    result.push(...data)
    if (data.length < pageSize) break
  }
  return result
}

// ─── Main function ────────────────────────────────────────────────

export async function getReplenishmentDatasetFromBsale(
  companyId: string,
  options: ReplenishmentOptions = {}
): Promise<{ success: boolean; data?: ReplenishmentDataset; error?: string }> {
  if (!companyId) return { success: false, error: 'companyId requerido' }

  const periodDays = options.periodDays ?? 180
  const docTypeIds = options.documentTypeIds ?? SALE_DOCUMENT_TYPE_IDS
  const dateFrom = new Date(Date.now() - periodDays * 86400000)
  const dateTo = new Date()
  const diag: Record<string, any> = {}

  try {
    // ── 1. Obtener productos ──
    const iDb = db()
const products = await fetchAll('integraciones', 'bsale_products',
    'bsale_id, name, product_type_id')
    diag.products = products.length
    const productNameMap = new Map(products.map(p => [p.bsale_id, p.name || '']))
    const productTypeMap = new Map(products.map(p => [p.bsale_id, p.product_type_id]))

    // ── 2. Obtener variantes ──
    const variants = await fetchAll('integraciones', 'bsale_variants',
    'bsale_id, code, description, bsale_product_id')
    diag.variants = variants.length
    const variantProductMap = new Map(variants.map(v => [v.bsale_id, v.bsale_product_id]))
    const variantDescMap = new Map(variants.map(v => [v.bsale_id, v.description]))

    // ── 3. Obtener documentos de venta (filtrados por tipo) ──
    const docs = await fetchAll('integraciones', 'bsale_documents',
    'bsale_id, emission_date, document_type_id',
    { document_type_id: docTypeIds })
    diag.docs_total = docs.length
    const docIdSet = new Set(docs.map(d => d.bsale_id))

    if (docs.length === 0) {
      return { success: false, error: 'No hay documentos de venta en el período. Ejecuta syncBsaleSales primero.' }
    }

    // ── 4. Obtener detalles ──
    const allDetails = await fetchAll('integraciones', 'bsale_document_details',
    'bsale_document_id, variant_id, variant_code, variant_description, quantity, net_unit_value, total_amount')
    diag.details_total = allDetails.length

    const saleDetails = allDetails.filter(d => docIdSet.has(d.bsale_document_id))
    diag.sale_details = saleDetails.length

    // ── 5. Obtener stocks ──
    const stocks = await fetchAll('integraciones', 'bsale_stock_current',
    'variant_id, variant_code, quantity_available')
    diag.stocks = stocks.length
    const stockMap = new Map(stocks.map(s => [s.variant_id, s.quantity_available ?? 0]))

    // ── 6. Obtener costos ──
    const costs = await fetchAll('integraciones', 'bsale_variant_costs',
    'variant_id, variant_code, average_cost')
    diag.costs = costs.length
    const costMap = new Map(costs.map(c => [c.variant_id, c.average_cost ?? 0]))

    // ── 7. Obtener product_supplier_mappings ──
    const aq = adqDb()
    let mappings: any[] = []
    try {
      const { data: m } = await aq.from('product_supplier_mappings')
        .select('sku, supplier_id, product_id, unit_cost, is_preferred')
        .eq('is_active', true)
      mappings = m || []
    } catch { /* tabla puede estar vacía */ }
    diag.mappings = mappings.length

    // ── 8. Construir NormalizedStock[] ──
    const stockMapNormalized = new Map<string, NormalizedStock>()

    // Agrupar stocks: un SKU puede tener stock en múltiples oficinas, sumamos
    for (const s of stocks) {
      const code = s.variant_code || ''
      if (!code) continue
      const existing = stockMapNormalized.get(code)
      const prodBsaleId = variantProductMap.get(s.variant_id)
      const productName = productNameMap.get(prodBsaleId) || code
      const cost = costMap.get(s.variant_id) || 0
      const desc = variantDescMap.get(s.variant_id) || ''

      if (existing) {
        existing.cantidad_disponible += s.quantity_available ?? 0
        existing.costo_total = existing.cantidad_disponible * existing.costo_unitario
      } else {
        stockMapNormalized.set(code, {
          SKU: code,
          producto: productName,
          variante: desc,
          cantidad_disponible: s.quantity_available ?? 0,
          costo_unitario: cost,
          costo_total: (s.quantity_available ?? 0) * cost,
          por_recibir: 0,
          precio_venta_bruto: 0,
          marca: '',
          tipo_producto: '',
          linea_tema: '',
        })
      }
    }

    // ── 9. Construir NormalizedSale[] ──
    const salesMap = new Map<string, NormalizedSale[]>()
    let skippedNoSku = 0

    for (const det of saleDetails) {
      const code = det.variant_code || ''
      if (!code) { skippedNoSku++; continue }

      const prodBsaleId = variantProductMap.get(det.variant_id)
      const productName = variantDescMap.get(det.variant_id)
        ? `${productNameMap.get(prodBsaleId) || ''} (${variantDescMap.get(det.variant_id)})`
        : (productNameMap.get(prodBsaleId) || code)

      // Buscar la fecha del documento
      const doc = docs.find(d => d.bsale_id === det.bsale_document_id)
      const fecha = doc?.emission_date ? new Date(doc.emission_date) : dateTo
      const cantidad = Number(det.quantity) || 0
      const netUnit = Number(det.net_unit_value) || 0
      const totalAmt = Number(det.total_amount) || 0

      const sale: NormalizedSale = {
        SKU: code,
        producto: productName,
        variante: variantDescMap.get(det.variant_id) || '',
        fecha,
        fechaStr: fecha.toISOString().split('T')[0],
        venta_bruta: totalAmt,
        cantidad,
        margen: 0, // No tenemos margen desde Bsale
        tipo_producto: '',
        marca: '',
        linea_tema: '',
        numero_documento: String(det.bsale_document_id),
        semana: getISOWeek(fecha),
        anio: fecha.getFullYear(),
        mes: `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}`,
        mes_num: fecha.getMonth() + 1,
      }

      if (!salesMap.has(code)) salesMap.set(code, [])
      salesMap.get(code)!.push(sale)
    }

    const sales = [...salesMap.values()].flat()
    diag.sales_rows = sales.length
    diag.skipped_no_sku = skippedNoSku

    // ── 10. Enriquecer NormalizedStock con supplier/product mapping ──
    for (const mapping of mappings) {
      const normSku = normalizeSku(mapping.sku)
      const st = stockMapNormalized.get(normSku)
      if (st) {
        // Podríamos agregar supplier info aquí cuando se necesite
        st.marca = mapping.product_id || ''
      }
    }

    return {
      success: true,
      data: {
        sales,
        stock: [...stockMapNormalized.values()],
        productsCount: products.length,
        variantsCount: variants.length,
        docsCount: docs.length,
        detailsCount: saleDetails.length,
        dateFrom: dateFrom.toISOString().split('T')[0],
        dateTo: dateTo.toISOString().split('T')[0],
        diagnostics: diag,
      },
    }
  } catch (err: any) {
    return { success: false, error: err.message || 'Error desconocido' }
  }
}

// ─── Helper: ISO week (duplicado de analytics.ts para no crear dependencia) ──
function getISOWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil((((date as any) - (yearStart as any)) / 86400000 + 1) / 7)
}
