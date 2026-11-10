import { createHash } from 'node:crypto'
// @ts-expect-error The local strip-types test runner resolves the source extension directly.
import { compareAuditedCommercialLines, type AuditCommercialLine } from './preparation-audit-commercial-verification.ts'
// @ts-expect-error The local strip-types test runner resolves the source extension directly.
import { compareCommercialVersions, type PreparationCommercialVersion } from './preparation-commercial-version.ts'

// Include the original payloads: the existing normalized fingerprint does not
// include source discount or tax attributes. This token is for optimistic
// concurrency, not a substitute for validating the fields themselves.
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function fingerprintAuditCommercialApproval(version: PreparationCommercialVersion): string {
  return createHash('sha256').update(stableJson(version)).digest('hex')
}

export type AuditCommercialAcceptancePlan = {
  eligible: boolean
  fingerprint: string
  previousFingerprint: string
  differences: ReturnType<typeof compareCommercialVersions>['differences']
  errors: string[]
  humanApprovalRequired: true
  historicalTaxRateCertified: false
  taxEvidenceFingerprint: string | null
}

/** Only a trusted server that fetched the referenced Bsale resources may supply this.
 * Never deserialize browser-provided evidence and pass it to this function. */
export type AuditCommercialTaxEvidence = {
  canonicalToken: string
  fetchedAt: string
  tax: { id: number; code: string; percentage: number; active: boolean; source: string }
  previousDocument: { id: number; taxIds: number[]; exemptAmount: number; taxAmount: number; source: string }
  currentDocument: { id: number; taxIds: number[]; exemptAmount: number; taxAmount: number; source: string }
  products: Array<{ variantId: number; productId: number; taxIds: number[]; source: string }>
}

// Match PostgreSQL numeric multiplication exactly, avoiding binary float rounding.
function decimal(value: number): [bigint, number] | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value))
  if (!match) return null
  const coefficient = BigInt(`${match[1]}${match[2]}${match[3] ?? ''}`)
  return [coefficient, (match[3]?.length ?? 0) - Number(match[4] ?? 0)]
}

function proportionalExact(a: number, b: number, oldQuantity: number, newQuantity: number): boolean {
  const values = [a, b, oldQuantity, newQuantity].map(decimal)
  if (values.some(value => value === null)) return false
  const [oldAmount, newAmount, oldQty, newQty] = values as [bigint, number][]
  const left = oldAmount[0] * newQty[0]
  const right = newAmount[0] * oldQty[0]
  const leftScale = oldAmount[1] + newQty[1]
  const rightScale = newAmount[1] + oldQty[1]
  return leftScale >= rightScale
    ? left === right * BigInt(10) ** BigInt(leftScale - rightScale)
    : left * BigInt(10) ** BigInt(rightScale - leftScale) === right
}

function exactSumEquals(values: number[], total: number): boolean {
  const parts = [...values, total].map(decimal)
  if (parts.some(value => value === null)) return false
  const numbers = parts as [bigint, number][]
  const scale = Math.max(...numbers.map(value => value[1]))
  const integers = numbers.map(([coefficient, exponent]) => coefficient * BigInt(10) ** BigInt(scale - exponent))
  return integers.slice(0, -1).reduce((sum, value) => sum + value, BigInt(0)) === integers[integers.length - 1]
}

// CLP positive amounts: nearest peso, exact half rounds away from zero.
function roundedProductEquals(left: number, right: number, divisor: number, expected: number): boolean {
  const parts = [left, right, divisor].map(decimal)
  if (parts.some(part => part === null) || !Number.isSafeInteger(expected) || expected < 0 || left < 0 || right < 0 || divisor <= 0) return false
  const [a, b, d] = parts as [bigint, number][]
  let numerator = a[0] * b[0]
  let denominator = d[0]
  const scale = a[1] + b[1] - d[1]
  if (scale >= 0) denominator *= BigInt(10) ** BigInt(scale)
  else numerator *= BigInt(10) ** BigInt(-scale)
  if (denominator <= BigInt(0)) return false
  const rounded = (numerator * BigInt(2) + denominator) / (denominator * BigInt(2))
  return rounded === BigInt(expected)
}

