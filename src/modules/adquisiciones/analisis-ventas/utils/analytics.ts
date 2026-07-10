// src/modules/adquisiciones/analisis-ventas/utils/analytics.ts
// Traducción FIEL del Python (analytics.py + data_loader.py) del repositorio original analisis_ventas_MYM
// Incluye columna "Variante" en stock y sales como extensión nueva.

// ─── Interfaces de filas crudas del Excel ──────────────────────────────────────

export interface RawSaleRow {
  [key: string]: any
}

export interface RawStockRow {
  [key: string]: any
}

// ─── Interfaces del modelo normalizado ────────────────────────────────────────

export interface NormalizedSale {
  SKU: string
  producto: string
  variante: string
  fecha: Date
  fechaStr: string
  venta_bruta: number
  cantidad: number
  margen: number
  tipo_producto: string
  marca: string
  linea_tema: string
  numero_documento: string
  semana: number
  anio: number
  mes: string
  mes_num: number
  real_supplier_name?: string
  pseudo_supplier_name?: string
}

export interface NormalizedStock {
  SKU: string
  producto: string
  variante: string
  cantidad_disponible: number
  costo_unitario: number
  costo_total: number
  por_recibir: number
  precio_venta_bruto: number
  marca: string
  tipo_producto: string
  linea_tema: string
  real_supplier_name?: string
  pseudo_supplier_name?: string
}

// ─── Interfaz principal por SKU ────────────────────────────────────────────────

export interface SkuSummary {
  SKU: string
  producto: string
  variante: string
  tipo_producto: string
  marca: string
  linea_tema: string
  real_supplier_name?: string
  pseudo_supplier_name?: string
  // Ventas del período
  venta_6m: number
  unidades_6m: number
  margen_6m: number
  documentos: number
  // Historial completo
  venta_historica_total: number
  unidades_historicas_total: number
  documentos_historicos: number
  fecha_primera_venta: Date | null
  fecha_ultima_venta: Date | null
  dias_desde_ultima_venta: number
  // Mitades del período (para caídas/crecimientos)
  venta_60d: number
  unidades_60d: number
  venta_prev_60d: number
  unidades_prev_60d: number
  diferencia_venta_periodo: number
  variacion_60d_pct: number | null
  // Primer/último mes
  venta_primer_mes: number
  venta_ultimo_mes: number
  // Stock
  cantidad_disponible: number
  costo_unitario: number
  valor_stock_disponible: number
  por_recibir: number
  // Promedios calculados
  venta_promedio_diaria: number
  unidades_promedio_diaria: number
  dias_cobertura: number | null
  venta_promedio_mientras_vendia: number
  // Clasificación
  tuvo_demanda_historica: boolean
  alerta: string
  prioridad: string
  // Compra sugerida
  suggested_quantity: number
}

// ─── Resultado del análisis para guardar ──────────────────────────────────────

export interface SalesAnalysisItem {
  sku: string
  product_name: string
  variant: string
  supplier: string
  category: string
  brand: string
  current_stock: number
  unit_cost: number
  total_units_sold: number
  weekly_average_sales: number
  suggested_quantity: number
  alert_type: string
  priority: string
  metrics: Record<string, any>
}

export interface SalesAnalysisReport {
  date_from: string
  date_to: string
  total_sales: number
  total_stock_value: number
  target_coverage_weeks: number
  items: SalesAnalysisItem[]
  diagnostics?: Record<string, any>
}

// ─── SKUs a excluir (ej: comerciales, sin producto real) ──────────────────────

const EXCLUDED_SKUS = new Set(['2202', '0001', 'P000038'])

// ─── Utilidades de normalización ──────────────────────────────────────────────

function normColName(name: string): string {
  return String(name)
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s\-\/]+/g, '_')
}

