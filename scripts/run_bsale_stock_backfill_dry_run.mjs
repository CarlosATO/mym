import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config({ path: '.env' })

const DEFAULT_COMPANY_ID = 'd1000000-0000-0000-0000-000000000001'
const API_BASE = process.env.BSALE_API_BASE_URL || 'https://api.bsale.cl/v1'
const API_LIMIT = 50
const DEFAULT_RATE = 4.5
const REQUEST_TIMEOUT_MS = 30_000
const MAX_ATTEMPTS = 4
const SOURCES = [
  { type: 'RECEPTION', path: '/stocks/receptions.json', dateParam: 'admissiondate', details: id => `/stocks/receptions/${id}/details.json` },
  { type: 'CONSUMPTION', path: '/stocks/consumptions.json', dateParam: 'consumptiondate', details: id => `/stocks/consumptions/${id}/details.json` },
  { type: 'SHIPPING', path: '/shippings.json', dateParam: 'shippingdate', details: id => `/shippings/${id}/details.json` },
  { type: 'RETURN', path: '/returns.json', dateParam: 'returndate', details: id => `/returns/${id}/details.json` },
]

class RateGate {
  constructor(rate) {
    this.interval = 1000 / rate
    this.nextAt = 0
  }

  async wait() {
    const now = Date.now()
    const delay = Math.max(0, this.nextAt - now)
    this.nextAt = Math.max(now, this.nextAt) + this.interval
    if (delay > 0) await sleep(delay)
  }
}

const args = parseArgs(process.argv.slice(2))
const writePilot = args.writePilot === true
const writeRange = args.writeRange === true
if (!args.dryRun && !writePilot && !writeRange) fail('Usa --dry-run, --write-pilot o --write-range')
if (writePilot && !args.resume) fail('--write-pilot requiere --resume sobre un cursor validado')
const companyId = args.company || DEFAULT_COMPANY_ID
const officeId = Number(args.office || 1)
const dateFrom = args.from
const dateTo = args.to
const variantFilter = args.variants ? new Set(args.variants.split(',').map(Number).filter(Number.isInteger)) : null
const statePath = args.state || path.join(os.tmpdir(), `mym-bsale-stock-backfill-${companyId}-${officeId}.json`)
const lockPath = path.join(os.tmpdir(), `mym-STOCK_KARDEX_BACKFILL-${companyId}-${officeId}.lock`)
const ratePerSecond = Math.max(0.5, Number(args.rate || DEFAULT_RATE))

validateDateRange(dateFrom, dateTo)
if (!Number.isInteger(officeId) || officeId <= 0) fail('--office debe ser un entero positivo')
if (variantFilter?.size === 0) fail('--variants no contiene variant_id válidos')
const PILOT_KEYS = new Set([
  'SHIPPING|80089|261455',
  'RECEPTION|10652|62337',
  'RETURN|4515|10692',
  'SHIPPING|80127|261782',
])
if (writePilot && (officeId !== 1 || dateFrom !== '2026-06-22' || dateTo !== '2026-09-15' || [...(variantFilter || [])].sort((a, b) => a - b).join(',') !== '6282,6457,7079')) {
  fail('--write-pilot solo permite el rango, office y variantes del piloto validado')
}
if (writeRange && variantFilter) fail('--write-range histórico no acepta --variants: procesa todas las variantes')

const token = process.env.BSALE_ACCESS_TOKEN
if (!token) fail('BSALE_ACCESS_TOKEN no configurado')
if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) fail('Variables Supabase requeridas no configuradas')

const metrics = {
  requests: 0,
  pages: 0,
  retries: 0,
  timeouts: 0,
  status429: 0,
  headersBySource: Object.fromEntries(SOURCES.map(source => [source.type, 0])),
  detailsBySource: Object.fromEntries(SOURCES.map(source => [source.type, 0])),
}

const stats = {
  eventsNormalized: 0,
  eventsExisting: 0,
  eventsNew: 0,
  eventsConflict: 0,
  semanticDuplicates: 0,
  physicalEffectiveEvents: 0,
  physicalEffectiveNew: 0,
}

