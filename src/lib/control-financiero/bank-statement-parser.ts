import * as XLSX from 'xlsx'

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
  sourceFormat: 'HISTORICAL_SEMICOLON' | 'CURRENT_XLS'
}

const headers = ['date', 'description', 'debit', 'credit', 'balance', 'documentNumber', 'transactionNumber', 'cashier', 'branch']

function parseAmount(value: string): number {
  const compact = value.trim().replace(/\s/g, '').replace(/\./g, '').replace(',', '.')
  if (!compact || /^[-+]?0+(?:[,.]0+)?$/.test(compact)) return 0
  const amount = Number(compact.replace(/^[+]/, ''))
  if (!Number.isFinite(amount)) throw new Error(`Monto inválido: ${value}`)
  return Math.abs(Math.round(amount))
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
