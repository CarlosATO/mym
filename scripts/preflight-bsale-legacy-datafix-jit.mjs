#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createClient } from '@supabase/supabase-js'

export const COMPANY_ID = 'd1000000-0000-0000-0000-000000000001'
export const CANDIDATE_IDS = Object.freeze([
  83836, 83932, 83960, 84113, 84231, 84455, 84459, 84649, 84940, 84958,
  85250, 85434, 85478, 85709, 85764, 85882, 85942, 85954, 86051, 86287,
  86611, 86777, 86887, 87033, 87164, 87192, 87332, 87404, 87512, 87513,
  87643, 87922, 87973, 88041, 88146, 88315, 88451, 88452, 88553, 88601,
  88677, 88682, 88792, 89119, 89285, 89387, 89521, 90006, 90021, 90427,
  90431, 90453, 90467, 90468, 90555, 90583, 90699, 90706, 90901, 90996,
  91220,
])

const SPECIAL_IDS = [83326, 83327, 83878, 90045, 91741, 92172]
const CLOSURE_TYPES = [1, 5, 7]
const PAGE_LIMIT = 50
const MAX_PAGES = 4000
const MAX_RETRIES = 7
const DETAIL_CONCURRENCY = 2
const SNAPSHOT_SHA256 = '5bb6cc27ab3a759c8ffee8ae1c9b9f4a7e5f92f361e4580618a83292f74bac0a'
const CSV_SHA256 = '76c3621cba547834b245a3208af26e8cab837638ed537a4fb690beecff4e29ef'
const JSON_SHA256 = '8a015816352bc9637c9692b1a500e9428438b4d64285c13ec88721455d192cff'
const SNAPSHOT_FILE = '2026-10-16_Productos-por-despachar.xlsx'
const START_DATE = '2026-02-01'
const TYPE_NAMES = { 1: 'Boleta', 5: 'Factura', 7: 'Guia' }

function loadEnvLocal() {
  try {
    const content = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
    for (const line of content.split('\n')) {
      const value = line.trim()
      if (!value || value.startsWith('#')) continue
      const separator = value.indexOf('=')
      if (separator < 0) continue
      const key = value.slice(0, separator).trim()
      if (key && !process.env[key]) process.env[key] = value.slice(separator + 1).trim()
    }
  } catch {}
}

function parseArgs(argv) {
  const args = { asOf: null, baseUrl: null, evidenceJson: null, evidenceCsv: null, skipDb: false }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--as-of') args.asOf = argv[++i]
    else if (token === '--base-url') args.baseUrl = argv[++i]
    else if (token === '--evidence-json') args.evidenceJson = argv[++i]
    else if (token === '--evidence-csv') args.evidenceCsv = argv[++i]
    else if (token === '--skip-db') args.skipDb = true
    else if (token === '--help' || token === '-h') args.help = true
    else throw new Error(`Argumento no reconocido: ${token}`)
  }
  return args
}

function printHelp() {
  process.stderr.write([
    'Uso: node scripts/preflight-bsale-legacy-datafix-jit.mjs [opciones]',
    '',
    'Precheck JIT READ-ONLY del universo congelado de 61 NV.',
    'No acepta IDs ni company_id arbitrarios.',
    '',
    '  --as-of <ISO>             Corte de ejecucion (default: ahora).',
    '  --base-url <URL>          Solo para QA; default https://api.bsale.cl/v1.',
    '  --evidence-json <ruta>    Artefacto historico JSON para hash/qty.',
    '  --evidence-csv <ruta>     Artefacto historico CSV para hash.',
    '  --skip-db                 Omite comparacion Supabase; queda unauthorized.',
    '  --help                    Ayuda.',
  ].join('\n') + '\n')
}