const gate = new RateGate(ratePerSecond)
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: 'integraciones' },
  auth: { autoRefreshToken: false, persistSession: false },
})

let cursor = await loadCursor()
const eventSpoolPath = cursor.eventsSpoolPath || cursorSpoolPath(statePath, writeRange)
metrics.requests = cursor.requestsCount || 0
metrics.pages = cursor.pagesCount || 0
metrics.retries = cursor.retries || 0
metrics.timeouts = cursor.timeouts || 0
metrics.status429 = cursor.status429 || 0
for (const source of SOURCES) {
  metrics.headersBySource[source.type] = cursor.headersBySource?.[source.type] || 0
  metrics.detailsBySource[source.type] = cursor.detailsBySource?.[source.type] || 0
}
let stopRequested = false
let lockHandle

try {
  lockHandle = await acquireLocalLock()
  const startedAt = Date.now()
  const existingEvents = await loadExistingEvents()
  const existingByKey = new Map(existingEvents.map(event => [technicalKey(event), event]))
  const normalizedEvents = await loadNormalizedEvents(eventSpoolPath, cursor)
  let persistedEventCount = normalizedEvents.length

  for (let sourceIndex = cursor.sourceIndex; sourceIndex < SOURCES.length && !stopRequested; sourceIndex++) {
    const source = SOURCES[sourceIndex]
    const firstDateIndex = sourceIndex === cursor.sourceIndex ? cursor.dateIndex : 0
    for (let dateIndex = firstDateIndex; dateIndex < listDates(dateFrom, dateTo).length && !stopRequested; dateIndex++) {
      const date = listDates(dateFrom, dateTo)[dateIndex]
      const firstPage = sourceIndex === cursor.sourceIndex && dateIndex === cursor.dateIndex ? cursor.page : 0
      const headers = await fetchHeadersForDate(source, date, firstPage)
      for (let pageIndex = 0; pageIndex < headers.pages.length && !stopRequested; pageIndex++) {
        const page = headers.pages[pageIndex]
        const pageNumber = pageIndex + firstPage / API_LIMIT
        await persistCursor({ sourceIndex, dateIndex, page: Math.floor(pageNumber * API_LIMIT), phase: 'details', updatedAt: new Date().toISOString() })
        for (const header of page.items) {
          const details = await fetchAll(source.details(header.id), {})
          metrics.detailsBySource[source.type] += details.length
          for (const detail of details) {
            const event = normalizeEvent(source.type, header, detail, companyId, officeId)
            if (!event || (variantFilter && event.variant_id !== null && !variantFilter.has(event.variant_id))) continue
            normalizedEvents.push(event)
            if (args.stopAfterEvents && normalizedEvents.length >= Number(args.stopAfterEvents)) {
              stopRequested = true
              break
            }
          }
          if (stopRequested) break
        }
        if (stopRequested) break
        if (eventSpoolPath && normalizedEvents.length > persistedEventCount) {
          await appendSpoolEvents(eventSpoolPath, normalizedEvents.slice(persistedEventCount))
          persistedEventCount = normalizedEvents.length
        }
        await persistCursor({ sourceIndex, dateIndex, page: Math.floor((pageNumber + 1) * API_LIMIT), phase: 'headers', ...(writeRange ? {} : { events: normalizedEvents }), updatedAt: new Date().toISOString() })
        if (args.stopAfterPages && metrics.pages >= Number(args.stopAfterPages)) {
          stopRequested = true
          break
        }
      }
      if (!stopRequested) await persistCursor({ sourceIndex, dateIndex: dateIndex + 1, page: 0, phase: 'headers', updatedAt: new Date().toISOString() })
    }
    if (!stopRequested) await persistCursor({ sourceIndex: sourceIndex + 1, dateIndex: 0, page: 0, phase: 'headers', updatedAt: new Date().toISOString() })
  }

  const resolvedEvents = await resolveReturnVariants(normalizedEvents)
  const classification = classifyEvents(resolvedEvents, existingByKey)
  Object.assign(stats, classification.stats)
  let writeResult = null
  if (writePilot) writeResult = await writePilotEvents(classification, existingByKey)
  if (writeRange && !stopRequested) writeResult = await writeRangeEvents(classification, existingByKey)
  const elapsedMs = Date.now() - startedAt
  const result = buildReport({ elapsedMs, normalizedEvents: resolvedEvents, classification, resumed: Boolean(args.resume), interrupted: stopRequested, writeResult })
  await persistCursor({
    ...cursor,
    sourceIndex: stopRequested ? cursor.sourceIndex : SOURCES.length,
    status: stopRequested ? 'PAUSED' : 'COMPLETED',
    requestsCount: metrics.requests,
    eventsSeen: resolvedEvents.length,
    eventsNew: stats.eventsNew,
    eventsExisting: stats.eventsExisting,
    semanticDuplicates: stats.semanticDuplicates,
    lastError: null,
    updatedAt: new Date().toISOString(),
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} catch (error) {
  await persistCursor({ status: 'PAUSED', lastError: safeError(error), updatedAt: new Date().toISOString() })
  process.stderr.write(`${safeError(error)}\n`)
  process.exitCode = 1
} finally {
  await releaseLocalLock(lockHandle)
}

function parseArgs(values) {
  const parsed = {}
  for (let index = 0; index < values.length; index++) {
    const value = values[index]
    if (!value.startsWith('--')) continue
    const [key, inline] = value.slice(2).split('=')
    const normalizedKey = key.split('-').map((part, partIndex) => partIndex === 0 ? part : `${part[0].toUpperCase()}${part.slice(1)}`).join('')
    if (inline !== undefined) parsed[normalizedKey] = inline
    else if (values[index + 1] && !values[index + 1].startsWith('--')) parsed[normalizedKey] = values[++index]
    else parsed[normalizedKey] = true
  }
  return parsed
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function validateDateRange(from, to) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) fail('--from y --to deben usar YYYY-MM-DD')
  if (from > to) fail('--from no puede ser posterior a --to')
}

function listDates(from, to) {
  const dates = []
  const current = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10))
    current.setUTCDate(current.getUTCDate() + 1)
  }
  return dates
}

