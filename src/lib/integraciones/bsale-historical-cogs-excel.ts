import * as XLSX from 'xlsx'
import { createClient } from '@supabase/supabase-js'

const INVOICE_LABEL = 'FACTURA ELECTRÓNICA'
const RECEIPT_LABEL = 'BOLETA ELECTRÓNICA T'
const SOURCE_EXCEL = 'BSALE_SALES_EXPORT_XLSX'

export type ExcelCogsPlanStatus =
  | 'API_ALREADY_OBSERVED'
  | 'EXCEL_CANDIDATE_OBSERVED'
  | 'EXCEL_MISSING_ZERO'
  | 'NO_MATCH'
  | 'AMBIGUOUS_MATCH'
  | 'DUPLICATE_SOURCE'
  | 'NET_DIFFERENCE'
  | 'INVALID_SOURCE'

export interface ExcelCogsRow {
  [header: string]: unknown
}

export interface ExcelCogsDocument {
  key: string
  documentType: typeof INVOICE_LABEL | typeof RECEIPT_LABEL
  documentTypeId: 1 | 5
  folio: string
  emissionDate: string
  rows: ExcelCogsRow[]
  sourceRowCount: number
  duplicateSourceRows: number
  netAmountExcel: string | null
  totalCostExcel: string | null
  invalidSource: boolean
  zeroCost: boolean
}

export interface ExcelCogsPetGroupDocument {
  bsale_id: number
  document_type_id: number
  number: string | number | null
  emission_date: string | null
  net_amount: string | number | null
}

export interface ExcelCogsExistingCost {
  bsale_document_id: number
  total_cost: string | number | null
  status: string
  source: string
}

export interface ExcelCogsPlanRow {
  key: string
  status: ExcelCogsPlanStatus
  documentType: string
  documentTypeId: number
  folio: string
  emissionDate: string
  sourceRowCount: number
  duplicateSourceRows: number
  bsaleDocumentId: number | null
  netAmountExcel: string | null
  netAmountPetGroup: string | null
  netValidation: 'MATCH_NET' | 'NET_DIFFERENCE' | 'NOT_CHECKED'
  dateValidation: 'MATCH_DATE' | 'DATE_DIFFERENCE' | 'NOT_CHECKED'
  totalCostExcel: string | null
  apiTotalCost: string | null
  apiSource: string | null
  dryRunAction: 'SKIP' | 'PLAN_INSERT' | 'PLAN_MISSING' | 'SKIP_ERROR'
}

interface DecimalValue {
  integer: bigint
  scale: number
}

interface QueryClient {
  schema(schema: string): { from(table: string): QueryBuilder }
}

interface QueryBuilder {
  select(columns: string): QueryBuilder
  eq(column: string, value: unknown): QueryBuilder
  in(column: string, values: unknown[]): QueryBuilder
  gte(column: string, value: unknown): QueryBuilder
  lt(column: string, value: unknown): QueryBuilder
  range(from: number, to: number): Promise<{ data: unknown[] | null; error: { message: string } | null }>
}

function decimal(value: unknown): DecimalValue | null {
  const text = String(value ?? '').trim()
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null
  const [whole, fraction = ''] = text.split('.')
  return { integer: BigInt(`${whole}${fraction}`), scale: fraction.length }
}

function addDecimal(left: DecimalValue | null, right: DecimalValue | null) {
  if (!left) return right
  if (!right) return left
  const scale = Math.max(left.scale, right.scale)
  return {
    integer: left.integer * BigInt(10) ** BigInt(scale - left.scale) + right.integer * BigInt(10) ** BigInt(scale - right.scale),
    scale,
  }
}

export function decimalToString(value: DecimalValue | null) {
  if (!value) return null
  const text = value.integer.toString().padStart(value.scale + 1, '0')
  if (value.scale === 0) return text
  return `${text.slice(0, -value.scale)}.${text.slice(-value.scale)}`.replace(/\.?0+$/, '') || '0'
}

