'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { bsaleFetchResourceForCompany } from '@/lib/bsale/client'
import { buildAuditCommercialPreview } from '@/lib/logistica/audit-commercial-preview'
import type { PreparationCommercialVersion } from '@/lib/logistica/preparation-commercial-version'
import type { AuditCommercialLine } from '@/lib/logistica/preparation-audit-commercial-verification'
import { requirePreparationCardAccess, requireWmsPermission } from './authorization'

/** Read-only preview. reviewedReference is an opaque digest to revalidate in a
 * future confirmation; it is not an approval, an RPC fingerprint, or a guarantee
 * that Bsale or the audit will remain unchanged. No evidence comes from input. */
export async function previewSalesOrderAuditCommercialAcceptance(params: { companyId: string; cardId: string; auditId: string }): Promise<{
  data: Awaited<ReturnType<typeof buildAuditCommercialPreview>> | null
  error: string | null
}> {
  try {
    const auth = await requireWmsPermission('logistica.audit.manage')
    if (auth.companyId !== params.companyId) throw new Error('COMPANY_ACCESS_DENIED')
    await requirePreparationCardAccess(auth, params.cardId)
    const db = createAdminClient().schema('logistica')
    const [card, audit, lines, version, commercialIncidents, auditIncidents] = await Promise.all([
      db.from('sales_order_preparation_cards').select('id,status,bsale_nv_id,bsale_nv_folio,canonical_bsale_token,current_bsale_nv_id').eq('company_id', auth.companyId).eq('id', params.cardId).maybeSingle(),
      db.from('sales_order_audits').select('id,status,package_count').eq('company_id', auth.companyId).eq('card_id', params.cardId).eq('id', params.auditId).maybeSingle(),
      db.from('sales_order_audit_lines').select('bsale_detail_id,bsale_variant_id,sku,product_name,audit_quantity,prepared_quantity_snapshot,line_status,excluded_from_dispatch_snapshot').eq('company_id', auth.companyId).eq('card_id', params.cardId).eq('audit_id', params.auditId),
      db.from('sales_order_preparation_commercial_versions').select('id,fingerprint,version_snapshot').eq('company_id', auth.companyId).eq('card_id', params.cardId).order('sequence_no', { ascending: false }).limit(1).maybeSingle(),
      db.from('sales_order_preparation_incidents').select('id').eq('company_id', auth.companyId).eq('card_id', params.cardId).eq('status', 'OPEN').limit(1),
      db.from('sales_order_audit_incidents').select('id').eq('company_id', auth.companyId).eq('audit_id', params.auditId).eq('status', 'OPEN').limit(1),
    ])
    if ([card, audit, lines, version, commercialIncidents, auditIncidents].some(result => result.error)) throw new Error('AUDIT_PREVIEW_DATABASE_ERROR')
    if (!card.data || card.data.status !== 'IN_AUDIT' || !audit.data || audit.data.status !== 'OPEN') throw new Error('AUDIT_NOT_OPEN')
    if (!audit.data.package_count || audit.data.package_count < 1) throw new Error('AUDIT_PACKAGES_REQUIRED')
    if (commercialIncidents.data?.length || auditIncidents.data?.length) throw new Error('AUDIT_OPEN_INCIDENTS')
    if (!lines.data?.length || lines.data.some(line => line.line_status !== 'CONFIRMED' || line.audit_quantity == null || Number(line.audit_quantity) !== Number(line.prepared_quantity_snapshot) || line.excluded_from_dispatch_snapshot !== false)) throw new Error('AUDIT_PHYSICAL_LINES_NOT_CONFORMING')
    if (!card.data.canonical_bsale_token || !card.data.bsale_nv_folio || !version.data?.id || !version.data.fingerprint || !version.data.version_snapshot || typeof version.data.version_snapshot !== 'object') throw new Error('ACCEPTED_VERSION_INVALID')
    const previous = version.data.version_snapshot as unknown as PreparationCommercialVersion
    if (!previous.identity || !Array.isArray(previous.lines) || !Array.isArray(previous.sourceDetails)) throw new Error('ACCEPTED_VERSION_INVALID')
    const signal = AbortSignal.timeout(30_000)
    const result = await buildAuditCommercialPreview({ canonicalToken: card.data.canonical_bsale_token, folio: String(card.data.bsale_nv_folio), historicalBsaleId: Number(card.data.bsale_nv_id), previousVersionId: version.data.id, previousFingerprint: version.data.fingerprint, previous, auditedLines: lines.data.map(line => ({ ...line, audit_quantity: Number(line.audit_quantity) })) as AuditCommercialLine[] },
      (path, query) => bsaleFetchResourceForCompany({ companyId: auth.companyId, path, params: query, signal, cache: 'no-store' }))
    if (result.currentBsaleId !== Number(card.data.current_bsale_nv_id)) throw new Error('AUDIT_CURRENT_DOCUMENT_STALE')
    return { data: result, error: null }
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : 'AUDIT_PREVIEW_UNAVAILABLE' }
  }
}
