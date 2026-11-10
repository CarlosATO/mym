'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { bsaleFetchResourceForCompany } from '@/lib/bsale/client'
import { buildAuditCommercialReview } from '@/lib/logistica/audit-commercial-preview'
import { verifyAuditCommercialReview } from '@/lib/logistica/audit-commercial-review-token'
import { fingerprintCommercialVersion, type PreparationCommercialVersion } from '@/lib/logistica/preparation-commercial-version'
import type { AuditCommercialLine } from '@/lib/logistica/preparation-audit-commercial-verification'
import { requirePreparationCardAccess, requireWmsPermission } from './authorization'

/** Calling this action represents explicit approval of the supplied review. */
export async function confirmSalesOrderAuditCommercialAcceptance(params: {
  companyId: string; cardId: string; auditId: string; reviewedReference: string
}): Promise<{ data: { status: 'ACCEPTED' | 'ALREADY_ACCEPTED'; versionId: string } | null; error: string | null }> {
  try {
    const auth = await requireWmsPermission('logistica.audit.manage')
    if (auth.companyId !== params.companyId) throw new Error('COMPANY_ACCESS_DENIED')
    await requirePreparationCardAccess(auth, params.cardId)
    const db = createAdminClient().schema('logistica')
    const [card, audit, physical, commercialIncidents, auditIncidents] = await Promise.all([
      db.from('sales_order_preparation_cards').select('id,status,bsale_nv_id,bsale_nv_folio,canonical_bsale_token,current_bsale_nv_id').eq('company_id', auth.companyId).eq('id', params.cardId).maybeSingle(),
      db.from('sales_order_audits').select('id,status,cycle_no,package_count').eq('company_id', auth.companyId).eq('card_id', params.cardId).eq('id', params.auditId).maybeSingle(),
      db.rpc('audit_commercial_physical_snapshot_v1', { p_company_id: auth.companyId, p_card_id: params.cardId, p_audit_id: params.auditId }),
      db.from('sales_order_preparation_incidents').select('id').eq('company_id', auth.companyId).eq('card_id', params.cardId).eq('status', 'OPEN').limit(1),
      db.from('sales_order_audit_incidents').select('id').eq('company_id', auth.companyId).eq('audit_id', params.auditId).eq('status', 'OPEN').limit(1),
    ])
    if ([card, audit, physical, commercialIncidents, auditIncidents].some(result => result.error)) throw new Error('AUDIT_CONFIRM_DATABASE_ERROR')
    if (!card.data || card.data.status !== 'IN_AUDIT' || !audit.data || audit.data.status !== 'OPEN') throw new Error('AUDIT_NOT_OPEN')
    const signed = verifyAuditCommercialReview(params.reviewedReference, process.env.AUDIT_COMMERCIAL_REVIEW_SECRET ?? '', { actorId: auth.user.id, companyId: auth.companyId, cardId: params.cardId, auditId: params.auditId, cycleNo: audit.data.cycle_no })
    if (commercialIncidents.data?.length || auditIncidents.data?.length) throw new Error('AUDIT_OPEN_INCIDENTS')
    if (!physical.data) throw new Error('AUDIT_PHYSICAL_SNAPSHOT_INVALID')
    const [signedPhysicalHash, currentPhysicalHash] = await Promise.all([
      db.rpc('audit_commercial_snapshot_fingerprint_v1', { p_snapshot: signed.auditPhysical }),
      db.rpc('audit_commercial_snapshot_fingerprint_v1', { p_snapshot: physical.data }),
    ])
    if (signedPhysicalHash.error || currentPhysicalHash.error || typeof signedPhysicalHash.data !== 'string' || signedPhysicalHash.data !== currentPhysicalHash.data) throw new Error('AUDIT_PHYSICAL_SNAPSHOT_CHANGED')
    const previousResult = await db.from('sales_order_preparation_commercial_versions').select('id,fingerprint,version_snapshot').eq('company_id', auth.companyId).eq('card_id', params.cardId).eq('id', signed.previousVersionId).maybeSingle()
    if (previousResult.error || !previousResult.data || previousResult.data.fingerprint !== signed.previousFingerprint || !previousResult.data.version_snapshot || !card.data.canonical_bsale_token || !card.data.bsale_nv_folio) throw new Error('ACCEPTED_VERSION_INVALID')
    const previous = previousResult.data.version_snapshot as unknown as PreparationCommercialVersion
    if (!previous.identity || !Array.isArray(previous.lines) || !Array.isArray(previous.sourceDetails)) throw new Error('ACCEPTED_VERSION_INVALID')
    const physicalLines = signed.auditPhysical.lines as Array<Record<string, unknown>>
    const auditedLines = physicalLines.map(line => ({ bsale_detail_id: line.bsaleDetailId, bsale_variant_id: line.bsaleVariantId, sku: line.sku, product_name: line.productName, audit_quantity: line.auditQuantity })) as AuditCommercialLine[]
    const signal = AbortSignal.timeout(30_000)
    // No transaction or PostgreSQL lock is held during these independent GETs.
    const review = await buildAuditCommercialReview({ canonicalToken: card.data.canonical_bsale_token, folio: String(card.data.bsale_nv_folio), historicalBsaleId: Number(card.data.bsale_nv_id), previousVersionId: signed.previousVersionId, previousFingerprint: signed.previousFingerprint, previous, auditedLines, auditContext: { companyId: auth.companyId, cardId: params.cardId, auditId: params.auditId, packageCount: Number(signed.auditPhysical.packageCount) } },
      (path, query) => bsaleFetchResourceForCompany({ companyId: auth.companyId, path, params: query, signal, cache: 'no-store' }))
    if (review.preview.currentBsaleId !== Number(card.data.current_bsale_nv_id)) throw new Error('AUDIT_CURRENT_DOCUMENT_STALE')
    if (review.preview.reviewedReference !== signed.commercialReference) throw new Error('AUDIT_COMMERCIAL_REVIEW_CHANGED')
    if (!review.preview.eligible) throw new Error(`AUDIT_COMMERCIAL_NOT_ELIGIBLE: ${review.preview.errors.join(', ')}`)
    verifyAuditCommercialReview(params.reviewedReference, process.env.AUDIT_COMMERCIAL_REVIEW_SECRET ?? '', { actorId: auth.user.id, companyId: auth.companyId, cardId: params.cardId, auditId: params.auditId, cycleNo: audit.data.cycle_no })
    // A retry must reuse the original persisted fingerprint; fetchedAt changes on each GET.
    const findRequest = () => db.from('sales_order_audit_commercial_acceptance_requests').select('id,company_id,card_id,audit_id,actor_id,previous_version_id,previous_fingerprint,approved_fingerprint,version_snapshot').eq('id', signed.requestId).maybeSingle()
    let existingResult = await findRequest()
    if (existingResult.error) throw new Error('AUDIT_REQUEST_READ_FAILED')
    if (!existingResult.data) {
      const snapshot = { ...review.current, taxEvidence: review.taxEvidence, auditPhysical: signed.auditPhysical }
      const fp = await db.rpc('audit_commercial_snapshot_fingerprint_v1', { p_snapshot: snapshot })
      if (fp.error || typeof fp.data !== 'string' || !/^[0-9a-f]{64}$/.test(fp.data)) throw new Error('AUDIT_FINGERPRINT_FAILED')
      const versionFingerprint = fingerprintCommercialVersion(review.current).value
      const timestamp = new Date().toISOString()
      const inserted = await db.from('sales_order_audit_commercial_acceptance_requests').insert({ id: signed.requestId, company_id: auth.companyId, card_id: params.cardId, audit_id: params.auditId, actor_id: auth.user.id, previous_version_id: signed.previousVersionId, previous_fingerprint: signed.previousFingerprint, approved_fingerprint: fp.data, version_fingerprint: versionFingerprint, version_snapshot: snapshot, approval_evidence: { actorId: auth.user.id, auditId: params.auditId, fingerprint: fp.data, versionFingerprint, approved: true }, approved_at: timestamp, verified_at: timestamp })
      if (inserted.error && inserted.error.code !== '23505') throw new Error('AUDIT_REQUEST_WRITE_FAILED')
      existingResult = await findRequest()
      if (existingResult.error || !existingResult.data) throw new Error('AUDIT_REQUEST_READ_FAILED')
    }
    const request = existingResult.data
    if (!request || request.company_id !== auth.companyId || request.card_id !== params.cardId || request.audit_id !== params.auditId || request.actor_id !== auth.user.id || request.previous_version_id !== signed.previousVersionId || request.previous_fingerprint !== signed.previousFingerprint || typeof request.approved_fingerprint !== 'string') throw new Error('AUDIT_REQUEST_INVALID')
    verifyAuditCommercialReview(params.reviewedReference, process.env.AUDIT_COMMERCIAL_REVIEW_SECRET ?? '', { actorId: auth.user.id, companyId: auth.companyId, cardId: params.cardId, auditId: params.auditId, cycleNo: audit.data.cycle_no })
    const result = await db.rpc('accept_sales_order_audit_commercial_changes_v1', { p_company_id: auth.companyId, p_card_id: params.cardId, p_audit_id: params.auditId, p_request_id: signed.requestId, p_actor_id: auth.user.id, p_approved_fingerprint: request.approved_fingerprint })
    if (result.error) throw new Error(result.error.message)
    const value = result.data as { status?: string; versionId?: string } | null
    if (!value || (value.status !== 'ACCEPTED' && value.status !== 'ALREADY_ACCEPTED') || typeof value.versionId !== 'string') throw new Error('AUDIT_ACCEPTANCE_RESULT_INVALID')
    return { data: { status: value.status, versionId: value.versionId }, error: null }
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : 'AUDIT_ACCEPTANCE_UNAVAILABLE' }
  }
}
