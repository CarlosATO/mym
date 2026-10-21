import { createHash } from 'node:crypto'

type FacturableSnapshot = {
  company_id: string
  canonical_bsale_token: string
  current_bsale_nv_id: number
  client_id: number | null
  office_id: number | null
  sale_condition_id: string | null
  details: Array<Record<string, unknown>>
  total: number | null
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]))
  }
  return value
}

function invoiceAttemptFingerprint(snapshot: FacturableSnapshot): string {
  const canonical = stable({ ...snapshot, details: [...snapshot.details].sort((a, b) => Number(a.detail_id) - Number(b.detail_id)) })
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex')
}

function invoiceAttemptSalesId(companyId: string, canonicalToken: string, fingerprint: string): string {
  const candidate = `PETGROUP:FACTURA:${companyId}:${canonicalToken}:${fingerprint}`
  return candidate.length <= 50 ? candidate : `PETGROUP:FACTURA:${createHash('sha256').update(candidate, 'utf8').digest('hex').slice(0, 32)}`
}

export const INVOICE_EMISSION_DISABLED = 'EMISSION_DISABLED' as const
export const TARGET_INVOICE_CASE = {
  folio: '5032',
  historicalNvId: 92486,
  currentNvId: 92513,
  clientId: 1005,
  officeId: 1,
  priceListId: 4,
  detailIds: [334790, 334791],
} as const

export type InvoiceEmissionPayload = {
  documentTypeId: 5
  officeId: number
  priceListId: number
  emissionDate: string
  expirationDate: string
  declareSii: 1
  clientId: number
  sellerId: number
  salesId: string
  details: Array<{ detailId: number; quantity: number }>
}

export type InvoiceEmissionSnapshot = FacturableSnapshot & {
  historical_bsale_nv_id: number
  folio: string
  seller_id: number
  price_list_id: number
  emission_date: string
  expiration_date: string
  totals: { net: number; tax: number; total: number }
}

export function invoiceEmissionEnabled(): boolean {
  return process.env.BSALE_INVOICE_EMISSION_ENABLED === 'true'
}

export function buildInvoiceEmissionPayload(input: {
  officeId: number
  priceListId: number
  emissionDate: string
  expirationDate: string
  clientId: number
  sellerId: number
  salesId: string
  details: Array<{ detailId: number; quantity: number }>
}): InvoiceEmissionPayload {
  return {
    documentTypeId: 5,
    officeId: input.officeId,
    priceListId: input.priceListId,
    emissionDate: input.emissionDate,
    expirationDate: input.expirationDate,
    declareSii: 1,
    clientId: input.clientId,
    sellerId: input.sellerId,
    salesId: input.salesId,
    details: input.details,
  }
}

export function buildInvoiceEmissionIdentity(snapshot: InvoiceEmissionSnapshot): { fingerprint: string; salesId: string } {
  const fingerprint = invoiceAttemptFingerprint(snapshot)
  return { fingerprint, salesId: invoiceAttemptSalesId(snapshot.company_id, snapshot.canonical_bsale_token, fingerprint) }
}

export function chileToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

export function validateTargetInvoiceDocument(document: any, expectedSalesId: string): { ok: true } | { ok: false; reason: string } {
  if (Number(document?.document_type?.id) !== 5) return { ok: false, reason: 'DOCUMENT_TYPE_MISMATCH' }
  if (Number(document?.client?.id) !== TARGET_INVOICE_CASE.clientId) return { ok: false, reason: 'CLIENT_MISMATCH' }
  if (Number(document?.office?.id) !== TARGET_INVOICE_CASE.officeId) return { ok: false, reason: 'OFFICE_MISMATCH' }
  if (Number(document?.netAmount) !== 4704 || Number(document?.taxAmount) !== 894 || Number(document?.totalAmount) !== 5598) return { ok: false, reason: 'TOTALS_MISMATCH' }
  if (document?.salesId !== expectedSalesId) return { ok: false, reason: 'SALES_ID_MISMATCH' }
  const details = Array.isArray(document?.details?.items) ? document.details.items : []
  if (details.length !== 2) return { ok: false, reason: 'DETAIL_COUNT_MISMATCH' }
  const expected = new Map([[334790, 1], [334791, 1]])
  for (const detail of details) {
    const related = Number(detail.relatedDetailId)
    if (!expected.has(related) || Number(detail.quantity) !== expected.get(related)) return { ok: false, reason: 'RELATED_DETAIL_ID_NOT_PROVABLE' }
  }
  return { ok: true }
}
