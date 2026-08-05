import * as XLSX from 'xlsx'
import { normalizeHeader, FileParseError } from './excel-import'

export type CampaignImportScope = 'TOTAL_CAMPAIGN' | 'BY_SITE' | 'BY_LOCATION'

export const CAMPAIGN_SCOPES: CampaignImportScope[] = ['TOTAL_CAMPAIGN', 'BY_SITE', 'BY_LOCATION']

export interface CampaignImportRawRow {
  rowNumber: number
  values: Record<string, string>
}

export interface CampaignImportNormalizedRow {
  rowNumber: number
  sku: string
  enteredDescription: string | null
  enteredSiteCode: string | null
  enteredLocationCode: string | null
  theoreticalQuantity: number | null
  unitCost: number | null
  rawValues: Record<string, string>
}

export interface CampaignImportParseIssue {
  level: 'ERROR' | 'WARNING'
  code: string
  message: string
  rowNumber?: number
  rowNumbers?: number[]
}

export interface CampaignImportParseResult {
  scope: CampaignImportScope
  rows: CampaignImportNormalizedRow[]
  issues: CampaignImportParseIssue[]
}

const CAMPAIGN_HEADER_MAP: Record<string, string> = {
  sku: 'sku',
  codigo: 'sku',
  'codigo producto': 'sku',
  'codigo sku': 'sku',
  'cantidad teorica': 'quantity',
  'cantidad teoricas': 'quantity',
  cantidad_teorica: 'quantity',
  cantidad: 'quantity',
  'stock teorico': 'quantity',
  'costo unitario': 'cost',
  costo_unitario: 'cost',
  costo: 'cost',
  'costo unitario clp': 'cost',
  'precio costo': 'cost',
  descripcion: 'description',
  description: 'description',
  'codigo unidad': 'site_code',
  codigo_unidad: 'site_code',
  'codigo ubicacion': 'location_code',
  'codigo de ubicacion': 'location_code',
  codigo_ubicacion: 'location_code',
}

const SCOPE_REQUIRED_FIELDS: Record<CampaignImportScope, string[]> = {
  TOTAL_CAMPAIGN: ['sku', 'quantity', 'cost'],
  BY_SITE: ['sku', 'site_code', 'quantity', 'cost'],
  BY_LOCATION: ['sku', 'site_code', 'location_code', 'quantity', 'cost'],
}

const SCOPE_CANONICAL_HEADERS: Record<string, string> = {
  sku: 'SKU',
  site_code: 'CODIGO_UNIDAD',
  location_code: 'CODIGO_UBICACION',
  quantity: 'CANTIDAD_TEORICA',
  cost: 'COSTO_UNITARIO',
}

const NUMERIC_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

interface ParsedCell {
  value: string
  isFormula: boolean
}

function cellToString(cell: XLSX.CellObject | undefined): ParsedCell {
  if (!cell) return { value: '', isFormula: false }
  if (cell.f) return { value: cell.v != null ? String(cell.v) : '', isFormula: true }
  if (cell.v == null) return { value: '', isFormula: false }
  return { value: String(cell.v).trim(), isFormula: false }
}

function parseNumeric(text: string): { value: number | null; scale: number } {
  if (!NUMERIC_PATTERN.test(text)) return { value: null, scale: 0 }
  const value = Number(text)
  if (!Number.isFinite(value)) return { value: null, scale: 0 }
  let scale = 0
  const decimal = /\.(\d+)/.exec(text)
  if (decimal) scale = decimal[1].length
  return { value, scale }
}

function duplicateKey(
  scope: CampaignImportScope,
  row: Pick<CampaignImportNormalizedRow, 'sku' | 'enteredSiteCode' | 'enteredLocationCode'>,
): string {
  if (scope === 'BY_LOCATION') {
    return [row.sku, row.enteredSiteCode ?? '', row.enteredLocationCode ?? ''].join('\u0001')
  }
  if (scope === 'BY_SITE') {
    return [row.sku, row.enteredSiteCode ?? ''].join('\u0001')
  }
  return row.sku
}