function epochDay(date) {
  return Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000)
}

function numeric(value) {
  if (value === null || value === undefined || value === '') return null
  const result = Number(value)
  return Number.isFinite(result) ? result : null
}

function eventDate(header, sourceType) {
  const raw = sourceType === 'RECEPTION' ? header.admissionDate
    : sourceType === 'CONSUMPTION' ? header.consumptionDate
      : sourceType === 'SHIPPING' ? header.shippingDate : header.returnDate
  const timestamp = numeric(raw)
  return timestamp === null ? null : new Date(timestamp * 1000).toISOString().slice(0, 10)
}

function normalizeEvent(sourceType, header, detail, companyIdValue, officeIdValue) {
  const variantId = numeric(detail.variant?.id ?? detail.variantId)
  const date = eventDate(header, sourceType)
  const rawQuantity = sourceType === 'RETURN' ? (detail.quantityDevStock ?? detail.quantity) : detail.quantity
  const quantity = numeric(rawQuantity)
  if (Number(header.office?.id) !== officeIdValue || Number(header.state ?? 0) !== 0) return null
  if (sourceType === 'CONSUMPTION' && numeric(header.updateStock) !== 1) return null
  if ((variantId === null && !(sourceType === 'RETURN' && numeric(detail.documentDetailId) !== null)) || date === null || quantity === null || quantity <= 0) return null
  return {
    company_id: companyIdValue,
    office_id: officeIdValue,
    variant_id: variantId,
    variant_code: detail.variant?.code || null,
    event_date: date,
    source_type: sourceType,
    source_header_id: Number(header.id),
    source_detail_id: Number(detail.id),
    quantity_delta: sourceType === 'RECEPTION' || sourceType === 'RETURN' ? quantity : -quantity,
    variant_stock_after: numeric(detail.variantStock),
    raw_json: { header, detail },
  }
}