function toDateOnly(value) {
  if (!value) return null
  if (typeof value === 'string') return value.slice(0, 10)
  const date = new Date(typeof value === 'number' ? value * 1000 : value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function monthWindows(from, to) {
  const windows = []
  let cursor = `${from.slice(0, 7)}-01`
  while (cursor <= to) {
    const next = addDays(new Date(Date.UTC(Number(cursor.slice(0, 4)), Number(cursor.slice(5, 7)), 0)).toISOString().slice(0, 10), 1)
    windows.push({ from: cursor < from ? from : cursor, to: next > to ? to : addDays(next, -1) })
    cursor = next
  }
  return windows
}

function chileOffset(date, hour = '00:00:00') {
  const guess = new Date(`${date}T${hour}Z`)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santiago', timeZoneName: 'longOffset', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(guess)
  const offset = parts.find((part) => part.type === 'timeZoneName')?.value?.replace('GMT', '') || '-03:00'
  return new Date(`${date}T${hour}${offset}`).getTime()
}

function epochSeconds(date, end = false) {
  return Math.floor(chileOffset(date, end ? '23:59:59' : '00:00:00') / 1000)
}

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function documentType(row) {
  return number(row?.documentTypeId ?? row?.document_type_id ?? row?.document_type?.id ?? row?.documentType?.id)
}

function documentState(row) {
  return number(row?.state)
}

function documentId(row) {
  return number(row?.id ?? row?.bsale_id)
}

function detailId(row) {
  return number(row?.bsale_id ?? row?.bsale_detail_id ?? row?.id)
}

function relatedDetailId(row) {
  return number(row?.relatedDetailId ?? row?.related_detail_bsale_id)
}

function detailQuantity(row) {
  return number(row?.quantity)
}

function createApiClient(baseUrl, token) {
  let requests = 0
  let retries = 0
  async function get(path, params = {}) {
    const url = new URL(`${baseUrl}${path}`)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
    let lastError
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: { access_token: token, Accept: 'application/json' },
          signal: AbortSignal.timeout(30000),
        })
        requests++
        if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
          const retryAfter = Number(response.headers.get('retry-after'))
          const error = new Error(`retryable HTTP ${response.status}`)
          error.retryAfterMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 0
          throw error
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return await response.json()
      } catch (error) {
        lastError = error
        if (attempt + 1 < MAX_RETRIES) {
          retries++
          const backoffMs = Math.min(30000, 1000 * (2 ** attempt))
          await new Promise((resolve) => setTimeout(resolve, Math.max(backoffMs, error.retryAfterMs || 0)))
        }
      }
    }
    throw new Error(`${path}: ${lastError?.message || 'request failed'}`)
  }
  return { get, stats: () => ({ requests, retries }) }
}

async function fetchAllPages(api, path, params, pages) {
  const items = []
  let offset = 0
  let reportedCount = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const payload = await api.get(path, { ...params, limit: PAGE_LIMIT, offset })
    const pageItems = Array.isArray(payload?.items) ? payload.items : null
    if (!pageItems) throw new Error(`${path}: respuesta sin items`) 
    if (Number.isFinite(Number(payload.count))) reportedCount = Number(payload.count)
    pages.count++
    items.push(...pageItems)
    if (pageItems.length < PAGE_LIMIT) {
      if (reportedCount !== null && items.length < reportedCount) throw new Error(`${path}: paginacion incompleta ${items.length}/${reportedCount}`)
      return { items, reportedCount }
    }
    offset += PAGE_LIMIT
  }
  throw new Error(`${path}: excedio MAX_PAGES`)
}

async function fetchDetails(api, id, pages) {
  return fetchAllPages(api, `/documents/${id}/details.json`, {}, pages)
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  async function consume() {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume))
  return results
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function loadEvidence(path, expectedHash) {
  if (!path) return { available: false, reason: 'not_provided' }
  if (!existsSync(path)) return { available: false, path, reason: 'missing' }
  const actual = sha256(path)
  return { available: actual === expectedHash, path, expectedHash, actual, reason: actual === expectedHash ? null : 'hash_mismatch' }
}

function loadFrozenJson(path) {
  if (!path || !existsSync(path)) return null
  const payload = JSON.parse(readFileSync(path, 'utf8'))
  return new Map((payload.candidates || []).map((row) => [Number(row.bsale_nv_id), row]))
}

