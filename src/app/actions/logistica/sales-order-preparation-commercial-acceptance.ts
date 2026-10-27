'use server'

import { requireWmsPermission } from './authorization'
import { createAdminClient } from '@/lib/supabase/admin'
import { createBsalePreparationCommercialProvider } from '@/lib/logistica/preparation-commercial-bsale-provider'
import { compareCommercialVersions, fingerprintCommercialVersion, type PreparationCommercialVersion } from '@/lib/logistica/preparation-commercial-version'
import { buildPreparationCommercialReconciliationPlan, type PreparationReconciliationIncident, type PreparationReconciliationLine } from '@/lib/logistica/preparation-commercial-reconciliation-plan'

export type CommercialAcceptanceStatus =
  | 'ACCEPTED' | 'ALREADY_ACCEPTED' | 'VERSION_CHANGED' | 'REQUIRES_RESOLUTION'
  | 'INVALID_STATUS' | 'UNAVAILABLE' | 'AMBIGUOUS' | 'CONCURRENT_MODIFICATION' | 'ERROR'

export type CommercialAcceptanceResult = {
  status: CommercialAcceptanceStatus
  detail?: string
  versionId?: string
  fingerprint?: string
}

type Card = {
  id: string
  company_id: string
  status: string
  bsale_nv_id: number
  bsale_nv_folio: string | null
  canonical_bsale_token: string | null
  current_bsale_nv_id: number | null
}

type StoredVersion = { version_snapshot: PreparationCommercialVersion; fingerprint: string }

function asVersion(value: unknown): PreparationCommercialVersion | null {
  if (!value || typeof value !== 'object') return null
  const version = value as PreparationCommercialVersion
  return Array.isArray(version.lines) && version.identity != null ? version : null
}

function fallbackVersion(card: Card, lines: Array<{ source_snapshot: Record<string, unknown> | null }>): PreparationCommercialVersion | null {
  if (!card.canonical_bsale_token || !card.bsale_nv_folio || lines.length === 0 || lines.some(line => !line.source_snapshot)) return null
  const snapshots = lines.map(line => line.source_snapshot as Record<string, unknown>)
  const numberOrNull = (value: unknown) => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value)
  return {
    identity: { canonicalToken: card.canonical_bsale_token, historicalBsaleId: card.bsale_nv_id, currentBsaleId: card.current_bsale_nv_id ?? card.bsale_nv_id, folio: card.bsale_nv_folio },
    physicalId: card.current_bsale_nv_id ?? card.bsale_nv_id,
    generationDate: null,
    emissionDate: null,
    lines: snapshots.map(snapshot => ({
      detailId: numberOrNull(snapshot.detail_id), variantId: numberOrNull(snapshot.variant_id),
      sku: typeof snapshot.sku === 'string' ? snapshot.sku : null,
      productName: typeof snapshot.product_name === 'string' ? snapshot.product_name : null,
      quantity: numberOrNull(snapshot.quantity) ?? 0,
      unitNetValue: numberOrNull(snapshot.unit_net_value), lineNetAmount: numberOrNull(snapshot.line_net_amount),
      lineTaxAmount: numberOrNull(snapshot.line_tax_amount), lineGrossAmount: numberOrNull(snapshot.line_gross_amount),
      lineNumber: numberOrNull(snapshot.line_number),
    })),
  }
}

function providerStatus(error: unknown): CommercialAcceptanceStatus {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : ''
  return code === 'UNAVAILABLE' ? 'UNAVAILABLE' : code === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'ERROR'
}

