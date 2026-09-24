import * as XLSX from 'xlsx'
import type { PurchaseOrderCatalogProduct } from '@/app/actions/adquisiciones/products'

export type ReplenishmentExcelFormat = 'COMPRA' | 'VENTAS' | 'COMPLETA'
export type ImportedRowStatus = 'VALIDO' | 'SKU_NO_ENCONTRADO' | 'CANTIDAD_INVALIDA' | 'DUPLICADO' | 'NO_CONFIRMADO'

export interface ReplenishmentExcelImportRow {
  rowNumber: number
  sku: string
  product: string
  quantity: number | null
  productId: string | null
  status: ImportedRowStatus
  reason: string
}

export interface ReplenishmentExcelImportPreview {
  fileName: string
  format: ReplenishmentExcelFormat
  provider: string
  totalRows: number
  validRows: number
  ignoredRows: number
  errorRows: number
  selectionBasis: 'CONFIRMADO_Y_CANTIDAD' | 'CANTIDAD'
  rows: ReplenishmentExcelImportRow[]
}

export function getVisibleReplenishmentExcelRows(rows: ReplenishmentExcelImportRow[], showAll: boolean): ReplenishmentExcelImportRow[] {
  return showAll ? rows : rows.filter(row => row.status !== 'NO_CONFIRMADO')
}

interface ParsedSheet {
  headers: string[]
  values: unknown[][]
  context: Map<string, string>
}

function normalize(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function headerIndex(headers: string[], names: string[]): number {
  return headers.findIndex(header => names.includes(normalize(header)))
}

function text(value: unknown): string {
  return String(value ?? '').trim()
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const raw = text(value).replace(/\s/g, '').replace(/\./g, '').replace(',', '.')
  if (!raw) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function isConfirmed(value: unknown): boolean {
  return ['si', 'sí', 'yes', 'true', '1', 'x', 'confirmado'].includes(normalize(value))
}

function formatFromHeaders(headers: string[]): ReplenishmentExcelFormat {
  const normalized = headers.map(normalize)
  const hasSalesMetrics = normalized.some(header =>
    header.includes('total vendido') || header.includes('promedio semanal') || header.includes('costo unitario') || header.startsWith('ventas bloque')
  )
  const hasAmount = normalized.some(header => header.includes('monto confirmado') || header.includes('monto estimado') || header.includes('monto conf'))
  if (hasSalesMetrics && hasAmount) return 'COMPLETA'
  if (hasSalesMetrics) return 'VENTAS'
  return 'COMPRA'
}

function readContext(workbook: XLSX.WorkBook): Map<string, string> {
  const contextSheet = workbook.Sheets.Contexto
  if (!contextSheet) return new Map()
  const rows = XLSX.utils.sheet_to_json<unknown[]>(contextSheet, { header: 1, defval: null, raw: true })
  const entries: Array<[string, string]> = []
  for (const row of rows) {
    const key = normalize(row[0])
    if (key) entries.push([key, text(row[1])])
  }
  return new Map(entries)
}

function readDetailSheet(workbook: XLSX.WorkBook): ParsedSheet {
  for (const sheetName of workbook.SheetNames) {
    if (normalize(sheetName) === 'contexto') continue
    const sheet = workbook.Sheets[sheetName]
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true })
    const headerRowIndex = rows.findIndex(row => {
      const headers = row.map(text)
      return headerIndex(headers, ['sku']) >= 0 && headerIndex(headers, ['producto', 'producto desc', 'producto descripcion']) >= 0
    })
    if (headerRowIndex < 0) continue
    return {
      headers: rows[headerRowIndex].map(text),
      values: rows.slice(headerRowIndex + 1),
      context: readContext(workbook),
    }
  }
  throw new Error('No se encontró una hoja de detalle con encabezados SKU y Producto.')
}

