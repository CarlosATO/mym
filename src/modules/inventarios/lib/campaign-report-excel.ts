import * as XLSX from 'xlsx'
import type {
  CampaignAllProductItem,
  CampaignApprovedBarcode,
  CampaignReviewSummary,
  CampaignVarianceItem,
} from '@/app/actions/inventarios/campaign-report'

export const VARIANCE_LABELS: Record<string, string> = {
  FALTANTE: 'Faltante',
  SOBRANTE: 'Sobrante',
  SIN_DIFERENCIA: 'Sin diferencia',
}

export const COVERAGE_LABELS: Record<string, string> = {
  COUNTED: 'Contado',
  NOT_COUNTED: 'No contado',
  OUT_OF_SNAPSHOT: 'No incluido para conteo',
}

export interface CampaignReportExcelContribRow {
  sku: string | null
  name: string | null
  session_name: string | null
  zone_code: string | null
  location_code: string | null
  counted_by_name: string | null
  physical_quantity: number
  identification_method: string | null
  scanned_code: string | null
  captured_at: string | null
}

export interface CampaignReportExcelData {
  campaignName: string
  campaignDate: string | null
  isFinal: boolean
  generatedAt: string
  summary: CampaignReviewSummary | null
  allVariances: CampaignVarianceItem[]
  allProducts: CampaignAllProductItem[]
  contributions: CampaignReportExcelContribRow[]
  operationalRows: string[][]
  approvedBarcodes?: CampaignApprovedBarcode[]
}

const METHOD_LABELS: Record<string, string> = {
  BARCODE: 'Barcode',
  SEARCH_MANUAL: 'Búsqueda manual',
  DISCOVERY: 'Descubrimiento',
  MANUAL: 'Manual',
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_').slice(0, 60)
}

