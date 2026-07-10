'use server'

import { createClient } from '@supabase/supabase-js'
import { SALE_DOCUMENT_TYPE_IDS } from '@/lib/bsale/config'
import type { NormalizedSale, NormalizedStock } from '@/modules/adquisiciones/analisis-ventas/utils/analytics'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

function adqDb() {
  return createClient(supabaseUrl, serviceKey, {
    db: { schema: 'adquisiciones' },
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function intDb() {
  return createClient(supabaseUrl, serviceKey, {
    db: { schema: 'integraciones' },
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

interface CatalogProductRow {
  id: string
  sku: string | null
  description: string | null
  barcode: string | null
  bsale_variant_id: number | string | null
  bsale_product_type_name: string | null
  product_type: string | null
}

interface ProductSupplierMappingRow {
  supplier_id: string | null
  product_id: string | null
  unit_cost: number | null
  is_preferred: boolean | null
  is_active: boolean | null
}

interface SupplierRow {
  id: string
  supplier_kind?: string | null
  business_name: string | null
  bsale_product_type_name?: string | null
  parent_supplier_id?: string | null
}

// ─── Pagination helper ────────────────────────────────────────────

async function fetchAll(
  schema: string,
  table: string,
  select: string,
  filters?: Record<string, any>,
  options?: { maxRows?: number; orderCol?: string }
): Promise<any[]> {
  const maxRows = options?.maxRows ?? 50000
  const orderCol = options?.orderCol
  const c = createClient(supabaseUrl, serviceKey, {
    db: { schema }, auth: { autoRefreshToken: false, persistSession: false },
  })
  const result: any[] = []
  const pageSize = 1000
  for (let off = 0; off < maxRows; off += pageSize) {
    let q = c.from(table).select(select).range(off, off + pageSize - 1)
    if (orderCol) q = q.order(orderCol)
    if (filters) {
      for (const [k, v] of Object.entries(filters)) {
        if (v !== undefined && v !== null) {
          if (Array.isArray(v)) q = q.in(k, v as any[])
          else q = q.eq(k, v)
        }
      }
    }
    const { data, error } = await q
    if (error) throw new Error(`[fetchAll] Error fetching ${schema}.${table}: ${error.message}`)
    if (!data || data.length === 0) break
    result.push(...data)
    if (data.length < pageSize) break
    
    if (off + pageSize >= maxRows) {
      throw new Error(`[fetchAll] Límite de seguridad de ${maxRows} filas excedido para tabla ${table}`)
    }
  }
  return result
}

// ─── Main function ────────────────────────────────────────────────

export async function getReplenishmentSalesFromBsaleMirror(
  companyId: string,
  dateFrom: Date,
  dateTo: Date,
) {
  const dateFromStr = dateFrom.toISOString().split('T')[0]
  const dateToStr = dateTo.toISOString().split('T')[0]

  // Paginación: pageSize=1000 coincide con el límite interno de PostgREST (max_rows).
  // El loop corta solo al recibir una página vacía, nunca por data.length < pageSize.
  const maxRows = 200000
  const c = intDb()
  const result: any[] = []
  const pageSize = 1000

  for (let off = 0; off < maxRows; off += pageSize) {
    const { data, error } = await c.from('vw_bsale_sales_logistic_valid')
      .select('emission_date, variant_code, logistic_net_quantity')
      .eq('company_id', companyId)
      .gte('emission_date', dateFromStr)
      .lte('emission_date', dateToStr)
      .order('emission_date', { ascending: true })
      .order('variant_code', { ascending: true })
      .order('document_number', { ascending: true })
      .range(off, off + pageSize - 1)

    if (error) throw new Error(`Error fetching mirror sales: ${error.message}`)

    const rowsReceived = data?.length ?? 0
    if (rowsReceived === 0) break
    result.push(...data)
  }

  // Agrupar por día y SKU en JS (una fila por combinación variant_code+emission_date)
  const grouped = new Map<string, number>()
  for (const row of result) {
    if (!row.variant_code || !row.emission_date) continue
    const qty = Number(row.logistic_net_quantity) || 0
    if (qty === 0) continue
    const key = `${row.variant_code}|${row.emission_date}`
    grouped.set(key, (grouped.get(key) || 0) + qty)
  }

  const finalSales = []
  for (const [key, qty] of grouped.entries()) {
    const [variant_code, emission_date] = key.split('|')
    finalSales.push({ variant_code, emission_date, quantity: qty })
  }

  return finalSales
}


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
    const products = await fetchAll('integraciones', 'bsale_products',
      'bsale_id, name, product_type_id')
    diag.products = products.length
    const productNameMap = new Map(products.map(p => [p.bsale_id, p.name || '']))

    // ── 2. Obtener variantes ──
    const variants = await fetchAll('integraciones', 'bsale_variants',
    'bsale_id, code, description, bsale_product_id')
    diag.variants = variants.length
    const variantProductMap = new Map(variants.map(v => [v.bsale_id, v.bsale_product_id]))
    const variantDescMap = new Map(variants.map(v => [v.bsale_id, v.description]))

    // ── 3. & 4. Ventas: Bsale Mirror Logístico ──
    const mirrorSales = await getReplenishmentSalesFromBsaleMirror(companyId, dateFrom, dateTo)
    diag.mirror_sales_rows = mirrorSales.length

    // Mocks for diagnostic block to prevent TS errors since we removed the old fetching logic
    const docs: any[] = []
    const allDetails: any[] = []
    const saleDetails: any[] = []

    // ── 4.5. Resolver oficina CASA MATRIZ ──
    let targetOfficeId: number | null = null
    try {
      const intDb = createClient(supabaseUrl, serviceKey, {
        db: { schema: 'integraciones' },
        auth: { autoRefreshToken: false, persistSession: false },
      })
      const { data: officeRows } = await intDb.from('bsale_stock_current')
        .select('office_id, raw_json')
        .not('office_id', 'is', null)
        .limit(5000)
      const seen = new Set<number>()
      for (const row of officeRows || []) {
        const oid = row.office_id
        if (seen.has(oid)) continue
        seen.add(oid)
        const name = row.raw_json?.office?.name || ''
        diag[`office_${oid}_name`] = name
        if (name.toUpperCase().includes('CASA MATRIZ') || name.toUpperCase().includes('MATRIZ')) {
          targetOfficeId = oid
        }
      }
      diag.office_ids_found = [...seen]
      diag.target_office_id = targetOfficeId
    } catch (e) {
      console.error('[bsale-dataset] office resolution error:', e instanceof Error ? e.message : e)
    }

    // ── 5. Obtener stocks ──
    const stocksRaw = await fetchAll('integraciones', 'bsale_stock_current',
    'variant_id, variant_code, quantity_available, office_id, synced_at',
    { company_id: companyId })
    diag.stocks_raw = stocksRaw.length
    // Deducir: agrupar por (variant_id, office_id), conservar la fila más reciente por synced_at
    const stockDedupMap = new Map<string, any>()
    for (const s of stocksRaw) {
      const key = `${s.variant_id}|${s.office_id ?? 'null'}`
      const existing = stockDedupMap.get(key)
      if (!existing || (s.synced_at && existing.synced_at && s.synced_at > existing.synced_at)) {
        stockDedupMap.set(key, s)
      } else if (!existing.synced_at && s.synced_at) {
        stockDedupMap.set(key, s)
      }
    }
    const stocksDeduped = [...stockDedupMap.values()]
    diag.stocks_deduped = stocksDeduped.length
    diag.stocks_duplicates = stocksRaw.length - stocksDeduped.length
    // Filtrar por oficina objetivo
    const stocks = targetOfficeId
      ? stocksDeduped.filter((s: any) => s.office_id === targetOfficeId)
      : stocksDeduped
    diag.stocks_filtered = stocks.length
    // ── 6. Obtener costos ──
    const costs = await fetchAll('integraciones', 'bsale_variant_costs',
    'variant_id, variant_code, average_cost',
    { company_id: companyId })
    diag.costs = costs.length
    const costMap = new Map(costs.map(c => [c.variant_id, c.average_cost ?? 0]))

    // ── 7. Obtener catálogo maestro, mappings y proveedores en lote ──
    const aq = adqDb()
    const catalogRows: CatalogProductRow[] = []
    const catalogPageSize = 1000
    const catalogMax = 10000
    for (let off = 0; off < catalogMax; off += catalogPageSize) {
      const { data, error } = await aq.from('products')
        .select('id, sku, description, barcode, bsale_variant_id, bsale_product_type_name, product_type')
        .eq('company_id', companyId)
        .range(off, off + catalogPageSize - 1)
      if (error) { console.error('[bsale-dataset] catalog page error:', error.message); break }
      if (!data || data.length === 0) break
      catalogRows.push(...(data as CatalogProductRow[]))
      if (data.length < catalogPageSize) break
      if (off + catalogPageSize >= catalogMax) {
        console.warn('[bsale-dataset] catalog pagination reached safety cap at', catalogMax, '— may be incomplete')
      }
    }
    diag.catalog_products_loaded = catalogRows.length

    const catalogBySku = new Map(catalogRows
      .filter(p => p.sku)
      .map(p => [String(p.sku).trim().toUpperCase(), p]))
    const catalogByVariant = new Map(catalogRows
      .filter(p => p.bsale_variant_id)
      .map(p => [String(p.bsale_variant_id), p]))

    function resolveCatalogProduct(variantId: number | string | null | undefined, sku: string) {
      return catalogByVariant.get(String(variantId)) || catalogBySku.get(String(sku || '').trim().toUpperCase())
    }

    const productIdsSet = new Set(catalogRows.map(p => p.id).filter(Boolean))
    const mappings: ProductSupplierMappingRow[] = []
    const mappingPageSize = 1000
    let mappingPagesExecuted = 0
    let mappingPageErrors = 0
    const mappingErrorsSample: string[] = []
    const mappingMax = 10000
    for (let off = 0; off < mappingMax; off += mappingPageSize) {
      mappingPagesExecuted++
      try {
        const { data: m, error } = await aq.from('product_supplier_mappings')
          .select('supplier_id, product_id, unit_cost, is_preferred, is_active')
          .eq('company_id', companyId)
          .eq('is_active', true)
          .range(off, off + mappingPageSize - 1)
        if (error) {
          mappingPageErrors++
          const msg = `page ${mappingPagesExecuted}: ${error.message}`
          console.error('[bsale-dataset] mappings page error:', msg)
          if (mappingErrorsSample.length < 3) mappingErrorsSample.push(msg)
          break
        }
        if (!m || m.length === 0) break
        for (const row of m) {
          if (productIdsSet.has(row.product_id)) {
            mappings.push(row as ProductSupplierMappingRow)
          }
        }
        if (m.length < mappingPageSize) break
      } catch (e) {
        mappingPageErrors++
        const msg = `page ${mappingPagesExecuted}: ${e instanceof Error ? e.message : 'unknown'}`
        console.error('[bsale-dataset] mappings page exception:', msg)
        if (mappingErrorsSample.length < 3) mappingErrorsSample.push(msg)
      }
    }
    diag.mappings = mappings.length
    diag.mapping_pages_executed = mappingPagesExecuted
    diag.mapping_page_errors = mappingPageErrors
    diag.product_ids_for_mappings = productIdsSet.size

    const mappingByProductId = new Map<string, ProductSupplierMappingRow>()
    for (const mapping of mappings) {
      if (!mapping.product_id) continue
      const current = mappingByProductId.get(mapping.product_id)
      if (!current || (!current.is_preferred && mapping.is_preferred)) {
        mappingByProductId.set(mapping.product_id, mapping)
      }
    }

    const supplierIds = Array.from(new Set(mappings.map(m => m.supplier_id).filter(Boolean)))
    const { data: supplierRows } = supplierIds.length > 0
      ? await aq.from('suppliers')
        .select('id, supplier_kind, business_name, bsale_product_type_name, parent_supplier_id')
        .eq('company_id', companyId)
        .in('id', supplierIds)
      : { data: [] as SupplierRow[] }

    const supplierList = (supplierRows || []) as SupplierRow[]
    const supplierById = new Map(supplierList.map(s => [s.id, s]))
    const parentIds = Array.from(new Set(supplierList.map(s => s.parent_supplier_id).filter(Boolean)))
    const { data: parentRows } = parentIds.length > 0
      ? await aq.from('suppliers')
        .select('id, business_name')
        .eq('company_id', companyId)
        .in('id', parentIds)
      : { data: [] as SupplierRow[] }
    const parentById = new Map(((parentRows || []) as SupplierRow[]).map(s => [s.id, s]))

    function resolveSuppliers(catalogProduct?: CatalogProductRow) {
      if (!catalogProduct?.id) {
        return { real_supplier_name: 'Sin proveedor', pseudo_supplier_name: 'Sin pseudoproveedor' }
      }

      const mapping = mappingByProductId.get(catalogProduct.id)
      const supplier = mapping?.supplier_id ? supplierById.get(mapping.supplier_id) : null
      if (!supplier) {
        return { real_supplier_name: 'Sin proveedor', pseudo_supplier_name: 'Sin pseudoproveedor' }
      }

      if (supplier.supplier_kind === 'REAL') {
        return { real_supplier_name: supplier.business_name || 'Sin proveedor', pseudo_supplier_name: 'Directo' }
      }

      if (supplier.supplier_kind === 'BSALE_OPERATIVE') {
        const parent = supplier.parent_supplier_id ? parentById.get(supplier.parent_supplier_id) : null
        return {
          real_supplier_name: parent?.business_name || 'Sin proveedor real',
          pseudo_supplier_name: supplier.business_name || supplier.bsale_product_type_name || 'Sin pseudoproveedor',
        }
      }

      return { real_supplier_name: 'Sin proveedor', pseudo_supplier_name: 'Sin pseudoproveedor' }
    }

    // ── 8. Construir NormalizedStock[] ──
    const stockMapNormalized = new Map<string, NormalizedStock>()

    // Agrupar stocks: un SKU puede tener stock en múltiples oficinas, sumamos
    for (const s of stocks) {
      const code = s.variant_code || ''
      if (!code) continue
      const existing = stockMapNormalized.get(code)
      const prodBsaleId = variantProductMap.get(s.variant_id)
      const catalogProduct = resolveCatalogProduct(s.variant_id, code)
      const suppliers = resolveSuppliers(catalogProduct)
      const productName = catalogProduct?.description || productNameMap.get(prodBsaleId) || code
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
          tipo_producto: catalogProduct?.bsale_product_type_name || catalogProduct?.product_type || '',
          linea_tema: '',
          real_supplier_name: suppliers.real_supplier_name,
          pseudo_supplier_name: suppliers.pseudo_supplier_name,
        })
      }
    }

    // ── 9. Construir NormalizedSale[] ──
    const salesMap = new Map<string, NormalizedSale[]>()
    let skippedNoSku = 0

    for (const det of mirrorSales) {
      const code = det.variant_code || ''
      if (!code) { skippedNoSku++; continue }

      const catalogProduct = resolveCatalogProduct(null, code)
      const suppliers = resolveSuppliers(catalogProduct)
      // Variant id is not directly available, fall back to code for name
      const productName = catalogProduct?.description || code

      // FIX 2: Create date in local timezone to avoid offset issues with buckets
      // If emission_date is "2026-06-15", adding "T00:00:00" parses as local time.
      const fecha = det.emission_date ? new Date(det.emission_date + 'T00:00:00') : dateTo
      const cantidad = Number(det.quantity) || 0

      const sale: NormalizedSale = {
        SKU: code,
        producto: productName,
        variante: '',
        fecha,
        fechaStr: fecha.toISOString().split('T')[0],
        venta_bruta: 0,
        cantidad,
        margen: 0,
        tipo_producto: catalogProduct?.bsale_product_type_name || catalogProduct?.product_type || '',
        marca: '',
        linea_tema: '',
        real_supplier_name: suppliers.real_supplier_name,
        pseudo_supplier_name: suppliers.pseudo_supplier_name,
        numero_documento: '',
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

    // ── 10. Métricas reales de proveedores ──
    const stockItems = [...stockMapNormalized.values()]
    const totalRows = stockItems.length
    let rowsWithProductMatch = 0
    let rowsWithoutProductMatch = 0
    let rowsWithMapping = 0
    let rowsWithoutMapping = 0
    let rowsWithPseudoSupplier = 0
    let rowsWithRealSupplier = 0
    let rowsWithDirectRealSupplier = 0
    let rowsWithBsaleOperativeSupplier = 0
    let rowsWithBsaleOperativeWithoutParent = 0
    let rowsUsingFallback = 0
    const uniquePseudoSuppliersSet = new Set<string>()
    const uniqueRealSuppliersSet = new Set<string>()

    for (const item of stockItems) {
      const pseudo = item.pseudo_supplier_name || ''
      const real = item.real_supplier_name || ''
      const tipo = item.tipo_producto || ''

      // Recalcular si hubo match de catálogo (no está almacenado, inferimos)
      const foundInCatalog = !(real === 'Sin proveedor' && pseudo === 'Sin pseudoproveedor') ||
        (tipo !== '')
      if (foundInCatalog) rowsWithProductMatch++
      else rowsWithoutProductMatch++

      if (real !== 'Sin proveedor' || pseudo !== 'Sin pseudoproveedor') rowsWithMapping++

      if (pseudo && pseudo !== 'Sin pseudoproveedor') {
        rowsWithPseudoSupplier++
        uniquePseudoSuppliersSet.add(pseudo)
        if (pseudo === 'Directo') rowsWithDirectRealSupplier++
        else rowsWithBsaleOperativeSupplier++
      }

      if (real && real !== 'Sin proveedor' && real !== 'Sin proveedor real') {
        rowsWithRealSupplier++
        uniqueRealSuppliersSet.add(real)
      }

      if (real === 'Sin proveedor real') rowsWithBsaleOperativeWithoutParent++

      // Fallback: si pseudo se resolvió pero coincide con tipo_producto (bsale_product_type_name)
      if (tipo && pseudo === tipo && pseudo !== 'Directo' && pseudo !== 'Sin pseudoproveedor') {
        rowsUsingFallback++
      }

      if (real === 'Sin proveedor' && pseudo === 'Sin pseudoproveedor') rowsWithoutMapping++
    }

    diag.total_rows = totalRows
    diag.catalog_products_loaded = catalogRows.length
    diag.product_ids_resolved = productIdsSet.size
    diag.rows_with_product_match = rowsWithProductMatch
    diag.rows_without_product_match = rowsWithoutProductMatch
    diag.mapping_rows_loaded = mappings.length
    diag.rows_with_mapping = rowsWithMapping
    diag.rows_without_mapping = rowsWithoutMapping
    diag.rows_with_pseudo_supplier = rowsWithPseudoSupplier
    diag.rows_with_real_supplier = rowsWithRealSupplier
    diag.rows_with_direct_real = rowsWithDirectRealSupplier
    diag.rows_with_bsale_operative = rowsWithBsaleOperativeSupplier
    diag.rows_with_bsale_operative_no_parent = rowsWithBsaleOperativeWithoutParent
    diag.rows_using_fallback = rowsUsingFallback
    diag.unique_pseudo_suppliers = uniquePseudoSuppliersSet.size
    diag.unique_real_suppliers = uniqueRealSuppliersSet.size
    if (mappingErrorsSample.length > 0) diag.mapping_errors_sample = mappingErrorsSample

    // ── 11. Diagnóstico SKU 1020 ──
    const sku1020 = '1020'
    try {
      // ── Stock por oficina ──
      const iDb = createClient(supabaseUrl, serviceKey, {
        db: { schema: 'integraciones' },
        auth: { autoRefreshToken: false, persistSession: false },
      })
      const { data: stockRaw } = await iDb.from('bsale_stock_current')
        .select('variant_id, variant_code, quantity, quantity_reserved, quantity_available, office_id, raw_json, synced_at')
        .eq('variant_code', sku1020)

      // Deduplicar en diagnóstico igual que en lógica principal
      const dedupMap = new Map<string, any>()
      for (const r of stockRaw || []) {
        const key = `${r.variant_id}|${r.office_id ?? 'null'}`
        const existing = dedupMap.get(key)
        if (!existing || (r.synced_at && existing.synced_at && r.synced_at > existing.synced_at)) {
          dedupMap.set(key, r)
        } else if (!existing.synced_at && r.synced_at) {
          dedupMap.set(key, r)
        }
      }

      const stockRows = (stockRaw || []).map((r: any) => {
        const key = `${r.variant_id}|${r.office_id ?? 'null'}`
        const isSelected = dedupMap.get(key) === r
        return {
          office_id: r.office_id,
          office_name: r.raw_json?.office?.name || '—',
          quantity: r.quantity,
          quantity_reserved: r.quantity_reserved,
          quantity_available: r.quantity_available,
          synced_at: r.synced_at,
          selected: isSelected,
          reason: isSelected ? 'selected latest' : 'duplicate older',
        }
      })

      diag.sku1020_stock_raw = stockRows
      diag.sku1020_stock_deduped = [...dedupMap.values()].map((r: any) => ({
        office_id: r.office_id,
        quantity_available: r.quantity_available,
      }))
      diag.sku1020_stock_total_raw = (stockRaw || []).reduce((a: number, r: any) => a + (r.quantity_available || 0), 0)
      diag.sku1020_stock_total_deduped = [...dedupMap.values()].reduce((a: number, r: any) => a + (r.quantity_available || 0), 0)

      // ── Ventas: todos los detalles (no solo filtrados) ──
      const allDet1020 = allDetails.filter((d: any) => String(d.variant_code) === sku1020)
      const includedDet1020 = saleDetails.filter((d: any) => String(d.variant_code) === sku1020)

      // Buckets corregidos: [2026-06-11, 2026-07-09)
      const bucketStarts = [
        new Date('2026-06-11T00:00:00'),
        new Date('2026-06-18T00:00:00'),
        new Date('2026-06-25T00:00:00'),
        new Date('2026-07-02T00:00:00'),
      ]
      const bucketEnd = new Date('2026-07-09T00:00:00')
      const bucketLabels = ['11/6 al 17/6', '18/6 al 24/6', '25/6 al 1/7', '2/7 al 8/7']
      const expectedByBlock = [100, 58, 70, 113]

      // Para cada detalle, encontrar su fecha
      interface DetWithDoc { det: any; doc: any; fecha: Date; doc_type_id: number | null; included: boolean }
      const detsWithDoc: DetWithDoc[] = []
      for (const det of allDet1020) {
        const doc = docs.find((d: any) => d.bsale_id === det.bsale_document_id)
        const fecha = doc?.emission_date ? new Date(doc.emission_date) : null
        detsWithDoc.push({
          det,
          doc,
          fecha: fecha || new Date('2026-01-01'),
          doc_type_id: doc?.document_type_id ?? null,
          included: includedDet1020.some((d: any) => d === det),
        })
      }

      // Agrupar por bloque y document_type
      const blockData = bucketLabels.map((label, bi) => {
        const bStart = bucketStarts[bi]
        const bEnd = bi < 3 ? bucketStarts[bi + 1] : bucketEnd
        const items = detsWithDoc.filter(d => d.fecha >= bStart && d.fecha < bEnd)
        const totalUnits = items.reduce((a, d) => a + (Number(d.det.quantity) || 0), 0)
        const byDocType = new Map<number, number>()
        for (const item of items) {
          const dt = item.doc_type_id ?? 0
          byDocType.set(dt, (byDocType.get(dt) || 0) + (Number(item.det.quantity) || 0))
        }
        return { label, expected: expectedByBlock[bi], petgrup: totalUnits, unitsByDocType: Object.fromEntries(byDocType), count: items.length }
      })

      diag.sku1020_blocks = blockData
      diag.sku1020_total_petgrup = blockData.reduce((a, b) => a + b.petgrup, 0)
      diag.sku1020_total_included = includedDet1020.reduce((a: number, d: any) => a + (Number(d.quantity) || 0), 0)
      diag.sku1020_total_all = allDet1020.reduce((a: number, d: any) => a + (Number(d.quantity) || 0), 0)

      // Documentos muestra (máximo 20)
      diag.sku1020_docs = detsWithDoc.slice(0, 20).map(d => ({
        emission_date: d.doc?.emission_date ?? null,
        generation_date: d.doc?.generation_date ?? null,
        document_type_id: d.doc_type_id,
        number: d.doc?.number ?? null,
        quantity: Number(d.det.quantity) || 0,
        included: d.included,
        reason: d.included ? 'filtro doc types OK' : 'excluido por doc_type_id',
      }))

      // Resumen por doc_type (todos los detalles)
      const allDocTypes = new Map<number, number>()
      let excludedUnits = 0
      for (const d of detsWithDoc) {
        const dt = d.doc_type_id ?? 0
        allDocTypes.set(dt, (allDocTypes.get(dt) || 0) + (Number(d.det.quantity) || 0))
        if (!d.included) excludedUnits += Number(d.det.quantity) || 0
      }
      diag.sku1020_units_by_doc_type = Object.fromEntries(allDocTypes)
      diag.sku1020_doc_type_ids_found = [...allDocTypes.keys()]
      diag.sku1020_excluded_units = excludedUnits
      diag.sku1020_all_detail_count = allDet1020.length
      diag.sku1020_included_detail_count = includedDet1020.length

      // Comparación emission_date vs generation_date
      const byEmission = new Map<string, number>()
      const byGeneration = new Map<string, number>()
      for (const d of detsWithDoc) {
        const emDate = d.doc?.emission_date ? String(d.doc.emission_date).slice(0, 10) : 'sin_fecha'
        byEmission.set(emDate, (byEmission.get(emDate) || 0) + (Number(d.det.quantity) || 0))
        if (d.doc?.generation_date) {
          const genDate = String(d.doc.generation_date).slice(0, 10)
          byGeneration.set(genDate, (byGeneration.get(genDate) || 0) + (Number(d.det.quantity) || 0))
        }
      }
      diag.sku1020_by_emission_date = Object.fromEntries(byEmission)
      diag.sku1020_by_generation_date = Object.fromEntries(byGeneration)

      // ── Diagnóstico directo Supabase: todos los docs del período ──
      try {
        const diagDateStart = '2026-06-11'
        const diagDateEnd = '2026-07-08'
        const { data: docsInPeriod } = await iDb.from('bsale_documents')
          .select('bsale_id, number, emission_date, document_type_id, state, office_id')
          .gte('emission_date', diagDateStart)
          .lte('emission_date', diagDateEnd)
        const docIds = (docsInPeriod || []).map((d: any) => d.bsale_id)
        const { data: detsInPeriod } = docIds.length > 0
          ? await iDb.from('bsale_document_details')
              .select('bsale_document_id, variant_code, quantity')
              .in('bsale_document_id', docIds)
          : { data: [] }

        // Totales por office_id
        const officeTotals = new Map<number, { docs: number; dets: number; units: number; unitSku1020: number }>()
        const officeDocTypes = new Map<string, Set<number>>()
        for (const doc of docsInPeriod || []) {
          const oid = doc.office_id ?? 0
          if (!officeTotals.has(oid)) officeTotals.set(oid, { docs: 0, dets: 0, units: 0, unitSku1020: 0 })
          officeTotals.get(oid)!.docs++
          const key = `${oid}_${doc.document_type_id}`
          if (!officeDocTypes.has(key)) officeDocTypes.set(key, new Set())
          officeDocTypes.get(key)!.add(doc.bsale_id)
        }
        for (const det of detsInPeriod || []) {
          const doc = (docsInPeriod || []).find((d: any) => d.bsale_id === det.bsale_document_id)
          const oid = doc?.office_id ?? 0
          if (officeTotals.has(oid)) {
            officeTotals.get(oid)!.dets++
            officeTotals.get(oid)!.units += Number(det.quantity) || 0
            if (String(det.variant_code) === sku1020) {
              officeTotals.get(oid)!.unitSku1020 += Number(det.quantity) || 0
            }
          }
        }

        diag.sku1020_supabase_docs_in_period = docsInPeriod?.length ?? 0
        diag.sku1020_supabase_dets_in_period = detsInPeriod?.length ?? 0
        diag.sku1020_supabase_by_office = Object.fromEntries(officeTotals)

        // Totales por document_type con nombre y signo
        const docTypeNames: Record<number, string> = { 1: 'FACTURA ELECTRÓNICA', 2: 'NOTA DE CRÉDITO ELECTRÓNICA', 5: 'BOLETA ELECTRÓNICA T', 23: 'OTRO' }
        const positiveTypes: number[] = [1, 5]
        const negativeTypes: number[] = [2]
        const diagDocTypes = new Map<number, { docs: number; units: number; unitsSku1020: number; unitsNetSku1020: number }>()
        for (const doc of docsInPeriod || []) {
          const dtid = doc.document_type_id ?? 0
          if (!diagDocTypes.has(dtid)) diagDocTypes.set(dtid, { docs: 0, units: 0, unitsSku1020: 0, unitsNetSku1020: 0 })
          diagDocTypes.get(dtid)!.docs++
        }
        for (const det of detsInPeriod || []) {
          const doc = (docsInPeriod || []).find((d: any) => d.bsale_id === det.bsale_document_id)
          const dtid = doc?.document_type_id ?? 0
          const entry = diagDocTypes.get(dtid)
          if (entry) {
            const qty = Number(det.quantity) || 0
            entry.units += qty
            if (String(det.variant_code) === sku1020) {
              entry.unitsSku1020 += qty
              // Neto: positivos suman, negativos restan
              if (positiveTypes.includes(dtid)) entry.unitsNetSku1020 += qty
              else if (negativeTypes.includes(dtid)) entry.unitsNetSku1020 -= qty
              else entry.unitsNetSku1020 += qty // otros: sumar para diagnóstico
            }
          }
        }
        const diagDocTypesArr = [...diagDocTypes.entries()].map(([dtid, data]) => ({
          type_id: dtid,
          name: docTypeNames[dtid] || `TIPO ${dtid}`,
          docs: data.docs,
          units: data.units,
          unitsSku1020: data.unitsSku1020,
          unitsNetSku1020: data.unitsNetSku1020,
          sign: positiveTypes.includes(dtid) ? '+' : negativeTypes.includes(dtid) ? '-' : '?',
        }))
        diag.sku1020_supabase_by_doc_type = diagDocTypesArr
        diag.sku1020_supabase_net_total = diagDocTypesArr.reduce((a: number, d: any) => a + d.unitsNetSku1020, 0)
        diag.sku1020_supabase_gross_total = diagDocTypesArr.filter((d: any) => d.sign === '+').reduce((a: number, d: any) => a + d.unitsSku1020, 0)

        // Totales por bloque con desglose neto
        const diagBlocks = ['11/6 al 17/6', '18/6 al 24/6', '25/6 al 1/7', '2/7 al 8/7']
        const diagBlockStarts = [
          new Date('2026-06-11T00:00:00'),
          new Date('2026-06-18T00:00:00'),
          new Date('2026-06-25T00:00:00'),
          new Date('2026-07-02T00:00:00'),
        ]
        const diagBlockEnd = new Date('2026-07-09T00:00:00')
        const expectedByBlock = [100, 58, 70, 113]
        const diagBlockData = diagBlocks.map((label, bi) => {
          const bStart = diagBlockStarts[bi]
          const bEnd = bi < 3 ? diagBlockStarts[bi + 1] : diagBlockEnd
          let gross = 0
          let net = 0
          const folios: number[] = []
          for (const det of detsInPeriod || []) {
            if (String(det.variant_code) !== sku1020) continue
            const doc = (docsInPeriod || []).find((d: any) => d.bsale_id === det.bsale_document_id)
            if (!doc?.emission_date) continue
            const fecha = new Date(doc.emission_date)
            if (fecha >= bStart && fecha < bEnd) {
              const qty = Number(det.quantity) || 0
              gross += qty
              const dtid = doc.document_type_id ?? 0
              if (positiveTypes.includes(dtid)) net += qty
              else if (negativeTypes.includes(dtid)) net -= qty
              else net += qty
              if (doc.number && !folios.includes(doc.number)) folios.push(doc.number)
            }
          }
          return { label, supabase_net: net, supabase_gross: gross, esperado: expectedByBlock[bi], diff: net - expectedByBlock[bi], folios: folios.join(',') }
        })
        diag.sku1020_supabase_blocks = diagBlockData
      } catch (e) {
        diag.sku1020_supabase_error = e instanceof Error ? e.message : 'unknown'
      }

      // ── Comparación contra Excel Bsale por folio ──
      const expectedFolios: Array<{folio: number; fecha: string; tipo: string; cantidad: number; bloque: string}> = [
        {folio:4138,fecha:'11/06/2026',tipo:'NC',cantidad:0,bloque:'11/6 al 17/6'},
        {folio:4139,fecha:'11/06/2026',tipo:'NC',cantidad:0,bloque:'11/6 al 17/6'},
        {folio:4140,fecha:'11/06/2026',tipo:'NC',cantidad:0,bloque:'11/6 al 17/6'},
        {folio:4141,fecha:'11/06/2026',tipo:'NC',cantidad:0,bloque:'11/6 al 17/6'},
        {folio:4142,fecha:'11/06/2026',tipo:'NC',cantidad:0,bloque:'11/6 al 17/6'},
        {folio:22779,fecha:'15/06/2026',tipo:'FE',cantidad:50,bloque:'11/6 al 17/6'},
        {folio:4147,fecha:'15/06/2026',tipo:'NC',cantidad:-50,bloque:'11/6 al 17/6'},
        {folio:22782,fecha:'15/06/2026',tipo:'FE',cantidad:50,bloque:'11/6 al 17/6'},
        {folio:22789,fecha:'15/06/2026',tipo:'FE',cantidad:50,bloque:'11/6 al 17/6'},
        {folio:4149,fecha:'15/06/2026',tipo:'NC',cantidad:0,bloque:'11/6 al 17/6'},
        {folio:4153,fecha:'16/06/2026',tipo:'NC',cantidad:0,bloque:'11/6 al 17/6'},
        {folio:4166,fecha:'17/06/2026',tipo:'NC',cantidad:0,bloque:'11/6 al 17/6'},
        {folio:22833,fecha:'18/06/2026',tipo:'FE',cantidad:10,bloque:'18/6 al 24/6'},
        {folio:22837,fecha:'18/06/2026',tipo:'FE',cantidad:30,bloque:'18/6 al 24/6'},
        {folio:22843,fecha:'18/06/2026',tipo:'FE',cantidad:10,bloque:'18/6 al 24/6'},
        {folio:22847,fecha:'18/06/2026',tipo:'FE',cantidad:5,bloque:'18/6 al 24/6'},
        {folio:22869,fecha:'19/06/2026',tipo:'FE',cantidad:3,bloque:'18/6 al 24/6'},
        {folio:22955,fecha:'26/06/2026',tipo:'FE',cantidad:5,bloque:'25/6 al 1/7'},
        {folio:22980,fecha:'26/06/2026',tipo:'FE',cantidad:50,bloque:'25/6 al 1/7'},
        {folio:22983,fecha:'26/06/2026',tipo:'FE',cantidad:5,bloque:'25/6 al 1/7'},
        {folio:22987,fecha:'26/06/2026',tipo:'FE',cantidad:10,bloque:'25/6 al 1/7'},
        {folio:23027,fecha:'02/07/2026',tipo:'FE',cantidad:50,bloque:'2/7 al 8/7'},
        {folio:23032,fecha:'03/07/2026',tipo:'FE',cantidad:5,bloque:'2/7 al 8/7'},
        {folio:23039,fecha:'03/07/2026',tipo:'FE',cantidad:10,bloque:'2/7 al 8/7'},
        {folio:23071,fecha:'04/07/2026',tipo:'FE',cantidad:8,bloque:'2/7 al 8/7'},
        {folio:23072,fecha:'04/07/2026',tipo:'FE',cantidad:30,bloque:'2/7 al 8/7'},
        {folio:23096,fecha:'08/07/2026',tipo:'FE',cantidad:10,bloque:'2/7 al 8/7'},
      ]

      // Buscar documentos en Supabase por folio
      const folioNumbers = expectedFolios.map(f => f.folio)
      const { data: foundDocs } = await iDb.from('bsale_documents')
        .select('bsale_id, number, emission_date, document_type_id, state, office_id')
        .in('number', folioNumbers)

      const docByNumber = new Map((foundDocs || []).map((d: any) => [d.number, d]))

      // Buscar details para esos documentos con SKU 1020
      const foundDocIds = (foundDocs || []).map((d: any) => d.bsale_id)
      const { data: foundDetails } = foundDocIds.length > 0
        ? await iDb.from('bsale_document_details')
            .select('bsale_document_id, variant_code, quantity')
            .in('bsale_document_id', foundDocIds)
        : { data: [] }

      const detailsByDocId = new Map<number, any[]>()
      for (const det of foundDetails || []) {
        const arr = detailsByDocId.get(det.bsale_document_id) || []
        arr.push(det)
        detailsByDocId.set(det.bsale_document_id, arr)
      }

      // Armar comparación por folio
      const folioComparison = expectedFolios.map(ef => {
        const doc = docByNumber.get(ef.folio)
        const docExists = !!doc
        const dets = doc ? detailsByDocId.get(doc.bsale_id) || [] : []
        const detSku1020 = dets.filter((d: any) => String(d.variant_code) === sku1020)
        const detailExists = detSku1020.length > 0
        const petgrupQty = detSku1020.reduce((a: number, d: any) => a + (Number(d.quantity) || 0), 0)

        let motivo = ''
        if (!docExists) motivo = 'falta document header en Supabase'
        else if (!detailExists) motivo = 'falta detail SKU 1020 en Supabase'
        else if (doc.document_type_id !== (ef.tipo === 'FE' ? 1 : 2)) motivo = `document_type_id distinto: ${doc.document_type_id}`
        else if (petgrupQty !== ef.cantidad) motivo = `cantidad distinta: PetGrup ${petgrupQty} vs Excel ${ef.cantidad}`
        else motivo = 'OK, coincide'

        return {
          folio: ef.folio,
          fecha_esperada: ef.fecha,
          tipo: ef.tipo,
          cantidad_esperada: ef.cantidad,
          bloque: ef.bloque,
          existe_header: docExists,
          existe_detail_sku1020: detailExists,
          cantidad_petgrup: petgrupQty,
          fecha_petgrup: doc?.emission_date || null,
          doc_type_id: doc?.document_type_id ?? null,
          estado_supabase: doc?.state ?? null,
          incluido: (docExists && detailExists),
          motivo,
        }
      })

      diag.sku1020_folio_comparison = folioComparison

      // Resumen por bloque desde folios esperados
      const blockSummary = expectedFolios.reduce((acc: any, ef) => {
        const found = folioComparison.find((f: any) => f.folio === ef.folio)
        const petgrup = found?.cantidad_petgrup ?? 0
        if (!acc[ef.bloque]) acc[ef.bloque] = { esperado: 0, petgrup: 0, folios_faltantes: [] }
        acc[ef.bloque].esperado += ef.cantidad
        acc[ef.bloque].petgrup += petgrup
        if (!found?.incluido) acc[ef.bloque].folios_faltantes.push(ef.folio)
        return acc
      }, {})
      diag.sku1020_block_comparison = blockSummary
      diag.sku1020_total_esperado = expectedFolios.reduce((a, f) => a + f.cantidad, 0)
      diag.sku1020_total_petgrup_folios = folioComparison.reduce((a: number, f: any) => a + f.cantidad_petgrup, 0)
      diag.sku1020_folios_encontrados = folioComparison.filter((f: any) => f.incluido).length
      diag.sku1020_folios_faltantes = folioComparison.filter((f: any) => !f.incluido).length

      // Totales facturas positivas vs notas crédito
      diag.sku1020_total_facturas = expectedFolios.filter(f => f.tipo === 'FE').reduce((a, f) => a + f.cantidad, 0)
      diag.sku1020_total_nc = expectedFolios.filter(f => f.tipo === 'NC').reduce((a, f) => a + f.cantidad, 0)

    } catch (e) {
      diag.sku1020_error = e instanceof Error ? e.message : 'unknown'
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
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Error desconocido' }
  }
}

// ─── Helper: ISO week (duplicado de analytics.ts para no crear dependencia) ──
function getISOWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
}