function normSku(val: any): string {
  if (val == null) return ''
  let s = String(val).trim()
  if (s.endsWith('.0')) s = s.slice(0, -2)
  if (['nan', 'none', 'null', ''].includes(s.toLowerCase())) return ''
  return s
}

function toNumber(val: any): number {
  if (val == null || val === '') return 0
  const n = Number(String(val).replace(/[^0-9.\-]/g, ''))
  return isNaN(n) ? 0 : n
}

/** Encuentra una columna en la fila de datos por su nombre normalizado */
function findCol(row: Record<string, any>, ...aliases: string[]): string | undefined {
  const normAliases = aliases.map(normColName)
  return Object.keys(row).find(k => normAliases.includes(normColName(k)))
}

/** Obtiene el valor de una columna por alias */
function getVal(row: Record<string, any>, ...aliases: string[]): any {
  const col = findCol(row, ...aliases)
  return col != null ? row[col] : undefined
}

// ─── Parseo de fecha ──────────────────────────────────────────────────────────

function parseDate(val: any): Date | null {
  if (!val) return null
  if (val instanceof Date && !isNaN(val.getTime())) return val
  // Número serial de Excel
  if (typeof val === 'number') {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30))
    const d = new Date(excelEpoch.getTime() + val * 86400000)
    if (!isNaN(d.getTime())) return d
  }
  const str = String(val).trim()
  // Intentar parseo directo ISO
  let d = new Date(str)
  if (!isNaN(d.getTime())) return d
  // Formato DD-MM-YYYY o DD/MM/YYYY
  const parts = str.split(/[-/\s]/)
  if (parts.length >= 3) {
    const [a, b, c] = parts.map(Number)
    if (a <= 31 && b <= 12) {
      // Asumimos DD-MM-YYYY
      d = new Date(c, b - 1, a)
      if (!isNaN(d.getTime())) return d
    }
  }
  return null
}

function getISOWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil((((date as any) - (yearStart as any)) / 86400000 + 1) / 7)
}

// ─── PASO 1: Normalizar Ventas ────────────────────────────────────────────────

export function parseAndNormalizeSales(rawData: RawSaleRow[]): {
  sales: NormalizedSale[]
  diagnostics: Record<string, any>
  minDate: Date
  maxDate: Date
} {
  const sales: NormalizedSale[] = []
  let skipped = 0

  for (const row of rawData) {
    const skuRaw = getVal(row, 'SKU', 'Codigo', 'Código', 'COD')
    const sku = normSku(skuRaw)
    if (!sku || EXCLUDED_SKUS.has(sku)) { skipped++; continue }

    const fechaRaw = getVal(row, 'Fecha y Hora Venta', 'Fecha de Emision', 'Fecha', 'Fecha Venta')
    const fecha = parseDate(fechaRaw)
    if (!fecha) { skipped++; continue }

    const venta = toNumber(getVal(row, 'Venta Total Bruta', 'Venta Bruta'))
    const cantidad = toNumber(getVal(row, 'Cantidad', 'Unidades'))
    const margen = toNumber(getVal(row, 'Margen', 'Margen Neto'))
    const producto = String(getVal(row, 'Producto / Servicio', 'Producto', 'Descripcion') || sku)
    const variante = String(getVal(row, 'Variante') || '')
    const tipo_producto = String(getVal(row, 'Tipo de Producto / Servicio', 'Tipo Producto', 'Tipo de Producto') || '')
    const marca = String(getVal(row, 'Marca') || '')
    const linea_tema = String(getVal(row, 'Linea / Tema de producto', 'Linea', 'Tema') || '')
    const numero_documento = String(getVal(row, 'Numero del documento', 'Numero Documento', 'Nro Documento') || '')

    const semana = getISOWeek(fecha)
    const anio = fecha.getFullYear()
    const mes_num = fecha.getMonth() + 1
    const mes = `${anio}-${String(mes_num).padStart(2, '0')}`

    sales.push({
      SKU: sku, producto, variante, fecha, fechaStr: fecha.toISOString().split('T')[0],
      venta_bruta: venta, cantidad, margen, tipo_producto, marca, linea_tema,
      numero_documento, semana, anio, mes, mes_num,
    })
  }

  const dates = sales.map(s => s.fecha.getTime())
  const minDate = new Date(Math.min(...dates))
  const maxDate = new Date(Math.max(...dates))

  return {
    sales,
    diagnostics: {
      sales_rows: sales.length,
      skipped,
    },
    minDate,
    maxDate,
  }
}