export async function acceptSalesOrderPreparationCommercialChanges(params: {
  cardId: string
  expectedCommercialFingerprint: string
}): Promise<CommercialAcceptanceResult> {
  let auth: Awaited<ReturnType<typeof requireWmsPermission>>
  try {
    auth = await requireWmsPermission('logistica.preparation.manage')
  } catch (error) {
    return { status: 'ERROR', detail: error instanceof Error ? error.message : 'No autorizado.' }
  }

  const db = createAdminClient()
  const { data: card, error: cardError } = await db.schema('logistica').from('sales_order_preparation_cards')
    .select('id, company_id, status, bsale_nv_id, bsale_nv_folio, canonical_bsale_token, current_bsale_nv_id')
    .eq('id', params.cardId).eq('company_id', auth.companyId).maybeSingle()
  if (cardError || !card) return { status: 'ERROR', detail: cardError?.message ?? 'Tarjeta no encontrada.' }
  const persistedCard = card as Card
  if (persistedCard.status !== 'IN_PREPARATION') return { status: 'INVALID_STATUS' }
  if (!persistedCard.canonical_bsale_token || !persistedCard.bsale_nv_folio) return { status: 'AMBIGUOUS', detail: 'La identidad canónica está incompleta.' }

  const [{ data: lines, error: linesError }, { data: incidents, error: incidentsError }, { data: stored }] = await Promise.all([
    db.schema('logistica').from('sales_order_preparation_lines').select('*').eq('company_id', auth.companyId).eq('card_id', params.cardId).is('retired_at', null),
    db.schema('logistica').from('sales_order_preparation_incidents').select('id, preparation_line_id, status, incident_type').eq('company_id', auth.companyId).eq('card_id', params.cardId),
    db.schema('logistica').from('sales_order_preparation_commercial_versions').select('version_snapshot, fingerprint').eq('company_id', auth.companyId).eq('card_id', params.cardId).order('sequence_no', { ascending: false }).limit(1).maybeSingle(),
  ])
  if (linesError || incidentsError) return { status: 'ERROR', detail: linesError?.message ?? incidentsError?.message }

  const acceptedVersion = asVersion((stored as StoredVersion | null)?.version_snapshot) ?? fallbackVersion(persistedCard, (lines ?? []) as Array<{ source_snapshot: Record<string, unknown> | null }>)
  if (!acceptedVersion) return { status: 'UNAVAILABLE', detail: 'No existe un snapshot comercial completo para comparar.' }

  let currentVersion: PreparationCommercialVersion
  try {
    currentVersion = await createBsalePreparationCommercialProvider().getCurrentVersion({
      companyId: auth.companyId, cardId: persistedCard.id, status: persistedCard.status,
      canonicalToken: persistedCard.canonical_bsale_token, historicalBsaleId: persistedCard.bsale_nv_id,
      currentBsaleId: persistedCard.current_bsale_nv_id, folio: persistedCard.bsale_nv_folio,
    }, AbortSignal.timeout(15_000))
  } catch (error) {
    return { status: providerStatus(error), detail: error instanceof Error ? error.message : 'No se pudo verificar Bsale.' }
  }
  const currentFingerprint = fingerprintCommercialVersion(currentVersion).value
  if (currentFingerprint !== params.expectedCommercialFingerprint) return { status: 'VERSION_CHANGED', fingerprint: currentFingerprint }

  const comparison = compareCommercialVersions(acceptedVersion, currentVersion)
  const plan = buildPreparationCommercialReconciliationPlan({
    card: { cardId: persistedCard.id, companyId: auth.companyId, status: persistedCard.status },
    identity: currentVersion.identity,
    acceptedVersion,
    currentVersion,
    preparationLines: (lines ?? []) as PreparationReconciliationLine[],
    incidents: (incidents ?? []) as PreparationReconciliationIncident[],
    comparison,
    snapshotComplete: true,
  })
  if (plan.status !== 'READY' || !plan.canAcceptCompletely) {
    return { status: plan.status === 'UNAVAILABLE' ? 'UNAVAILABLE' : plan.status === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'REQUIRES_RESOLUTION', detail: plan.conflicts[0]?.message }
  }

  const { data: request, error: requestError } = await db.schema('logistica').from('sales_order_preparation_commercial_acceptance_requests').upsert({
    company_id: auth.companyId, card_id: persistedCard.id, expected_fingerprint: currentFingerprint,
    previous_fingerprint: fingerprintCommercialVersion(acceptedVersion).value,
    verified_current_bsale_nv_id: currentVersion.physicalId, version_snapshot: currentVersion,
    plan_snapshot: plan, verified_at: new Date().toISOString(), requested_by: auth.user.id,
  }, { onConflict: 'company_id,card_id,expected_fingerprint' }).select('id').single()
  if (requestError || !request) return { status: 'ERROR', detail: requestError?.message ?? 'No se pudo registrar la verificación.' }

  const { data: result, error: rpcError } = await db.schema('logistica').rpc('accept_sales_order_preparation_commercial_changes', {
    p_request_id: request.id, p_company_id: auth.companyId, p_card_id: persistedCard.id,
    p_expected_fingerprint: params.expectedCommercialFingerprint, p_actor_id: auth.user.id,
  })
  if (rpcError) return { status: 'ERROR', detail: rpcError.message }
  return (result ?? { status: 'ERROR' }) as CommercialAcceptanceResult
}
