import * as XLSX from 'xlsx'
import { PDFParse } from 'pdf-parse'
import { getData } from 'pdf-parse/worker'

PDFParse.setWorker(getData())

export type ParsedBankMovement = {
  date: string
  description: string
  credit: number
  debit: number
  balance: number
  documentNumber: string | null
  transactionNumber: string | null
  cashier: string | null
  branch: string | null
  sourceRowNumber: number
  sequenceNumber: number
  raw: Record<string, string>
}

export type ParsedBankStatement = {
  accountNumber: string | null
  accountHolder: string | null
  bankName: string | null
  currency: 'CLP'
  year: number
  month: number
  order: 'ASC' | 'DESC'
  openingBalance: number
  totalCredits: number
  totalDebits: number
  closingBalance: number
  firstTransactionDate: string
  lastTransactionDate: string
  rowCount: number
  movements: ParsedBankMovement[]
  validations: {
    globalDifference: number
    rowDifference: number
    rowDifferenceCount: number
    rowDifferenceTotal: number
    rowBalanceValidated: boolean
  }
  sourceFormat: 'HISTORICAL_SEMICOLON' | 'CURRENT_XLS' | 'ITAU_PDF'
  creditLineTotal?: number | null
  creditLineUsed?: number | null
  creditLineAvailable?: number | null
}

const headers = ['date', 'description', 'debit', 'credit', 'balance', 'documentNumber', 'transactionNumber', 'cashier', 'branch']

function parseAmount(value: string): number {
  const compact = value
    .trim()
    .replace(/[$()]/g, '')
    .replace(/\s/g, '')
    .replace(/\./g, '')
    .replace(',', '.')
  if (!compact || compact === '-' || /^[-+]?0+(?:[,.]0+)?$/.test(compact)) return 0
  const amount = Number(compact.replace(/^[+]/, ''))
  if (!Number.isFinite(amount)) throw new Error(`Monto inválido: ${value}`)
  return Math.abs(Math.round(amount))
}

function parseSignedAmount(value: string): number {
  const normalized = value
    .trim()
    .replace(/\$/g, '')
    .replace(/[()]/g, '')
    .replace(/\s/g, '')
    .replace(/\./g, '')
    .replace(',', '.')
  if (!normalized || normalized === '-') return 0
  const amount = Number(normalized)
  if (!Number.isFinite(amount)) throw new Error(`Monto inválido: ${value}`)
  return Math.round(amount) * (value.includes('(') ? -1 : 1)
}

function parseDate(value: string): string {
  const match = value.trim().match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/)
  if (!match) throw new Error(`Fecha inválida: ${value}`)
  const [, day, month, year] = match
  const date = `${year}-${month}-${day}`
  if (Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new Error(`Fecha inválida: ${value}`)
  return date
}

function detectDirection(movements: ParsedBankMovement[]): 'ASC' | 'DESC' {
  const score = (rows: ParsedBankMovement[]) => rows.slice(1).reduce((total, row, index) => {
    const previous = rows[index]
    return total + (previous.balance + row.credit - row.debit === row.balance ? 1 : 0)
  }, 0)
  const reverse = [...movements].reverse()
  return score(reverse) > score(movements) ? 'DESC' : 'ASC'
}

function validateRows(ordered: ParsedBankMovement[]) {
  const differences = ordered.slice(1).map((row, index) =>
    ordered[index].balance + row.credit - row.debit - row.balance,
  )
  return {
    rowDifference: differences.reduce((max, difference) => Math.max(max, Math.abs(difference)), 0),
    rowDifferenceCount: differences.filter(Boolean).length,
    rowDifferenceTotal: differences.reduce((sum, difference) => sum + difference, 0),
  }
}

