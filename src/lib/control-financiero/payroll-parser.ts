import { createHash } from 'node:crypto'

export type PayrollEncoding = 'UTF-8' | 'ISO-8859-1'

type NumericValue = number | null

export type PayrollParsedRow = {
  sourceRowNumber: number
  workerRutOriginal: string
  workerRutNormalized: string | null
  contractStartDate: string | null
  contractEndDate: string | null
  daysWorked: NumericValue
  medicalLeaveDays: NumericValue
  vacationDays: NumericValue
  salary: NumericValue
  gratification: NumericValue
  businessSalary: NumericValue
  mealAllowance: NumericValue
  transportAllowance: NumericValue
  travelAllowance: NumericValue
  familyAllowance: NumericValue
  holidayIndemnity: NumericValue
  workerPension: NumericValue
  workerHealth: NumericValue
  workerAfc: NumericValue
  incomeTax: NumericValue
  advances: NumericValue
  employerAfc: NumericValue
  employerAccidentSanna: NumericValue
  employerSis: NumericValue
  totalEarnings: NumericValue
  taxableEarnings: NumericValue
  nonTaxableEarnings: NumericValue
  nonTaxableTaxableEarnings: NumericValue
  totalDeductions: NumericValue
  totalWorkerContributions: NumericValue
  totalIncomeTax: NumericValue
  totalOtherDeductions: NumericValue
  totalEmployerContributions: NumericValue
  netPay: NumericValue
  totalIndemnities: NumericValue
  taxableIndemnities: NumericValue
  nonTaxableIndemnities: NumericValue
  rawValues: Record<string, string>
  rawValuesByCode: Record<string, string>
}

export type PayrollParsedFile = {
  filename: string
  hash: string
  encoding: PayrollEncoding
  headers: string[]
  rows: PayrollParsedRow[]
  detectedMonth: number | null
}

export type PayrollPreview = {
  file: {
    filename: string
    hash: string
    encoding: PayrollEncoding
    rowCount: number
    detectedMonth: number | null
    selectedYear: number | null
  }
  structure: {
    recognized: boolean
    headersCount: number
    missingRequiredColumns: string[]
    extraColumns: string[]
  }
  workers: {
    workerCount: number
    invalidRutCount: number
    missingRutCount: number
    duplicateRutCount: number
  }
  totals: {
    totalSalary: number
    totalTaxableEarnings: number
    totalNonTaxableEarnings: number
    totalEarnings: number
    totalDeductions: number
    totalWorkerContributions: number
    totalEmployerContributions: number
    totalNetPay: number
    totalIndemnities: number
    totalLaborCost: number
    recurringLaborCost: number
  }
  validation: {
    errors: string[]
    warnings: string[]
    canImport: boolean
  }
  parsedFile: PayrollParsedFile
}

const MONTHS: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
}

const COLUMN_CODES = {
  rut: '1101',
  contractStart: '1102',
  contractEnd: '1103',
  daysWorked: '1115',
  medicalLeaveDays: '1116',
  vacationDays: '1117',
  salary: '2101',
  gratification: '2106',
  businessSalary: '2161',
  mealAllowance: '2301',
  transportAllowance: '2302',
  travelAllowance: '2303',
  familyAllowance: '2311',
  holidayIndemnity: '2313',
  workerPension: '3141',
  workerHealth: '3143',
  workerAfc: '3151',
  incomeTax: '3161',
  advances: '3188',
  employerAfc: '4151',
  employerAccidentSanna: '4152',
  employerSis: '4155',
  totalEarnings: '5201',
  taxableEarnings: '5210',
  nonTaxableEarnings: '5230',
  nonTaxableTaxableEarnings: '5240',
  totalDeductions: '5301',
  totalWorkerContributions: '5341',
  totalIncomeTax: '5361',
  totalOtherDeductions: '5302',
  totalEmployerContributions: '5410',
  netPay: '5501',
  totalIndemnities: '5502',
  taxableIndemnities: '5564',
  nonTaxableIndemnities: '5565',
} as const

const REQUIRED_CODES = Object.values(COLUMN_CODES)

function columnCode(header: string): string | null {
  return header.match(/\((\d+)\)\s*$/)?.[1] ?? null
}

function toBytes(input: Uint8Array | string): Uint8Array {
  return typeof input === 'string' ? new TextEncoder().encode(input) : input
}