async function compareDb(apiRows, sourceDetails, reasons, skipDb) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (skipDb || !url || !key) {
    reasons.push('DB_READ_ONLY_COMPARISON_UNAVAILABLE')
    return { available: false, docs: 0, details: 0, invoiceLinks: 0, drift: ['DB comparison unavailable'] }
  }
  const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } }).schema('integraciones')
  const ids = [...apiRows.keys()]
  const selectIn = async (table, column, values) => {
    const rows = []
    for (let start = 0; start < values.length; start += 100) {
      const { data, error } = await db.from(table).select('*').eq('company_id', COMPANY_ID).in(column, values.slice(start, start + 100))
      if (error) throw new Error(`${table}: ${error.message}`)
      rows.push(...(data || []))
    }
    return rows
  }
  try {
    const [docs, details, links] = await Promise.all([
      selectIn('bsale_documents', 'bsale_id', ids),
      selectIn('bsale_document_details', 'bsale_document_id', ids),
      selectIn('bsale_invoice_sales_order_links', 'sales_order_bsale_id', ids),
    ])
    const drift = []
    const dbDocById = new Map(docs.map((row) => [Number(row.bsale_id), row]))
    const dbDetailsByDoc = new Map()
    for (const row of details) {
      const id = Number(row.bsale_document_id)
      if (!dbDetailsByDoc.has(id)) dbDetailsByDoc.set(id, [])
      dbDetailsByDoc.get(id).push(row)
    }
    for (const [id, source] of apiRows) {
      const dbDoc = dbDocById.get(id)
      if (!dbDoc || Number(dbDoc.document_type_id) !== 23 || Number(dbDoc.state) !== 0) drift.push({ bsale_nv_id: id, reason: 'DB_SOURCE_TYPE_OR_STATE' })
      const apiIds = [...(sourceDetails.get(id) || [])].map(detailId).sort((a, b) => a - b)
      const dbIds = (dbDetailsByDoc.get(id) || []).map(detailId).sort((a, b) => a - b)
      if (JSON.stringify(apiIds) !== JSON.stringify(dbIds)) drift.push({ bsale_nv_id: id, reason: 'DB_SOURCE_DETAIL_IDS' })
    }
    for (const link of links) drift.push({ bsale_nv_id: Number(link.sales_order_bsale_id), reason: 'DB_INVOICE_LINK_PRESENT' })
    return { available: true, docs: docs.length, details: details.length, invoiceLinks: links.length, drift }
  } catch (error) {
    reasons.push('DB_READ_ONLY_QUERY_ERROR')
    return { available: false, docs: 0, details: 0, invoiceLinks: 0, drift: [error.message] }
  }
}