function providerFromRows(headers: string[], values: unknown[][], context: Map<string, string>): string {
  const contextProvider = context.get('proveedor') ?? ''
  const providerColumn = headerIndex(headers, ['proveedor', 'proveedor real'])
  const providers = providerColumn < 0 ? [] : Array.from(new Set(values.map(row => text(row[providerColumn])).filter(provider =>
    provider && !['sin proveedor', 'proveedor no resuelto'].includes(normalize(provider))
  )))
  if (providers.length > 1) return 'Proveedor por seleccionar'
  if (contextProvider && !['todos', 'todas', 'proveedor por seleccionar', 'proveedor no resuelto'].includes(normalize(contextProvider))) {
    return providers.length === 1 && normalize(providers[0]) !== normalize(contextProvider)
      ? 'Proveedor por seleccionar'
      : contextProvider
  }
  return providers.length === 1 ? providers[0] : 'Proveedor por seleccionar'
}

export async function parseReplenishmentExcel(file: File, catalog: PurchaseOrderCatalogProduct[]): Promise<ReplenishmentExcelImportPreview> {
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' })
  const detail = readDetailSheet(workbook)
  const format = formatFromHeaders(detail.headers)
  const skuColumn = headerIndex(detail.headers, ['sku'])
  const productColumn = headerIndex(detail.headers, ['producto', 'producto desc', 'producto descripcion'])
  const suggestedColumn = headerIndex(detail.headers, ['sugerido', 'cantidad sugerida'])
  const quantityColumn = headerIndex(detail.headers, ['cantidad confirmada', 'cantidad seleccionada', 'cantidad'])
  const confirmedColumn = headerIndex(detail.headers, ['confirmado', 'confirmacion'])
  if (skuColumn < 0 || productColumn < 0 || quantityColumn < 0) {
    throw new Error('El archivo debe contener encabezados SKU, Producto y Cantidad.')
  }

  const catalogBySku = new Map(catalog.map(product => [normalize(product.sku), product]))
  const rows = detail.values.filter(row => text(row[skuColumn]) && normalize(row[skuColumn]) !== 'totales')
  const skuCounts = new Map<string, number>()
  for (const row of rows) {
    const sku = normalize(row[skuColumn])
    skuCounts.set(sku, (skuCounts.get(sku) ?? 0) + 1)
  }

  const importedRows = rows.map((row, index): ReplenishmentExcelImportRow => {
    const sku = text(row[skuColumn])
    const product = text(row[productColumn])
    const quantity = numberValue(row[quantityColumn])
    const catalogProduct = catalogBySku.get(normalize(sku))
    const confirmed = confirmedColumn < 0 || isConfirmed(row[confirmedColumn])
    const suggested = suggestedColumn >= 0 ? numberValue(row[suggestedColumn]) : null
    void suggested

    if (!confirmed) return { rowNumber: index + 2, sku, product, quantity, productId: catalogProduct?.id ?? null, status: 'NO_CONFIRMADO', reason: 'La fila no está confirmada.' }
    if (quantity === null || quantity <= 0) return { rowNumber: index + 2, sku, product, quantity, productId: catalogProduct?.id ?? null, status: 'CANTIDAD_INVALIDA', reason: 'La cantidad debe ser mayor que 0.' }
    if ((skuCounts.get(normalize(sku)) ?? 0) > 1) return { rowNumber: index + 2, sku, product, quantity, productId: catalogProduct?.id ?? null, status: 'DUPLICADO', reason: 'El SKU aparece más de una vez en el archivo.' }
    if (!catalogProduct) return { rowNumber: index + 2, sku, product, quantity, productId: null, status: 'SKU_NO_ENCONTRADO', reason: 'El SKU no existe en el catálogo ERP.' }
    return { rowNumber: index + 2, sku, product: product || catalogProduct.description, quantity, productId: catalogProduct.id, status: 'VALIDO', reason: 'Línea candidata para OC.' }
  })

  return {
    fileName: file.name,
    format,
    provider: providerFromRows(detail.headers, rows, detail.context),
    totalRows: importedRows.length,
    validRows: importedRows.filter(row => row.status === 'VALIDO').length,
    ignoredRows: importedRows.filter(row => row.status === 'NO_CONFIRMADO').length,
    errorRows: importedRows.filter(row => !['VALIDO', 'NO_CONFIRMADO'].includes(row.status)).length,
    selectionBasis: confirmedColumn >= 0 ? 'CONFIRMADO_Y_CANTIDAD' : 'CANTIDAD',
    rows: importedRows,
  }
}
