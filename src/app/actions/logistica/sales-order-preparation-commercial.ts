'use server'

import { requireWmsPermission } from './authorization'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  detectPreparationCommercialChange,
  type PreparationDetectionCardIdentity,
  type PreparationDetectorResult,
} from '@/lib/logistica/preparation-commercial-detector'
import { createBsalePreparationCommercialProvider } from '@/lib/logistica/preparation-commercial-bsale-provider'
import { fingerprintCommercialVersion, preparationCommercialLineFromSnapshot, type PreparationCommercialLineInput, type PreparationCommercialVersion } from '@/lib/logistica/preparation-commercial-version'

type PersistedPreparationCard = {
  id: string
  company_id: string
  status: string
  bsale_nv_id: number
  bsale_nv_folio: string | null
  canonical_bsale_token: string | null
  current_bsale_nv_id: number | null
}

type PersistedPreparationLine = {
  source_snapshot: Record<string, unknown> | null
}

type PersistedAcceptedVersion = {
  version_snapshot: PreparationCommercialVersion | null
}

export type PreparationCommercialAlertLine = {
  kind: 'ADDED' | 'REMOVED' | 'QUANTITY_INCREASED' | 'QUANTITY_DECREASED' | 'VALUE_CHANGED' | 'SUBSTITUTION'
  previous: { variantId: number | null; sku: string | null; productName: string | null; quantity: number | null } | null
  current: { variantId: number | null; sku: string | null; productName: string | null; quantity: number | null } | null
  quantityDelta: number | null
  changedFields: string[]
}

export type PreparationCommercialAlert = {
  status: PreparationDetectorResult['status']
  detail: string
  verifiedAt: string | null
  verificationSource: PreparationDetectorResult['verificationSource']
  differences: PreparationCommercialAlertLine[]
  totalDelta: number | null
  currentFingerprint?: string | null
  errorCode?: PreparationDetectorResult['errorCode']
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function sumSnapshotField(snapshots: Record<string, unknown>[], field: string): number | null {
  const values = snapshots.map(snapshot => numberOrNull(snapshot[field]))
  return values.some(value => value == null) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
}

function snapshotVersion(card: PersistedPreparationCard, lines: PersistedPreparationLine[]): PreparationCommercialVersion | null {
  if (!card.canonical_bsale_token || !card.bsale_nv_folio || lines.length === 0) return null
  const snapshots = lines.map(line => line.source_snapshot)
  if (snapshots.some(snapshot => !snapshot)) return null
  const completeSnapshots = snapshots as Record<string, unknown>[]
  const versionLines: PreparationCommercialLineInput[] = completeSnapshots.map(preparationCommercialLineFromSnapshot)

  return {
    identity: {
      canonicalToken: card.canonical_bsale_token,
      historicalBsaleId: card.bsale_nv_id,
      currentBsaleId: card.current_bsale_nv_id ?? card.bsale_nv_id,
      folio: card.bsale_nv_folio,
    },
    physicalId: card.bsale_nv_id,
    generationDate: null,
    emissionDate: null,
    lines: versionLines,
    netAmount: sumSnapshotField(completeSnapshots, 'line_net_amount'),
    taxAmount: sumSnapshotField(completeSnapshots, 'line_tax_amount'),
    totalAmount: sumSnapshotField(completeSnapshots, 'line_gross_amount'),
  }
}

function serializeAlert(result: PreparationDetectorResult): PreparationCommercialAlert {
  return {
    status: result.status,
    detail: result.detail,
    verifiedAt: result.verifiedAt,
    verificationSource: result.verificationSource,
    differences: (result.comparison?.differences ?? []).map(difference => ({
      kind: difference.kind,
      previous: difference.previous ? {
        variantId: difference.previous.variantId ?? null,
        sku: difference.previous.sku ?? null,
        productName: difference.previous.productName ?? null,
        quantity: difference.previous.quantity ?? null,
      } : null,
      current: difference.current ? {
        variantId: difference.current.variantId ?? null,
        sku: difference.current.sku ?? null,
        productName: difference.current.productName ?? null,
        quantity: difference.current.quantity ?? null,
      } : null,
      quantityDelta: difference.quantityDelta,
      changedFields: difference.changedFields,
    })),
    totalDelta: result.comparison?.totals.totalDelta ?? null,
    currentFingerprint: result.currentVersion ? fingerprintCommercialVersion(result.currentVersion).value : null,
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
  }
}

function baseIdentity(card: PersistedPreparationCard): PreparationDetectionCardIdentity {
  return {
    companyId: card.company_id,
    cardId: card.id,
    status: card.status,
    canonicalToken: card.canonical_bsale_token,
    historicalBsaleId: card.bsale_nv_id,
    currentBsaleId: card.current_bsale_nv_id,
    folio: card.bsale_nv_folio,
  }
}

export async function getSalesOrderPreparationCommercialAlert(cardId: string): Promise<{
  data: PreparationCommercialAlert | null
  error: string | null
}> {
  let auth
  try {
    auth = await requireWmsPermission('module.logistica.view')
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : 'No autorizado para consultar Preparación de Pedidos.' }
  }

  const supabase = await createClient()
  const { data: card, error: cardError } = await supabase
    .schema('logistica')
    .from('sales_order_preparation_cards')
    .select('id, company_id, status, bsale_nv_id, bsale_nv_folio, canonical_bsale_token, current_bsale_nv_id')
    .eq('id', cardId)
    .eq('company_id', auth.companyId)
    .maybeSingle()

  if (cardError || !card) return { data: null, error: cardError?.message ?? 'No se encontró la tarjeta de preparación.' }
  const persistedCard = card as PersistedPreparationCard
  const identity = baseIdentity(persistedCard)
  if (persistedCard.status !== 'IN_PREPARATION') {
    return {
      data: {
        status: 'NOT_APPLICABLE',
        detail: 'La tarjeta no está En preparación.',
        verifiedAt: null,
        verificationSource: 'NONE',
        differences: [],
        totalDelta: null,
      },
      error: null,
    }
  }

  const { data: lines, error: linesError } = await supabase
    .schema('logistica')
    .from('sales_order_preparation_lines')
    .select('source_snapshot')
    .eq('company_id', auth.companyId)
    .eq('card_id', persistedCard.id)
    .is('retired_at', null)
    .order('bsale_detail_id', { ascending: true })

  if (linesError) return { data: null, error: linesError.message }
  const { data: acceptedVersion, error: acceptedVersionError } = await createAdminClient()
    .schema('logistica')
    .from('sales_order_preparation_commercial_versions')
    .select('version_snapshot')
    .eq('company_id', auth.companyId)
    .eq('card_id', persistedCard.id)
    .order('sequence_no', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (acceptedVersionError) return { data: null, error: acceptedVersionError.message }
  const knownVersion = (acceptedVersion as PersistedAcceptedVersion | null)?.version_snapshot
    ?? snapshotVersion(persistedCard, (lines ?? []) as PersistedPreparationLine[])
  const result = await detectPreparationCommercialChange(
    { card: identity, knownVersion },
    { provider: createBsalePreparationCommercialProvider(), authorize: () => undefined },
  )
  return { data: serializeAlert(result), error: null }
}