export async function runPreflight({ api, asOf, asOfInstant, evidenceJsonPath, evidenceCsvPath, skipDb = false } = {}) {
  const reasons = []
  const apiErrors = []
  const pages = { count: 0 }
  const sourceRows = new Map()
  const sourceDetails = new Map()
  const frozen = loadFrozenJson(evidenceJsonPath)
  const sourceValidations = []
  const sourceDetailIds = new Set()

  if (CANDIDATE_IDS.length !== 61 || new Set(CANDIDATE_IDS).size !== 61 || CANDIDATE_IDS.some((id) => SPECIAL_IDS.includes(id))) {
    reasons.push('FIXED_UNIVERSE_INVALID')
  }
  if (CANDIDATE_IDS.some((id) => SPECIAL_IDS.includes(id))) reasons.push('SPECIAL_ID_IN_UNIVERSE')

  for (const id of CANDIDATE_IDS) {
    try {
      const doc = await api.get(`/documents/${id}.json`)
      const detailsPayload = await fetchDetails(api, id, pages)
      const details = detailsPayload.items
      const validDetails = details.length > 0 && details.every((row) => detailId(row) !== null && detailQuantity(row) !== null)
      const validation = {
        bsale_nv_id: id,
        exists: documentId(doc) === id,
        document_type_id: documentType(doc),
        state: documentState(doc),
        details_count: details.length,
        details_complete: validDetails,
        detail_ids: details.map(detailId).filter((value) => value !== null),
        total_quantity: details.reduce((sum, row) => sum + (detailQuantity(row) || 0), 0),
        folio: doc.number ?? null,
      }
      sourceValidations.push(validation)
      if (!validation.exists || validation.document_type_id !== 23 || validation.state !== 0 || !validDetails) reasons.push(`SOURCE_INVALID_${id}`)
      if (validation.exists && validation.document_type_id === 23 && validation.state === 0 && validDetails) {
        sourceRows.set(id, doc)
        sourceDetails.set(id, details)
        for (const detail of details) sourceDetailIds.add(detailId(detail))
      }
      const frozenRow = frozen?.get(id)
      if (frozenRow && (frozenRow.api_details_count !== details.length || Number(frozenRow.api_detail_qty) !== validation.total_quantity)) {
        reasons.push(`FROZEN_DETAIL_DRIFT_${id}`)
      }
    } catch (error) {
      apiErrors.push({ scope: 'source', bsale_nv_id: id, error: error.message })
      reasons.push(`SOURCE_API_ERROR_${id}`)
    }
  }

  const relatedMatches = []
  const docsScanned = { 1: 0, 5: 0, 7: 0 }
  const pagesByType = { 1: 0, 5: 0, 7: 0 }
  if (sourceRows.size === 61 && apiErrors.length === 0) {
    const windows = monthWindows(START_DATE, asOf)
    const closureDocs = new Map()
    for (const type of CLOSURE_TYPES) {
      for (const window of windows) {
        try {
          const pagesBefore = pages.count
          const result = await fetchAllPages(api, '/documents.json', {
            documenttypeid: type,
            generationdaterange: `[${epochSeconds(window.from)},${window.to === asOf && asOfInstant ? Math.floor(Date.parse(asOfInstant) / 1000) : epochSeconds(window.to, true)}]`,
          }, pages)
          pagesByType[type] += pages.count - pagesBefore
          for (const doc of result.items) {
            const id = documentId(doc)
            if (id !== null && documentType(doc) === type) closureDocs.set(`${type}:${id}`, doc)
          }
        } catch (error) {
          apiErrors.push({ scope: 'closure_list', document_type_id: type, window, error: error.message })
          reasons.push(`CLOSURE_LIST_API_ERROR_${type}_${window.from}`)
        }
      }
    }
    for (const doc of closureDocs.values()) docsScanned[documentType(doc)]++
    const detailsResults = await mapLimit([...closureDocs.values()], DETAIL_CONCURRENCY, async (doc) => {
      try {
        const details = await fetchDetails(api, documentId(doc), pages)
        return { doc, details: details.items }
      } catch (error) {
        apiErrors.push({ scope: 'closure_details', document_type_id: documentType(doc), bsale_document_id: documentId(doc), error: error.message })
        reasons.push(`CLOSURE_DETAILS_API_ERROR_${documentType(doc)}_${documentId(doc)}`)
        return { doc, details: null }
      }
    })
    for (const { doc, details } of detailsResults) {
      if (!details) continue
      for (const child of details) {
        const related = relatedDetailId(child)
        if (related === null || !sourceDetailIds.has(related)) continue
        const childQuantity = detailQuantity(child)
        const match = {
          candidate_bsale_nv_id: [...sourceDetails.entries()].find(([, rows]) => rows.some((row) => detailId(row) === related))?.[0] ?? null,
          source_detail: { id: related, quantity: null },
          child: { bsale_document_id: documentId(doc), document_type_id: documentType(doc), number: doc.number ?? null, state: documentState(doc), emission_date: doc.emissionDate ?? null, generation_date: doc.generationDate ?? null },
          child_detail: { id: detailId(child), relatedDetailId: related, quantity: childQuantity },
          classification: documentState(doc) === 0 ? 'ACTIVE_CHILD_STATE_0' : 'INACTIVE_OR_OTHER_STATE_CHILD',
        }
        const source = sourceDetails.get(match.candidate_bsale_nv_id)?.find((row) => detailId(row) === related)
        match.source_detail.quantity = detailQuantity(source)
        relatedMatches.push(match)
        reasons.push(`RELATED_CHILD_${match.candidate_bsale_nv_id}`)
      }
    }
  } else {
    reasons.push('CLOSURE_SCAN_NOT_AUTHORIZED_BY_SOURCE_VALIDATION')
  }

  const evidence = {
    snapshot: { file: SNAPSHOT_FILE, sha256: SNAPSHOT_SHA256 },
    csv: loadEvidence(evidenceCsvPath, CSV_SHA256),
    json: { ...loadEvidence(evidenceJsonPath, JSON_SHA256), frozen_detail_comparison: Boolean(frozen) },
  }
  const db = await compareDb(sourceRows, sourceDetails, reasons, skipDb)
  const sourceOk = sourceValidations.length === 61 && sourceValidations.every((row) => row.exists && row.document_type_id === 23 && row.state === 0 && row.details_complete)
  const closureOk = apiErrors.length === 0 && sourceRows.size === 61 && relatedMatches.length === 0
  const authorized = CANDIDATE_IDS.length === 61 && new Set(CANDIDATE_IDS).size === 61 && sourceOk && closureOk && db.available && db.drift.length === 0 && !reasons.some((reason) => reason.startsWith('FROZEN_DETAIL_DRIFT_'))
  return {
    executed_at: new Date().toISOString(), timezone: 'America/Santiago', company_id: COMPANY_ID,
    candidate_count: CANDIDATE_IDS.length, candidate_distinct_count: new Set(CANDIDATE_IDS).size,
    excluded_ids_present: CANDIDATE_IDS.filter((id) => SPECIAL_IDS.includes(id)),
    source: { validations: sourceValidations, valid_count: sourceValidations.filter((row) => row.exists && row.document_type_id === 23 && row.state === 0 && row.details_complete).length, details_complete_count: sourceValidations.filter((row) => row.details_complete).length },
    scan: { from: START_DATE, to: asOfInstant || asOf, timezone: 'America/Santiago', document_types: CLOSURE_TYPES, docs_scanned: docsScanned, pages_scanned: pages.count, pages_by_type: pagesByType, no_state_filter: true, monthly_windows: true },
    related_matches: relatedMatches, related_counts: Object.fromEntries(CLOSURE_TYPES.map((type) => [TYPE_NAMES[type], relatedMatches.filter((row) => row.child.document_type_id === type).length])),
    api_errors: apiErrors, db_comparison: db, evidence, api_stats: api.stats?.() || null,
    drift: [...db.drift, ...reasons.filter((reason) => reason.startsWith('FROZEN_DETAIL_DRIFT_'))],
    authorized, DATA_FIX_AUTHORIZED: authorized, reasons_not_authorized: authorized ? [] : [...new Set(reasons)],
  }
}

