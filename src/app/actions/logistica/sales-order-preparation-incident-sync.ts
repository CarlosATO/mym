'use server'

import { requireWmsPermission } from './authorization'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createBsalePreparationCommercialProvider } from '@/lib/logistica/preparation-commercial-bsale-provider'
import { hydrateBsaleDocumentsById, mapBsaleDocument, mapBsaleDocumentDetails } from '@/lib/integraciones/bsale-document-hydration'
import { acquireSyncLock as acquireOperationalBsaleSyncLock, releaseSyncLock as releaseOperationalBsaleSyncLock } from '@/app/actions/integraciones/bsale-sync'

type IncidentSyncStatus = 'RESOLVED' | 'PENDING' | 'UNABLE_TO_VERIFY' | 'ALREADY_RESOLVED'

export type PreparationIncidentSyncResult = {
  status: IncidentSyncStatus
  incidentId: string
  cardId: string | null
  currentBsaleNvId: number | null
  syncRunId: string | null
  verification: Record<string, unknown> | null
  differences: Array<Record<string, unknown>>
  message: string
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

type IncidentRow = { id: string; card_id: string; company_id: string; status: string }

function result(status: IncidentSyncStatus, incidentId: string, cardId: string | null, currentBsaleNvId: number | null, syncRunId: string | null, message: string, verification: Record<string, unknown> | null = null, differences: Array<Record<string, unknown>> = []): PreparationIncidentSyncResult {
  return { status, incidentId, cardId, currentBsaleNvId, syncRunId, verification, differences, message }
}

async function createBsaleRun(companyId: string): Promise<string> {
  const db = createAdminClient()
  const { data, error } = await db.schema('integraciones').from('bsale_sync_runs').insert({
    company_id: companyId,
    status: 'STARTED',
    trigger: 'MANUAL',
  }).select('id').single()
  if (error || !data) throw new Error(error?.message ?? 'No se pudo iniciar la sincronización Bsale.')
  return String(data.id)
}

async function finishBsaleRun(runId: string, status: 'COMPLETED' | 'FAILED', errorMessage: string | null, detailsCount = 0) {
  const db = createAdminClient()
  await db.schema('integraciones').from('bsale_sync_runs').update({
    status,
    completed_at: new Date().toISOString(),
    documents_count: status === 'COMPLETED' ? 1 : 0,
    document_details_count: detailsCount,
    error_message: errorMessage,
  }).eq('id', runId)
}

async function replaceBsaleDocumentSnapshot(companyId: string, runId: string, document: Record<string, unknown>, details: Array<Record<string, unknown>>) {
  const { data, error } = await createAdminClient().schema('integraciones').rpc('replace_bsale_document_snapshot_v1', {
    p_company_id: companyId,
    p_run_id: runId,
    p_document: document,
    p_details: details,
  })
  if (error) throw new Error(`No se pudo reemplazar atómicamente el espejo Bsale: ${error.message}`)
  return data as Record<string, unknown>
}

async function loadDifferences(companyId: string, cardId: string, documentId: number) {
  const db = createAdminClient()
  const [{ data: prepared }, { data: current }] = await Promise.all([
    db.schema('logistica').from('sales_order_preparation_lines').select('sku, bsale_variant_id, prepared_quantity').eq('company_id', companyId).eq('card_id', cardId).is('retired_at', null),
    db.schema('integraciones').from('bsale_document_details').select('bsale_id, variant_id, variant_code, quantity').eq('company_id', companyId).eq('bsale_document_id', documentId),
  ])
  const key = (row: Record<string, unknown>) => {
    const sku = String(row.sku ?? row.variant_code ?? '').trim().toUpperCase()
    return sku ? `SKU:${sku}` : row.bsale_variant_id ?? row.variant_id ? `VARIANT:${row.bsale_variant_id ?? row.variant_id}` : null
  }
  const quantities = (rows: Record<string, unknown>[], field: string) => {
    const map = new Map<string, number>()
    for (const row of rows) {
      const identity = key(row)
      if (!identity) continue
      map.set(identity, (map.get(identity) ?? 0) + Number(row[field] ?? 0))
    }
    return map
  }
  const expected = quantities((prepared ?? []) as Record<string, unknown>[], 'prepared_quantity')
  const observed = quantities((current ?? []) as Record<string, unknown>[], 'quantity')
  return [...new Set([...expected.keys(), ...observed.keys()])]
    .sort()
    .filter(identity => (expected.get(identity) ?? 0) !== (observed.get(identity) ?? 0))
    .map(identity => ({ identity, preparedQuantity: expected.get(identity) ?? 0, bsaleQuantity: observed.get(identity) ?? 0, difference: (observed.get(identity) ?? 0) - (expected.get(identity) ?? 0) }))
}

export async function syncSalesOrderPreparationIncident(incidentId: string): Promise<PreparationIncidentSyncResult> {
  let auth
  try {
    auth = await requireWmsPermission('logistica.preparation.manage')
  } catch (error) {
    return result('UNABLE_TO_VERIFY', incidentId, null, null, null, error instanceof Error ? error.message : 'No autorizado para gestionar incidencias.')
  }

  const db = await createClient()
  const { data: incident, error: incidentError } = await db.schema('logistica').from('sales_order_preparation_incidents').select('id, card_id, company_id, status').eq('id', incidentId).eq('company_id', auth.companyId).maybeSingle()
  if (incidentError || !incident) return result('UNABLE_TO_VERIFY', incidentId, null, null, null, 'No se encontró la incidencia en la empresa activa.')
  const row = incident as IncidentRow
  if (row.status !== 'OPEN') return result('ALREADY_RESOLVED', incidentId, row.card_id, null, null, 'La incidencia ya no está abierta; se conserva su historial.')

  const { data: card, error: cardError } = await db.schema('logistica').from('sales_order_preparation_cards').select('id, company_id, status, bsale_nv_id, bsale_nv_folio, canonical_bsale_token, current_bsale_nv_id').eq('id', row.card_id).eq('company_id', auth.companyId).maybeSingle()
  if (cardError || !card) return result('UNABLE_TO_VERIFY', incidentId, row.card_id, null, null, 'No se pudo identificar la tarjeta original.')
  const cardRow = card as CardRow
  if (!cardRow.canonical_bsale_token || !cardRow.bsale_nv_folio) return result('UNABLE_TO_VERIFY', incidentId, cardRow.id, null, null, 'La identidad canónica de la Nota de Venta está incompleta.')

  let runId: string | null = null
  let operationalLockAcquired = false
  try {
    runId = await createBsaleRun(auth.companyId)
    const identity = { companyId: auth.companyId, cardId: cardRow.id, status: cardRow.status, canonicalToken: cardRow.canonical_bsale_token, historicalBsaleId: cardRow.bsale_nv_id, currentBsaleId: cardRow.current_bsale_nv_id, folio: cardRow.bsale_nv_folio }
    const live = await createBsalePreparationCommercialProvider().getCurrentVersion(identity, AbortSignal.timeout(30_000))
    const currentBsaleNvId = live.identity.currentBsaleId
    const hydrated = await hydrateBsaleDocumentsById(createAdminClient(), auth.companyId, [currentBsaleNvId], null, undefined, false)
    const document = hydrated[0]
    if (!document || Number(document.document.id) !== currentBsaleNvId || document.details.length !== live.lines.length) throw new Error('La sincronización de la NV quedó incompleta.')
    const operationalLockName = 'bsale_operational_prep_sync'
    operationalLockAcquired = await acquireOperationalBsaleSyncLock(auth.companyId, operationalLockName, runId, 10)
    if (!operationalLockAcquired) throw new Error('Ya existe una sincronización de Notas de Venta en curso. Intente nuevamente.')
    const documentSnapshot = mapBsaleDocument(auth.companyId, runId, document.document) as Record<string, unknown>
    const detailSnapshots = mapBsaleDocumentDetails(auth.companyId, runId, currentBsaleNvId, document.details) as Array<Record<string, unknown>>
    const replacement = await replaceBsaleDocumentSnapshot(auth.companyId, runId, documentSnapshot, detailSnapshots)
    const admin = createAdminClient()
    const { error: pointerError } = await admin.schema('logistica').from('sales_order_preparation_cards').update({ current_bsale_nv_id: currentBsaleNvId, updated_at: new Date().toISOString() }).eq('id', cardRow.id).eq('company_id', auth.companyId)
    if (pointerError) throw new Error(`No se pudo actualizar la versión canónica de la tarjeta: ${pointerError.message}`)
    const { data: mirror } = await admin.schema('integraciones').from('bsale_documents').select('bsale_sync_run_id').eq('company_id', auth.companyId).eq('bsale_id', currentBsaleNvId).maybeSingle()
    const { data: mirrorDetails } = await admin.schema('integraciones').from('bsale_document_details').select('bsale_sync_run_id').eq('company_id', auth.companyId).eq('bsale_document_id', currentBsaleNvId)
    if (replacement.document_id !== currentBsaleNvId || mirror?.bsale_sync_run_id !== runId || (mirrorDetails ?? []).some(detail => detail.bsale_sync_run_id !== runId)) throw new Error('La cabecera y las líneas no pertenecen a una misma corrida completa.')
    const { data: verification, error: verificationError } = await admin.schema('logistica').rpc('verify_open_preparation_incidents_v1', { p_company_id: auth.companyId, p_bsale_nv_ids: [currentBsaleNvId] })
    if (verificationError) throw new Error(`No se pudo verificar la incidencia: ${verificationError.message}`)
    const { data: refreshed } = await admin.schema('logistica').from('sales_order_preparation_incidents').select('status, verification_status').eq('id', incidentId).maybeSingle()
    const differences = await loadDifferences(auth.companyId, cardRow.id, currentBsaleNvId)
    if (refreshed?.status === 'RESOLVED' && refreshed.verification_status === 'MATCHED') return result('RESOLVED', incidentId, cardRow.id, currentBsaleNvId, runId, 'La conciliación comercial fue exitosa.', verification as Record<string, unknown>)
    return result('PENDING', incidentId, cardRow.id, currentBsaleNvId, runId, 'La Nota de Venta todavía presenta diferencias con lo preparado/auditado.', verification as Record<string, unknown>, differences)
  } catch (error) {
    if (runId) await finishBsaleRun(runId, 'FAILED', error instanceof Error ? error.message : 'Error de sincronización.')
    return result('UNABLE_TO_VERIFY', incidentId, cardRow.id, cardRow.current_bsale_nv_id, runId, error instanceof Error ? error.message : 'La comprobación no pudo completarse.')
  } finally {
    if (operationalLockAcquired && runId) await releaseOperationalBsaleSyncLock(auth.companyId, 'bsale_operational_prep_sync', runId)
  }
}
