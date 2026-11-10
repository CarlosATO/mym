import { createHash } from 'node:crypto'
// @ts-expect-error The local strip-types test runner resolves the source extension directly.
import { planAuditCommercialAcceptance, type AuditCommercialTaxEvidence } from './audit-commercial-acceptance-plan.ts'
import type { PreparationCommercialVersion } from './preparation-commercial-version.ts'
import type { AuditCommercialLine } from './preparation-audit-commercial-verification.ts'

type Json = Record<string, unknown>
type FetchResource = (path: string, params?: Record<string, string | number>) => Promise<unknown>

function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('BSALE_RESPONSE_INCOMPLETE')
  return value as Json
}
function number(value: unknown): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !/^-?\d+(?:\.\d+)?$/.test(value))) throw new Error('BSALE_NUMBER_INVALID')
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error('BSALE_NUMBER_INVALID')
  return n
}
function id(value: unknown, allowZero = false): number {
  const n = number(value)
  if (!Number.isSafeInteger(n) || n < (allowZero ? 0 : 1) || (typeof value === 'string' && !/^\d+$/.test(value))) throw new Error('BSALE_ID_INVALID')
  return n
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('BSALE_TEXT_INVALID')
  return value.trim()
}
async function all(fetch: FetchResource, path: string, params: Record<string, string | number> = {}): Promise<Json[]> {
  const result: Json[] = []
  let count: number | undefined
  for (let page = 0; page < 100; page++) {
    const response = object(await fetch(path, { ...params, limit: 50, offset: result.length }))
    const total = id(response.count, true)
    if (count !== undefined && count !== total) throw new Error('BSALE_PAGINATION_INCONSISTENT')
    count = total
    if (response.offset != null && id(response.offset, true) !== result.length) throw new Error('BSALE_PAGINATION_INCONSISTENT')
    if (!Array.isArray(response.items) || response.items.length > 50) throw new Error('BSALE_PAGINATION_INCONSISTENT')
    result.push(...response.items.map(object))
    if (result.length === count) return result
    if (result.length > count || response.items.length === 0) throw new Error('BSALE_PAGINATION_INCOMPLETE')
  }
  throw new Error('BSALE_PAGINATION_INCOMPLETE')
}

export type AuditCommercialPreviewInput = {
  canonicalToken: string
  folio: string
  historicalBsaleId: number
  previousVersionId: string
  previousFingerprint: string
  previous: PreparationCommercialVersion
  auditedLines: AuditCommercialLine[]
}

/** Read-only preview. reviewedReference is a digest for subsequent revalidation,
 * not an authorization or the PostgreSQL approval fingerprint. */