function printHuman(report, outputPath) {
  const source = report.source
  process.stdout.write([
    'JIT BSALE LEGACY DATA-FIX',
    '',
    `Candidates: ${source.valid_count === 61 ? '61/61' : `${source.valid_count}/61`}`,
    `Source type23: ${source.validations.filter((row) => row.document_type_id === 23).length}/61`,
    `Source state0: ${source.validations.filter((row) => row.state === 0).length}/61`,
    `Source details complete: ${source.details_complete_count}/61`,
    '',
    `Closure documents scanned: Type 1: ${report.scan.docs_scanned[1]} | Type 5: ${report.scan.docs_scanned[5]} | Type 7: ${report.scan.docs_scanned[7]}`,
    `Related child docs: Boletas: ${report.related_counts.Boleta} | Facturas: ${report.related_counts.Factura} | Guias: ${report.related_counts.Guia}`,
    `Other-state related docs: ${report.related_matches.filter((row) => row.classification === 'INACTIVE_OR_OTHER_STATE_CHILD').length}`,
    `API errors: ${report.api_errors.length}`,
    `Drift: ${report.drift.length}`,
    `DATA_FIX_AUTHORIZED=${report.DATA_FIX_AUTHORIZED}`,
    `JSON: ${outputPath}`,
  ].join('\n') + '\n')
}

async function main() {
  loadEnvLocal()
  const args = parseArgs(process.argv.slice(2))
  if (args.help) return printHelp()
  const asOf = toDateOnly(args.asOf) || new Date().toISOString().slice(0, 10)
  const asOfInstant = args.asOf
    ? (args.asOf.includes('T') ? new Date(args.asOf).toISOString() : `${asOf}T23:59:59.999Z`)
    : new Date().toISOString()
  if (asOf < START_DATE) throw new Error(`--as-of no puede ser anterior a ${START_DATE}`)
  const token = process.env.BSALE_ACCESS_TOKEN_CAYLO || process.env.BSALE_ACCESS_TOKEN
  if (!token) throw new Error('No hay token Bsale configurado')
  const api = createApiClient((args.baseUrl || process.env.BSALE_API_BASE_URL || 'https://api.bsale.cl/v1').replace(/\/$/, ''), token)
  const report = await runPreflight({ api, asOf, asOfInstant, evidenceJsonPath: args.evidenceJson, evidenceCsvPath: args.evidenceCsv, skipDb: args.skipDb })
  const outputPath = `${tmpdir()}/legacy-jit-precheck-${Date.now()}.json`
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  printHuman(report, outputPath)
  process.exitCode = report.DATA_FIX_AUTHORIZED ? 0 : 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
