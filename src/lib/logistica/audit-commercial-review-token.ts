import { createHmac, timingSafeEqual } from 'node:crypto'

/** Server-only authenticated record of the exact review; it is not approval. */
export type AuditCommercialReviewToken = {
  requestId: string
  companyId: string
  cardId: string
  auditId: string
  actorId: string
  previousVersionId: string
  previousFingerprint: string
  commercialReference: string
  auditPhysical: Record<string, unknown>
  issuedAt: number
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const digest = /^[0-9a-f]{64}$/
const maxAgeMs = 15 * 60 * 1000

function key(secret: string): Buffer {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('AUDIT_REVIEW_SECRET_NOT_CONFIGURED')
  const value = Buffer.from(secret, 'base64url')
  if (value.length !== 32 || value.toString('base64url') !== secret) throw new Error('AUDIT_REVIEW_SECRET_NOT_CONFIGURED')
  return value
}

function valid(value: unknown): value is AuditCommercialReviewToken {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as AuditCommercialReviewToken
  return [v.requestId, v.companyId, v.cardId, v.auditId, v.actorId, v.previousVersionId].every(item => typeof item === 'string' && uuid.test(item))
    && typeof v.previousFingerprint === 'string' && v.previousFingerprint.length > 0 && v.previousFingerprint.length <= 4096
    && typeof v.commercialReference === 'string' && digest.test(v.commercialReference)
    && !!v.auditPhysical && typeof v.auditPhysical === 'object' && !Array.isArray(v.auditPhysical)
    && v.auditPhysical.companyId === v.companyId && v.auditPhysical.cardId === v.cardId && v.auditPhysical.auditId === v.auditId
    && Number.isSafeInteger(v.auditPhysical.cycleNo) && Number(v.auditPhysical.cycleNo) > 0
    && Number.isSafeInteger(v.auditPhysical.packageCount) && Number(v.auditPhysical.packageCount) > 0
    && Array.isArray(v.auditPhysical.lines) && v.auditPhysical.lines.length > 0
    && Number.isSafeInteger(v.issuedAt)
}

export function signAuditCommercialReview(value: AuditCommercialReviewToken, secret: string): string {
  if (!valid(value)) throw new Error('AUDIT_REVIEW_INVALID')
  const payload = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  const signature = createHmac('sha256', key(secret)).update(`audit-commercial-review-v1.${payload}`).digest('base64url')
  const token = `v1.${payload}.${signature}`
  if (token.length > 262144) throw new Error('AUDIT_REVIEW_TOO_LARGE')
  return token
}

/** The expected identity and cycle must come from the authenticated server context. */
export function verifyAuditCommercialReview(token: string, secret: string, expectedContext: { actorId: string; companyId: string; cardId: string; auditId: string; cycleNo: number }, now = Date.now()): AuditCommercialReviewToken {
  if (typeof token !== 'string' || token.length > 262144) throw new Error('AUDIT_REVIEW_INVALID')
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1' || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) throw new Error('AUDIT_REVIEW_INVALID')
  const signature = Buffer.from(parts[2], 'base64url')
  const expected = createHmac('sha256', key(secret)).update(`audit-commercial-review-v1.${parts[1]}`).digest()
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected) || signature.toString('base64url') !== parts[2]) throw new Error('AUDIT_REVIEW_INVALID')
  let review: unknown
  try { review = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) } catch { throw new Error('AUDIT_REVIEW_INVALID') }
  if (!valid(review) || review.issuedAt > now || now - review.issuedAt > maxAgeMs
    || review.actorId !== expectedContext.actorId || review.companyId !== expectedContext.companyId
    || review.cardId !== expectedContext.cardId || review.auditId !== expectedContext.auditId
    || review.auditPhysical.cycleNo !== expectedContext.cycleNo) throw new Error('AUDIT_REVIEW_INVALID')
  return review
}
