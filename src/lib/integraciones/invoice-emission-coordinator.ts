export type ControlledInvoiceStatus = 'SUBMITTING' | 'UNKNOWN' | 'RECONCILIATION_REQUIRED' | 'CONFIRMED'

export type ControlledInvoiceInput = {
  salesId: string
  fingerprint: string
  payload: Record<string, unknown>
  expected: Omit<ControlledInvoiceDocument, 'salesId' | 'documentTypeId' | 'details'> & { details: Array<{ relatedDetailId: number; quantity: number }> }
}

export type ControlledInvoiceDocument = {
  salesId: string
  documentTypeId: number
  clientId: number
  officeId: number
  netAmount: number
  taxAmount: number
  totalAmount: number
  details: Array<{ relatedDetailId: number; quantity: number }>
}

export type ControlledInvoiceTransport = {
  post: (payload: Record<string, unknown>) => Promise<ControlledInvoiceDocument>
}

export function createControlledInvoiceCoordinator(transport: ControlledInvoiceTransport) {
  const attempts = new Map<string, { input: ControlledInvoiceInput; status: ControlledInvoiceStatus; document?: ControlledInvoiceDocument }>()
  const inFlight = new Map<string, Promise<{ status: ControlledInvoiceStatus; document?: ControlledInvoiceDocument }>>()

  const validate = (input: ControlledInvoiceInput, document: ControlledInvoiceDocument) => (
    document.salesId === input.salesId
    && document.documentTypeId === 5
    && document.clientId === input.expected.clientId
    && document.officeId === input.expected.officeId
    && document.netAmount === input.expected.netAmount
    && document.taxAmount === input.expected.taxAmount
    && document.totalAmount === input.expected.totalAmount
    && document.details.length === input.expected.details.length
    && document.details.every(detail => input.expected.details.some(expected => expected.relatedDetailId === detail.relatedDetailId && expected.quantity === detail.quantity))
  )

  async function emit(input: ControlledInvoiceInput, enabled: boolean) {
    if (!enabled) return { status: 'RECONCILIATION_REQUIRED' as const, reason: 'EMISSION_DISABLED' }
    const existing = attempts.get(input.salesId)
    if (existing && existing.input.fingerprint !== input.fingerprint) return { status: 'RECONCILIATION_REQUIRED' as const, reason: 'FINGERPRINT_CHANGED' }
    if (existing?.status === 'CONFIRMED') return { status: existing.status, document: existing.document }
    if (existing?.status === 'UNKNOWN' || existing?.status === 'RECONCILIATION_REQUIRED') return { status: existing.status, document: existing.document }
    const pending = inFlight.get(input.salesId)
    if (pending) return pending

    attempts.set(input.salesId, { input, status: 'SUBMITTING' })
    const run = transport.post(input.payload)
      .then(document => {
        const attempt = attempts.get(input.salesId)
        if (!attempt || !validate(input, document)) {
          if (attempt) attempt.status = 'RECONCILIATION_REQUIRED'
          return { status: 'RECONCILIATION_REQUIRED' as const }
        }
        attempt.status = 'CONFIRMED'
        attempt.document = document
        return { status: 'CONFIRMED' as const, document }
      })
      .catch(() => {
        const attempt = attempts.get(input.salesId)
        if (attempt) attempt.status = 'UNKNOWN'
        return { status: 'UNKNOWN' as const }
      })
      .finally(() => inFlight.delete(input.salesId))
    inFlight.set(input.salesId, run)
    return run
  }

  function reconcile(salesId: string, document: ControlledInvoiceDocument) {
    const attempt = attempts.get(salesId)
    if (!attempt || attempt.input.salesId !== document.salesId || !validate(attempt.input, document)) {
      return { status: 'RECONCILIATION_REQUIRED' as const }
    }
    attempt.status = 'CONFIRMED'
    attempt.document = document
    return { status: 'CONFIRMED' as const, document }
  }

  return { emit, reconcile, attempts }
}