function decodeInput(input: Uint8Array | string): { bytes: Uint8Array; text: string; encoding: PayrollEncoding } {
  const bytes = toBytes(input)
  if (typeof input === 'string') return { bytes, text: input.replace(/^\uFEFF/, ''), encoding: 'UTF-8' }

  const utf8 = new TextDecoder('utf-8', { fatal: true })
  try {
    return { bytes, text: utf8.decode(bytes).replace(/^\uFEFF/, ''), encoding: 'UTF-8' }
  } catch {
    return { bytes, text: new TextDecoder('iso-8859-1').decode(bytes), encoding: 'ISO-8859-1' }
  }
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const delimiter = firstLine.includes(';') ? ';' : ','
  let row: string[] = []
  let cell = ''
  let quoted = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"'
        i += 1
      } else if (char === '"') {
        quoted = false
      } else {
        cell += char
      }
    } else if (char === '"' && cell.length === 0) {
      quoted = true
    } else if (char === delimiter) {
      row.push(cell)
      cell = ''
    } else if (char === '\n') {
      row.push(cell.replace(/\r$/, ''))
      if (row.some(value => value.trim() !== '')) rows.push(row)
      row = []
      cell = ''
    } else {
      cell += char
    }
  }

  if (quoted) throw new Error('CSV inválido: comillas sin cerrar.')
  if (cell !== '' || row.length) {
    row.push(cell.replace(/\r$/, ''))
    if (row.some(value => value.trim() !== '')) rows.push(row)
  }
  return rows
}

function parseAmount(value: string): NumericValue {
  const trimmed = value.trim()
  if (!trimmed) return null
  const compact = trimmed.replace(/\s/g, '').replace(/\./g, '').replace(',', '.')
  const amount = Number(compact)
  if (!Number.isFinite(amount) || !Number.isInteger(amount)) throw new Error(`Importe inválido: ${value}`)
  return amount
}

function parseDate(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const match = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (!match) return trimmed
  const year = match[3].length === 2 ? `20${match[3]}` : match[3]
  return `${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`
}

export function normalizeRut(value: string): string | null {
  const compact = value.trim().toUpperCase().replace(/[.\s-]/g, '')
  if (!compact) return null
  if (!/^\d{7,8}[0-9K]$/.test(compact)) return null
  return `${compact.slice(0, -1)}-${compact.slice(-1)}`
}

export function isValidRut(value: string): boolean {
  const normalized = normalizeRut(value)
  if (!normalized) return false
  const [body, checkDigit] = normalized.split('-')
  let multiplier = 2
  let sum = 0
  for (let i = body.length - 1; i >= 0; i -= 1) {
    sum += Number(body[i]) * multiplier
    multiplier = multiplier === 7 ? 2 : multiplier + 1
  }
  const remainder = 11 - (sum % 11)
  const expected = remainder === 11 ? '0' : remainder === 10 ? 'K' : String(remainder)
  return checkDigit === expected
}

function detectedMonth(filename: string): number | null {
  const stem = filename.replace(/\.[^.]+$/, '').toLowerCase().trim()
  return MONTHS[stem] ?? null
}

function amount(row: string[], index: number | undefined): NumericValue {
  return parseAmount(index === undefined ? '' : row[index] ?? '')
}

function valueOrZero(value: NumericValue): number {
  return value ?? 0
}

function sum(rows: PayrollParsedRow[], field: keyof PayrollParsedRow): number {
  return rows.reduce((total, row) => total + valueOrZero(row[field] as NumericValue), 0)
}