export function parseBankStatement(input: string): ParsedBankStatement {
  const text = input.replace(/^\uFEFF/, '').replace(/\r/g, '')
  const lines = text.split('\n').map(line => line.trimEnd()).filter(Boolean)
  if (lines.length < 3) throw new Error('La cartola no contiene filas suficientes.')
  const metadata = lines[0]
  const accountNumber = metadata.match(/cta\s*:\s*([\d-]+)/i)?.[1]?.replace(/\D/g, '') ?? null
  const accountHolder = metadata.replace(/\s*\(\d{7,}-?\d\).*$/i, '').trim() || null
  const headerIndex = lines.findIndex(line => line.toLowerCase().startsWith('fecha;'))
  if (headerIndex < 0) throw new Error('No se encontró el encabezado de la cartola.')
  const separator = lines[headerIndex].includes(';') ? ';' : null
  if (!separator) throw new Error('Formato no soportado: se esperaba delimitador punto y coma.')
  const rows = lines.slice(headerIndex + 1).map(line => line.split(separator).map(value => value.trim()))
    .filter(row => row.length >= headers.length && row[0])
  if (!rows.length) throw new Error('La cartola no contiene movimientos.')
  const movements = rows.map((row, index) => {
    const raw = Object.fromEntries(headers.map((key, i) => [key, row[i] ?? '']))
    return {
      date: parseDate(row[0]), description: row[1], debit: parseAmount(row[2]), credit: parseAmount(row[3]),
      balance: Number(row[4].replace(/\./g, '').replace(/\s/g, '')), documentNumber: row[5] || null,
      transactionNumber: row[6] || null, cashier: row[7] || null, branch: row[8] || null,
      sourceRowNumber: headerIndex + index + 2, sequenceNumber: index + 1, raw,
    }
  })
  const order = detectDirection(movements)
  const ordered = order === 'ASC' ? movements : [...movements].reverse()
  const first = ordered[0]
  const last = ordered[ordered.length - 1]
  const openingBalance = first.balance - first.credit + first.debit
  const totalCredits = movements.reduce((sum, row) => sum + row.credit, 0)
  const totalDebits = movements.reduce((sum, row) => sum + row.debit, 0)
  const closingBalance = last.balance
  const globalDifference = openingBalance + totalCredits - totalDebits - closingBalance
  const rowValidation = validateRows(ordered)
  const firstDate = new Date(`${first.date}T00:00:00Z`)
  return {
    accountNumber, accountHolder, bankName: null, currency: 'CLP', year: firstDate.getUTCFullYear(), month: firstDate.getUTCMonth() + 1,
    order, openingBalance, totalCredits, totalDebits, closingBalance, firstTransactionDate: first.date,
    lastTransactionDate: last.date, rowCount: movements.length, movements: ordered,
    validations: { globalDifference, ...rowValidation, rowBalanceValidated: rowValidation.rowDifference === 0 }, sourceFormat: 'HISTORICAL_SEMICOLON',
  }
}

/** Parses the definitive semicolon-delimited bank statement export. */
export function parseDefinitiveBankStatement(input: string): ParsedBankStatement {
  const parsed = parseBankStatement(input)
  if (parsed.sourceFormat !== 'HISTORICAL_SEMICOLON') {
    throw new Error('La cartola no corresponde al formato definitivo semicolon.')
  }
  return parsed
}

function parseCurrentAmount(value: unknown): number {
  if (typeof value === 'number') return Math.abs(Math.round(value))
  const compact = String(value ?? '').trim().replace(/\s/g, '').replace(/\./g, '').replace(',', '.')
  if (!compact) return 0
  const amount = Number(compact.replace(/^[+]/, ''))
  if (!Number.isFinite(amount)) throw new Error(`Monto inválido: ${value}`)
  return Math.abs(Math.round(amount))
}

function parseSpreadsheetDate(value: unknown): string {
  if (value instanceof Date) return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  const match = String(value ?? '').trim().match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/)
  if (!match) throw new Error(`Fecha inválida: ${value}`)
  return `${match[3]}-${match[2]}-${match[1]}`
}

