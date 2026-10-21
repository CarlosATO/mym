import { createHash } from 'node:crypto'

export const INVOICE_ATTEMPT_STATUSES = [
  'PREPARED', 'LOCKED', 'UNKNOWN', 'CONFIRMED',
  'RECONCILIATION_REQUIRED', 'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'CANCELLED',
] as const

export type InvoiceAttemptStatus = typeof INVOICE_ATTEMPT_STATUSES[number]

export type FacturableSnapshot = {
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

/** Contract: UTF-8 SHA-256 hex of canonical JSON, with detail lines sorted by detail_id. */
export function invoiceAttemptFingerprint(snapshot: FacturableSnapshot): string {
  const canonical = stable({ ...snapshot, details: [...snapshot.details].sort((a, b) => Number(a.detail_id) - Number(b.detail_id)) })
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex')
}

/** Contract: full salesId first; if Bsale's 50-char limit is exceeded, hash the full candidate. */
export function invoiceAttemptSalesId(companyId: string, canonicalToken: string, fingerprint: string): string {
  const candidate = `PETGROUP:FACTURA:${companyId}:${canonicalToken}:${fingerprint}`
  return candidate.length <= 50 ? candidate : `PETGROUP:FACTURA:${createHash('sha256').update(candidate, 'utf8').digest('hex').slice(0, 32)}`
}

export function invoiceAttemptUsesCurrentNv(attempt: { current_bsale_nv_id: number }, requestedNvId: number): boolean {
  return attempt.current_bsale_nv_id === requestedNvId
}
