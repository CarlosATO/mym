import * as XLSX from 'xlsx'

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

const UNRESOLVED_SUPPLIER = 'Proveedor no resuelto'

function displaySupplier(name: string): string {
  if (!name || name.trim() === '' || name === 'Sin proveedor') return UNRESOLVED_SUPPLIER
  return name
}

function supplierKey(name: string): string {
  return displaySupplier(name)
}

interface SupplierSummary {
  skus: number
  units: number
  amount: number
  noCost: number
}

function buildResumenRows(rows: ReplenishmentExcelRow[], now: Date, periodLabel: string, coverageLabel: string): { header: (string | number)[][]; body: (string | number)[][] } {
  const criticalCount = rows.filter(r => r.critical).length
  const noCostCount = rows.filter(r => r.noCost).length
  const unresolvedCount = rows.filter(r => r.realSupplier === '' || r.realSupplier === 'Sin proveedor').length
  const totalUnits = rows.reduce((a, r) => a + r.confirmedQty, 0)
  const totalAmount = rows.reduce((a, r) => a + r.subtotal, 0)

  const bySupplier = new Map<string, SupplierSummary>()
  for (const r of rows) {
    const key = supplierKey(r.realSupplier)
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

  // Hoja Resumen
  const { header, body } = buildResumenRows(rows, now, periodLabel, coverageLabel)
  const summaryRows: (string | number)[][] = [...header, ...body]
  const summaryWs = XLSX.utils.aoa_to_sheet(summaryRows)
  summaryWs['!cols'] = [{ wch: 34 }, { wch: 22 }, { wch: 14 }, { wch: 20 }, { wch: 14 }]

  // Hoja Detalle
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
  // Fila de totales
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