async function fetchHeadersForDate(source, date, firstPage) {
  const pages = []
  let offset = firstPage
  for (;;) {
    const page = await fetchPage(source.path, { officeid: officeId, [source.dateParam]: epochDay(date), limit: API_LIMIT, offset })
    metrics.pages++
    metrics.headersBySource[source.type] += page.items.length
    if (metrics.pages % 250 === 0) process.stderr.write(`[backfill dry-run] requests=${metrics.requests} pages=${metrics.pages} source=${source.type} date=${date}\n`)
    pages.push({ items: page.items })
    if (page.items.length < API_LIMIT || offset + page.items.length >= Number(page.count ?? offset + page.items.length)) break
    offset += API_LIMIT
    await persistCursor({ sourceIndex: SOURCES.findIndex(item => item.type === source.type), dateIndex: listDates(dateFrom, dateTo).indexOf(date), page: offset, phase: 'headers', updatedAt: new Date().toISOString() })
  }
  return { pages }
}

async function fetchAll(pathValue, params) {
  const items = []
  for (let offset = 0; ; offset += API_LIMIT) {
    const page = await fetchPage(pathValue, { ...params, limit: API_LIMIT, offset })
    metrics.pages++
    items.push(...page.items)
    if (page.items.length < API_LIMIT || offset + page.items.length >= Number(page.count ?? offset + page.items.length)) return items
  }
}

async function fetchPage(pathValue, params) {
  let lastError = 'error desconocido'
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await gate.wait()
    metrics.requests++
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL(`${API_BASE}${pathValue}`)
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
      const response = await fetch(url, { headers: { access_token: token, Accept: 'application/json' }, signal: controller.signal })
      if (response.ok) return await response.json()
      lastError = `HTTP ${response.status}`
      if (response.status === 429) metrics.status429++
      if (![408, 429, 500, 502, 503, 504].includes(response.status)) break
    } catch (error) {
      lastError = error?.name === 'AbortError' ? 'timeout' : safeError(error)
      if (lastError === 'timeout') metrics.timeouts++
    } finally {
      clearTimeout(timeout)
    }
    if (attempt < MAX_ATTEMPTS - 1) {
      metrics.retries++
      await sleep(500 * 2 ** attempt)
    }
  }
  throw new Error(`${pathValue}: ${lastError}`)
}

async function loadExistingEvents() {
  const rows = []
  for (let offset = 0; ; offset += 1000) {
    let query = db.from('bsale_stock_kardex_events').select('company_id,office_id,variant_id,variant_code,event_date,source_type,source_header_id,source_detail_id,quantity_delta,variant_stock_after,raw_json')
      .eq('company_id', companyId).eq('office_id', officeId).range(offset, offset + 999)
    if (variantFilter) query = query.in('variant_id', [...variantFilter])
    const { data, error } = await query
    if (error) throw new Error(`No se pudo leer Kardex existente: ${error.message}`)
    rows.push(...(data || []))
    if (!data || data.length < 1000) return rows
  }
}

async function resolveReturnVariants(events) {
  const pending = events.filter(event => event.source_type === 'RETURN' && event.variant_id === null)
  if (!pending.length) return events
  const ids = [...new Set(pending.map(event => numeric(event.raw_json?.detail?.documentDetailId)).filter(Boolean))]
  const resolved = new Map()
  for (let offset = 0; offset < ids.length; offset += 100) {
    const { data, error } = await db.from('bsale_document_details').select('bsale_id,variant_id,variant_code').in('bsale_id', ids.slice(offset, offset + 100))
    if (error) throw new Error(`No se pudieron resolver devoluciones: ${error.message}`)
    for (const row of data || []) resolved.set(Number(row.bsale_id), row)
  }
  return events.map(event => {
    if (event.source_type !== 'RETURN' || event.variant_id !== null) return event
    const match = resolved.get(numeric(event.raw_json?.detail?.documentDetailId))
    return match ? { ...event, variant_id: Number(match.variant_id), variant_code: match.variant_code || event.variant_code } : event
  }).filter(event => event.variant_id !== null && (!variantFilter || variantFilter.has(event.variant_id)))
}

function technicalKey(event) {
  return [event.company_id, event.office_id, event.source_type, event.source_header_id, event.source_detail_id].join('|')
}

