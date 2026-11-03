import { createHash } from 'node:crypto'
import {
  resolveBsaleClientAddress,
  type BsaleAdditionalAddressItem,
  type BsaleAddressInput,
// @ts-expect-error Standalone Node test runner needs explicit TypeScript extensions.
} from './bsale-address-resolution.ts'

export type FacturableSnapshot = {
  company_id: string
  canonical_bsale_token: string
  current_bsale_nv_id: number
  client_id: number | null
  office_id: number | null
  sale_condition_id: string | null
  payment_type_id: number | null
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

export type InvoiceEmissionPayload = {
  documentTypeId: 5
  dispatch: 1
  officeId: number
  priceListId: number
  saleConditionId: number
  emissionDate: number
  expirationDate: number
  declareSii: 1
  clientId: number
  sellerId: number
  salesId: string
  addressId?: number
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

export function invoiceAddressResolutionEnabled(): boolean {
  return process.env.BSALE_INVOICE_ADDRESS_RESOLUTION_ENABLED === 'true'
}

export function buildInvoiceEmissionPayload(input: {
  officeId: number
  priceListId: number
  saleConditionId: number
  emissionDate: number
  expirationDate: number
  clientId: number
  sellerId: number
  salesId: string
  addressId?: number | null
  details: Array<{ detailId: number; quantity: number }>
  payments: Array<{ paymentTypeId: number; amount: number; recordDate: number }>
}): InvoiceEmissionPayload {
  const payload: InvoiceEmissionPayload = {
    documentTypeId: 5,
    dispatch: 1,
    officeId: input.officeId,
    priceListId: input.priceListId,
    saleConditionId: input.saleConditionId,
    emissionDate: input.emissionDate,
    expirationDate: input.expirationDate,
    declareSii: 1,
    clientId: input.clientId,
    sellerId: input.sellerId,
    salesId: input.salesId,
    details: input.details,
    payments: input.payments,
  }
  if (input.addressId != null && Number.isSafeInteger(input.addressId) && input.addressId > 0) {
    payload.addressId = input.addressId
  }
  return payload
}

/**
 * Aplica las decisiones de resolución de direcciones para la emisión de facturas (FAC-DIR-02B, Regla 4).
 * - ADDITIONAL_ADDRESS_MATCHED: retorna ok: true con addressId validado.
 * - PRIMARY_ADDRESS_MATCHED: retorna ok: true con addressId: null (omisión autorizada al haber coincidencia probada).
 * - ADDRESS_NOT_FOUND / AMBIGUOUS_MATCH / INSUFFICIENT_DATA: bloquea con ok: false y mensaje explicativo.
 */
export function resolveInvoiceEmissionAddress(input: {
  nv: BsaleAddressInput
  client: BsaleAddressInput | null | undefined
  clientAddresses: BsaleAdditionalAddressItem[]
}): { ok: true; addressId: number | null } | { ok: false; error: string; code: string } {
  const resolution = resolveBsaleClientAddress({
    salesOrder: {
      address: input.nv.address,
      municipality: input.nv.municipality,
      commune: input.nv.commune || input.nv.municipality,
      city: input.nv.city,
    },
    client: {
      address: input.client?.address,
      commune: input.client?.commune || input.client?.municipality,
      municipality: input.client?.municipality || input.client?.commune,
      city: input.client?.city,
    },
    bsaleAddresses: input.clientAddresses,
  })

  if (resolution.status === 'ADDITIONAL_ADDRESS_MATCHED') {
    return { ok: true, addressId: resolution.addressId }
  }
  if (resolution.status === 'PRIMARY_ADDRESS_MATCHED') {
    return { ok: true, addressId: null }
  }
  if (resolution.status === 'ADDRESS_NOT_FOUND') {
    const detail = resolution.reason === 'MATCHING_ADDRESS_IS_INACTIVE'
      ? 'La dirección de la Nota de Venta coincide con una dirección inactiva en Bsale.'
      : 'No se encontró una dirección coincidente para el cliente en Bsale.'
    return { ok: false, error: `Resolución de dirección fallida: ${detail}`, code: resolution.reason || resolution.status }
  }
  if (resolution.status === 'AMBIGUOUS_MATCH') {
    return { ok: false, error: 'Resolución de dirección fallida: múltiples direcciones activas coinciden con la Nota de Venta.', code: resolution.status }
  }
  return { ok: false, error: `Resolución de dirección fallida: datos insuficientes en la Nota de Venta (${resolution.reason ?? ''}).`, code: resolution.status }
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

export function validateInvoiceDocument(document: any, expected: {
  salesId: string
  clientId: number
  officeId: number
  totals: { net: number; tax: number; total: number }
  details: Array<{
    detailId: number
    quantity: number
  }>
}): { ok: true; audit?: { code: 'INVOICE_TOTAL_DIFFERENCE_ACCEPTED'; totalDifference: number; limit: number } } | { ok: false; reason: string } {
  if (Number(document?.document_type?.id) !== 5) return { ok: false, reason: 'DOCUMENT_TYPE_MISMATCH' }
  if (Number(document?.client?.id) !== expected.clientId) return { ok: false, reason: 'CLIENT_MISMATCH' }
  if (Number(document?.office?.id) !== expected.officeId) return { ok: false, reason: 'OFFICE_MISMATCH' }
  if (document?.salesId !== expected.salesId) return { ok: false, reason: 'SALES_ID_MISMATCH' }
  const invoiceTotal = Number(document?.totalAmount)
  const totalDifference = invoiceTotal - expected.totals.total
  if (!Number.isFinite(invoiceTotal) || Math.abs(totalDifference) > 5) return { ok: false, reason: 'TOTALS_MISMATCH' }
  const details = Array.isArray(document?.details?.items) ? document.details.items : []
  if (details.length !== expected.details.length) return { ok: false, reason: 'DETAIL_COUNT_MISMATCH' }
  const expectedDetails = new Map<number, (typeof expected.details)[number]>()
  for (const expectedDetail of expected.details) {
    if (expectedDetails.has(expectedDetail.detailId)) return { ok: false, reason: 'RELATED_DETAIL_ID_NOT_PROVABLE' }
    expectedDetails.set(expectedDetail.detailId, expectedDetail)
  }
  const seenRelatedDetailIds = new Set<number>()
  for (const detail of details) {
    const related = Number(detail.relatedDetailId)
    const expectedDetail = expectedDetails.get(related)
    if (!expectedDetail || seenRelatedDetailIds.has(related) || Number(detail.quantity) !== expectedDetail.quantity) return { ok: false, reason: 'RELATED_DETAIL_ID_NOT_PROVABLE' }
    seenRelatedDetailIds.add(related)
  }
  if (totalDifference === 0) return { ok: true }
  return { ok: true, audit: { code: 'INVOICE_TOTAL_DIFFERENCE_ACCEPTED', totalDifference, limit: 5 } }
}

export function validateCompleteInvoiceLines(
  current: Array<{ detailId: number; quantity: number }>,
  mirrored: Array<{ detailId: number; quantity: number }>,
  linkedInvoiceCount: number,
): { ok: true } | { ok: false; reason: string } {
  if (linkedInvoiceCount > 0) return { ok: false, reason: 'INVOICE_ALREADY_LINKED' }
  if (current.length === 0 || current.length !== mirrored.length) return { ok: false, reason: 'DETAIL_LINES_MISMATCH' }
  const mirroredById = new Map(mirrored.map(line => [line.detailId, line.quantity]))
  for (const line of current) {
    if (line.quantity <= 0 || mirroredById.get(line.detailId) !== line.quantity) return { ok: false, reason: 'DETAIL_QUANTITY_MISMATCH' }
  }
  return { ok: true }
}