function parseDate(value: unknown) {
  const match = String(value ?? '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null
}

function typeInfo(value: unknown) {
  if (value === INVOICE_LABEL) return { label: INVOICE_LABEL, id: 5 } as const
  if (value === RECEIPT_LABEL) return { label: RECEIPT_LABEL, id: 1 } as const
  return null
}

function rowFingerprint(row: ExcelCogsRow) {
  return JSON.stringify(Object.keys(row).sort().map(key => [key, row[key]]))
}

export function groupHistoricalCogsRows(rows: ExcelCogsRow[], year: number): ExcelCogsDocument[] {
  const groups = new Map<string, ExcelCogsDocument>()
  for (const row of rows) {
    const info = typeInfo(row['Tipo de Documento'])
    const date = parseDate(row['Fecha de Emisión'])
    if (!info || !date || !date.startsWith(`${year}-`)) continue
    const folio = String(row['Numero del documento'] ?? '').trim()
    if (!folio) continue
    const key = `${info.id}|${folio}`
    let document = groups.get(key)
    if (!document) {
      document = {
        key,
        documentType: info.label,
        documentTypeId: info.id,
        folio,
        emissionDate: date,
        rows: [],
        sourceRowCount: 0,
        duplicateSourceRows: 0,
        netAmountExcel: null,
        totalCostExcel: null,
        invalidSource: false,
        zeroCost: false,
      }
      groups.set(key, document)
    }
    document.rows.push(row)
    document.sourceRowCount++
    document.netAmountExcel = decimalToString(addDecimal(decimal(document.netAmountExcel), decimal(row['Venta Total Neta'])))
    const cost = decimal(row['Costo Total Neto'])
    if (cost) document.totalCostExcel = decimalToString(addDecimal(decimal(document.totalCostExcel), cost))
    else document.invalidSource = true
    if (String(row['Costo Total Neto'] ?? '').trim() === '0') document.zeroCost = true
  }
  for (const document of groups.values()) {
    const fingerprints = new Map<string, number>()
    for (const row of document.rows) fingerprints.set(rowFingerprint(row), (fingerprints.get(rowFingerprint(row)) || 0) + 1)
    document.duplicateSourceRows = [...fingerprints.values()].reduce((total, count) => total + (count > 1 ? count - 1 : 0), 0)
  }
  return [...groups.values()]
}

export function classifyExcelCogsDocument(document: ExcelCogsDocument, match: { petGroup: ExcelCogsPetGroupDocument | null; ambiguous: boolean; apiCost: ExcelCogsExistingCost | null; netMatches: boolean; dateMatches: boolean }) {
  if (match.apiCost?.status === 'OBSERVED' && match.apiCost.source !== SOURCE_EXCEL) return 'API_ALREADY_OBSERVED' as const
  if (match.ambiguous) return 'AMBIGUOUS_MATCH' as const
  if (!match.petGroup) return 'NO_MATCH' as const
  if (!match.dateMatches) return 'AMBIGUOUS_MATCH' as const
  if (!match.netMatches) return 'NET_DIFFERENCE' as const
  if (document.duplicateSourceRows > 0) return 'DUPLICATE_SOURCE' as const
  if (document.invalidSource) return 'INVALID_SOURCE' as const
  if (document.zeroCost || document.totalCostExcel === '0') return 'EXCEL_MISSING_ZERO' as const
  return 'EXCEL_CANDIDATE_OBSERVED' as const
}

async function selectAll<T>(client: QueryClient, table: string, build: (query: QueryBuilder) => QueryBuilder) {
  const rows: T[] = []
  for (let offset = 0;; offset += 1000) {
    const query = build(client.schema('integraciones').from(table))
    const { data, error } = await query.range(offset, offset + 999)
    if (error) throw new Error(`${table}: ${error.message}`)
    rows.push(...((data || []) as T[]))
    if (!data || data.length < 1000) return rows
  }
}

function persistenceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase server credentials are not configured')
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } }) as unknown as QueryClient
}