// ─── PASO 2: Normalizar Stock ─────────────────────────────────────────────────

export function parseAndNormalizeStock(rawData: RawStockRow[]): {
  stock: NormalizedStock[]
  diagnostics: Record<string, any>
} {
  const stock: NormalizedStock[] = []
  let stockColOrigin = 'Disponible'

  for (const row of rawData) {
    const skuRaw = getVal(row, 'SKU', 'Codigo', 'Código', 'COD')
    const sku = normSku(skuRaw)
    if (!sku || EXCLUDED_SKUS.has(sku)) continue

    // Prioridad: Disponible > Stock
    let cantidad_disponible = toNumber(getVal(row, 'Disponible', 'Cantidad Disponible'))
    if (cantidad_disponible === 0) {
      const stockVal = getVal(row, 'Stock', 'Stock Actual')
      if (stockVal != null) {
        cantidad_disponible = toNumber(stockVal)
        stockColOrigin = 'Stock'
      }
    }

    const producto = String(getVal(row, 'Producto', 'Descripcion', 'Nombre') || sku)
    const variante = String(getVal(row, 'Variante') || '')
    const costo_unitario = toNumber(getVal(row, 'Costo Neto Prom. Unitario', 'Costo Unitario', 'Costo Promedio'))
    const costo_total = toNumber(getVal(row, 'Costo Neto Prom. Total', 'Costo Total'))
    const por_recibir = toNumber(getVal(row, 'Por recibir', 'En camino'))
    const precio_venta_bruto = toNumber(getVal(row, 'Precio Venta Bruto', 'Precio Bruto'))
    const marca = String(getVal(row, 'Marca') || '')
    const tipo_producto = String(getVal(row, 'Tipo de Producto', 'Tipo Producto', 'Tipo de Producto / Servicio') || '')
    const linea_tema = String(getVal(row, 'Linea / Tema de producto', 'Linea', 'Tema') || '')

    stock.push({
      SKU: sku, producto, variante, cantidad_disponible, costo_unitario, costo_total,
      por_recibir, precio_venta_bruto, marca, tipo_producto, linea_tema,
    })
  }

  return {
    stock,
    diagnostics: { stock_rows: stock.length, stock_col_origin: stockColOrigin },
  }
}

// ─── PASO 3: buildSkuSummary ───────────────────────────────────────────────────