export function parseCampaignImportBuffer(
  buffer: ArrayBuffer,
  scope: CampaignImportScope,
): CampaignImportParseResult {
  const normalizedScope = scope.trim().toUpperCase()
  if (!CAMPAIGN_SCOPES.includes(normalizedScope as CampaignImportScope)) {
    throw new FileParseError('INVALID_SCOPE', 'El alcance de importacion no es valido.')
  }
  const targetScope = normalizedScope as CampaignImportScope

  const wb = XLSX.read(buffer, { type: 'array', cellFormula: true })

  if (wb.SheetNames.length === 0) {
    throw new FileParseError('FILE_DATA_SHEET_MISSING', 'El archivo no contiene hojas de datos.')
  }

  let target: XLSX.WorkSheet
  if (wb.SheetNames.length === 1) {
    target = wb.Sheets[wb.SheetNames[0]]
  } else {
    const sheetName = wb.SheetNames.find(n => normalizeHeader(n) === 'datos')
    if (!sheetName) {
      throw new FileParseError('FILE_DATA_SHEET_MISSING', 'El archivo no contiene la hoja "Datos".')
    }
    target = wb.Sheets[sheetName]
  }

  return parseCampaignSheet(target, targetScope)
}

function parseCampaignSheet(ws: XLSX.WorkSheet, scope: CampaignImportScope): CampaignImportParseResult {
  const rows: CampaignImportNormalizedRow[] = []
  const issues: CampaignImportParseIssue[] = []

  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1')
  const headerRow = range.s.r
  const firstDataRow = headerRow + 1

  const colMap: Record<string, { col: number; field: string }> = {}
  const extraHeaders: string[] = []

  for (let c = range.s.c; c <= range.e.c; c++) {
    const addr = XLSX.utils.encode_cell({ r: headerRow, c })
    const cell = ws[addr]
    const raw = cell && cell.t === 's' ? String(cell.v ?? '') : cell && cell.v != null ? String(cell.v) : ''
    const norm = normalizeHeader(raw)
    if (!norm) continue
    const field = CAMPAIGN_HEADER_MAP[norm]
    if (field) {
      colMap[field] = { col: c, field }
    } else {
      extraHeaders.push(raw.trim())
    }
  }

  const missing = SCOPE_REQUIRED_FIELDS[scope].filter(f => !colMap[f])
  if (missing.length > 0) {
    for (const field of missing) {
      issues.push({
        level: 'ERROR',
        code: 'FILE_HEADER_MISSING',
        message: `Falta la columna obligatoria "${SCOPE_CANONICAL_HEADERS[field]}".`,
      })
    }
    return { scope, rows: [], issues }
  }

  if (extraHeaders.length > 0) {
    issues.push({
      level: 'WARNING',
      code: 'FILE_EXTRA_COLUMN',
      message: `El archivo contiene columnas adicionales que no participan en la importacion: ${extraHeaders
        .map(h => `"${h}"`)
        .join(', ')}.`,
    })
  }

  const seenKeys = new Map<string, number>()
  const seenCostBySku = new Map<string, { cost: number; rowNumber: number }>()

  for (let r = firstDataRow; r <= range.e.r; r++) {
    const get = (field: string): ParsedCell => {
      const entry = colMap[field]
      if (!entry) return { value: '', isFormula: false }
      const addr = XLSX.utils.encode_cell({ r, c: entry.col })
      return cellToString(ws[addr])
    }

    const rawValues: Record<string, string> = {}
    const descriptionEntry = colMap.description
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c })
      const cell = ws[addr]
      const raw = cell && cell.t === 's' ? String(cell.v ?? '') : cell && cell.v != null ? String(cell.v) : ''
      const header = XLSX.utils.encode_col(c)
      if (raw.trim() !== '') rawValues[header] = raw
      if (descriptionEntry && descriptionEntry.col === c && raw.trim() !== '') rawValues.DESCRIPCION = raw.trim()
    }

    const skuCell = get('sku')
    const descriptionCell = get('description')
    const siteCell = get('site_code')
    const locationCell = get('location_code')
    const qtyCell = get('quantity')
    const costCell = get('cost')

    if (
      !skuCell.value &&
      !siteCell.value &&
      !locationCell.value &&
      !qtyCell.value &&
      !costCell.value &&
      Object.keys(rawValues).length === 0
    ) {
      continue
    }

    const rowNumber = r + 1
    const sku = skuCell.value
    const enteredDescription = descriptionCell.value ? descriptionCell.value.trim() || null : null
    const enteredSiteCode = siteCell.value || null
    const enteredLocationCode = locationCell.value || null

    let theoreticalQuantity: number | null = null
    let unitCost: number | null = null

    if (qtyCell.isFormula) {
      issues.push({
        level: 'ERROR',
        code: 'FORMULA_NOT_ALLOWED',
        message: 'La celda de cantidad contiene una formula no permitida.',
        rowNumber,
      })
    } else if (!qtyCell.value) {
      issues.push({
        level: 'ERROR',
        code: 'MISSING_QUANTITY',
        message: 'La cantidad teorica es obligatoria.',
        rowNumber,
      })
    } else {
      const parsed = parseNumeric(qtyCell.value)
      if (parsed.value == null) {
        issues.push({
          level: 'ERROR',
          code: 'INVALID_QUANTITY',
          message: 'La cantidad no es un valor numerico valido.',
          rowNumber,
        })
      } else if (parsed.value < 0) {
        issues.push({
          level: 'ERROR',
          code: 'NEGATIVE_QUANTITY',
          message: 'La cantidad no puede ser negativa.',
          rowNumber,
        })
      } else if (parsed.scale > 3) {
        issues.push({
          level: 'ERROR',
          code: 'QUANTITY_SCALE_EXCEEDED',
          message: 'La cantidad no puede tener mas de 3 decimales.',
          rowNumber,
        })
      } else {
        theoreticalQuantity = parsed.value
      }
    }

    if (costCell.isFormula) {
      issues.push({
        level: 'ERROR',
        code: 'FORMULA_NOT_ALLOWED',
        message: 'La celda de costo contiene una formula no permitida.',
        rowNumber,
      })
    } else if (!costCell.value) {
      issues.push({
        level: 'WARNING',
        code: 'MISSING_COST',
        message: 'El costo unitario no fue informado.',
        rowNumber,
      })
    } else {
      const parsed = parseNumeric(costCell.value)
      if (parsed.value == null) {
        issues.push({
          level: 'ERROR',
          code: 'INVALID_COST',
          message: 'El costo unitario no es un valor numerico valido.',
          rowNumber,
        })
      } else if (parsed.value < 0) {
        issues.push({
          level: 'ERROR',
          code: 'INVALID_COST',
          message: 'El costo unitario no puede ser negativo.',
          rowNumber,
        })
      } else if (parsed.scale > 2) {
        issues.push({
          level: 'ERROR',
          code: 'INVALID_COST',
          message: 'El costo unitario no puede tener mas de 2 decimales.',
          rowNumber,
        })
      } else if (parsed.value === 0) {
        issues.push({
          level: 'WARNING',
          code: 'ZERO_COST',
          message: 'El costo unitario es cero.',
          rowNumber,
        })
      } else {
        unitCost = parsed.value
      }
    }

    if (!sku) {
      issues.push({
        level: 'ERROR',
        code: 'FILE_ROW_SKU_REQUIRED',
        message: 'El SKU es obligatorio.',
        rowNumber,
      })
    }
    if ((scope === 'BY_SITE' || scope === 'BY_LOCATION') && !enteredSiteCode) {
      issues.push({
        level: 'ERROR',
        code: 'FILE_ROW_SITE_REQUIRED',
        message: 'El codigo de unidad es obligatorio.',
        rowNumber,
      })
    }
    if (scope === 'BY_LOCATION' && !enteredLocationCode) {
      issues.push({
        level: 'ERROR',
        code: 'FILE_ROW_LOCATION_REQUIRED',
        message: 'El codigo de ubicacion es obligatorio.',
        rowNumber,
      })
    }

    const normalizedRow: CampaignImportNormalizedRow = {
      rowNumber,
      sku,
      enteredDescription,
      enteredSiteCode,
      enteredLocationCode,
      theoreticalQuantity,
      unitCost,
      rawValues,
    }

    const key = duplicateKey(scope, normalizedRow)
    const firstRow = seenKeys.get(key)
    if (firstRow != null) {
      issues.push({
        level: 'ERROR',
        code: 'FILE_ROW_DUPLICATE',
        message: 'El archivo contiene filas duplicadas para la misma clave de alcance.',
        rowNumber,
        rowNumbers: [firstRow, rowNumber],
      })
    } else {
      seenKeys.set(key, rowNumber)
    }

    if (sku && unitCost != null) {
      const prev = seenCostBySku.get(sku)
      if (prev && prev.cost !== unitCost) {
        issues.push({
          level: 'ERROR',
          code: 'INCONSISTENT_COST',
          message: 'El SKU mantiene costos distintos entre ubicaciones.',
          rowNumber,
          rowNumbers: [prev.rowNumber, rowNumber],
        })
      } else if (!prev) {
        seenCostBySku.set(sku, { cost: unitCost, rowNumber })
      }
    }

    rows.push(normalizedRow)
  }

  if (rows.length === 0) {
    issues.push({
      level: 'ERROR',
      code: 'FILE_NO_USEFUL_ROWS',
      message: 'El archivo no contiene filas utiles.',
    })
  }

  return { scope, rows, issues }
}