function normalizedHeader(value: unknown) { return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ') }

function normalizedItauText(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function itauMetadataAmount(text: string, label: RegExp) {
  const amountPattern = '([($+-]?\\$?[0-9][0-9.]*[,]?[0-9]*[)]?)'
  const match = text.match(new RegExp(`${label.source}\\s*[:\\-]?\\s*${amountPattern}`, 'i'))
  return match ? parseSignedAmount(match[1]) : null
}

function itauHeaderRowAmounts(text: string, header: RegExp) {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  const headerIndex = lines.findIndex(line => header.test(normalizedItauText(line)))
  if (headerIndex < 0) return []
  for (const line of lines.slice(headerIndex + 1, headerIndex + 4)) {
    const values = line.match(/\$?-?[0-9][0-9.]*/g)
    if (values?.length) return values.map(parseSignedAmount)
  }
  return []
}

function itauAccountNumber(text: string) {
  const match = text.match(/(?:numero|n[uú]mero)\s+de\s+cuenta\s*[:#-]?\s*([0-9][0-9 .-]{5,})/i)
    ?? text.match(/cuenta\s+corriente\s*(?:n[°ºo.]*)?\s*[:#-]?\s*([0-9][0-9 .-]{5,})/i)
  return match?.[1].replace(/\D/g, '') || null
}

function itauAccountHolder(text: string) {
  const match = text.match(/(?:nombre|titular)\s*[:#-]?\s*([^\n]+)/i)
  return match?.[1]?.trim() || null
}

function itauPeriodDates(text: string) {
  const match = text.match(/per[ií]odo[^\n]*?(\d{2}[/-]\d{2}[/-]\d{4})[^\n]*?(?:-|a|al|hasta)[^\n]*?(\d{2}[/-]\d{2}[/-]\d{4})/i)
  return match ? [parseDate(match[1]), parseDate(match[2])] : []
}

function parseItauDate(value: string, year: string | null) {
  if (/^\d{2}[/-]\d{2}[/-]\d{4}$/.test(value)) return parseDate(value)
  const shortDate = value.match(/^(\d{2})[/-](\d{2})$/)
  if (!shortDate || !year) throw new Error(`Fecha Itaú inválida: ${value}`)
  return parseDate(`${shortDate[1]}/${shortDate[2]}/${year}`)
}

function itauMoneyToken(value: string) {
  return /^[-+($]?\$?[0-9][0-9.,]*\)?$/.test(value) || value === '-'
}

function parseItauMovementLine(
  line: string,
  sourceRowNumber: number,
  year: string | null,
): ParsedBankMovement | null {
  const tokens = line.trim().split(/\s+/)
  if (tokens.length < 7 || !/^\d{2}[/-]\d{2}(?:[/-]\d{4})?$/.test(tokens[0])) return null
  const amountStart = tokens.length - 3
  if (!tokens.slice(amountStart).every(itauMoneyToken)) return null
  const date = parseItauDate(tokens[0], year)
  const transactionNumber = tokens[1] || null
  const branch = tokens[2] || null
  const description = tokens.slice(3, amountStart).join(' ').trim()
  if (!description) return null
  const credit = parseAmount(tokens[amountStart])
  const debit = parseAmount(tokens[amountStart + 1])
  const balance = parseSignedAmount(tokens[amountStart + 2])
  return {
    date,
    description,
    credit,
    debit,
    balance,
    documentNumber: null,
    transactionNumber,
    cashier: null,
    branch,
    sourceRowNumber,
    sequenceNumber: sourceRowNumber,
    raw: {
      date: tokens[0],
      transactionNumber: tokens[1],
      branch: tokens[2],
      description,
      credit: tokens[amountStart],
      debit: tokens[amountStart + 1],
      balance: tokens[amountStart + 2],
    },
  } satisfies ParsedBankMovement
}

/** Extracts text from an Itaú Empresas PDF without OCR or external binaries. */
export async function extractItauPdfText(bytes: Uint8Array) {
  const parser = new PDFParse({ data: bytes })
  try {
    const result = await parser.getText()
    return result.text
  } finally {
    await parser.destroy()
  }
}

/** Parses one monthly Itaú Empresas statement from already extracted text. */
export function parseItauStatementText(input: string): ParsedBankStatement {
  const text = input.replace(/^\uFEFF/, '').replace(/\r/g, '')
  if (!/ita[uú]/i.test(text) || !/cartola\s+historica/i.test(normalizedItauText(text)))
    throw new Error('El PDF no corresponde a una cartola histórica Itaú Empresas.')
  const periodDates = itauPeriodDates(text)
  const statementYear = periodDates[0]?.slice(0, 4) ?? null
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  const movements = lines
    .map((line, index) => parseItauMovementLine(line, index + 1, statementYear))
    .filter((movement): movement is ParsedBankMovement => Boolean(movement))
  if (!movements.length) throw new Error('No se encontraron movimientos Itaú en el PDF.')
  const movementPeriods = new Set(movements.map(movement => movement.date.slice(0, 7)))
  if (movementPeriods.size !== 1)
    throw new Error('La cartola Itaú debe contener un solo período mensual.')
  if (periodDates.length === 2 && periodDates[0].slice(0, 7) !== periodDates[1].slice(0, 7))
    throw new Error('La cartola Itaú debe contener un solo período mensual.')
  if (periodDates.length === 2 && periodDates[0].slice(0, 7) !== [...movementPeriods][0])
    throw new Error('El período declarado no coincide con los movimientos Itaú.')
  const order = detectDirection(movements)
  const ordered = order === 'ASC' ? movements : [...movements].reverse()
  const first = ordered[0]
  const last = ordered[ordered.length - 1]
  const calculatedOpeningBalance = first.balance - first.credit + first.debit
  const creditLineValues = itauHeaderRowAmounts(
    text,
    /monto\s+l[ií]nea\s+de\s+cr[eé]dito.*monto\s+utilizado/i,
  )
  const availableAndOpeningValues = itauHeaderRowAmounts(
    text,
    /monto\s+disponible.*saldo\s+anterior\s+cuenta\s+corriente/i,
  )
  const openingBalance =
    availableAndOpeningValues[1] ??
    itauMetadataAmount(text, /saldo\s+anterior(?:\s+cuenta\s+corriente)?/) ??
    calculatedOpeningBalance
  const totalCredits = ordered.reduce((sum, row) => sum + row.credit, 0)
  const totalDebits = ordered.reduce((sum, row) => sum + row.debit, 0)
  const closingBalance = last.balance
  const globalDifference = openingBalance + totalCredits - totalDebits - closingBalance
  const rowValidation = validateRows(ordered)
  return {
    accountNumber: itauAccountNumber(text),
    accountHolder: itauAccountHolder(text),
    bankName: 'Itaú',
    currency: 'CLP',
    year: Number(first.date.slice(0, 4)),
    month: Number(first.date.slice(5, 7)),
    order,
    openingBalance,
    totalCredits,
    totalDebits,
    closingBalance,
    firstTransactionDate: first.date,
    lastTransactionDate: last.date,
    rowCount: ordered.length,
    movements: ordered,
    validations: { globalDifference, ...rowValidation, rowBalanceValidated: rowValidation.rowDifference === 0 },
    sourceFormat: 'ITAU_PDF',
    creditLineTotal:
      creditLineValues[0] ??
      itauMetadataAmount(text, /monto\s+l[ií]nea\s+de\s+cr[eé]dito/),
    creditLineUsed:
      creditLineValues[1] ?? itauMetadataAmount(text, /monto\s+utilizado/),
    creditLineAvailable:
      availableAndOpeningValues[0] ?? itauMetadataAmount(text, /monto\s+disponible/),
  }
}

/** Parses Banco de Chile's current-month XLS export without persisting it. */
export function parseCurrentBankStatementXls(input: Uint8Array): ParsedBankStatement {
  const workbook = XLSX.read(input, { type: 'array', raw: true, cellDates: true })
  let rows: unknown[][] | null = null
  for (const sheetName of workbook.SheetNames) {
    const candidate = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, raw: true, defval: '' })
    if (candidate.some(row => row.some(cell => normalizedHeader(cell) === 'fecha')) && candidate.some(row => row.some(cell => normalizedHeader(cell) === 'saldo (clp)'))) {
      rows = candidate
      break
    }
  }
  if (!rows) throw new Error('No se encontró una hoja de movimientos de mes actual.')
  const headerIndex = rows.findIndex(row => row.some(cell => normalizedHeader(cell) === 'fecha') && row.some(cell => normalizedHeader(cell) === 'saldo (clp)'))
  const header = rows[headerIndex].map(normalizedHeader)
  const indexOf = (name: string) => header.indexOf(name)
  const dateIndex = indexOf('fecha')
  const descriptionIndex = indexOf('descripción') >= 0 ? indexOf('descripción') : indexOf('descripcion')
  const branchIndex = indexOf('canal o sucursal')
  const documentIndex = indexOf('nro. docto.')
  const debitIndex = indexOf('cargos (clp)')
  const creditIndex = indexOf('abonos (clp)')
  const balanceIndex = indexOf('saldo (clp)')
  const dataRows = rows.slice(headerIndex + 1).filter(row => /^\d{2}[/-]\d{2}[/-]\d{4}$/.test(String(row[dateIndex] ?? '').trim()))
  if (!dataRows.length) throw new Error('La cartola de mes actual no contiene movimientos.')
  const rawMovements = dataRows.map((row, index) => ({
    date: parseSpreadsheetDate(row[dateIndex]), description: String(row[descriptionIndex] ?? '').trim(),
    debit: parseCurrentAmount(row[debitIndex]), credit: parseCurrentAmount(row[creditIndex]), balance: parseCurrentAmount(row[balanceIndex]),
    documentNumber: String(row[documentIndex] ?? '').trim() || null, transactionNumber: null, cashier: null,
    branch: String(row[branchIndex] ?? '').trim() || null, sourceRowNumber: headerIndex + index + 2,
    sequenceNumber: index + 1, raw: Object.fromEntries(header.map((key, column) => [key || `column_${column}`, String(row[column] ?? '')])),
  }))
  const ordered = [...rawMovements].reverse()
  const first = ordered[0]
  const last = ordered[ordered.length - 1]
  const openingBalance = first.balance - first.credit + first.debit
  const totalCredits = rawMovements.reduce((sum, row) => sum + row.credit, 0)
  const totalDebits = rawMovements.reduce((sum, row) => sum + row.debit, 0)
  const globalDifference = openingBalance + totalCredits - totalDebits - last.balance
  const rowValidation = validateRows(ordered)
  const metadataValue = (label: RegExp) => {
    for (const row of rows!.slice(0, headerIndex)) {
      const labelIndex = row.findIndex(value => label.test(String(value ?? '').trim()))
      if (labelIndex >= 0) {
        const value = row.slice(labelIndex + 1).map(item => String(item ?? '').trim()).find(Boolean)
        if (value) return value
      }
    }
    return null
  }
  const accountNumber = metadataValue(/cuenta n/i)?.replace(/\D/g, '') ?? null
  const accountHolder = metadataValue(/nombre empresa/i)
  return {
    accountNumber, accountHolder, bankName: 'Banco de Chile', currency: 'CLP', year: Number(first.date.slice(0, 4)), month: Number(first.date.slice(5, 7)),
    order: 'DESC', openingBalance, totalCredits, totalDebits, closingBalance: last.balance,
    firstTransactionDate: first.date, lastTransactionDate: last.date, rowCount: ordered.length, movements: ordered,
    validations: { globalDifference, ...rowValidation, rowBalanceValidated: rowValidation.rowDifference === 0 }, sourceFormat: 'CURRENT_XLS',
  }
}