export function buildSkuSummary(
  allSales: NormalizedSale[],
  allStock: NormalizedStock[],
  globalMaxDate: Date,
  startDate: Date,
  endDate: Date,
  targetCoverageWeeks: number = 4,
): SkuSummary[] {
  const durationDays = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / 86400000))
  const halfDays = Math.max(1, Math.floor(durationDays / 2))
  const midDate = new Date(endDate.getTime() - halfDays * 86400000)

  // Filtrar ventas por período seleccionado
  const salesInPeriod = allSales.filter(s => s.fecha >= startDate && s.fecha <= endDate)

  // ── Agrupado por SKU ── ventas del período
  const skuPeriod = new Map<string, {
    venta: number; unidades: number; margen: number; documentos: Set<string>
    venta_60d: number; unidades_60d: number
    venta_prev: number; unidades_prev: number
    meses: Set<string>
    venta_por_mes: Map<string, number>
    producto: string; variante: string; tipo_producto: string; marca: string; linea_tema: string
    real_supplier_name?: string; pseudo_supplier_name?: string
  }>()

  for (const s of salesInPeriod) {
    if (!skuPeriod.has(s.SKU)) {
      skuPeriod.set(s.SKU, {
        venta: 0, unidades: 0, margen: 0, documentos: new Set(),
        venta_60d: 0, unidades_60d: 0, venta_prev: 0, unidades_prev: 0,
        meses: new Set(), venta_por_mes: new Map(),
        producto: s.producto, variante: s.variante,
        tipo_producto: s.tipo_producto, marca: s.marca, linea_tema: s.linea_tema,
        real_supplier_name: s.real_supplier_name, pseudo_supplier_name: s.pseudo_supplier_name,
      })
    }
    const agg = skuPeriod.get(s.SKU)!
    agg.venta += s.venta_bruta
    agg.unidades += s.cantidad
    agg.margen += s.margen
    if (s.numero_documento) agg.documentos.add(s.numero_documento)
    agg.meses.add(s.mes)
    agg.venta_por_mes.set(s.mes, (agg.venta_por_mes.get(s.mes) || 0) + s.venta_bruta)
    // Segunda mitad
    if (s.fecha >= midDate) {
      agg.venta_60d += s.venta_bruta; agg.unidades_60d += s.cantidad
    } else {
      agg.venta_prev += s.venta_bruta; agg.unidades_prev += s.cantidad
    }
    // Nombre del producto (primer encontrado)
    if (!agg.producto && s.producto) agg.producto = s.producto
    if (!agg.variante && s.variante) agg.variante = s.variante
    if (!agg.real_supplier_name && s.real_supplier_name) agg.real_supplier_name = s.real_supplier_name
    if (!agg.pseudo_supplier_name && s.pseudo_supplier_name) agg.pseudo_supplier_name = s.pseudo_supplier_name
  }

  // ── Historial completo (para primera/última venta) ──
  const skuHistory = new Map<string, {
    venta_total: number; unidades_total: number; documentos: Set<string>
    first_date: Date; last_date: Date
  }>()

  for (const s of allSales) {
    if (!skuHistory.has(s.SKU)) {
      skuHistory.set(s.SKU, {
        venta_total: 0, unidades_total: 0, documentos: new Set(),
        first_date: s.fecha, last_date: s.fecha,
      })
    }
    const h = skuHistory.get(s.SKU)!
    h.venta_total += s.venta_bruta
    h.unidades_total += s.cantidad
    if (s.numero_documento) h.documentos.add(s.numero_documento)
    if (s.fecha < h.first_date) h.first_date = s.fecha
    if (s.fecha > h.last_date) h.last_date = s.fecha
  }

  // ── Índice de stock ──
  const stockBySku = new Map<string, NormalizedStock>()
  for (const s of allStock) {
    if (!stockBySku.has(s.SKU)) stockBySku.set(s.SKU, s)
  }

  // ── Unión de todos los SKUs ──
  const allSkus = new Set([...skuPeriod.keys(), ...skuHistory.keys(), ...stockBySku.keys()])
  const result: SkuSummary[] = []

  for (const sku of allSkus) {
    const period = skuPeriod.get(sku)
    const history = skuHistory.get(sku)
    const stockData = stockBySku.get(sku)

    // Nombres: priorizar ventas > stock; si no hay nombre, mantener el SKU como fallback visible.
    const producto = period?.producto || stockData?.producto || sku
    const variante = period?.variante || stockData?.variante || ''
    const marca = period?.marca || stockData?.marca || ''
    const tipo_producto = period?.tipo_producto || stockData?.tipo_producto || ''
    const linea_tema = period?.linea_tema || stockData?.linea_tema || ''
    const real_supplier_name = period?.real_supplier_name || stockData?.real_supplier_name || 'Sin proveedor'
    const pseudo_supplier_name = period?.pseudo_supplier_name || stockData?.pseudo_supplier_name || 'Sin pseudoproveedor'

    const venta_6m = period?.venta || 0
    const unidades_6m = period?.unidades || 0
    const margen_6m = period?.margen || 0
    const documentos = period?.documentos.size || 0

    const venta_historica_total = history?.venta_total || 0
    const unidades_historicas_total = history?.unidades_total || 0
    const documentos_historicos = history?.documentos.size || 0
    const fecha_primera_venta = history?.first_date || null
    const fecha_ultima_venta = history?.last_date || null

    const dias_desde_ultima_venta = fecha_ultima_venta
      ? Math.floor((globalMaxDate.getTime() - fecha_ultima_venta.getTime()) / 86400000)
      : 9999

    const venta_60d = period?.venta_60d || 0
    const venta_prev_60d = period?.venta_prev || 0
    const unidades_60d = period?.unidades_60d || 0
    const unidades_prev_60d = period?.unidades_prev || 0
    const diferencia_venta_periodo = venta_60d - venta_prev_60d
    const variacion_60d_pct = venta_prev_60d > 0
      ? (venta_60d - venta_prev_60d) / venta_prev_60d
      : null

    // Primer y último mes
    let venta_primer_mes = 0, venta_ultimo_mes = 0
    if (period?.venta_por_mes && period.venta_por_mes.size > 0) {
      const meses = [...period.meses].sort()
      venta_primer_mes = period.venta_por_mes.get(meses[0]) || 0
      venta_ultimo_mes = period.venta_por_mes.get(meses[meses.length - 1]) || 0
    }

    // Stock
    const cantidad_disponible = stockData?.cantidad_disponible || 0
    const costo_unitario = stockData?.costo_unitario || 0
    const por_recibir = stockData?.por_recibir || 0
    const valor_stock_disponible = cantidad_disponible * costo_unitario

    // Promedios
    const unidades_promedio_diaria = durationDays > 0 ? unidades_6m / durationDays : 0
    const venta_promedio_diaria = durationDays > 0 ? venta_6m / durationDays : 0
    const dias_cobertura = unidades_promedio_diaria > 0
      ? cantidad_disponible / unidades_promedio_diaria
      : null

    // Promedio durante período activo
    const dias_activo = fecha_primera_venta && fecha_ultima_venta
      ? Math.max(1, Math.floor((fecha_ultima_venta.getTime() - fecha_primera_venta.getTime()) / 86400000) + 1)
      : 1
    const venta_promedio_mientras_vendia = venta_historica_total / dias_activo

    // Demanda histórica relevante
    const tuvo_demanda_historica =
      venta_historica_total >= 100000 ||
      unidades_historicas_total >= 5 ||
      documentos_historicos >= 3

    // Compra sugerida
    const stock_objetivo = Math.ceil(unidades_promedio_diaria * 7 * targetCoverageWeeks)
    const suggested_quantity = Math.max(0, stock_objetivo - cantidad_disponible)

    result.push({
      SKU: sku, producto, variante, tipo_producto, marca, linea_tema,
      real_supplier_name, pseudo_supplier_name,
      venta_6m, unidades_6m, margen_6m, documentos,
      venta_historica_total, unidades_historicas_total, documentos_historicos,
      fecha_primera_venta, fecha_ultima_venta, dias_desde_ultima_venta,
      venta_60d, unidades_60d, venta_prev_60d, unidades_prev_60d,
      diferencia_venta_periodo, variacion_60d_pct,
      venta_primer_mes, venta_ultimo_mes,
      cantidad_disponible, costo_unitario, valor_stock_disponible, por_recibir,
      venta_promedio_diaria, unidades_promedio_diaria, dias_cobertura,
      venta_promedio_mientras_vendia,
      tuvo_demanda_historica, alerta: 'Normal', prioridad: 'Normal',
      suggested_quantity,
    })
  }

  return result
}