function semanticDuplicateOf(event, events) {
  if (event.source_type !== 'RECEPTION') return null
  const returnEvent = events.find(candidate => candidate.source_type === 'RETURN'
    && candidate.event_date === event.event_date
    && candidate.variant_id === event.variant_id
    && candidate.quantity_delta === event.quantity_delta
    && candidate.variant_stock_after === event.variant_stock_after
    && String(event.raw_json?.header?.note ?? '') === String(candidate.source_header_id)
    && String(event.raw_json?.header?.documentNumber ?? '') === String(candidate.raw_json?.header?.credit_note?.number ?? ''))
  return returnEvent ? technicalKey(returnEvent) : null
}

function classifyEvents(events, existingByKey) {
  const statuses = []
  let semanticDuplicates = 0
  for (const event of events) {
    const duplicateOf = semanticDuplicateOf(event, events)
    const existing = existingByKey.get(technicalKey(event))
    const conflict = existing && ['variant_id', 'event_date', 'quantity_delta', 'variant_stock_after'].some(field => !sameValue(existing[field], event[field]))
    const status = duplicateOf ? 'SEMANTIC_DUPLICATE' : conflict ? 'CONFLICT' : existing ? 'EXISTING' : 'NEW'
    if (duplicateOf) semanticDuplicates++
    statuses.push({ event, status, technical_status: existing ? (conflict ? 'CONFLICT' : 'EXISTING') : 'NEW', semantic_duplicate_of: duplicateOf, existing: existing || null })
  }
  const effective = statuses.filter(item => item.status !== 'SEMANTIC_DUPLICATE')
  const counts = {
    eventsNormalized: events.length,
    eventsExisting: statuses.filter(item => item.technical_status === 'EXISTING').length,
    eventsNew: statuses.filter(item => item.technical_status === 'NEW').length,
    eventsConflict: statuses.filter(item => item.technical_status === 'CONFLICT').length,
    semanticDuplicates,
    physicalEffectiveEvents: effective.length,
    physicalEffectiveNew: effective.filter(item => item.technical_status === 'NEW').length,
  }
  return { statuses, effective, stats: counts }
}

function sameValue(left, right) {
  return left == null && right == null ? true : Number.isFinite(Number(left)) && Number.isFinite(Number(right)) ? Number(left) === Number(right) : String(left) === String(right)
}

function buildReport({ elapsedMs, normalizedEvents, classification, resumed, interrupted, writeResult }) {
  return {
    mode: writePilot ? 'WRITE_PILOT' : writeRange ? 'WRITE_RANGE' : 'DRY_RUN',
    range: { from: dateFrom, to: dateTo, office: officeId, variants: variantFilter ? [...variantFilter] : 'ALL' },
    elapsed_ms: elapsedMs,
    requests: metrics.requests,
    pages: metrics.pages,
    retries: metrics.retries,
    timeouts: metrics.timeouts,
    status_429: metrics.status429,
    requests_per_second: Number((metrics.requests / Math.max(0.001, elapsedMs / 1000)).toFixed(3)),
    headers_by_source: metrics.headersBySource,
    details_by_source: metrics.detailsBySource,
    events_normalized: normalizedEvents.length,
    events_existing: stats.eventsExisting,
    events_new: stats.eventsNew,
    events_conflict: stats.eventsConflict,
    semantic_duplicates: stats.semanticDuplicates,
    physical_effective_events: stats.physicalEffectiveEvents,
    physical_effective_new: stats.physicalEffectiveNew,
    resumed,
    interrupted,
    write_result: writeResult,
    new_events: classification.statuses.filter(item => item.technical_status === 'NEW').map(item => ({ ...summarize(item.event), semantic_status: item.status, semantic_duplicate_of: item.semantic_duplicate_of })),
    conflicts: classification.statuses.filter(item => item.status === 'CONFLICT').map(item => ({ key: technicalKey(item.event), existing: summarize(item.existing), api: summarize(item.event) })),
    semantic_duplicate_events: classification.statuses.filter(item => item.status === 'SEMANTIC_DUPLICATE').map(item => ({ event: summarize(item.event), semantic_duplicate_of: item.semantic_duplicate_of })),
  }
}