export async function buildAuditCommercialPreview(input: AuditCommercialPreviewInput, fetch: FetchResource) {
  const { previous, canonicalToken, folio } = input
  if (!canonicalToken || !folio || previous.identity?.canonicalToken !== canonicalToken || !input.previousVersionId || !input.previousFingerprint) throw new Error('ACCEPTED_VERSION_INVALID')
  const oldId = id(previous.physicalId)
  if (id(previous.identity.currentBsaleId) !== oldId) throw new Error('ACCEPTED_VERSION_INVALID')
  const candidates = await all(fetch, '/documents.json', { documenttypeid: 23, number: folio })
  const matches = candidates.filter(row => String(row.number) === folio && row.token === canonicalToken && id(object(row.document_type).id) === 23)
  if (!matches.length) throw new Error('BSALE_DOCUMENT_NOT_FOUND')
  const sorted = matches.map(row => ({ id: id(row.id), generation: number(row.generationDate) })).sort((a, b) => b.generation - a.generation || b.id - a.id)
  if (new Set(sorted.map(row => row.id)).size !== sorted.length) throw new Error('BSALE_DOCUMENT_AMBIGUOUS')
  const currentId = sorted[0].id
  const [oldDocRaw, currentDocRaw] = await Promise.all([fetch(`/documents/${oldId}.json`), fetch(`/documents/${currentId}.json`)])
  const oldDoc = object(oldDocRaw); const currentDoc = object(currentDocRaw)
  for (const [doc, expectedId, version] of [[oldDoc, oldId, previous], [currentDoc, currentId, null]] as const) {
    if (id(doc.id) !== expectedId || String(doc.number) !== folio || doc.token !== canonicalToken || id(object(doc.document_type).id) !== 23) throw new Error('BSALE_DOCUMENT_IDENTITY_MISMATCH')
    if (number(doc.exemptAmount) !== 0) throw new Error('BSALE_EXEMPT_DOCUMENT')
    if (version && (number(doc.netAmount) !== version.netAmount || number(doc.taxAmount) !== version.taxAmount || number(doc.totalAmount) !== version.totalAmount)) throw new Error('BSALE_HISTORICAL_DOCUMENT_MISMATCH')
  }
  if (id(currentDoc.state, true) !== 0) throw new Error('BSALE_CURRENT_DOCUMENT_INACTIVE')
  const details = await all(fetch, `/documents/${currentId}/details.json`)
  const current: PreparationCommercialVersion = {
    identity: { canonicalToken, historicalBsaleId: input.historicalBsaleId, currentBsaleId: currentId, folio }, physicalId: currentId,
    lines: details.map(row => ({ detailId: id(row.id), variantId: id(object(row.variant).id), sku: text(object(row.variant).code), productName: typeof row.description === 'string' ? row.description : null,
      quantity: number(row.quantity), unitNetValue: number(row.netUnitValue), lineNetAmount: number(row.netAmount), lineTaxAmount: number(row.taxAmount), lineGrossAmount: number(row.totalAmount), lineNumber: row.lineNumber == null ? null : id(row.lineNumber, true) })),
    netAmount: number(currentDoc.netAmount), taxAmount: number(currentDoc.taxAmount), totalAmount: number(currentDoc.totalAmount),
    sourceDetails: details.map(row => ({ ...row, id: id(row.id), netDiscount: number(row.netDiscount) })),
  }
  const documentEvidence = async (doc: Json, documentId: number) => {
    const source = `/documents/${documentId}/document_taxes.json`
    const taxes = await all(fetch, source)
    if (taxes.length !== 1) throw new Error('BSALE_DOCUMENT_TAX_AMBIGUOUS')
    const row = taxes[0]
    id(row.id)
    if (number(row.exemptAmount) !== 0 || number(row.totalAmount) !== number(doc.taxAmount)) throw new Error('BSALE_DOCUMENT_TAX_MISMATCH')
    return { id: documentId, taxIds: [id(object(row.tax).id)], exemptAmount: number(doc.exemptAmount), taxAmount: number(doc.taxAmount), source }
  }
  const [previousDocument, currentDocument] = await Promise.all([documentEvidence(oldDoc, oldId), documentEvidence(currentDoc, currentId)])
  if (previousDocument.taxIds[0] !== currentDocument.taxIds[0]) throw new Error('BSALE_DOCUMENT_TAX_MISMATCH')
  const taxId = currentDocument.taxIds[0]; const taxSource = `/taxes/${taxId}.json`
  const tax = object(await fetch(taxSource))
  if (id(tax.id) !== taxId || id(tax.state, true) !== 0) throw new Error('BSALE_TAX_INVALID')
  const products = await Promise.all(current.lines.map(async line => {
    const variantId = id(line.variantId); const variant = object(await fetch(`/variants/${variantId}.json`))
    if (id(variant.id) !== variantId || text(variant.code) !== line.sku) throw new Error('BSALE_VARIANT_MISMATCH')
    const productId = id(object(variant.product).id); const source = `/products/${productId}/product_taxes.json`
    const taxes = await all(fetch, source)
    const taxIds = taxes.map(row => { id(row.id); return id(object(row.tax).id) })
    if (taxIds.length !== 1 || taxIds[0] !== taxId) throw new Error('BSALE_PRODUCT_TAX_MISMATCH')
    return { variantId, productId, taxIds, source }
  }))
  const taxEvidence: AuditCommercialTaxEvidence = { canonicalToken, fetchedAt: new Date().toISOString(), tax: { id: taxId, code: typeof tax.code === 'number' ? String(tax.code) : text(tax.code), percentage: number(tax.percentage), active: true, source: taxSource }, previousDocument, currentDocument, products }
  const plan = planAuditCommercialAcceptance({ previous, current, auditedLines: input.auditedLines, taxEvidence })
  // The timestamp changes on each read; bind the actual evidence rather than its collection time.
  const { fetchedAt: _fetchedAt, ...stableEvidence } = taxEvidence
  const reviewedReference = createHash('sha256').update(JSON.stringify({ previousVersionId: input.previousVersionId, previousFingerprint: input.previousFingerprint, current, taxEvidence: stableEvidence })).digest('hex')
  return { eligible: plan.eligible, differences: plan.differences, errors: plan.errors, reviewedReference, currentBsaleId: currentId, previousVersionId: input.previousVersionId, historicalTaxRateCertified: false as const }
}