function buildRow(row: string[], headers: string[], codeIndexes: Map<string, number>, sourceRowNumber: number): PayrollParsedRow {
  const rawValues = Object.fromEntries(headers.map((header, index) => [header, row[index] ?? '']))
  const rawValuesByCode = Object.fromEntries(headers.map((header, index) => {
    const code = columnCode(header)
    return [code ?? `column_${index + 1}`, row[index] ?? '']
  }))
  const get = (code: string) => codeIndexes.get(code)
  const originalRut = row[get(COLUMN_CODES.rut) ?? 0] ?? ''

  return {
    sourceRowNumber,
    workerRutOriginal: originalRut,
    workerRutNormalized: normalizeRut(originalRut),
    contractStartDate: parseDate(row[get(COLUMN_CODES.contractStart) ?? 0] ?? ''),
    contractEndDate: parseDate(row[get(COLUMN_CODES.contractEnd) ?? 0] ?? ''),
    daysWorked: amount(row, get(COLUMN_CODES.daysWorked)),
    medicalLeaveDays: amount(row, get(COLUMN_CODES.medicalLeaveDays)),
    vacationDays: amount(row, get(COLUMN_CODES.vacationDays)),
    salary: amount(row, get(COLUMN_CODES.salary)),
    gratification: amount(row, get(COLUMN_CODES.gratification)),
    businessSalary: amount(row, get(COLUMN_CODES.businessSalary)),
    mealAllowance: amount(row, get(COLUMN_CODES.mealAllowance)),
    transportAllowance: amount(row, get(COLUMN_CODES.transportAllowance)),
    travelAllowance: amount(row, get(COLUMN_CODES.travelAllowance)),
    familyAllowance: amount(row, get(COLUMN_CODES.familyAllowance)),
    holidayIndemnity: amount(row, get(COLUMN_CODES.holidayIndemnity)),
    workerPension: amount(row, get(COLUMN_CODES.workerPension)),
    workerHealth: amount(row, get(COLUMN_CODES.workerHealth)),
    workerAfc: amount(row, get(COLUMN_CODES.workerAfc)),
    incomeTax: amount(row, get(COLUMN_CODES.incomeTax)),
    advances: amount(row, get(COLUMN_CODES.advances)),
    employerAfc: amount(row, get(COLUMN_CODES.employerAfc)),
    employerAccidentSanna: amount(row, get(COLUMN_CODES.employerAccidentSanna)),
    employerSis: amount(row, get(COLUMN_CODES.employerSis)),
    totalEarnings: amount(row, get(COLUMN_CODES.totalEarnings)),
    taxableEarnings: amount(row, get(COLUMN_CODES.taxableEarnings)),
    nonTaxableEarnings: amount(row, get(COLUMN_CODES.nonTaxableEarnings)),
    nonTaxableTaxableEarnings: amount(row, get(COLUMN_CODES.nonTaxableTaxableEarnings)),
    totalDeductions: amount(row, get(COLUMN_CODES.totalDeductions)),
    totalWorkerContributions: amount(row, get(COLUMN_CODES.totalWorkerContributions)),
    totalIncomeTax: amount(row, get(COLUMN_CODES.totalIncomeTax)),
    totalOtherDeductions: amount(row, get(COLUMN_CODES.totalOtherDeductions)),
    totalEmployerContributions: amount(row, get(COLUMN_CODES.totalEmployerContributions)),
    netPay: amount(row, get(COLUMN_CODES.netPay)),
    totalIndemnities: amount(row, get(COLUMN_CODES.totalIndemnities)),
    taxableIndemnities: amount(row, get(COLUMN_CODES.taxableIndemnities)),
    nonTaxableIndemnities: amount(row, get(COLUMN_CODES.nonTaxableIndemnities)),
    rawValues,
    rawValuesByCode,
  }
}

function validateRows(rows: PayrollParsedRow[], errors: string[], warnings: string[]): void {
  rows.forEach(row => {
    if (!row.workerRutNormalized || !isValidRut(row.workerRutOriginal)) errors.push(`Fila ${row.sourceRowNumber}: RUT inválido o faltante.`)
    const netExpected = valueOrZero(row.totalEarnings) - valueOrZero(row.totalDeductions)
    if (row.netPay !== null && row.totalEarnings !== null && row.totalDeductions !== null && row.netPay !== netExpected) {
      warnings.push(`Fila ${row.sourceRowNumber}: líquido no reconcilia con haberes menos descuentos.`)
    }
    const earningsSubtotal = valueOrZero(row.taxableEarnings) + valueOrZero(row.nonTaxableEarnings) + valueOrZero(row.nonTaxableTaxableEarnings)
    if (row.totalEarnings !== null && row.taxableEarnings !== null && row.nonTaxableEarnings !== null && row.nonTaxableTaxableEarnings !== null && row.totalEarnings !== earningsSubtotal) {
      warnings.push(`Fila ${row.sourceRowNumber}: subtotales de haberes no reconcilian con total haberes.`)
    }
    const deductionsSubtotal = valueOrZero(row.totalWorkerContributions) + valueOrZero(row.totalIncomeTax) + valueOrZero(row.totalOtherDeductions)
    if (row.totalDeductions !== null && row.totalWorkerContributions !== null && row.totalIncomeTax !== null && row.totalOtherDeductions !== null && row.totalDeductions !== deductionsSubtotal) {
      warnings.push(`Fila ${row.sourceRowNumber}: subtotales de descuentos no reconcilian con total descuentos.`)
    }
  })
}

