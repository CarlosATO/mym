export type InvoiceStockVerificationDetail = {
  variantId?: number
  sku?: string
  quantity: number
}

export type InvoiceStockVerificationInput = {
  companyId: string
  invoiceId: number
  invoiceNumber?: number | string
  salesId?: string
  officeId: number
  details: InvoiceStockVerificationDetail[]
}

export type InvoiceStockVerificationStatus = 'VERIFIED' | 'PENDING' | 'UNABLE_TO_VERIFY'

export type InvoiceStockVerificationResult = {
  status: InvoiceStockVerificationStatus
  invoiceId: number
  reasons: string[]
  expected: Array<InvoiceStockVerificationDetail & { key: string }>
  observed: {
    active: Array<{ shippingId: number; officeId: number; variantId: number | null; sku: string | null; quantity: number }>
    inactiveShippingIds: number[]
    wrongOfficeShippingIds: number[]
  }
  evidence: {
    shippingIds: number[]
    activeShippingIds: number[]
    costsAvailable: boolean
  }
}

type BsaleDocument = {
  id?: number | string
  number?: number | string
  salesId?: string | null
  state?: number | string
  document_type?: { id?: number | string }
  documentTypeId?: number | string
  office?: { id?: number | string }
  officeId?: number | string
  details?: { items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>
}

type BsaleShipping = {
  id?: number | string
  state?: number | string
  office?: { id?: number | string }
  officeId?: number | string
}

type BsaleShippingDetail = {
  quantity?: number | string
  variant?: { id?: number | string; code?: string | null }
  variantId?: number | string
  variantCode?: string | null
}

export type InvoiceStockVerificationTransport = {
  getResource<T>(path: string, params?: Record<string, string | number>): Promise<T>
  getCollection<T>(path: string, params?: Record<string, string | number>): Promise<T[]>
  getCosts?(invoiceId: number): Promise<unknown>
}

function numeric(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function sku(value: unknown): string | null {
  if (value == null || String(value).trim() === '') return null
  return String(value).trim().toUpperCase()
}

function productKey(detail: { variantId?: unknown; sku?: unknown }): string | null {
  const variantId = numeric(detail.variantId)
  if (variantId != null && variantId > 0) return `variant:${variantId}`
  const code = sku(detail.sku)
  return code ? `sku:${code}` : null
}

function documentDetails(document: BsaleDocument): Array<Record<string, unknown>> {
  if (Array.isArray(document.details)) return document.details
  return Array.isArray(document.details?.items) ? document.details.items : []
}

function detailIdentity(detail: BsaleShippingDetail | Record<string, unknown>) {
  const variant = (detail as BsaleShippingDetail).variant
  return {
    variantId: numeric(variant?.id ?? (detail as BsaleShippingDetail).variantId ?? (detail as Record<string, unknown>).id),
    sku: sku(variant?.code ?? (detail as BsaleShippingDetail).variantCode ?? (detail as Record<string, unknown>).sku),
    quantity: numeric(detail.quantity),
  }
}

function aggregate(details: InvoiceStockVerificationDetail[]) {
  const result = new Map<string, number>()
  for (const detail of details) {
    const key = productKey(detail)
    if (key) result.set(key, (result.get(key) ?? 0) + detail.quantity)
  }
  return result
}

/** Reads Bsale only; it never changes invoices, attempts, stock, or Supabase. */
export async function verifyInvoiceStockDispatch(
  input: InvoiceStockVerificationInput,
  transport: InvoiceStockVerificationTransport = createDefaultTransport(input.companyId),
): Promise<InvoiceStockVerificationResult> {
  const expected = input.details.map(detail => ({ ...detail, sku: sku(detail.sku) ?? undefined, key: productKey(detail) ?? '' }))
  const base = {
    invoiceId: input.invoiceId,
    expected,
    observed: { active: [], inactiveShippingIds: [], wrongOfficeShippingIds: [] },
    evidence: { shippingIds: [], activeShippingIds: [], costsAvailable: false },
  }
  if (!Number.isSafeInteger(input.invoiceId) || input.invoiceId <= 0 || !Number.isSafeInteger(input.officeId) || input.officeId <= 0 || input.details.length === 0 || expected.some(detail => !detail.key || !Number.isFinite(detail.quantity) || detail.quantity <= 0)) {
    return { ...base, status: 'UNABLE_TO_VERIFY', reasons: ['INVALID_EXPECTED_IDENTITY'] }
  }

  try {
    const document = await transport.getResource<BsaleDocument>(`/documents/${input.invoiceId}.json`, { expand: 'details' })
    const documentId = numeric(document.id)
    const documentTypeId = numeric(document.document_type?.id ?? document.documentTypeId)
    const documentOfficeId = numeric(document.office?.id ?? document.officeId)
    const identityReasons: string[] = []
    if (documentId !== input.invoiceId) identityReasons.push('INVOICE_ID_MISMATCH')
    if (documentTypeId !== 5) identityReasons.push('DOCUMENT_TYPE_NOT_INVOICE')
    if (numeric(document.state) !== 0) identityReasons.push('INVOICE_INACTIVE')
    if (documentOfficeId !== input.officeId) identityReasons.push('INVOICE_OFFICE_MISMATCH')
    if (input.invoiceNumber != null && String(document.number) !== String(input.invoiceNumber)) identityReasons.push('INVOICE_NUMBER_MISMATCH')
    if (input.salesId != null && document.salesId !== input.salesId) identityReasons.push('SALES_ID_MISMATCH')
    const invoiceLines = documentDetails(document).map(detail => ({
      variantId: numeric((detail.variant as Record<string, unknown> | undefined)?.id ?? detail.variantId),
      sku: sku((detail.variant as Record<string, unknown> | undefined)?.code ?? detail.variantCode),
      quantity: numeric(detail.quantity),
    }))
    if (invoiceLines.length === 0 || invoiceLines.some(detail => detail.quantity == null || !productKey(detail))) identityReasons.push('INVOICE_DETAILS_INCOMPLETE')
    const expectedTotals = aggregate(input.details)
    const invoiceTotals = aggregate(invoiceLines.flatMap(detail => detail.quantity != null && productKey(detail)
      ? [{ variantId: detail.variantId ?? undefined, sku: detail.sku ?? undefined, quantity: detail.quantity }]
      : []))
    if (expectedTotals.size !== invoiceTotals.size || [...expectedTotals].some(([key, quantity]) => invoiceTotals.get(key) !== quantity)) identityReasons.push('INVOICE_DETAILS_MISMATCH')
    if (identityReasons.length > 0) return { ...base, status: 'UNABLE_TO_VERIFY', reasons: identityReasons }

    const shippings = await transport.getCollection<BsaleShipping>('/shippings.json', { documentid: input.invoiceId })
    const observed = { active: [] as InvoiceStockVerificationResult['observed']['active'], inactiveShippingIds: [] as number[], wrongOfficeShippingIds: [] as number[] }
    const shippingIds: number[] = []
    const activeShippingIds: number[] = []
    const activeQuantities: InvoiceStockVerificationDetail[] = []
    for (const shipping of shippings) {
      const shippingId = numeric(shipping.id)
      const shippingOfficeId = numeric(shipping.office?.id ?? shipping.officeId)
      if (shippingId == null || shippingOfficeId == null) return { ...base, status: 'UNABLE_TO_VERIFY', reasons: ['SHIPPING_ID_OR_OFFICE_MISSING'] }
      shippingIds.push(shippingId)
      const active = numeric(shipping.state) === 0
      if (!active) {
        observed.inactiveShippingIds.push(shippingId)
        continue
      }
      if (shippingOfficeId !== input.officeId) {
        observed.wrongOfficeShippingIds.push(shippingId)
        continue
      }
      const details = await transport.getCollection<BsaleShippingDetail>(`/shippings/${shippingId}/details.json`)
      if (details.length === 0) return { ...base, status: 'UNABLE_TO_VERIFY', reasons: ['ACTIVE_SHIPPING_DETAILS_INCOMPLETE'], evidence: { shippingIds, activeShippingIds, costsAvailable: false }, observed }
      activeShippingIds.push(shippingId)
      for (const detail of details) {
        const identity = detailIdentity(detail)
        if (identity.quantity == null || !productKey(identity)) return { ...base, status: 'UNABLE_TO_VERIFY', reasons: ['SHIPPING_DETAILS_INCOMPLETE'], evidence: { shippingIds, activeShippingIds, costsAvailable: false }, observed }
        activeQuantities.push({ variantId: identity.variantId ?? undefined, sku: identity.sku ?? undefined, quantity: identity.quantity })
        observed.active.push({ shippingId, officeId: shippingOfficeId, variantId: identity.variantId, sku: identity.sku, quantity: identity.quantity })
      }
    }

    let costsAvailable = false
    if (transport.getCosts) {
      try {
        await transport.getCosts(input.invoiceId)
        costsAvailable = true
      } catch {
        // Costs corroborate the shipping but are not sufficient or required evidence.
      }
    }
    const activeTotals = aggregate(activeQuantities)
    const matches = activeTotals.size === expectedTotals.size && [...expectedTotals].every(([key, quantity]) => activeTotals.get(key) === quantity)
    const hasUnexpectedProduct = [...activeTotals].some(([key]) => !expectedTotals.has(key))
    const reasons = matches && !hasUnexpectedProduct && observed.wrongOfficeShippingIds.length === 0
      ? []
      : [
          ...(activeShippingIds.length === 0 ? ['NO_ACTIVE_SHIPPING'] : []),
          ...(observed.inactiveShippingIds.length > 0 ? ['INACTIVE_SHIPPING_NOT_EFFECTIVE'] : []),
          ...(observed.wrongOfficeShippingIds.length > 0 ? ['SHIPPING_OFFICE_MISMATCH'] : []),
          ...(!matches || hasUnexpectedProduct ? ['SHIPPING_PRODUCTS_OR_QUANTITIES_MISMATCH'] : []),
        ]
    return { invoiceId: input.invoiceId, status: reasons.length === 0 ? 'VERIFIED' : 'PENDING', reasons, expected, observed, evidence: { shippingIds, activeShippingIds, costsAvailable } }
  } catch {
    return { ...base, status: 'UNABLE_TO_VERIFY', reasons: ['BSALE_READ_FAILED'] }
  }
}

function createDefaultTransport(companyId: string): InvoiceStockVerificationTransport {
  return {
    getResource: async <T>(path: string, params?: Record<string, string | number>) => {
      const { bsaleFetchResourceForCompany } = await import('@/lib/bsale/client')
      return bsaleFetchResourceForCompany<T>({ companyId, path, params })
    },
    getCollection: async <T>(path: string, params?: Record<string, string | number>) => {
      const { bsaleFetchAllForCompany } = await import('@/lib/bsale/client')
      return bsaleFetchAllForCompany<T>({ companyId, path, params })
    },
    getCosts: async invoiceId => {
      const { bsaleFetchResourceForCompany } = await import('@/lib/bsale/client')
      return bsaleFetchResourceForCompany({ companyId, path: '/documents/costs.json', params: { documentid: invoiceId } })
    },
  }
}

export type InvoiceStockEvidenceLine = {
  line_key: string
  variant_id: number | null
  sku: string | null
  expected_quantity: number
  dispatched_quantity: number
  shipping_ids: number[]
}

export type InvoiceStockEvidencePayloadInput = {
  companyId: string
  attemptId: string
  invoiceBsaleId: number
  salesId: string
  attemptFingerprint: string
  officeId: number
  verification: InvoiceStockVerificationResult
  rawEvidence?: Record<string, unknown>
  verifiedAt?: string
}

export type InvoiceStockEvidenceRpcPayload = {
  p_company_id: string
  p_attempt_id: string
  p_invoice_bsale_id: number
  p_sales_id: string
  p_attempt_fingerprint: string
  p_office_id: number
  p_shipping_ids: number[]
  p_active_shipping_ids: number[]
  p_lines: InvoiceStockEvidenceLine[]
  p_raw_evidence: Record<string, unknown>
  p_verified_at: string
}

export function buildInvoiceStockEvidenceLines(
  observedActive: InvoiceStockVerificationResult['observed']['active'],
  expectedLines?: InvoiceStockVerificationResult['expected']
): InvoiceStockEvidenceLine[] {
  const lineMap = new Map<string, {
    line_key: string
    variant_id: number | null
    sku: string | null
    dispatched_quantity: number
    shipping_ids: Set<number>
  }>()

  for (const item of observedActive) {
    const rawVariant = Number(item.variantId)
    const variantId = Number.isSafeInteger(rawVariant) && rawVariant > 0 ? rawVariant : null
    const rawSku = item.sku != null ? String(item.sku).trim().toUpperCase() : null
    const skuCode = rawSku && rawSku !== '' ? rawSku : null

    const key = variantId != null ? `variant:${variantId}` : (skuCode ? `sku:${skuCode}` : null)
    if (!key) continue

    const existing = lineMap.get(key)
    const qty = Number(item.quantity) || 0
    const shippingId = Number(item.shippingId)
    const validShippingId = Number.isSafeInteger(shippingId) && shippingId > 0 ? shippingId : null

    if (!existing) {
      lineMap.set(key, {
        line_key: key,
        variant_id: variantId,
        sku: variantId != null ? (skuCode ?? null) : skuCode,
        dispatched_quantity: qty,
        shipping_ids: new Set(validShippingId ? [validShippingId] : []),
      })
    } else {
      existing.dispatched_quantity += qty
      if (validShippingId) existing.shipping_ids.add(validShippingId)
      if (!existing.sku && skuCode) existing.sku = skuCode
    }
  }

  if (expectedLines) {
    for (const exp of expectedLines) {
      const expVariant = Number(exp.variantId)
      const variantId = Number.isSafeInteger(expVariant) && expVariant > 0 ? expVariant : null
      const expSku = exp.sku != null ? String(exp.sku).trim().toUpperCase() : null
      const key = exp.key || (variantId != null ? `variant:${variantId}` : (expSku ? `sku:${expSku}` : ''))
      const line = lineMap.get(key)
      if (line && !line.sku && expSku) {
        line.sku = expSku
      }
    }
  }

  return Array.from(lineMap.values()).map(line => ({
    line_key: line.line_key,
    variant_id: line.variant_id,
    sku: line.sku,
    expected_quantity: line.dispatched_quantity,
    dispatched_quantity: line.dispatched_quantity,
    shipping_ids: Array.from(line.shipping_ids).sort((a, b) => a - b),
  }))
}

export function buildInvoiceStockEvidencePayload(input: InvoiceStockEvidencePayloadInput): InvoiceStockEvidenceRpcPayload {
  const verifiedAt = input.verifiedAt ?? new Date().toISOString()
  const shippingIds = Array.from(new Set(
    (input.verification.evidence?.shippingIds ?? []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0)
  )).sort((a, b) => a - b)

  const activeShippingIds = Array.from(new Set(
    (input.verification.evidence?.activeShippingIds ?? []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0)
  )).sort((a, b) => a - b)

  const lines = buildInvoiceStockEvidenceLines(
    input.verification.observed?.active ?? [],
    input.verification.expected
  )

  const rawEvidence = input.rawEvidence ?? {
    status: input.verification.status,
    invoiceId: input.verification.invoiceId,
    reasons: input.verification.reasons,
    costsAvailable: input.verification.evidence?.costsAvailable ?? false,
    observedActiveCount: input.verification.observed?.active?.length ?? 0,
    inactiveShippingIds: input.verification.observed?.inactiveShippingIds ?? [],
    wrongOfficeShippingIds: input.verification.observed?.wrongOfficeShippingIds ?? [],
  }

  return {
    p_company_id: input.companyId,
    p_attempt_id: input.attemptId,
    p_invoice_bsale_id: input.invoiceBsaleId,
    p_sales_id: input.salesId,
    p_attempt_fingerprint: input.attemptFingerprint,
    p_office_id: input.officeId,
    p_shipping_ids: shippingIds,
    p_active_shipping_ids: activeShippingIds,
    p_lines: lines,
    p_raw_evidence: rawEvidence,
    p_verified_at: verifiedAt,
  }
}