// ─── PASO 4: classifySkus ─────────────────────────────────────────────────────

export function classifySkus(skus: SkuSummary[]): SkuSummary[] {
  return skus.map(s => {
    const cond_muerto = s.cantidad_disponible > 0 && s.dias_desde_ultima_venta >= 45 && s.venta_6m === 0
    const cond_demanda_sin_stock =
      s.cantidad_disponible <= 0 &&
      s.dias_desde_ultima_venta >= 14 &&
      s.tuvo_demanda_historica
    const cond_quiebre_critico = s.dias_cobertura != null && s.dias_cobertura < 7 && s.cantidad_disponible > 0
    const cond_riesgo_quiebre = s.dias_cobertura != null && s.dias_cobertura < 15 && s.cantidad_disponible > 0
    const cond_caida = s.venta_60d < s.venta_prev_60d * 0.2 && s.venta_prev_60d > 0 && s.cantidad_disponible > 0
    const cond_crecimiento = s.venta_60d > s.venta_prev_60d * 1.5 && s.venta_prev_60d > 0

    let alerta = 'Normal'
    let prioridad = 'Normal'

    if (cond_muerto) { alerta = 'Producto muerto con stock'; prioridad = 'Alta' }
    else if (cond_demanda_sin_stock) { alerta = 'Demanda histórica sin stock'; prioridad = 'Alta' }
    else if (cond_quiebre_critico) { alerta = 'Quiebre crítico'; prioridad = 'Alta' }
    else if (cond_riesgo_quiebre) { alerta = 'Riesgo de quiebre'; prioridad = 'Media' }
    else if (cond_caida) { alerta = 'Venta en caída con stock'; prioridad = 'Media-Alta' }
    else if (cond_crecimiento) { alerta = 'Producto en crecimiento'; prioridad = 'Normal' }

    return { ...s, alerta, prioridad }
  })
}

