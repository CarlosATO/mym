import * as XLSX from 'xlsx'
import type { ColumnId } from './replenishment-columns'

// ─── Tipos del exportador V1 (preservados para no romper imports existentes) ─

export interface ReplenishmentExcelRow {
  sku: string
  product: string
  variant: string
  realSupplier: string
  pseudoSupplier: string
  stockAvailable: number
  buckets: number[]
  totalSold: number
  avgPer7: number
  suggestedQty: number
  confirmedQty: number
  unitCost: number
  subtotal: number
  critical: boolean
  noCost: boolean
  trend: string
}

export interface ReplenishmentExcelParams {
  periodLabel: string
  coverageLabel: string
  rows: ReplenishmentExcelRow[]
}

// ─── Tipos del exportador V2 ─────────────────────────────────────────────────

export interface ReplenishmentExcelOptionsV2 {
  /** Columnas fijas efectivamente visibles en la tabla (effectiveVisibleFixed) */
  visibleFixedCols: ColumnId[]
  /** ¿Están visibles las columnas de semanas? */
  weeksVisible: boolean
  /** Índices de bucket visibles en la tabla */
  visibleBucketIndices: number[]
  /** Etiquetas de las semanas visibles */
  bucketLabels: string[]
  /** Filtros activos (para hoja de contexto) */
  supplierFilter: string
  lineFilter: string
  statusFilter: string
  periodLabel: string
  coverageLabel: string
  historialLabel: string
  /** Filas a exportar (ya filtradas por la semántica: visibles o seleccionados) */
  rows: ReplenishmentExcelRow[]
  /** Etiqueta del modo para la hoja de contexto */
  exportMode: 'Resultados visibles' | 'Solo seleccionados'
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const UNRESOLVED_SUPPLIER = 'Proveedor no resuelto'

function displaySupplier(name: string): string {
  if (!name || name.trim() === '' || name === 'Sin proveedor') return UNRESOLVED_SUPPLIER
  return name
}

// ─── Exportador V1 (legacy — sin cambios funcionales) ───────────────────────

interface SupplierSummary {
  skus: number
  units: number
  amount: number
  noCost: number
}

function buildResumenRows(
  rows: ReplenishmentExcelRow[],
  now: Date,
  periodLabel: string,
  coverageLabel: string,
): { header: (string | number)[][]; body: (string | number)[][] } {
  const criticalCount = rows.filter(r => r.critical).length
  const noCostCount = rows.filter(r => r.noCost).length
  const unresolvedCount = rows.filter(r => r.realSupplier === '' || r.realSupplier === 'Sin proveedor').length
  const totalUnits = rows.reduce((a, r) => a + r.confirmedQty, 0)
  const totalAmount = rows.reduce((a, r) => a + r.subtotal, 0)

  const bySupplier = new Map<string, SupplierSummary>()
  for (const r of rows) {
    const key = displaySupplier(r.realSupplier)
    const s = bySupplier.get(key) ?? { skus: 0, units: 0, amount: 0, noCost: 0 }
    s.skus += 1
    s.units += r.confirmedQty
    s.amount += r.subtotal
    if (r.noCost) s.noCost += 1
    bySupplier.set(key, s)
  }

  const supplierNames = Array.from(bySupplier.keys())

  const header: (string | number)[][] = []
  const body: (string | number)[][] = []
  header.push(['RESUMEN DE REPOSICIÓN'])
  header.push(['Fecha de generación', now.toLocaleString('es-CL')])
  header.push(['Periodo analizado', periodLabel])
  header.push(['Cobertura', coverageLabel])
  header.push(['SKU seleccionados', rows.length])
  header.push(['Unidades totales a comprar', totalUnits])
  header.push(['Costo estimado total', totalAmount])
  header.push(['Productos críticos', criticalCount])
  header.push(['Productos sin costo', noCostCount])
  header.push(['Productos sin proveedor resuelto', unresolvedCount])
  header.push(['Proveedores involucrados', supplierNames.length])
  header.push([])
  header.push(['TOTALES POR PROVEEDOR'])
  header.push(['Proveedor', 'SKU', 'Unidades', 'Monto estimado', 'Sin costo'])
  body.push([])

  const sorted = supplierNames.slice().sort()
  for (const name of sorted) {
    const s = bySupplier.get(name)!
    body.push([name, s.skus, s.units, s.amount, s.noCost])
  }

  return { header, body }
}

function buildDetalleHeader(bucketCount: number): string[] {
  const base = [
    'SKU',
    'Producto',
    'Variante / tipo',
    'Proveedor real',
    'Pseudoproveedor',
    'Stock disponible',
  ]
  for (let b = 1; b <= bucketCount; b++) {
    base.push(`Ventas bloque ${b}`)
  }
  base.push(
    'Total vendido',
    'Promedio cada 7 días',
    'Cantidad sugerida',
    'Cantidad seleccionada',
    'Costo unitario',
    'Subtotal estimado',
    'Condición crítica',
    'Advertencia de costo',
    'Estado de tendencia'
  )
  return base
}

export function buildReplenishmentWorkbook(params: ReplenishmentExcelParams): XLSX.WorkBook {
  const { periodLabel, coverageLabel, rows } = params
  const now = new Date()

  const { header, body } = buildResumenRows(rows, now, periodLabel, coverageLabel)
  const summaryRows: (string | number)[][] = [...header, ...body]
  const summaryWs = XLSX.utils.aoa_to_sheet(summaryRows)
  summaryWs['!cols'] = [{ wch: 34 }, { wch: 22 }, { wch: 14 }, { wch: 20 }, { wch: 14 }]

  const bucketCount = rows[0]?.buckets.length ?? 0
  const detalleHeader = buildDetalleHeader(bucketCount)
  const detalleRows: (string | number | boolean)[][] = []
  detalleRows.push(detalleHeader)
  for (const r of rows) {
    const row: (string | number | boolean)[] = [
      r.sku,
      r.product,
      r.variant || '—',
      displaySupplier(r.realSupplier),
      r.pseudoSupplier || '—',
      r.stockAvailable,
    ]
    for (let b = 0; b < bucketCount; b++) {
      row.push(r.buckets[b] ?? 0)
    }
    row.push(
      r.totalSold,
      Number(r.avgPer7.toFixed(1)),
      r.suggestedQty,
      r.confirmedQty,
      r.unitCost,
      r.subtotal,
      r.critical ? 'Sí' : 'No',
      r.noCost ? 'Sin costo' : '',
      r.trend
    )
    detalleRows.push(row)
  }

  const totalRow: (string | number | boolean)[] = ['', '', '', '', '', '']
  for (let b = 0; b < bucketCount; b++) totalRow.push('')
  totalRow.push(
    rows.reduce((a, r) => a + r.totalSold, 0),
    '',
    rows.reduce((a, r) => a + r.suggestedQty, 0),
    rows.reduce((a, r) => a + r.confirmedQty, 0),
    '',
    rows.reduce((a, r) => a + r.subtotal, 0),
    '',
    '',
    ''
  )
  detalleRows.push(totalRow)

  const detalleWs = XLSX.utils.aoa_to_sheet(detalleRows)
  detalleWs['!cols'] = [
    { wch: 14 }, { wch: 30 }, { wch: 18 }, { wch: 22 }, { wch: 22 }, { wch: 12 },
    ...Array.from({ length: bucketCount }, () => ({ wch: 12 })),
    { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 16 },
    { wch: 12 }, { wch: 16 }, { wch: 14 },
  ]
  detalleWs['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(detalleHeader.length - 1)}${detalleRows.length}` }

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, summaryWs, 'Resumen')
  XLSX.utils.book_append_sheet(wb, detalleWs, 'Detalle de compra')
  return wb
}

export function downloadReplenishmentExcel(params: ReplenishmentExcelParams): string {
  const wb = buildReplenishmentWorkbook(params)
  const date = new Date().toISOString().slice(0, 10)
  const filename = `Reposicion_${date}.xlsx`
  XLSX.writeFile(wb, filename)
  return filename
}

// ─── Exportador V2 (coherente con columnas/semanas visibles) ─────────────────

/** Mapa de ColumnId a nombre de columna en el Excel */
const COL_LABEL: Partial<Record<ColumnId, string>> = {
  index: '#',
  sku: 'SKU',
  product: 'Producto / desc.',
  variant: 'Variante / tipo',
  supplier: 'Proveedor',
  line: 'Línea de artículos',
  disponible: 'Stock disponible',
  estado: 'Estado',
  sugerido: 'Sugerido',
  cantidad: 'Cantidad confirmada',
  monto: 'Monto confirmado',
  confirmar: 'Confirmado',
  totalVendido: 'Total vendido',
  promedio: 'Promedio semanal',
  costo: 'Costo unitario',
}

// Columnas que no son relevantes o son operacionales (no se exportan)
const SKIP_COLS = new Set<ColumnId>(['index', 'confirmar', 'cantidad', 'monto'])

function getCellValue(col: ColumnId, row: ReplenishmentExcelRow): string | number {
  switch (col) {
    case 'sku': return row.sku
    case 'product': return row.product
    case 'variant': return row.variant || '—'
    case 'supplier': return displaySupplier(row.realSupplier)
    case 'line': return row.pseudoSupplier || '—'
    case 'disponible': return row.stockAvailable
    case 'estado': return row.critical ? 'Crítico' : row.noCost ? 'Sin costo' : 'Normal'
    case 'sugerido': return row.suggestedQty
    case 'cantidad': return row.confirmedQty
    case 'monto': return row.subtotal
    case 'confirmar': return row.confirmedQty > 0 ? 'Sí' : 'No'
    case 'totalVendido': return row.totalSold
    case 'promedio': return Number(row.avgPer7.toFixed(1))
    case 'costo': return row.unitCost
    default: return ''
  }
}

function buildContextSheet(opts: ReplenishmentExcelOptionsV2, now: Date): XLSX.WorkSheet {
  const rows: (string | number)[][] = []
  rows.push(['ANÁLISIS DE REPOSICIÓN — CONTEXTO DE EXPORTACIÓN'])
  rows.push([])
  rows.push(['Fecha de generación', now.toLocaleString('es-CL')])
  rows.push(['Modo de exportación', opts.exportMode])
  rows.push(['Total de filas exportadas', opts.rows.length])
  rows.push([])
  rows.push(['FILTROS APLICADOS'])
  rows.push(['Período', opts.periodLabel])
  rows.push(['Cobertura', opts.coverageLabel])
  rows.push(['Proveedor', opts.supplierFilter || 'Todos'])
  rows.push(['Línea de artículos', opts.lineFilter || 'Todas'])
  rows.push(['Estado', opts.statusFilter || 'Todos'])
  rows.push(['Detalle semanal', opts.historialLabel])

  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!cols'] = [{ wch: 30 }, { wch: 40 }]
  return ws
}

function buildDetalleSheetV2(opts: ReplenishmentExcelOptionsV2): XLSX.WorkSheet {
  const { visibleFixedCols, weeksVisible, visibleBucketIndices, bucketLabels, rows } = opts

  // Columnas fijas a exportar (excluir las operacionales y respetar visibilidad)
  const exportCols = visibleFixedCols.filter(id => !SKIP_COLS.has(id))

  // Construir encabezado
  const header: string[] = []
  for (const col of exportCols) {
    header.push(COL_LABEL[col] ?? col)
  }
  // Agregar columna de Cantidad confirmada si 'cantidad' estaba visible
  if (visibleFixedCols.includes('cantidad')) header.push('Cantidad confirmada')
  // Agregar columna de Monto si 'monto' estaba visible
  if (visibleFixedCols.includes('monto')) header.push('Monto estimado')
  // Agregar columna confirmado si 'confirmar' estaba visible
  if (visibleFixedCols.includes('confirmar')) header.push('Confirmado')
  // Columnas semanales
  if (weeksVisible) {
    for (const bi of visibleBucketIndices) {
      header.push(bucketLabels[bi] ?? `Sem. ${bi + 1}`)
    }
  }

  const dataRows: (string | number | boolean)[][] = [header]

  for (const r of rows) {
    const row: (string | number | boolean)[] = []

    // Columnas fijas no skip
    for (const col of exportCols) {
      row.push(getCellValue(col, r))
    }
    // Columnas skip pero presentes
    if (visibleFixedCols.includes('cantidad')) row.push(r.confirmedQty)
    if (visibleFixedCols.includes('monto')) row.push(r.subtotal)
    if (visibleFixedCols.includes('confirmar')) row.push(r.confirmedQty > 0 ? 'Sí' : 'No')

    // Columnas semanales
    if (weeksVisible) {
      for (const bi of visibleBucketIndices) {
        row.push(r.buckets[bi] ?? 0)
      }
    }

    dataRows.push(row)
  }

  // Fila de totales (solo columnas numéricas relevantes)
  const totalRow: (string | number | boolean)[] = exportCols.map(col => {
    if (col === 'sku') return 'TOTALES'
    if (col === 'disponible') return rows.reduce((a, r) => a + r.stockAvailable, 0)
    if (col === 'sugerido') return rows.reduce((a, r) => a + r.suggestedQty, 0)
    if (col === 'totalVendido') return rows.reduce((a, r) => a + r.totalSold, 0)
    return ''
  })
  if (visibleFixedCols.includes('cantidad')) totalRow.push(rows.reduce((a, r) => a + r.confirmedQty, 0))
  if (visibleFixedCols.includes('monto')) totalRow.push(rows.reduce((a, r) => a + r.subtotal, 0))
  if (visibleFixedCols.includes('confirmar')) totalRow.push('')
  if (weeksVisible) {
    for (const bi of visibleBucketIndices) {
      totalRow.push(rows.reduce((a, r) => a + (r.buckets[bi] ?? 0), 0))
    }
  }
  dataRows.push(totalRow)

  const ws = XLSX.utils.aoa_to_sheet(dataRows)
  const numCols = header.length
  ws['!cols'] = Array.from({ length: numCols }, (_, i) => {
    // Columna producto más ancha
    if (i === exportCols.findIndex(c => c === 'product')) return { wch: 32 }
    if (i === exportCols.findIndex(c => c === 'supplier') || i === exportCols.findIndex(c => c === 'line')) return { wch: 22 }
    return { wch: 14 }
  })
  ws['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(numCols - 1)}${dataRows.length}` }

  return ws
}

export function downloadReplenishmentExcelV2(opts: ReplenishmentExcelOptionsV2): string {
  const now = new Date()
  const wb = XLSX.utils.book_new()

  // Hoja 1: Contexto / filtros
  const contextWs = buildContextSheet(opts, now)
  XLSX.utils.book_append_sheet(wb, contextWs, 'Contexto')

  // Hoja 2: Detalle coherente con pantalla
  const detalleWs = buildDetalleSheetV2(opts)
  const modeLabel = opts.exportMode === 'Solo seleccionados' ? 'Seleccionados' : 'Detalle'
  XLSX.utils.book_append_sheet(wb, detalleWs, modeLabel)

  const date = now.toISOString().slice(0, 10)
  const filename = `Reposicion_${date}.xlsx`
  XLSX.writeFile(wb, filename)
  return filename
}
