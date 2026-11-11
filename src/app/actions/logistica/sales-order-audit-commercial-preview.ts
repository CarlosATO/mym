'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { randomUUID } from 'node:crypto'
import { bsaleFetchResourceForCompany } from '@/lib/bsale/client'
import { buildAuditCommercialPreview } from '@/lib/logistica/audit-commercial-preview'
import { signAuditCommercialReview } from '@/lib/logistica/audit-commercial-review-token'
import type { PreparationCommercialVersion } from '@/lib/logistica/preparation-commercial-version'
import type { AuditCommercialLine } from '@/lib/logistica/preparation-audit-commercial-verification'
import { requirePreparationCardAccess, requireWmsPermission } from './authorization'

/** Read-only preview. The signed reference is not an approval or an RPC fingerprint. */
export async function previewSalesOrderAuditCommercialAcceptance(params: { companyId: string; cardId: string; auditId: string }): Promise<{
  data: (Omit<Awaited<ReturnType<typeof buildAuditCommercialPreview>>, 'reviewedReference'> & { reviewedReference: string | null }) | null
  error: string | null
}> {
  try {
    const auth = await requireWmsPermission('logistica.audit.manage')
    if (auth.companyId !== params.companyId) throw new Error('COMPANY_ACCESS_DENIED')
    await requirePreparationCardAccess(auth, params.cardId)
    const db = createAdminClient().schema('logistica')
    const [card, audit, physical, version, commercialIncidents, auditIncidents] = await Promise.all([
      db.from('sales_order_preparation_cards').select('id,status,bsale_nv_id,bsale_nv_folio,canonical_bsale_token,current_bsale_nv_id').eq('company_id', auth.companyId).eq('id', params.cardId).maybeSingle(),
      db.from('sales_order_audits').select('id,status,package_count,cycle_no').eq('company_id', auth.companyId).eq('card_id', params.cardId).eq('id', params.auditId).maybeSingle(),
      db.rpc('audit_commercial_physical_snapshot_v1', { p_company_id: auth.companyId, p_card_id: params.cardId, p_audit_id: params.auditId }),
      db.from('sales_order_preparation_commercial_versions').select('id,company_id,card_id,canonical_bsale_token,historical_bsale_nv_id,current_bsale_nv_id,fingerprint,version_snapshot').eq('company_id', auth.companyId).eq('card_id', params.cardId).order('sequence_no', { ascending: false }).limit(1).maybeSingle(),
      db.from('sales_order_preparation_incidents').select('id').eq('company_id', auth.companyId).eq('card_id', params.cardId).eq('status', 'OPEN').limit(1),
      db.from('sales_order_audit_incidents').select('id').eq('company_id', auth.companyId).eq('audit_id', params.auditId).eq('status', 'OPEN').limit(1),
    ])
    if ([card, audit, physical, version, commercialIncidents, auditIncidents].some(result => result.error)) throw new Error('AUDIT_PREVIEW_DATABASE_ERROR')
    if (!card.data || card.data.status !== 'IN_AUDIT' || !audit.data || audit.data.status !== 'OPEN') throw new Error('AUDIT_NOT_OPEN')
    if (!audit.data.package_count || audit.data.package_count < 1) throw new Error('AUDIT_PACKAGES_REQUIRED')
    if (commercialIncidents.data?.length || auditIncidents.data?.length) throw new Error('AUDIT_OPEN_INCIDENTS')
    const snapshot = physical.data as { companyId?: unknown; cardId?: unknown; auditId?: unknown; cycleNo?: unknown; packageCount?: unknown; lines?: unknown } | null
    if (!snapshot || snapshot.companyId !== auth.companyId || snapshot.cardId !== params.cardId || snapshot.auditId !== params.auditId || snapshot.cycleNo !== audit.data.cycle_no || snapshot.packageCount !== audit.data.package_count || !Array.isArray(snapshot.lines) || !snapshot.lines.length) throw new Error('AUDIT_PHYSICAL_SNAPSHOT_INVALID')
    const physicalLines = snapshot.lines as Array<Record<string, unknown>>
    if (physicalLines.some(line => !line || line.companyId !== auth.companyId || line.cardId !== params.cardId || line.lineStatus !== 'CONFIRMED' || typeof line.auditQuantity !== 'number' || typeof line.preparedQuantity !== 'number' || line.auditQuantity !== line.preparedQuantity || line.excluded !== false || typeof line.bsaleDetailId !== 'number' || (line.bsaleVariantId !== null && typeof line.bsaleVariantId !== 'number') || (line.sku !== null && typeof line.sku !== 'string') || typeof line.productName !== 'string')) throw new Error('AUDIT_PHYSICAL_LINES_NOT_CONFORMING')
    if (!card.data.canonical_bsale_token || !card.data.bsale_nv_folio || !version.data?.id || !version.data.fingerprint || !version.data.version_snapshot || typeof version.data.version_snapshot !== 'object') throw new Error('ACCEPTED_VERSION_INVALID')
    const previous = version.data.version_snapshot as unknown as PreparationCommercialVersion
    if (!previous.identity || !Array.isArray(previous.lines) || !Array.isArray(previous.sourceDetails)) throw new Error('ACCEPTED_VERSION_INVALID')
    const signal = AbortSignal.timeout(30_000)
    const auditedLines = physicalLines.map(line => ({ bsale_detail_id: line.bsaleDetailId, bsale_variant_id: line.bsaleVariantId, sku: line.sku, product_name: line.productName, audit_quantity: line.auditQuantity })) as AuditCommercialLine[]
    const result = await buildAuditCommercialPreview({ canonicalToken: card.data.canonical_bsale_token, folio: String(card.data.bsale_nv_folio), historicalBsaleId: Number(card.data.bsale_nv_id), previousVersionId: version.data.id, previousFingerprint: version.data.fingerprint, previous, previousRecord: { id: version.data.id, companyId: version.data.company_id, cardId: version.data.card_id, canonicalToken: version.data.canonical_bsale_token, historicalBsaleId: Number(version.data.historical_bsale_nv_id), currentBsaleId: Number(version.data.current_bsale_nv_id) }, auditedLines, auditContext: { companyId: auth.companyId, cardId: params.cardId, auditId: params.auditId, packageCount: audit.data.package_count } },
      (path, query) => bsaleFetchResourceForCompany({ companyId: auth.companyId, path, params: query, signal, cache: 'no-store' }))
    if (result.currentBsaleId !== Number(card.data.current_bsale_nv_id)) throw new Error('AUDIT_CURRENT_DOCUMENT_STALE')
    const reviewedReference = result.eligible ? signAuditCommercialReview({ requestId: randomUUID(), companyId: auth.companyId, cardId: params.cardId, auditId: params.auditId, actorId: auth.user.id, previousVersionId: version.data.id, previousFingerprint: version.data.fingerprint, commercialReference: result.reviewedReference, auditPhysical: snapshot as Record<string, unknown>, issuedAt: Date.now() }, process.env.AUDIT_COMMERCIAL_REVIEW_SECRET ?? '') : null
    return { data: { ...result, reviewedReference }, error: null }
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : 'AUDIT_PREVIEW_UNAVAILABLE' }
  }
}