function validTaxEvidence(e: AuditCommercialTaxEvidence | undefined, previous: PreparationCommercialVersion, current: PreparationCommercialVersion): e is AuditCommercialTaxEvidence {
  if (!e || !e.tax || !e.previousDocument || !e.currentDocument || !Array.isArray(e.products)) return false
  const { tax } = e
  if (!Number.isSafeInteger(tax.id) || tax.id <= 0 || !tax.code || tax.active !== true
    || typeof tax.percentage !== 'number' || !Number.isFinite(tax.percentage) || tax.percentage < 0 || tax.percentage > 100
    || tax.source !== `/taxes/${tax.id}.json` || !Number.isFinite(Date.parse(e.fetchedAt))
    || !e.canonicalToken || e.canonicalToken !== previous.identity.canonicalToken || e.canonicalToken !== current.identity.canonicalToken) return false
  for (const [doc, version] of [[e.previousDocument, previous], [e.currentDocument, current]] as const) {
    if (!Number.isSafeInteger(doc.id) || doc.id <= 0 || doc.id !== version.physicalId
      || doc.source !== `/documents/${doc.id}/document_taxes.json`
      || !Array.isArray(doc.taxIds) || doc.taxIds.length !== 1 || doc.taxIds[0] !== tax.id
      || doc.exemptAmount !== 0 || doc.taxAmount !== version.taxAmount) return false
  }
  if (e.products.length !== current.lines.length) return false
  return current.lines.every(line => {
    const matches = e.products.filter(product => product && typeof product === 'object' && product.variantId === line.variantId)
    if (matches.length !== 1) return false
    const product = matches[0]
    return Number.isSafeInteger(product.productId) && product.productId > 0
      && product.source === `/products/${product.productId}/product_taxes.json`
      && Array.isArray(product.taxIds) && product.taxIds.length === 1 && product.taxIds[0] === tax.id
  })
}

function sourceDetail(row: Record<string, unknown>): Record<string, unknown> {
  const raw = row.raw_json
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : row
}

