import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export const COGS_STATUSES = [
  'OBSERVED',
  'MISSING',
  'AMBIGUOUS',
  'NOT_DISPATCHED',
  'ZERO_WITH_EVIDENCE',
] as const

export type CogsStatus = (typeof COGS_STATUSES)[number]

type JsonObject = Record<string, unknown>
type NumericInput = string | number

export interface BsaleDocumentCostPayload extends JsonObject {
  id: NumericInput
  totalCost?: NumericInput | null
  cost_detail?: unknown
}

export interface BsaleDocumentCostRecord {
  company_id: string
  bsale_document_id: number
  total_cost: string | null
  status: CogsStatus
  source: string
  observed_at: string
  raw_json: JsonObject
}

export interface BsaleDocumentCostDetailRecord {
  company_id: string
  bsale_document_id: number
  cost_detail_key: string
  bsale_shipping_detail_id: number | null
  bsale_variant_id: number | null
  quantity: string | null
  unit_cost: string | null
  total_cost: string
  raw_json: JsonObject
}

export interface BsaleCreditNoteReturnPayload extends JsonObject {
  id: NumericInput
  credit_note?: { id?: NumericInput | null } | null
  reference_document?: { id?: NumericInput | null } | null
  returnDate?: NumericInput | null
  amount?: NumericInput | null
  priceAdjustment?: NumericInput | boolean | null
  editTexts?: NumericInput | boolean | null
  type?: NumericInput | null
  motive?: string | null
}

export interface BsaleCreditNoteReturnRecord {
  company_id: string
  bsale_credit_note_id: number
  bsale_return_id: number
  referenced_document_id: number | null
  return_date: string | null
  motive: string | null
  return_type: number | null
  amount: string | null
  price_adjustment: boolean | null
  edit_texts: boolean | null
  accounting_status: CogsStatus
  observed_at: string
  raw_json: JsonObject
}

export interface BsaleCreditNoteReturnDetailPayload extends JsonObject {
  id: NumericInput
  documentDetailId?: NumericInput | null
  variant?: { id?: NumericInput | null } | null
  variantId?: NumericInput | null
  quantity?: NumericInput | null
  quantityDevStock?: NumericInput | null
  variantStock?: NumericInput | null
  variantCost?: NumericInput | null
}

export interface BsaleCreditNoteReturnDetailRecord {
  company_id: string
  bsale_return_id: number
  bsale_return_detail_id: number
  bsale_document_detail_id: number | null
  bsale_variant_id: number | null
  quantity: string | null
  quantity_dev_stock: string | null
  variant_stock: string | null
  variant_cost: string | null
  raw_json: JsonObject
}

type PersistenceClient = SupabaseClient

function getPersistenceClient(): PersistenceClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) throw new Error('Supabase server credentials are not configured')
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function requireCompanyId(companyId: string) {
  if (!companyId || !companyId.trim()) throw new Error('companyId is required')
  return companyId
}

function positiveInteger(value: unknown, field: string): number {
  if (value === null || value === undefined || value === '') throw new Error(`${field} is required`)
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${field} must be a positive integer`)
  return parsed
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (value === null || value === undefined || value === '') throw new Error(`${field} is required`)
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${field} must be a non-negative integer`)
  return parsed
}

function numericString(value: unknown, field: string, required = false): string | null {
  if (value === null || value === undefined || value === '') {
    if (required) throw new Error(`${field} is required`)
    return null
  }
  const text = typeof value === 'number' ? String(value) : String(value).trim()
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) throw new Error(`${field} must be a decimal value`)
  return text
}

function booleanFlag(value: unknown, field: string): boolean | null {
  if (value === null || value === undefined || value === '') return null
  if (value === true || value === 1 || value === '1') return true
  if (value === false || value === 0 || value === '0') return false
  throw new Error(`${field} must be a boolean flag`)
}

function statusOrDefault(status: CogsStatus | undefined, totalCost: string | null): CogsStatus {
  if (status) return status
  return totalCost !== null && !isZeroNumeric(totalCost)
    ? 'OBSERVED'
    : 'MISSING'
}