export function parsePayrollCsv(input: Uint8Array | string, filename: string): PayrollParsedFile {
  const decoded = decodeInput(input)
  const rows = parseCsv(decoded.text)
  if (rows.length < 2) throw new Error('El CSV no contiene encabezado y filas de datos.')

  const originalHeaders = rows[0].map(header => header.trim())
  const dataRows = rows.slice(1)
  const trailingColumnIsEmpty = originalHeaders.at(-1) === '' && dataRows.every(row => (row.at(-1) ?? '').trim() === '')
  const headers = trailingColumnIsEmpty ? originalHeaders.slice(0, -1) : originalHeaders
  const normalizedRows = dataRows.map(row => trailingColumnIsEmpty ? row.slice(0, -1) : row)
  const codeIndexes = new Map<string, number>()
  headers.forEach((header, index) => {
    const code = columnCode(header)
    if (code) codeIndexes.set(code, index)
  })
  const parsedRows = normalizedRows.map((row, index) => buildRow(row, headers, codeIndexes, index + 2))

  return {
    filename,
    hash: createHash('sha256').update(decoded.bytes).digest('hex'),
    encoding: decoded.encoding,
    headers,
    rows: parsedRows,
    detectedMonth: detectedMonth(filename),
  }
}

export function buildPayrollPreview(input: Uint8Array | string, options: { filename: string; selectedYear?: number }): PayrollPreview {
  const parsedFile = parsePayrollCsv(input, options.filename)
  const presentCodes = new Set(parsedFile.headers.map(columnCode).filter((code): code is string => Boolean(code)))
  const requiredCodeSet = new Set<string>(REQUIRED_CODES)
  const missingRequiredColumns = REQUIRED_CODES.filter(code => !presentCodes.has(code))
  const extraColumns = parsedFile.headers.filter(header => {
    const code = columnCode(header)
    return code !== null && !requiredCodeSet.has(code)
  })
  const errors: string[] = missingRequiredColumns.length
    ? [`Faltan columnas requeridas: ${missingRequiredColumns.join(', ')}.`]
    : []
  const warnings: string[] = []
  validateRows(parsedFile.rows, errors, warnings)

  const rutCounts = new Map<string, number>()
  parsedFile.rows.forEach(row => {
    if (row.workerRutNormalized) rutCounts.set(row.workerRutNormalized, (rutCounts.get(row.workerRutNormalized) ?? 0) + 1)
  })
  const duplicateRutCount = [...rutCounts.values()].filter(count => count > 1).reduce((total, count) => total + count - 1, 0)
  const invalidRutCount = parsedFile.rows.filter(row => row.workerRutOriginal.trim() !== '' && !isValidRut(row.workerRutOriginal)).length
  const missingRutCount = parsedFile.rows.filter(row => row.workerRutOriginal.trim() === '').length
  const totalEarnings = sum(parsedFile.rows, 'totalEarnings')
  const totalIndemnities = sum(parsedFile.rows, 'totalIndemnities')
  const totalEmployerContributions = sum(parsedFile.rows, 'totalEmployerContributions')

  return {
    file: {
      filename: parsedFile.filename,
      hash: parsedFile.hash,
      encoding: parsedFile.encoding,
      rowCount: parsedFile.rows.length,
      detectedMonth: parsedFile.detectedMonth,
      selectedYear: options.selectedYear ?? null,
    },
    structure: {
      recognized: missingRequiredColumns.length === 0,
      headersCount: parsedFile.headers.length,
      missingRequiredColumns,
      extraColumns,
    },
    workers: {
      workerCount: new Set(parsedFile.rows.map(row => row.workerRutNormalized).filter(Boolean)).size,
      invalidRutCount,
      missingRutCount,
      duplicateRutCount,
    },
    totals: {
      totalSalary: sum(parsedFile.rows, 'salary'),
      totalTaxableEarnings: sum(parsedFile.rows, 'taxableEarnings'),
      totalNonTaxableEarnings: sum(parsedFile.rows, 'nonTaxableEarnings') + sum(parsedFile.rows, 'nonTaxableTaxableEarnings'),
      totalEarnings,
      totalDeductions: sum(parsedFile.rows, 'totalDeductions'),
      totalWorkerContributions: sum(parsedFile.rows, 'totalWorkerContributions'),
      totalEmployerContributions,
      totalNetPay: sum(parsedFile.rows, 'netPay'),
      totalIndemnities,
      totalLaborCost: totalEarnings + totalEmployerContributions,
      recurringLaborCost: totalEarnings - totalIndemnities + totalEmployerContributions,
    },
    validation: {
      errors,
      warnings,
      canImport: Boolean(options.selectedYear) && errors.length === 0,
    },
    parsedFile,
  }
}
