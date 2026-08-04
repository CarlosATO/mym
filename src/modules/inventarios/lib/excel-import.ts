import * as XLSX from 'xlsx'
import { createHash } from 'crypto'

export const IMPORT_BUCKET = 'inventario-imports'
export const IMPORT_MAX_SIZE = 20 * 1024 * 1024
export const IMPORT_MAX_ROWS = 200000

export const IMPORT_ALLOWED_MIME = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'application/csv',
]

export const IMPORT_ALLOWED_EXT = ['xlsx', 'xls', 'csv']

export interface ParsedImportCell {
  value: string
  isFormula: boolean
}

export interface ParsedImportRow {
  row_index: number
  sku: string
  barcode: string
  entered_name: string
  location_code: string
  quantity: string
  cost: string
  formula_fields: string[]
}

export interface FileIssue {
  level: 'ERROR' | 'WARNING'
  code: string
  message: string
}

export interface ParsedImportResult {
  rows: ParsedImportRow[]
  file_issues: FileIssue[]
}

export function normalizeHeader(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
}

export function safeFileName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 120)
}

export function computeSha256(buffer: Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex')
}

export function detectExtension(filename: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(filename || '')
  return m ? m[1].toLowerCase() : ''
}

export function isAllowedMime(mime: string | null, filename: string): boolean {
  if (!mime) return false
  if ((IMPORT_ALLOWED_MIME as readonly string[]).includes(mime)) return true
  const ext = detectExtension(filename)
  return (IMPORT_ALLOWED_EXT as readonly string[]).includes(ext) && mime === 'application/octet-stream'
}

const HEADER_MAP: Record<string, string> = {
  sku: 'sku',
  codigo: 'sku',
  'codigo producto': 'sku',
  'codigo sku': 'sku',
  'codigo de barras': 'barcode',
  'codigo barra': 'barcode',
  barcode: 'barcode',
  'codigo de barra': 'barcode',
  'nombre producto': 'entered_name',
  'nombre del producto': 'entered_name',
  nombre: 'entered_name',
  'descripcion producto': 'entered_name',
  descripcion: 'entered_name',
  'codigo ubicacion': 'location_code',
  'codigo de ubicacion': 'location_code',
  ubicacion: 'location_code',
  localizacion: 'location_code',
  'cantidad teorica': 'quantity',
  'cantidad teoricas': 'quantity',
  cantidad: 'quantity',
  'stock teorico': 'quantity',
  'costo unitario': 'cost',
  costo: 'cost',
  'costo unitario clp': 'cost',
  'precio costo': 'cost',
}

function cellToString(cell: XLSX.CellObject | undefined): { value: string; isFormula: boolean } {
  if (!cell) return { value: '', isFormula: false }
  if (cell.f) return { value: cell.v != null ? String(cell.v) : '', isFormula: true }
  if (cell.v == null) return { value: '', isFormula: false }
  return { value: String(cell.v).trim(), isFormula: false }
}

function sheetToRows(ws: XLSX.WorkSheet): { rows: ParsedImportRow[]; file_issues: FileIssue[] } {
  const rows: ParsedImportRow[] = []
  const file_issues: FileIssue[] = []

  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1')
  const headerRow = range.s.r
  const firstDataRow = headerRow + 1

  const colMap: Record<string, { col: number; field: string }> = {}
  const unknownCols: string[] = []

  for (let c = range.s.c; c <= range.e.c; c++) {
    const addr = XLSX.utils.encode_cell({ r: headerRow, c })
    const cell = ws[addr]
    const raw = cell && cell.t === 's' ? String(cell.v ?? '') : cell && cell.v != null ? String(cell.v) : ''
    const norm = normalizeHeader(raw)
    if (!norm) continue
    const field = HEADER_MAP[norm]
    if (field) {
      colMap[field] = { col: c, field }
    } else {
      unknownCols.push(raw)
    }
  }

  for (const u of unknownCols) {
    file_issues.push({ level: 'WARNING', code: 'FILE_UNKNOWN_COLUMN', message: `Columna no reconocida: "${u}".` })
  }

  for (let r = firstDataRow; r <= range.e.r; r++) {
    const get = (field: string): ParsedImportCell => {
      const entry = colMap[field]
      if (!entry) return { value: '', isFormula: false }
      const addr = XLSX.utils.encode_cell({ r, c: entry.col })
      return cellToString(ws[addr])
    }

    const sku = get('sku')
    const barcode = get('barcode')
    const name = get('entered_name')
    const loc = get('location_code')
    const qty = get('quantity')
    const cost = get('cost')

    const isEmpty =
      !sku.value && !barcode.value && !name.value && !loc.value && !qty.value && !cost.value

    if (isEmpty) continue

    const formula_fields: string[] = []
    if (sku.isFormula) formula_fields.push('sku')
    if (qty.isFormula) formula_fields.push('quantity')
    if (cost.isFormula) formula_fields.push('cost')
    if (loc.isFormula) formula_fields.push('location_code')

    rows.push({
      row_index: r + 1,
      sku: sku.value,
      barcode: barcode.value,
      entered_name: name.value,
      location_code: loc.value,
      quantity: qty.value,
      cost: cost.value,
      formula_fields,
    })
  }

  return { rows, file_issues }
}

export function parseImportBuffer(buffer: ArrayBuffer): ParsedImportResult {
  const wb = XLSX.read(buffer, { type: 'array', cellFormula: true })

  if (wb.SheetNames.length === 0) {
    throw new FileParseError('FILE_DATA_SHEET_MISSING', 'El archivo no contiene hojas de datos.')
  }

  let target: XLSX.WorkSheet | null = null
  if (wb.SheetNames.length === 1) {
    // CSV: tabla única
    target = wb.Sheets[wb.SheetNames[0]]
  } else {
    const sheetName = wb.SheetNames.find(n => normalizeHeader(n) === 'datos')
    if (!sheetName) {
      throw new FileParseError('FILE_DATA_SHEET_MISSING', 'El archivo no contiene la hoja "Datos".')
    }
    target = wb.Sheets[sheetName]
  }

  const { rows, file_issues } = sheetToRows(target)
  return { rows, file_issues }
}

export class FileParseError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export interface ImportIssueCsvRow {
  row_index: number
  sku: string
  location_code: string | null
  level: string
  code: string
  message: string
}

export function buildImportIssuesCsv(issues: ImportIssueCsvRow[]): string {
  const escape = (v: string | null | undefined): string => {
    const s = v ?? ''
    return `"${s.replace(/"/g, '""')}"`
  }
  const header = 'Fila,SKU,Ubicación,Nivel,Código,Mensaje'
  const lines = issues.map(i =>
    [String(i.row_index), i.sku, i.location_code ?? '', i.level, i.code, i.message].map(escape).join(',')
  )
  return [header, ...lines].join('\n')
}
