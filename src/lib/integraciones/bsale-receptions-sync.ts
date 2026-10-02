import { createClient } from '@supabase/supabase-js'
import {
  createSyncRun,
  finishSyncRun,
  releaseSyncLock,
  tryAcquireSyncLock,
  type SyncTriggerType,
} from './sync-core'

export type BsaleReception = {
  id: number
  admissionDate?: number | null
  rawAdmissionDate?: string | null
  document?: string | null
  documentNumber?: string | number | null
  note?: string | null
  office?: { id?: string | number | null } | null
  [key: string]: unknown
}

export type BsaleReceptionDetail = {
  id: number
  quantity?: number | string | null
  cost?: number | string | null
  variantStock?: number | string | null
  variant?: { id?: string | number | null } | null
  [key: string]: unknown
}

export type ReceptionSyncResult = {
  success: boolean
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED_FRESH' | 'SKIPPED_LOCKED' | 'NO_WATERMARK'
  runId?: string
  message?: string
  window?: { from: string; to: string }
  receptionsFetched?: number
  receptionsUpserted?: number
  detailsFetched?: number
  detailsUpserted?: number
  touchedVariantIds?: number[]
  touchedVariantCount?: number
}

type SyncMetadata = {
  sync_kind: 'RECEPTIONS'
  window_from: string
  window_to: string
  overlap_days: number
  backfill: boolean
  watermark_admission_date?: string
  rows_upserted: number
  receptions_fetched: number
  details_fetched: number
  details_upserted: number
  touched_variant_ids: number[]
  touched_variant_count: number
  rows_processed: number
}

type LastSuccessfulRun = { finished_at?: string | null; metadata?: Partial<SyncMetadata> | null }

type ReceptionSyncDependencies = {
  now?: () => Date
  getLastSuccessfulRun?: (companyId: string) => Promise<LastSuccessfulRun | null>
  acquireLock?: (companyId: string, trigger: SyncTriggerType) => Promise<boolean>
  releaseLock?: (companyId: string) => Promise<void>
  createRun?: (companyId: string, trigger: SyncTriggerType, metadata: SyncMetadata) => Promise<string>
  finishRun?: (runId: string, status: 'SUCCESS' | 'FAILED', metadata: SyncMetadata, message?: string) => Promise<void>
  fetchHeaders?: (companyId: string, from: string, to: string) => Promise<BsaleReception[]>
  fetchDetails?: (companyId: string, receptionId: number) => Promise<BsaleReceptionDetail[]>
  upsertHeaders?: (rows: Record<string, unknown>[]) => Promise<void>
  upsertDetails?: (rows: Record<string, unknown>[]) => Promise<void>
  resolveVariantCodes?: (companyId: string, variantIds: number[], cache: Map<number, string | null>) => Promise<Map<number, string>>
}

const COOLDOWN_MINUTES = 10
const OVERLAP_DAYS = 3
const HEADER_CHUNK_SIZE = 250
const DETAIL_CHUNK_SIZE = 500