async function writePilotEvents(classification, existingByKey) {
  const technicalNew = classification.statuses.filter(item => item.technical_status === 'NEW')
  const actualKeys = new Set(technicalNew.map(item => `${item.event.source_type}|${item.event.source_header_id}|${item.event.source_detail_id}`))
  if (actualKeys.size !== PILOT_KEYS.size || [...PILOT_KEYS].some(key => !actualKeys.has(key))) {
    fail(`Allowlist write-pilot no coincide con eventos nuevos: ${[...actualKeys].join(', ')}`)
  }
  if (technicalNew.some(item => existingByKey.has(technicalKey(item.event)))) {
    fail('Write-pilot detectó una clave existente durante la validación previa')
  }
  const reception = technicalNew.find(item => item.event.source_type === 'RECEPTION' && item.event.source_header_id === 10652)
  const canonicalReturn = technicalNew.find(item => item.event.source_type === 'RETURN' && item.event.source_header_id === 4515)
  if (!reception || !canonicalReturn || reception.semantic_duplicate_of !== technicalKey(canonicalReturn.event)) {
    fail('Write-pilot no pudo validar RECEPTION duplicate -> RETURN canonical')
  }

  const now = new Date().toISOString()
  const rows = technicalNew.map(item => ({
    ...item.event,
    update_stock: null,
    source_state: null,
    consumption_type_id: null,
    related_document_id: numeric(item.event.raw_json?.header?.guide?.id ?? item.event.raw_json?.header?.reference_document?.id ?? item.event.raw_json?.header?.internalDispatchId),
    captured_at: now,
    synced_at: now,
    bsale_sync_run_id: null,
  }))
  const { data, error } = await db.from('bsale_stock_kardex_events').insert(rows).select('source_type,source_header_id,source_detail_id')
  if (error) throw new Error(`Write-pilot no insertó eventos: ${error.message}`)
  if ((data || []).length !== rows.length) throw new Error(`Write-pilot insertó ${data?.length || 0} filas, se esperaban ${rows.length}`)

  const refresh = await refreshCurrentReadModels()
  return { inserted: data, refresh }
}

async function writeRangeEvents(classification, existingByKey) {
  if (classification.stats.eventsConflict > 0) {
    throw new Error(`Write-range detenido: ${classification.stats.eventsConflict} conflictos detectados; no se insertó ningún evento`)
  }
  const technicalNew = classification.statuses.filter(item => item.technical_status === 'NEW')
  if (technicalNew.some(item => existingByKey.has(technicalKey(item.event)))) {
    throw new Error('Write-range detectó una clave existente durante la validación previa')
  }
  const now = new Date().toISOString()
  const rows = technicalNew.map(item => ({
    ...item.event,
    update_stock: null,
    source_state: null,
    consumption_type_id: null,
    related_document_id: numeric(item.event.raw_json?.header?.guide?.id ?? item.event.raw_json?.header?.reference_document?.id ?? item.event.raw_json?.header?.internalDispatchId),
    captured_at: now,
    synced_at: now,
    bsale_sync_run_id: null,
  }))
  let inserted = 0
  for (let offset = 0; offset < rows.length; offset += 500) {
    const chunk = rows.slice(offset, offset + 500)
    const { data, error } = await db.from('bsale_stock_kardex_events').insert(chunk).select('source_type,source_header_id,source_detail_id')
    if (error) throw new Error(`Write-range no insertó lote ${offset}: ${error.message}`)
    inserted += data?.length || 0
  }
  const refresh = await refreshCurrentReadModels()
  return { inserted, technicalNew: rows.length, refresh }
}

async function refreshCurrentReadModels() {
  const { data: summary, error: summaryError } = await db.from('bsale_stock_break_summary_60d')
    .select('date_to').eq('company_id', companyId).eq('office_id', officeId).order('date_to', { ascending: false }).limit(1).maybeSingle()
  if (summaryError) throw new Error(`No se pudo leer ventana vigente del read model: ${summaryError.message}`)
  if (!summary?.date_to) throw new Error('No se encontró date_to vigente del read model')
  const dateToValue = new Date(`${summary.date_to}T00:00:00Z`)
  const dateFromValue = new Date(dateToValue)
  dateFromValue.setUTCDate(dateFromValue.getUTCDate() - 59)
  const dateFromValueString = dateFromValue.toISOString().slice(0, 10)
  const { data, error } = await db.rpc('refresh_bsale_stock_break_read_models', {
    p_company_id: companyId,
    p_office_id: officeId,
    p_date_from: dateFromValueString,
    p_date_to: summary.date_to,
  })
  if (error) throw new Error(`No se pudo refrescar read model: ${error.message}`)
  return { dateFrom: dateFromValueString, dateTo: summary.date_to, result: data }
}