// ─── PASO 5: Análisis Pareto ──────────────────────────────────────────────────

export interface ParetoRow {
  SKU: string
  producto: string
  variante: string
  venta_6m: number
  unidades_6m: number
  venta_acumulada: number
  pct_acumulado: number
  clasificacion_pareto: string
}

export function paretoAnalysis(skus: SkuSummary[]): ParetoRow[] {
  const sorted = [...skus].filter(s => s.venta_6m > 0).sort((a, b) => b.venta_6m - a.venta_6m)
  const total = sorted.reduce((acc, s) => acc + s.venta_6m, 0)
  let acumulada = 0
  return sorted.map(s => {
    acumulada += s.venta_6m
    const pct = total > 0 ? acumulada / total : 0
    return {
      SKU: s.SKU,
      producto: s.producto,
      variante: s.variante,
      venta_6m: s.venta_6m,
      unidades_6m: s.unidades_6m,
      venta_acumulada: acumulada,
      pct_acumulado: pct,
      clasificacion_pareto: pct <= 0.80 ? 'A: Core ventas' : 'B/C: Cola larga',
    }
  })
}

// ─── PASO 6: Agrupación semanal ───────────────────────────────────────────────

export interface WeeklySummary {
  anio: number
  semana: number
  label: string
  venta: number
  unidades: number
  margen: number
}

export function weeklyGrouping(sales: NormalizedSale[]): WeeklySummary[] {
  const map = new Map<string, WeeklySummary>()
  for (const s of sales) {
    const key = `${s.anio}-${String(s.semana).padStart(2, '0')}`
    if (!map.has(key)) {
      map.set(key, {
        anio: s.anio,
        semana: s.semana,
        label: `S${s.semana} (${s.anio})`,
        venta: 0,
        unidades: 0,
        margen: 0,
      })
    }
    const w = map.get(key)!
    w.venta += s.venta_bruta
    w.unidades += s.cantidad
    w.margen += s.margen
  }
  return [...map.values()].sort((a, b) => a.anio !== b.anio ? a.anio - b.anio : a.semana - b.semana)
}