export function buildCampaignReportWorkbook(data: CampaignReportExcelData): XLSX.WorkBook {
  const wb = XLSX.utils.book_new()
  const theoreticalProducts = data.allProducts.length
  const countedTheoreticalProducts = data.allProducts.filter(item => item.coverage_status === 'COUNTED').length
  const uncountedTheoreticalProducts = theoreticalProducts - countedTheoreticalProducts
  const theoreticalProductKeys = new Set(data.allProducts.map(item => item.product_key))
  const outOfStockProducts = data.allVariances.filter(item => !theoreticalProductKeys.has(item.product_key))

  // ---------- Hoja Resumen ----------
  const summary: (string | number)[][] = [['Informe del Inventario', data.campaignName]]
  summary.push(['Nombre del Inventario', data.campaignName])
  summary.push(['Fecha del Inventario', data.campaignDate ?? '—'])
  summary.push(['Estado', data.isFinal ? 'Resultado final' : 'Resultado provisorio'])
  summary.push(['Fecha/hora de generación', data.generatedAt])
  summary.push([])
  summary.push(['Productos del stock teórico', theoreticalProducts])
  summary.push(['Productos del stock teórico contados', countedTheoreticalProducts])
  summary.push(['Productos sin conteo', uncountedTheoreticalProducts])
  summary.push(['Productos encontrados fuera del stock teórico', outOfStockProducts.length])
  summary.push(['Total de productos con resultado', data.allVariances.length])
  summary.push([])
  const stock = data.summary?.stock
  if (stock) {
    summary.push(['Faltantes', stock.faltantes])
    summary.push(['Sobrantes', stock.sobrantes])
    summary.push(['Sin diferencia', stock.sin_diferencia])
    summary.push(['Unidades faltantes', stock.units_faltante])
    summary.push(['Unidades sobrantes', stock.units_sobrante])
    summary.push(['Valorización neta', stock.net_valuation])
    summary.push(['Valorización absoluta', stock.absolute_valuation])
  }
  summary.push([])
  const op = data.summary?.operation
  if (op) {
    summary.push(['Secciones totales', op.total_sessions])
    summary.push(['Secciones terminadas', op.sessions_by_status.APPROVED ?? 0])
    summary.push(['Secciones en curso', (op.sessions_by_status.COUNTING ?? 0) + (op.sessions_by_status.UNDER_REVIEW ?? 0)])
    summary.push(['Secciones pendientes', (op.sessions_by_status.DRAFT ?? 0) + (op.sessions_by_status.PREPARED ?? 0)])
    summary.push(['Zonas completadas', op.zones_completed])
    summary.push(['Zonas en curso', op.zones_in_progress])
    summary.push(['Ubicaciones totales', op.locations_total])
    summary.push(['Ubicaciones visitadas', op.locations_visited])
    summary.push(['Ubicaciones abiertas', op.locations_open])
    summary.push(['Ubicaciones nunca visitadas', op.locations_never_visited])
    summary.push(['Ubicaciones visitadas sin registros', op.locations_visited_without_counts])
    summary.push(['Productos no incluidos para conteo', stock?.out_of_snapshot ?? 0])
    summary.push(['Códigos pendientes', op.pending_barcode_proposals])
  }
  const summaryWs = XLSX.utils.aoa_to_sheet(summary)
  summaryWs['!cols'] = [{ wch: 34 }, { wch: 24 }]
  XLSX.utils.book_append_sheet(wb, summaryWs, 'Resumen')

  // ---------- Hoja Resultado completo ----------
  const header = [
    'SKU',
    'Producto',
    'Stock teórico',
    'Cantidad contada',
    'Diferencia',
    'Resultado',
    'Situación del conteo',
    'Costo unitario',
    'Impacto valorizado',
    'Código Bsale al Inventario',
    'Códigos adicionales autorizados',
  ]
  const rows: (string | number | null)[][] = [header]
  for (const item of data.allVariances) {
    const approved = (item.approved_barcodes ?? []).filter(Boolean)
    rows.push([
      item.sku ?? '—',
      item.name ?? '—',
      item.theoretical_quantity,
      item.physical_quantity,
      item.difference_quantity,
      VARIANCE_LABELS[item.variance_status] ?? item.variance_status,
      COVERAGE_LABELS[item.coverage_status] ?? item.coverage_status,
      item.unit_cost,
      item.difference_value,
      item.barcode ?? 'Sin código registrado',
      approved.length > 0 ? approved.join(', ') : '—',
    ])
  }
  const resultWs = XLSX.utils.aoa_to_sheet(rows)
  resultWs['!cols'] = [
    { wch: 14 }, { wch: 36 }, { wch: 14 }, { wch: 14 }, { wch: 12 },
    { wch: 14 }, { wch: 20 }, { wch: 16 }, { wch: 18 },
    { wch: 24 }, { wch: 28 },
  ]
  resultWs['!autofilter'] = { ref: `A1:K${rows.length}` }
  resultWs['!freeze'] = { xSplit: 0, ySplit: 1 }
  XLSX.utils.book_append_sheet(wb, resultWs, 'Resultado completo')

  // ---------- Hoja Todos los productos ----------
  const allProductRows: (string | number | null)[][] = [header]
  for (const item of data.allProducts) {
    const approved = (item.approved_barcodes ?? []).filter(Boolean)
    const counted = item.coverage_status === 'COUNTED'
    allProductRows.push([
      item.sku ?? '—',
      item.name ?? '—',
      item.theoretical_quantity,
      item.physical_quantity,
      item.difference_quantity,
      item.variance_status === 'SIN_CONTEO'
        ? 'Sin conteo'
        : VARIANCE_LABELS[item.variance_status] ?? item.variance_status,
      counted ? COVERAGE_LABELS.COUNTED : COVERAGE_LABELS.NOT_COUNTED,
      item.unit_cost,
      item.difference_value,
      item.barcode ?? 'Sin código registrado',
      approved.length > 0 ? approved.join(', ') : '—',
    ])
  }
  const allProductsWs = XLSX.utils.aoa_to_sheet(allProductRows)
  allProductsWs['!cols'] = [
    { wch: 14 }, { wch: 36 }, { wch: 14 }, { wch: 14 }, { wch: 12 },
    { wch: 14 }, { wch: 20 }, { wch: 16 }, { wch: 18 },
    { wch: 24 }, { wch: 28 },
  ]
  allProductsWs['!autofilter'] = { ref: `A1:K${allProductRows.length}` }
  allProductsWs['!freeze'] = { xSplit: 0, ySplit: 1 }
  XLSX.utils.book_append_sheet(wb, allProductsWs, 'Todos los productos')

  // ---------- Hoja Fuera del stock teórico ----------
  const outHeader = [
    'SKU',
    'Producto',
    'Cantidad contada',
    'Resultado',
    'Situación',
    'Código Bsale al Inventario',
    'Códigos adicionales autorizados',
    'ID variante Bsale',
  ]
  const outRows: (string | number | null)[][] = [outHeader]
  for (const item of outOfStockProducts) {
    const approved = (item.approved_barcodes ?? []).filter(Boolean)
    outRows.push([
      item.sku ?? '—',
      item.name ?? '—',
      item.physical_quantity,
      'Encontrado fuera del stock teórico',
      'No incluido para conteo',
      item.barcode ?? 'Sin código registrado',
      approved.length > 0 ? approved.join(', ') : '—',
      item.bsale_variant_id,
    ])
  }
  const outWs = XLSX.utils.aoa_to_sheet(outRows)
  outWs['!cols'] = [
    { wch: 14 }, { wch: 36 }, { wch: 16 }, { wch: 34 },
    { wch: 24 }, { wch: 24 }, { wch: 28 }, { wch: 16 },
  ]
  outWs['!autofilter'] = { ref: `A1:H${outRows.length}` }
  outWs['!freeze'] = { xSplit: 0, ySplit: 1 }
  XLSX.utils.book_append_sheet(wb, outWs, 'Fuera del stock teórico')

  // ---------- Hoja Detalle de conteos ----------
  const detHeader = [
    'SKU',
    'Producto',
    'Bodega / Sección',
    'Zona',
    'Ubicación',
    'Contador',
    'Cantidad',
    'Método',
    'Código escaneado',
    'Fecha / hora',
  ]
  const detRows: (string | number | null)[][] = [detHeader]
  for (const c of data.contributions) {
    detRows.push([
      c.sku ?? '—',
      c.name ?? '—',
      c.session_name ?? '—',
      c.zone_code ?? '—',
      c.location_code ?? '—',
      c.counted_by_name ?? '—',
      c.physical_quantity,
      c.identification_method ? (METHOD_LABELS[c.identification_method] ?? c.identification_method) : '—',
      c.scanned_code ?? '—',
      c.captured_at ?? '—',
    ])
  }
  const detWs = XLSX.utils.aoa_to_sheet(detRows)
  detWs['!cols'] = [
    { wch: 14 }, { wch: 32 }, { wch: 30 }, { wch: 10 }, { wch: 22 },
    { wch: 20 }, { wch: 10 }, { wch: 16 }, { wch: 18 }, { wch: 20 },
  ]
  detWs['!autofilter'] = { ref: `A1:J${detRows.length}` }
  detWs['!freeze'] = { xSplit: 0, ySplit: 1 }
  XLSX.utils.book_append_sheet(wb, detWs, 'Detalle de conteos')

  // ---------- Hoja Estado operacional ----------
  const opHeader = ['Tipo', 'Sección', 'Zona', 'Ubicación', 'Estado / Situación', 'Detalle']
  const opRows: string[][] = [opHeader, ...data.operationalRows]
  const opWs = XLSX.utils.aoa_to_sheet(opRows)
  opWs['!cols'] = [{ wch: 26 }, { wch: 30 }, { wch: 12 }, { wch: 22 }, { wch: 22 }, { wch: 40 }]
  opWs['!autofilter'] = { ref: `A1:F${opRows.length}` }
  opWs['!freeze'] = { xSplit: 0, ySplit: 1 }
  XLSX.utils.book_append_sheet(wb, opWs, 'Estado operacional')

  // ---------- Hoja Actualización de códigos ----------
  const bcHeader = [
    'SKU',
    'Producto',
    'Código Bsale anterior',
    'Código nuevo autorizado',
    'Veces detectado',
    'Ubicaciones',
    'Primera detección',
    'Última detección',
    'Estado',
    'Acción sugerida',
  ]
  const bcRows: (string | number | null)[][] = [bcHeader]
  for (const b of data.approvedBarcodes ?? []) {
    bcRows.push([
      b.sku ?? '—',
      b.product_name ?? '—',
      b.original_barcode ?? 'Sin código registrado',
      b.approved_barcode,
      b.occurrence_count,
      b.location_count,
      b.first_detected_at ?? '—',
      b.latest_detected_at ?? '—',
      b.status === 'Autorizado' ? 'Autorizado' : b.status,
      'Revisar / actualizar en Bsale',
    ])
  }
  const bcWs = XLSX.utils.aoa_to_sheet(bcRows)
  bcWs['!cols'] = [
    { wch: 14 }, { wch: 36 }, { wch: 24 }, { wch: 24 },
    { wch: 14 }, { wch: 12 }, { wch: 20 }, { wch: 20 },
    { wch: 14 }, { wch: 26 },
  ]
  bcWs['!autofilter'] = { ref: `A1:J${bcRows.length}` }
  bcWs['!freeze'] = { xSplit: 0, ySplit: 1 }
  XLSX.utils.book_append_sheet(wb, bcWs, 'Actualización de códigos')

  return wb
}

export function downloadCampaignReportExcel(data: CampaignReportExcelData): string {
  const wb = buildCampaignReportWorkbook(data)
  const state = data.isFinal ? 'FINAL' : 'PROVISORIO'
  const filename = `Informe_Inventario_${sanitizeFileName(data.campaignName)}_${state}.xlsx`
  XLSX.writeFile(wb, filename)
  return filename
}