function summarize(event) {
  if (!event) return null
  return {
    company_id: event.company_id,
    office_id: event.office_id,
    variant_id: event.variant_id,
    variant_code: event.variant_code,
    event_date: event.event_date,
    source_type: event.source_type,
    source_header_id: event.source_header_id,
    source_detail_id: event.source_detail_id,
    quantity_delta: event.quantity_delta,
    variant_stock_after: event.variant_stock_after,
    stock_before: event.variant_stock_after == null ? null : event.variant_stock_after - event.quantity_delta,
  }
}

async function loadCursor() {
  if (!args.resume) return { backfillId: `${companyId}:${officeId}:${dateFrom}:${dateTo}`, sourceIndex: 0, dateIndex: 0, page: 0, phase: 'headers', status: 'NEW' }
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, 'utf8'))
    if (parsed.companyId !== companyId || parsed.dateFrom !== dateFrom || parsed.dateTo !== dateTo || Number(parsed.officeId) !== officeId) fail('El cursor no coincide con company/office/rango')
    return parsed
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`No existe cursor para --resume: ${statePath}`)
    throw error
  }
}

async function persistCursor(patch) {
  cursor = { ...cursor, companyId, officeId, dateFrom, dateTo, ...patch }
  if (eventSpoolPath) cursor.eventsSpoolPath = eventSpoolPath
  const cursorDates = listDates(dateFrom, dateTo)
  cursor.currentSource = SOURCES[cursor.sourceIndex]?.type || null
  cursor.currentDate = cursorDates[cursor.dateIndex] || null
  cursor.currentPage = cursor.page || 0
  cursor.requestsCount = metrics.requests
  cursor.pagesCount = metrics.pages
  cursor.retries = metrics.retries
  cursor.timeouts = metrics.timeouts
  cursor.status429 = metrics.status429
  cursor.headersBySource = metrics.headersBySource
  cursor.detailsBySource = metrics.detailsBySource
  await fs.mkdir(path.dirname(statePath), { recursive: true })
  const temporary = `${statePath}.tmp-${process.pid}`
  await fs.writeFile(temporary, JSON.stringify(cursor, null, 2), 'utf8')
  await fs.rename(temporary, statePath)
}

function cursorSpoolPath(cursorFile, enabled) {
  return enabled ? `${cursorFile}.events.jsonl` : null
}

async function loadNormalizedEvents(spoolPath, savedCursor) {
  if (spoolPath) {
    try {
      const text = await fs.readFile(spoolPath, 'utf8')
      return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return Array.isArray(savedCursor.events) ? savedCursor.events : []
}

async function appendSpoolEvents(spoolPath, events) {
  if (!events.length) return
  await fs.mkdir(path.dirname(spoolPath), { recursive: true })
  await fs.appendFile(spoolPath, `${events.map(event => JSON.stringify(event)).join('\n')}\n`, 'utf8')
}

async function acquireLocalLock() {
  try {
    const handle = await fs.open(lockPath, 'wx')
    await handle.writeFile(JSON.stringify({ pid: process.pid, lock: 'STOCK_KARDEX_BACKFILL', started_at: new Date().toISOString() }))
    return handle
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    try {
      const active = JSON.parse(await fs.readFile(lockPath, 'utf8'))
      process.kill(Number(active.pid), 0)
    } catch (probeError) {
      if (probeError?.code === 'ESRCH' || probeError?.code === 'ENOENT') {
        await fs.unlink(lockPath).catch(() => {})
        return acquireLocalLock()
      }
    }
    fail(`Lock activo: ${lockPath}`)
  }
}

async function releaseLocalLock(handle) {
  await handle?.close().catch(() => {})
  await fs.unlink(lockPath).catch(() => {})
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