export async function runHistoricalCogsExcelDryRun(options: { companyId: string; filePath: string; year: number; dryRun: true; client?: QueryClient }) {
  if (!options.dryRun) throw new Error('Excel COGS importer is restricted to dryRun=true in this phase')
  const workbook = XLSX.readFile(options.filePath, { raw: true, cellDates: false })
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json<ExcelCogsRow>(firstSheet, { defval: null, raw: true })
  const documents = groupHistoricalCogsRows(rows, options.year)
  const client = options.client || persistenceClient()
  const petGroup = await selectAll<ExcelCogsPetGroupDocument>(client, 'bsale_documents', query => query.select('bsale_id,document_type_id,number,emission_date,net_amount').eq('company_id', options.companyId).eq('state', 0).in('document_type_id', [1, 5]).gte('emission_date', `${options.year}-01-01`).lt('emission_date', `${options.year + 1}-01-01`))
  const existingCosts = await selectAll<ExcelCogsExistingCost>(client, 'bsale_document_costs', query => query.select('bsale_document_id,total_cost,status,source').eq('company_id', options.companyId))
  const petByKey = new Map<string, ExcelCogsPetGroupDocument[]>()
  for (const row of petGroup) {
    const key = `${Number(row.document_type_id)}|${String(row.number ?? '').trim()}`
    petByKey.set(key, [...(petByKey.get(key) || []), row])
  }
  const apiById = new Map(existingCosts.map(row => [Number(row.bsale_document_id), row]))
  const plans: ExcelCogsPlanRow[] = documents.map(document => {
    const matches = petByKey.get(document.key) || []
    const pet = matches.length === 1 ? matches[0] : null
    const netMatches = !!pet && decimalToString(decimal(document.netAmountExcel)) === decimalToString(decimal(pet.net_amount))
    const dateMatches = !!pet && pet.emission_date?.slice(0, 10) === document.emissionDate
    const apiCost = pet ? apiById.get(Number(pet.bsale_id)) || null : null
    const status = classifyExcelCogsDocument(document, { petGroup: pet, ambiguous: matches.length > 1, apiCost, netMatches, dateMatches })
    const action = status === 'EXCEL_CANDIDATE_OBSERVED' ? 'PLAN_INSERT' : status === 'EXCEL_MISSING_ZERO' ? 'PLAN_MISSING' : status === 'API_ALREADY_OBSERVED' || status === 'NO_MATCH' || status === 'AMBIGUOUS_MATCH' || status === 'DUPLICATE_SOURCE' || status === 'NET_DIFFERENCE' ? 'SKIP' : 'SKIP_ERROR'
    return { key: document.key, status, documentType: document.documentType, documentTypeId: document.documentTypeId, folio: document.folio, emissionDate: document.emissionDate, sourceRowCount: document.sourceRowCount, duplicateSourceRows: document.duplicateSourceRows, bsaleDocumentId: pet?.bsale_id || null, netAmountExcel: document.netAmountExcel, netAmountPetGroup: pet?.net_amount == null ? null : String(pet.net_amount), netValidation: pet ? netMatches ? 'MATCH_NET' : 'NET_DIFFERENCE' : 'NOT_CHECKED', dateValidation: pet ? dateMatches ? 'MATCH_DATE' : 'DATE_DIFFERENCE' : 'NOT_CHECKED', totalCostExcel: document.totalCostExcel, apiTotalCost: apiCost?.total_cost == null ? null : String(apiCost.total_cost), apiSource: apiCost?.source || null, dryRunAction: action }
  })
  const counts = plans.reduce<Record<string, number>>((result, plan) => { result[plan.status] = (result[plan.status] || 0) + 1; return result }, {})
  return { dryRun: true as const, companyId: options.companyId, year: options.year, sheetNames: workbook.SheetNames, sourceRows: rows.length, documents, plans, counts, maxDocumentDateExcel: documents.map(document => document.emissionDate).sort().at(-1) || null, writes: 0, sourceExcel: SOURCE_EXCEL }
}
