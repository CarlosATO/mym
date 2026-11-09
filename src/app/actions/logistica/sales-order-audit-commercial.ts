'use server'

import { createHash } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireWmsPermission } from './authorization'
import { createBsalePreparationCommercialProvider } from '@/lib/logistica/preparation-commercial-bsale-provider'
import { compareAuditedCommercialLines, type AuditCommercialDifference } from '@/lib/logistica/preparation-audit-commercial-verification'
import type { PreparationCommercialVersion } from '@/lib/logistica/preparation-commercial-version'

export type SalesOrderAuditCommercialVerification = {
  id: string
  status: 'READY_TO_INVOICE' | 'INCIDENTS' | 'BLOCKED'
  current_bsale_nv_id: number | null
  canonical_bsale_token: string | null
  reason: string
  differences: AuditCommercialDifference[]
  verified_at: string
}

type CardRow = {
  id: string
  company_id: string
  status: string
  bsale_nv_id: number
  bsale_nv_folio: string | null
  canonical_bsale_token: string | null
  current_bsale_nv_id: number | null
}

type AuditLineRow = {
  bsale_detail_id: number
  bsale_variant_id: number | null
  sku: string | null
  product_name: string
  audit_quantity: number | null
}

const liveVerificationInFlight = new Map<string, Promise<PreparationCommercialVersion>>()

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function asVersion(value: unknown): PreparationCommercialVersion | null {
  if (!value || typeof value !== 'object') return null
  const version = value as PreparationCommercialVersion
  return Array.isArray(version.lines) && version.identity != null ? version : null
}

async function getCurrentVersionOnce(identity: Parameters<ReturnType<typeof createBsalePreparationCommercialProvider>['getCurrentVersion']>[0]): Promise<PreparationCommercialVersion> {
  const key = `${identity.companyId}:${identity.canonicalToken ?? `folio:${identity.folio ?? 'unknown'}`}`
  const existing = liveVerificationInFlight.get(key)
  if (existing) return existing
  const request = createBsalePreparationCommercialProvider().getCurrentVersion(identity, AbortSignal.timeout(30_000))
  liveVerificationInFlight.set(key, request)
  try {
    return await request
  } finally {
    liveVerificationInFlight.delete(key)
  }
}

async function persistVerification(input: {
  companyId: string
  cardId: string
  auditId: string
  status: SalesOrderAuditCommercialVerification['status']
  currentBsaleNvId: number | null
  canonicalToken: string | null
  reason: string
  differences: AuditCommercialDifference[]
  snapshot: Record<string, unknown>
  fingerprint: string
}): Promise<SalesOrderAuditCommercialVerification> {
  const { data, error } = await createAdminClient().schema('logistica').rpc('record_sales_order_audit_commercial_verification_v1', {
    p_company_id: input.companyId,
    p_card_id: input.cardId,
    p_audit_id: input.auditId,
    p_status: input.status,
    p_current_bsale_nv_id: input.currentBsaleNvId,
    p_canonical_bsale_token: input.canonicalToken,
    p_reason: input.reason,
    p_fingerprint: input.fingerprint,
    p_snapshot: input.snapshot,
    p_differences: input.differences,
  })
  if (error || !data) throw new Error(error?.message ?? 'No se pudo registrar la verificación comercial.')
  return data as SalesOrderAuditCommercialVerification
}