function isZeroNumeric(value: string | null) {
  return value !== null && /^0(?:\.0+)?$/.test(value)
}

function assertZeroEvidence(status: CogsStatus, totalCost: string | null, zeroEvidence: boolean | undefined) {
  if (status === 'OBSERVED' && isZeroNumeric(totalCost)) {
    throw new Error('OBSERVED requires a positive totalCost; classify an evidenced zero explicitly')
  }
  if (status === 'ZERO_WITH_EVIDENCE' && (!isZeroNumeric(totalCost) || !zeroEvidence)) {
    throw new Error('ZERO_WITH_EVIDENCE requires explicit zeroEvidence and totalCost equal to zero')
  }
}

function observedAt(value?: string) {
  return value || new Date().toISOString()
}

function epochToIso(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  const epoch = Number(value)
  if (!Number.isFinite(epoch)) throw new Error('returnDate must be an epoch value')
  return new Date(epoch * 1000).toISOString()
}

function costDetailRows(companyId: string, documentId: number, payload: BsaleDocumentCostPayload): BsaleDocumentCostDetailRecord[] {
  if (!Array.isArray(payload.cost_detail)) return []
  return payload.cost_detail.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`cost_detail[${index}] must be an object`)
    const row = entry as JsonObject
    const shipping = row.shipping_detail
    if (!shipping || typeof shipping !== 'object') throw new Error(`cost_detail[${index}].shipping_detail is required`)
    const shippingDetail = shipping as JsonObject
    const shippingId = positiveInteger(shippingDetail.id, `cost_detail[${index}].shipping_detail.id`)
    const totalCost = numericString(shippingDetail.variantTotalCost, `cost_detail[${index}].variantTotalCost`, true)
    return {
      company_id: companyId,
      bsale_document_id: documentId,
      cost_detail_key: `shipping_detail:${shippingId}`,
      bsale_shipping_detail_id: shippingId,
      bsale_variant_id: row.variant && typeof row.variant === 'object'
        ? positiveInteger((row.variant as JsonObject).id, `cost_detail[${index}].variant.id`)
        : null,
      quantity: numericString(shippingDetail.quantity, `cost_detail[${index}].quantity`),
      unit_cost: numericString(shippingDetail.variantCost, `cost_detail[${index}].variantCost`),
      total_cost: totalCost!,
      raw_json: row,
    }
  })
}

export function mapDocumentCostPayload(
  companyId: string,
  payload: BsaleDocumentCostPayload,
  options: { status?: CogsStatus; observedAt?: string; source?: string; zeroEvidence?: boolean } = {},
) {
  const safeCompanyId = requireCompanyId(companyId)
  const documentId = positiveInteger(payload.id, 'document.id')
  const totalCost = numericString(payload.totalCost, 'document.totalCost')
  const status = statusOrDefault(options.status, totalCost)
  assertZeroEvidence(status, totalCost, options.zeroEvidence)
  const record: BsaleDocumentCostRecord = {
    company_id: safeCompanyId,
    bsale_document_id: documentId,
    total_cost: totalCost,
    status,
    source: options.source || 'BSALE_DOCUMENT_COSTS',
    observed_at: observedAt(options.observedAt),
    raw_json: payload,
  }
  return { record, details: costDetailRows(safeCompanyId, documentId, payload) }
}

export function mapCreditNoteReturnPayload(
  companyId: string,
  payload: BsaleCreditNoteReturnPayload,
  options: { creditNoteId?: NumericInput; accountingStatus?: CogsStatus; observedAt?: string } = {},
): BsaleCreditNoteReturnRecord {
  const safeCompanyId = requireCompanyId(companyId)
  const returnId = positiveInteger(payload.id, 'return.id')
  const creditNoteId = positiveInteger(options.creditNoteId ?? payload.credit_note?.id, 'return.credit_note.id')
  const referencedId = payload.reference_document?.id == null ? null : positiveInteger(payload.reference_document.id, 'return.reference_document.id')
  return {
    company_id: safeCompanyId,
    bsale_credit_note_id: creditNoteId,
    bsale_return_id: returnId,
    referenced_document_id: referencedId,
    return_date: epochToIso(payload.returnDate),
    motive: payload.motive ?? null,
    return_type: payload.type == null ? null : nonNegativeInteger(payload.type, 'return.type'),
    amount: numericString(payload.amount, 'return.amount'),
    price_adjustment: booleanFlag(payload.priceAdjustment, 'return.priceAdjustment'),
    edit_texts: booleanFlag(payload.editTexts, 'return.editTexts'),
    accounting_status: options.accountingStatus || 'AMBIGUOUS',
    observed_at: observedAt(options.observedAt),
    raw_json: payload,
  }
}