function integrDb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    db: { schema: 'integraciones' },
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function adqDb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    db: { schema: 'adquisiciones' },
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function toNum(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function epochToIso(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? new Date(parsed * 1000).toISOString() : null
}

function dateFromEpoch(value: unknown) {
  const iso = epochToIso(value)
  return iso ? iso.slice(0, 10) : null
}

export function formatUtcDate(date: Date) {
  return date.toISOString().slice(0, 10)
}

export function addDays(date: string, days: number) {
  const result = new Date(`${date}T00:00:00Z`)
  result.setUTCDate(result.getUTCDate() + days)
  return formatUtcDate(result)
}

export function listUtcDates(from: string, to: string) {
  const result: string[] = []
  for (let current = from; current <= to; current = addDays(current, 1)) result.push(current)
  return result
}

export function planReceptionWindow(params: {
  today: string
  watermark?: string | null
  from?: string
  to?: string
  overlapDays?: number
}) {
  if (params.from || params.to) {
    if (!params.from || !params.to || params.from > params.to) throw new Error('from/to inválidos')
    if (params.to > params.today) throw new Error('La fecha to no puede ser futura')
    return { from: params.from, to: params.to, backfill: true }
  }
  if (!params.watermark) return null
  const from = addDays(params.watermark, -(params.overlapDays ?? OVERLAP_DAYS))
  return { from, to: params.today, backfill: false }
}

export function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

export function isWithinCooldown(finishedAt: string | null | undefined, now: Date, minutes = COOLDOWN_MINUTES) {
  if (!finishedAt) return false
  const age = now.getTime() - new Date(finishedAt).getTime()
  return age >= 0 && age < minutes * 60_000
}

async function getLastSuccessfulRun(companyId: string) {
  const { data, error } = await integrDb()
    .from('sync_runs')
    .select('finished_at, metadata')
    .eq('company_id', companyId)
    .eq('provider', 'BSALE')
    .eq('entity', 'RECEPTIONS')
    .eq('status', 'SUCCESS')
    .order('finished_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Error leyendo watermark de recepciones: ${error.message}`)
  return data as LastSuccessfulRun | null
}

async function defaultAcquireLock(companyId: string, trigger: SyncTriggerType) {
  return tryAcquireSyncLock({ companyId, provider: 'BSALE', entity: 'RECEPTIONS', ttlMinutes: 60, lockedBy: trigger })
}

async function defaultCreateRun(companyId: string, trigger: SyncTriggerType, metadata: SyncMetadata) {
  return createSyncRun({ companyId, provider: 'BSALE', entity: 'RECEPTIONS', triggerType: trigger, metadata })
}

async function defaultFinishRun(runId: string, status: 'SUCCESS' | 'FAILED', metadata: SyncMetadata, message?: string) {
  return finishSyncRun({
    runId,
    status,
    readCount: metadata.receptions_fetched + metadata.details_fetched,
    insertedCount: 0,
    updatedCount: 0,
    errorCount: status === 'FAILED' ? 1 : 0,
    message,
    metadata,
  })
}

async function fetchHeaders(companyId: string, from: string, to: string) {
  const { bsaleFetchAllForCompany } = await import('../bsale/client')
  const headers: BsaleReception[] = []
  for (const date of listUtcDates(from, to)) {
    const admissiondate = String(Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000))
    headers.push(...await bsaleFetchAllForCompany<BsaleReception>({
      companyId,
      path: '/stocks/receptions.json',
      params: { admissiondate },
    }))
  }
  return headers
}

async function fetchDetails(companyId: string, receptionId: number) {
  const { bsaleFetchAllForCompany } = await import('../bsale/client')
  return bsaleFetchAllForCompany<BsaleReceptionDetail>({
    companyId,
    path: `/stocks/receptions/${receptionId}/details.json`,
  })
}

async function upsertHeaders(rows: Record<string, unknown>[]) {
  for (const rowsChunk of chunk(rows, HEADER_CHUNK_SIZE)) {
    const { error } = await integrDb().from('bsale_receptions').upsert(rowsChunk, { onConflict: 'company_id,bsale_id' })
    if (error) throw new Error(`Error upserting receptions: ${error.message}`)
  }
}

async function upsertDetails(rows: Record<string, unknown>[]) {
  for (const rowsChunk of chunk(rows, DETAIL_CHUNK_SIZE)) {
    const { error } = await integrDb().from('bsale_reception_details').upsert(rowsChunk, { onConflict: 'company_id,bsale_id' })
    if (error) throw new Error(`Error upserting reception details: ${error.message}`)
  }
}

async function resolveVariantCodes(companyId: string, variantIds: number[], cache: Map<number, string | null>) {
  const result = new Map<number, string>()
  const unresolved = variantIds.filter(id => !cache.has(id))
  if (unresolved.length) {
    const { data, error } = await adqDb().from('products').select('bsale_variant_id, sku').eq('company_id', companyId).in('bsale_variant_id', unresolved)
    if (error) throw error
    for (const row of (data || []) as Array<{ bsale_variant_id: number | string; sku: string | null }>) {
      const id = Number(row.bsale_variant_id)
      const sku = row.sku?.trim().toUpperCase() || null
      cache.set(id, sku)
    }
    for (const id of unresolved.filter(candidate => !cache.has(candidate))) {
      try {
        const { getBsaleConfigForCompany } = await import('../bsale/company-config')
        const { baseUrl, accessToken } = getBsaleConfigForCompany(companyId)
        const response = await fetch(`${baseUrl}/variants/${id}.json`, { headers: { access_token: accessToken, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
        const body = response.ok ? await response.json() as { code?: string | null } : null
        cache.set(id, body?.code?.trim().toUpperCase() || null)
      } catch {
        cache.set(id, null)
      }
    }
  }
  for (const id of variantIds) {
    const code = cache.get(id)
    if (code) result.set(id, code)
  }
  return result
}

export async function syncBsaleReceptionsDelta(options: {
  companyId: string
  trigger: SyncTriggerType
  from?: string
  to?: string
  allowLargeBackfill?: boolean
  dependencies?: ReceptionSyncDependencies
}): Promise<ReceptionSyncResult> {
  const deps = options.dependencies || {}
  const now = deps.now || (() => new Date())
  const today = formatUtcDate(now())
  const previous = await (deps.getLastSuccessfulRun || getLastSuccessfulRun)(options.companyId)
  const metadata = previous?.metadata
  const window = planReceptionWindow({ today, watermark: metadata?.watermark_admission_date, from: options.from, to: options.to })
  if (!window) return { success: false, status: 'NO_WATERMARK', message: 'No existe watermark; solicita un backfill explícito.' }
  if (!window.backfill && isWithinCooldown(previous?.finished_at, now())) {
    return { success: true, status: 'SKIPPED_FRESH', window, message: 'La última sincronización exitosa aún está dentro del cooldown.' }
  }

  const days = Math.floor((new Date(`${window.to}T00:00:00Z`).getTime() - new Date(`${window.from}T00:00:00Z`).getTime()) / 86_400_000) + 1
  if (days > 31 && !options.allowLargeBackfill) throw new Error('El rango máximo permitido sin allowLargeBackfill es de 31 días')

  const acquire = deps.acquireLock || defaultAcquireLock
  if (!await acquire(options.companyId, options.trigger)) return { success: true, status: 'SKIPPED_LOCKED', window, message: 'Ya existe una sincronización de recepciones en curso.' }

  let runId: string | undefined
  const counts = { receptions_fetched: 0, details_fetched: 0, details_upserted: 0, rows_upserted: 0 }
  const touched = new Set<number>()
  const variantCache = new Map<number, string | null>()
  const finish = deps.finishRun || defaultFinishRun
  const baseMetadata = (includeWatermark = true): SyncMetadata => ({
    sync_kind: 'RECEPTIONS', window_from: window.from, window_to: window.to, overlap_days: window.backfill ? 0 : OVERLAP_DAYS,
    backfill: window.backfill, ...(includeWatermark ? { watermark_admission_date: window.to } : {}), ...counts,
    touched_variant_ids: Array.from(touched).sort((a, b) => a - b), touched_variant_count: touched.size,
    rows_processed: counts.receptions_fetched + counts.details_fetched,
  })

  try {
    runId = await (deps.createRun || defaultCreateRun)(options.companyId, options.trigger, baseMetadata(false))
    const headers = await (deps.fetchHeaders || fetchHeaders)(options.companyId, window.from, window.to)
    counts.receptions_fetched = headers.length
    const headerRows = headers.map(reception => ({
      company_id: options.companyId, bsale_id: Number(reception.id), admission_date: epochToIso(reception.admissionDate),
      raw_admission_date: reception.rawAdmissionDate || dateFromEpoch(reception.admissionDate), document: reception.document || null,
      document_number: reception.documentNumber ? String(reception.documentNumber) : null, note: reception.note || null,
      office_id: Number(reception.office?.id || 0) || null, raw_json: reception,
      synced_at: now().toISOString(), updated_at: now().toISOString(),
    }))
    await (deps.upsertHeaders || upsertHeaders)(headerRows)
    counts.rows_upserted += headerRows.length

    for (const receptionBatch of chunk(headers, 5)) {
      const detailResults = await Promise.all(receptionBatch.map(async reception => ({ reception, details: await (deps.fetchDetails || fetchDetails)(options.companyId, reception.id) })))
      const variantIds = Array.from(new Set(detailResults.flatMap(result => result.details.map(detail => Number(detail.variant?.id || 0)).filter(id => id > 0))))
      const codeMap = await (deps.resolveVariantCodes || resolveVariantCodes)(options.companyId, variantIds, variantCache)
      const detailRows = detailResults.flatMap(({ reception, details }) => details.map(detail => {
        const variantId = Number(detail.variant?.id || 0) || null
        if (variantId) touched.add(variantId)
        return {
          company_id: options.companyId, bsale_id: Number(detail.id), bsale_reception_id: Number(reception.id),
          quantity: toNum(detail.quantity), cost: toNum(detail.cost), variant_stock: toNum(detail.variantStock), variant_id: variantId,
          variant_code: variantId ? codeMap.get(variantId) || null : null, raw_json: detail,
          synced_at: now().toISOString(), updated_at: now().toISOString(),
        }
      }))
      counts.details_fetched += detailRows.length
      await (deps.upsertDetails || upsertDetails)(detailRows)
      counts.details_upserted += detailRows.length
      counts.rows_upserted += detailRows.length
    }

    await finish(runId, 'SUCCESS', baseMetadata())
    return { success: true, status: 'SUCCESS', runId, window, receptionsFetched: counts.receptions_fetched, receptionsUpserted: headers.length, detailsFetched: counts.details_fetched, detailsUpserted: counts.details_upserted, touchedVariantIds: Array.from(touched), touchedVariantCount: touched.size }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error inesperado sincronizando recepciones Bsale'
    if (runId) await finish(runId, 'FAILED', baseMetadata(false), message)
    return { success: false, status: 'FAILED', runId, window, message, touchedVariantIds: Array.from(touched), touchedVariantCount: touched.size }
  } finally {
    await (deps.releaseLock || (companyId => releaseSyncLock(companyId, 'BSALE', 'RECEPTIONS')))(options.companyId)
  }
}

export async function syncBsaleReceptions(options: {
  companyId: string
  trigger: SyncTriggerType
  dateFrom?: string
  dateTo?: string
  allowLargeBackfill?: boolean
}) {
  return syncBsaleReceptionsDelta({
    companyId: options.companyId,
    trigger: options.trigger,
    from: options.dateFrom,
    to: options.dateTo,
    allowLargeBackfill: options.allowLargeBackfill,
  })
}