/** Conservative comparison: missing or non-proportional commercial evidence fails closed. */
export function planAuditCommercialAcceptance(input: {
  previous: PreparationCommercialVersion
  current: PreparationCommercialVersion
  auditedLines: AuditCommercialLine[]
  /** Constructed from independent server-side Bsale GETs, never from client input. */
  taxEvidence?: AuditCommercialTaxEvidence
}): AuditCommercialAcceptancePlan {
  const { previous, current, auditedLines, taxEvidence } = input
  const comparison = compareCommercialVersions(previous, current)
  const errors: string[] = []
  const fiscalEvidenceValid = validTaxEvidence(taxEvidence, previous, current)
  if (!fiscalEvidenceValid) errors.push('TAX_EVIDENCE_INCOMPLETE_OR_AMBIGUOUS')
  if (!comparison.sameIdentity || comparison.conflicts.length) errors.push('IDENTITY_AMBIGUOUS')
  if (!current.identity.canonicalToken || current.physicalId !== current.identity.currentBsaleId) errors.push('IDENTITY_AMBIGUOUS')
  if (!auditedLines.length || compareAuditedCommercialLines(auditedLines, current).status !== 'READY_TO_INVOICE') errors.push('AUDITED_QUANTITIES_MISMATCH')
  if (!Array.isArray(previous.sourceDetails) || !Array.isArray(current.sourceDetails)) errors.push('SOURCE_DETAILS_MISSING')
  if (!previous.lines.length || previous.lines.length !== current.lines.length || auditedLines.length !== current.lines.length) errors.push('LINE_COUNT_MISMATCH')
  // The normalized comparator does not report a source-only discount change.
  // Check every line, including those it considers unchanged.
  for (const oldLine of previous.lines) {
    if (!Number.isSafeInteger(oldLine.variantId) || Number(oldLine.variantId) < 0) {
      errors.push('SOURCE_LINE_IDENTITY_AMBIGUOUS')
      continue
    }
    const matches = current.lines.filter(line => line.variantId === oldLine.variantId)
    if (matches.length !== 1 || previous.lines.filter(line => line.variantId === oldLine.variantId).length !== 1 || auditedLines.filter(line => line.bsale_variant_id === oldLine.variantId).length !== 1) {
      errors.push('SOURCE_LINE_IDENTITY_AMBIGUOUS')
      continue
    }
    const newLine = matches[0]
    if ((oldLine.sku ?? '').replace(/^ +| +$/g, '') !== (newLine.sku ?? '').replace(/^ +| +$/g, '')) errors.push('SOURCE_LINE_IDENTITY_AMBIGUOUS')
    if (!(oldLine.quantity > 0 && newLine.quantity > 0 && newLine.quantity <= oldLine.quantity)) errors.push('INVALID_QUANTITY')
    if (typeof oldLine.unitNetValue !== 'number' || !Number.isFinite(oldLine.unitNetValue) || oldLine.unitNetValue !== newLine.unitNetValue) errors.push('UNIT_PRICE_CHANGED_OR_MISSING')
    if (typeof oldLine.lineNetAmount !== 'number' || typeof newLine.lineNetAmount !== 'number'
      || !proportionalExact(oldLine.lineNetAmount, newLine.lineNetAmount, oldLine.quantity, newLine.quantity)) errors.push('NET_AMOUNT_NOT_PROPORTIONAL')
    const oldSource = previous.sourceDetails?.map(sourceDetail).filter(row => row.id != null && oldLine.detailId != null && String(row.id) === String(oldLine.detailId) && typeof row.netDiscount === 'number') ?? []
    const newSource = current.sourceDetails?.map(sourceDetail).filter(row => row.id != null && newLine.detailId != null && String(row.id) === String(newLine.detailId) && typeof row.netDiscount === 'number') ?? []
    if (oldSource.length !== 1 || newSource.length !== 1) {
      errors.push('DISCOUNT_EVIDENCE_MISSING')
    } else {
      const oldDiscount = Number(oldSource[0].netDiscount)
      const newDiscount = Number(newSource[0].netDiscount)
      // Bsale's discount semantics can differ by document; require explicit zero
      // until a supported, independently verified discount rule is available.
      if (oldDiscount !== 0 || newDiscount !== 0 || !proportionalExact(oldDiscount, newDiscount, oldLine.quantity, newLine.quantity)) errors.push('DISCOUNT_CHANGED')
    }
    if (fiscalEvidenceValid) for (const line of [oldLine, newLine]) {
      if (typeof line.unitNetValue !== 'number' || typeof line.lineNetAmount !== 'number'
        || !roundedProductEquals(line.quantity, line.unitNetValue, 1, line.lineNetAmount)) errors.push('NET_AMOUNT_INVALID')
      if (typeof line.lineNetAmount !== 'number' || typeof line.lineTaxAmount !== 'number'
        || !roundedProductEquals(line.lineNetAmount, taxEvidence.tax.percentage, 100, line.lineTaxAmount)) errors.push('TAX_AMOUNT_INVALID')
      if (typeof line.lineNetAmount !== 'number' || typeof line.lineTaxAmount !== 'number' || typeof line.lineGrossAmount !== 'number'
        || !exactSumEquals([line.lineNetAmount, line.lineTaxAmount], line.lineGrossAmount)) errors.push('GROSS_AMOUNT_INVALID')
    }
  }

  for (const difference of comparison.differences) {
    if (difference.confidence !== 'CERTAIN' || !difference.previous || !difference.current || !['QUANTITY_DECREASED', 'VALUE_CHANGED'].includes(difference.kind)) {
      errors.push('UNSUPPORTED_COMMERCIAL_CHANGE')
      continue
    }
  }
  for (const version of [previous, current]) {
    for (const [total, lineField] of [['netAmount', 'lineNetAmount'], ['taxAmount', 'lineTaxAmount'], ['totalAmount', 'lineGrossAmount']] as const) {
      const values = version.lines.map(line => line[lineField])
      if (typeof version[total] !== 'number' || values.some(value => typeof value !== 'number' || !Number.isFinite(value)) || !exactSumEquals(values as number[], version[total])) errors.push(`${total}_INCONSISTENT_OR_MISSING`)
    }
  }
  return {
    eligible: errors.length === 0,
    fingerprint: fingerprintAuditCommercialApproval(current),
    previousFingerprint: fingerprintAuditCommercialApproval(previous),
    differences: comparison.differences,
    errors: [...new Set(errors)],
    humanApprovalRequired: true,
    historicalTaxRateCertified: false,
    taxEvidenceFingerprint: fiscalEvidenceValid ? createHash('sha256').update(stableJson(taxEvidence)).digest('hex') : null,
  }
}