export function mapCreditNoteReturnDetailPayload(
  companyId: string,
  returnIdInput: NumericInput,
  payload: BsaleCreditNoteReturnDetailPayload,
): BsaleCreditNoteReturnDetailRecord {
  const safeCompanyId = requireCompanyId(companyId)
  const returnId = positiveInteger(returnIdInput, 'return.id')
  return {
    company_id: safeCompanyId,
    bsale_return_id: returnId,
    bsale_return_detail_id: positiveInteger(payload.id, 'return.detail.id'),
    bsale_document_detail_id: payload.documentDetailId == null ? null : positiveInteger(payload.documentDetailId, 'return.detail.documentDetailId'),
    bsale_variant_id: payload.variant?.id != null
      ? positiveInteger(payload.variant.id, 'return.detail.variant.id')
      : payload.variantId == null ? null : positiveInteger(payload.variantId, 'return.detail.variantId'),
    quantity: numericString(payload.quantity, 'return.detail.quantity'),
    quantity_dev_stock: numericString(payload.quantityDevStock, 'return.detail.quantityDevStock'),
    variant_stock: numericString(payload.variantStock, 'return.detail.variantStock'),
    variant_cost: numericString(payload.variantCost, 'return.detail.variantCost'),
    raw_json: payload,
  }
}

async function upsertOne(client: PersistenceClient, table: string, record: Record<string, unknown>, onConflict: string) {
  const { error } = await client.schema('integraciones').from(table).upsert({
    ...record,
    updated_at: new Date().toISOString(),
  }, { onConflict, ignoreDuplicates: false })
  if (error) throw new Error(`Error upserting ${table}: ${error.message}`)
}

function clientOrDefault(client?: PersistenceClient) {
  return client || getPersistenceClient()
}

function assertRecordCompany(companyId: string, recordCompanyId: string) {
  const safeCompanyId = requireCompanyId(companyId)
  if (recordCompanyId !== safeCompanyId) throw new Error('record company_id does not match companyId')
  return safeCompanyId
}

export async function upsertDocumentCost(companyId: string, record: BsaleDocumentCostRecord, client?: PersistenceClient) {
  assertRecordCompany(companyId, record.company_id)
  await upsertOne(clientOrDefault(client), 'bsale_document_costs', record as unknown as Record<string, unknown>, 'company_id,bsale_document_id')
}

export async function upsertDocumentCostDetails(companyId: string, records: BsaleDocumentCostDetailRecord[], client?: PersistenceClient) {
  if (!records.length) return
  records.forEach(record => assertRecordCompany(companyId, record.company_id))
  const database = clientOrDefault(client)
  for (const record of records) await upsertOne(database, 'bsale_document_cost_details', record as unknown as Record<string, unknown>, 'company_id,bsale_document_id,cost_detail_key')
}

export async function upsertCreditNoteReturn(companyId: string, record: BsaleCreditNoteReturnRecord, client?: PersistenceClient) {
  assertRecordCompany(companyId, record.company_id)
  await upsertOne(clientOrDefault(client), 'bsale_credit_note_returns', record as unknown as Record<string, unknown>, 'company_id,bsale_return_id')
}

export async function upsertCreditNoteReturnDetails(companyId: string, records: BsaleCreditNoteReturnDetailRecord[], client?: PersistenceClient) {
  if (!records.length) return
  records.forEach(record => assertRecordCompany(companyId, record.company_id))
  const database = clientOrDefault(client)
  for (const record of records) await upsertOne(database, 'bsale_credit_note_return_details', record as unknown as Record<string, unknown>, 'company_id,bsale_return_id,bsale_return_detail_id')
}
