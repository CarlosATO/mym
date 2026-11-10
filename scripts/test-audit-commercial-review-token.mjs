import assert from 'node:assert/strict'
import test from 'node:test'
import { signAuditCommercialReview, verifyAuditCommercialReview } from '../src/lib/logistica/audit-commercial-review-token.ts'

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const secret = Buffer.alloc(32, 42).toString('base64url')
const review = { requestId: id(1), companyId: id(2), cardId: id(3), auditId: id(4), actorId: id(5), previousVersionId: id(6), previousFingerprint: 'previous', commercialReference: 'a'.repeat(64), issuedAt: 1000,
  auditPhysical: { companyId: id(2), cardId: id(3), auditId: id(4), cycleNo: 2, packageCount: 8, lines: [{ id: id(7), auditQuantity: 4 }] } }
const context = { companyId: id(2), cardId: id(3), auditId: id(4), actorId: id(5), cycleNo: 2 }

test('referencia autenticada preserva el snapshot y su vencimiento', () => {
  const token = signAuditCommercialReview(review, secret)
  assert.deepEqual(verifyAuditCommercialReview(token, secret, context, 1001), review)
  assert.throws(() => verifyAuditCommercialReview(token, secret, context, 1000 + 15 * 60 * 1000 + 1), /AUDIT_REVIEW_INVALID/)
})

test('rechaza payload o firma manipulados, identidad incoherente y secreto débil', () => {
  const token = signAuditCommercialReview(review, secret)
  const parts = token.split('.')
  const changed = { ...review, auditPhysical: { ...review.auditPhysical, packageCount: 9 } }
  assert.throws(() => verifyAuditCommercialReview(`v1.${Buffer.from(JSON.stringify(changed)).toString('base64url')}.${parts[2]}`, secret, context, 1001), /AUDIT_REVIEW_INVALID/)
  for (const changedReview of [{ ...review, commercialReference: 'b'.repeat(64) }, { ...review, auditPhysical: { ...review.auditPhysical, lines: [{ id: id(7), auditQuantity: 3 }] } }, { ...review, previousFingerprint: 'other' }]) {
    assert.throws(() => verifyAuditCommercialReview(`v1.${Buffer.from(JSON.stringify(changedReview)).toString('base64url')}.${parts[2]}`, secret, context, 1001), /AUDIT_REVIEW_INVALID/)
  }
  assert.throws(() => verifyAuditCommercialReview(token, Buffer.alloc(32, 43).toString('base64url'), context, 1001), /AUDIT_REVIEW_INVALID/)
  assert.throws(() => verifyAuditCommercialReview(token, secret, context, 999), /AUDIT_REVIEW_INVALID/)
  for (const field of ['actorId', 'companyId', 'cardId', 'auditId']) assert.throws(() => verifyAuditCommercialReview(token, secret, { ...context, [field]: id(9) }, 1001), /AUDIT_REVIEW_INVALID/)
  assert.throws(() => verifyAuditCommercialReview(token, secret, { ...context, cycleNo: 3 }, 1001), /AUDIT_REVIEW_INVALID/)
  assert.throws(() => signAuditCommercialReview({ ...review, auditId: id(9) }, secret), /AUDIT_REVIEW_INVALID/)
  assert.throws(() => signAuditCommercialReview(review, 'short'), /AUDIT_REVIEW_SECRET_NOT_CONFIGURED/)
})