export async function verifySalesOrderAuditCommercial(params: {
  auditId: string
  cardId: string
  companyId: string
}): Promise<{ data: SalesOrderAuditCommercialVerification | null; error: string | null }> {
  try {
    const auth = await requireWmsPermission('logistica.audit.manage')
    if (auth.companyId !== params.companyId) return { data: null, error: 'Empresa activa inválida.' }

    const db = createAdminClient()
    const [{ data: card, error: cardError }, { data: audit, error: auditError }, { data: lines, error: linesError }, { data: storedVersion, error: versionError }] = await Promise.all([
      db.schema('logistica').from('sales_order_preparation_cards').select('id, company_id, status, bsale_nv_id, bsale_nv_folio, canonical_bsale_token, current_bsale_nv_id').eq('id', params.cardId).eq('company_id', params.companyId).maybeSingle(),
      db.schema('logistica').from('sales_order_audits').select('id, status, card_id').eq('id', params.auditId).eq('card_id', params.cardId).eq('company_id', params.companyId).maybeSingle(),
      db.schema('logistica').from('sales_order_audit_lines').select('bsale_detail_id, bsale_variant_id, sku, product_name, audit_quantity').eq('audit_id', params.auditId).eq('card_id', params.cardId).eq('company_id', params.companyId).order('bsale_detail_id', { ascending: true }),
      db.schema('logistica').from('sales_order_preparation_commercial_versions').select('version_snapshot').eq('company_id', params.companyId).eq('card_id', params.cardId).order('sequence_no', { ascending: false }).limit(1).maybeSingle(),
    ])
    if (cardError || !card) return { data: null, error: cardError?.message ?? 'Tarjeta no encontrada.' }
    if (auditError || !audit) return { data: null, error: auditError?.message ?? 'Auditoría no encontrada.' }
    if (linesError || versionError) return { data: null, error: linesError?.message ?? versionError?.message ?? 'No se pudo leer la referencia comercial.' }
    const cardRow = card as CardRow
    if (cardRow.status !== 'IN_AUDIT' || audit.status !== 'OPEN') return { data: null, error: 'La auditoría ya no está disponible para verificación.' }

    const identity = {
      companyId: params.companyId,
      cardId: params.cardId,
      status: cardRow.status,
      canonicalToken: cardRow.canonical_bsale_token,
      historicalBsaleId: cardRow.bsale_nv_id,
      currentBsaleId: cardRow.current_bsale_nv_id,
      folio: cardRow.bsale_nv_folio,
    }
    const auditedLines = (lines ?? []).map(row => ({ ...row, audit_quantity: row.audit_quantity == null ? NaN : Number(row.audit_quantity) })) as AuditLineRow[]
    const acceptedVersion = asVersion((storedVersion as { version_snapshot?: unknown } | null)?.version_snapshot)
    const baseSnapshot = { cardId: params.cardId, auditId: params.auditId, identity, auditedLines, acceptedVersion }

    try {
      if (!identity.canonicalToken || !identity.folio || auditedLines.length === 0 || auditedLines.some(line => !Number.isFinite(line.audit_quantity))) {
        return { data: await persistVerification({ companyId: params.companyId, cardId: params.cardId, auditId: params.auditId, status: 'BLOCKED', currentBsaleNvId: cardRow.current_bsale_nv_id ?? cardRow.bsale_nv_id, canonicalToken: cardRow.canonical_bsale_token, reason: 'AUDIT_COMMERCIAL_IDENTITY_INCOMPLETE', differences: [], snapshot: { ...baseSnapshot, status: 'BLOCKED' }, fingerprint: fingerprint({ ...baseSnapshot, status: 'BLOCKED' }) }), error: null }
      }

      const current = await getCurrentVersionOnce(identity)
      const comparison = compareAuditedCommercialLines(auditedLines as Array<AuditLineRow & { audit_quantity: number }>, current, acceptedVersion)
      const snapshot = { ...baseSnapshot, currentVersion: current, comparison, status: comparison.status }
      return { data: await persistVerification({ companyId: params.companyId, cardId: params.cardId, auditId: params.auditId, status: comparison.status, currentBsaleNvId: current.identity.currentBsaleId, canonicalToken: current.identity.canonicalToken, reason: comparison.status === 'READY_TO_INVOICE' ? 'COMMERCIAL_MATCHED' : 'COMMERCIAL_DIFFERENCES_FOUND', differences: comparison.differences, snapshot, fingerprint: fingerprint(snapshot) }), error: null }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'No se pudo consultar Bsale.'
      const snapshot = { ...baseSnapshot, status: 'BLOCKED', error: reason }
      return { data: await persistVerification({ companyId: params.companyId, cardId: params.cardId, auditId: params.auditId, status: 'BLOCKED', currentBsaleNvId: cardRow.current_bsale_nv_id ?? cardRow.bsale_nv_id, canonicalToken: cardRow.canonical_bsale_token, reason: 'BSale_UNAVAILABLE', differences: [], snapshot, fingerprint: fingerprint(snapshot) }), error: null }
    }
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : 'No se pudo verificar comercialmente la auditoría.' }
  }
}