// ─── PASO 7: Agrupación mensual ───────────────────────────────────────────────

export interface MonthlySummary {
  mes: string
  label: string
  venta: number
  unidades: number
  margen: number
  sku_activos: number
}

const MESES_ES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']

export function monthlyGrouping(sales: NormalizedSale[]): MonthlySummary[] {
  const map = new Map<string, MonthlySummary & { skus: Set<string> }>()
  for (const s of sales) {
    const key = s.mes
    if (!map.has(key)) {
      const [anio, mes_num] = key.split('-').map(Number)
      const nombreMes = MESES_ES[mes_num - 1] || String(mes_num)
      map.set(key, { mes: key, label: `${nombreMes} ${anio}`, venta: 0, unidades: 0, margen: 0, sku_activos: 0, skus: new Set() })
    }
    const m = map.get(key)!
    m.venta += s.venta_bruta
    m.unidades += s.cantidad
    m.margen += s.margen
    m.skus.add(s.SKU)
  }
  return [...map.values()]
    .sort((a, b) => a.mes.localeCompare(b.mes))
    .map(m => ({ mes: m.mes, label: m.label, venta: m.venta, unidades: m.unidades, margen: m.margen, sku_activos: m.skus.size }))
}

// ─── PASO 8: Generar reporte completo para guardar ────────────────────────────

export function buildFullReport(
  skus: SkuSummary[],
  dateFrom: Date,
  dateTo: Date,
  targetCoverageWeeks: number,
  totalSales: number,
  diagnostics: Record<string, any>,
): SalesAnalysisReport {
  const items: SalesAnalysisItem[] = skus
    .filter(s => !(s.cantidad_disponible === 0 && s.venta_6m === 0))
    .sort((a, b) => b.suggested_quantity - a.suggested_quantity)
    .map(s => ({
      sku: s.SKU,
      product_name: s.producto,
      variant: s.variante,
      supplier: '',
      category: s.tipo_producto,
      brand: s.marca,
      current_stock: s.cantidad_disponible,
      unit_cost: s.costo_unitario,
      total_units_sold: s.unidades_6m,
      weekly_average_sales: Number((s.unidades_promedio_diaria * 7).toFixed(2)),
      suggested_quantity: s.suggested_quantity,
      alert_type: s.alerta,
      priority: s.prioridad,
      metrics: {
        venta_6m: s.venta_6m,
        margen_6m: s.margen_6m,
        venta_60d: s.venta_60d,
        venta_prev_60d: s.venta_prev_60d,
        diferencia_venta_periodo: s.diferencia_venta_periodo,
        variacion_60d_pct: s.variacion_60d_pct,
        dias_cobertura: s.dias_cobertura,
        valor_stock_disponible: s.valor_stock_disponible,
        dias_desde_ultima_venta: s.dias_desde_ultima_venta,
        fecha_ultima_venta: s.fecha_ultima_venta?.toISOString().split('T')[0] ?? null,
        fecha_primera_venta: s.fecha_primera_venta?.toISOString().split('T')[0] ?? null,
        venta_historica_total: s.venta_historica_total,
        venta_promedio_mientras_vendia: s.venta_promedio_mientras_vendia,
        tuvo_demanda_historica: s.tuvo_demanda_historica,
        por_recibir: s.por_recibir,
        unidades_promedio_diaria: s.unidades_promedio_diaria,
        linea_tema: s.linea_tema,
      },
    }))

  const totalStockValue = skus.reduce((acc, s) => acc + s.valor_stock_disponible, 0)

  return {
    date_from: dateFrom.toISOString().split('T')[0],
    date_to: dateTo.toISOString().split('T')[0],
    total_sales: totalSales,
    total_stock_value: totalStockValue,
    target_coverage_weeks: targetCoverageWeeks,
    items,
    diagnostics,
  }
}
