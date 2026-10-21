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
export const TARGET_INVOICE_SALES_ID = 'PETGROUP:FACTURA:586cf837a6a4e6a7d82a2a20e0772017' as const

export type InvoiceEmissionPayload = {
  documentTypeId: 5
  officeId: number
  priceListId: number
  emissionDate: number
  expirationDate: number
  declareSii: 1
  clientId: number
  sellerId: number
  salesId: string
  details: Array<{ detailId: number; quantity: number }>
  payments: Array<{ paymentTypeId: number; amount: number; recordDate: number }>
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
  emissionDate: number
  expirationDate: number
  clientId: number
  sellerId: number
  salesId: string
  details: Array<{ detailId: number; quantity: number }>
  payments: Array<{ paymentTypeId: number; amount: number; recordDate: number }>
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
    payments: input.payments,
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

/** Converts a Chile calendar date to Bsale's UTC-midnight Unix date. */
export function chileDateToBsaleEpoch(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) throw new Error(`INVALID_CHILE_DATE:${date}`)
  const epoch = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 1000
  if (!Number.isInteger(epoch)) throw new Error(`INVALID_BSALE_DATE:${date}`)
  return epoch
}

function sanitizeBsaleBody(body: string | undefined): string {
  if (!body) return ''
  try {
    const redact = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(redact)
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          /token|authorization|secret|password/i.test(key) ? '[REDACTED]' : redact(item),
        ]))
      }
      return value
    }
    return JSON.stringify(redact(JSON.parse(body))).slice(0, 700)
  } catch {
    return body.replace(/(access_token|authorization|token|secret|password)\s*[:=]\s*[^,\s]+/gi, '$1=[REDACTED]').slice(0, 700)
  }
}

export function formatBsaleRejection(input: { status?: number; message: string; body?: string }): string {
  const body = sanitizeBsaleBody(input.body)
  return ['BSALE_REJECTED', input.status == null ? null : `http_status=${input.status}`, `message=${input.message}`, body ? `body=${body}` : null].filter(Boolean).join('|').slice(0, 1000)
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
