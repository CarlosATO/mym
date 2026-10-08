#!/usr/bin/env node

// GET-only Bsale expand audit. No Supabase and no Bsale writes.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function loadEnv() {
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

loadEnv()
const companyId = process.env.BSALE_WAREHOUSE_AUDIT_COMPANY_ID || 'd1000000-0000-0000-0000-000000000001'
const baseUrl = process.env.BSALE_API_BASE_URL?.trim() || 'https://api.bsale.cl/v1'
const token = companyId === 'd3000000-0000-0000-0000-000000000003'
  ? process.env.BSALE_ACCESS_TOKEN_AMIMASCOTA
  : process.env.BSALE_ACCESS_TOKEN_CAYLO || process.env.BSALE_ACCESS_TOKEN
if (!token) throw new Error(`No hay token Bsale configurado para ${companyId}`)

const headers = { access_token: token, Accept: 'application/json' }
let requests = 0

async function get(path, params = {}) {
  const url = new URL(`${baseUrl}${path}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  const started = Date.now()
  const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(30000) })
  requests++
  const text = await response.text()
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}: ${text.slice(0, 200)}`)
  return { value: JSON.parse(text), bytes: Buffer.byteLength(text), durationMs: Date.now() - started }
}

function detailItems(value) {
  if (Array.isArray(value?.details)) return value.details
  if (Array.isArray(value?.details?.items)) return value.details.items
  if (Array.isArray(value?.detail)) return value.detail
  return null
}

async function inspectType(documentTypeId) {
  const page = await get('/documents.json', { documenttypeid: documentTypeId, limit: 50, offset: 0, expand: 'details' })
  const listItems = Array.isArray(page.value.items) ? page.value.items : []
  const listDetailShape = listItems[0] ? {
    keys: Object.keys(listItems[0]),
    hasDetails: Object.prototype.hasOwnProperty.call(listItems[0], 'details'),
    detailsType: typeof listItems[0].details,
  } : null
  const expandedListItems = listItems.map((item) => ({
    id: item.id,
    number: item.number,
    detailCount: detailItems(item)?.length ?? null,
  }))

  const samples = []
  // Ten per type keeps this audit bounded while still finding ordinary and
  // high-line documents. The list page itself is also tested with expand.
  for (const item of listItems.slice(0, 10)) {
    const result = await get(`/documents/${item.id}.json`, { expand: 'details' })
    const details = detailItems(result.value)
    samples.push({
      id: item.id,
      number: item.number,
      state: item.state,
      detailCount: details?.length ?? null,
      hasDetails: details !== null,
      detailKeys: details?.[0] ? Object.keys(details[0]) : [],
      includesRelatedDetailId: Boolean(details?.some((detail) => Object.prototype.hasOwnProperty.call(detail, 'relatedDetailId'))),
      bytes: result.bytes,
      durationMs: result.durationMs,
      topLevelKeys: Object.keys(result.value),
    })
  }

  return {
    documentTypeId,
    list: {
      requestedLimit: 50,
      returned: listItems.length,
      topLevelKeys: Object.keys(page.value),
      itemShape: listDetailShape,
      expandedItemDetailCounts: expandedListItems,
    },
    documentSamples: samples,
  }
}

async function compareKnownDocuments() {
  const configured = (process.env.BSALE_EXPAND_IDS || '23:72407,5:68')
    .split(',').map((value) => value.trim()).filter(Boolean)
  const results = []
  for (const entry of configured) {
    const [type, idText] = entry.split(':')
    const id = Number(idText)
    if (!Number.isFinite(id)) continue
    const expanded = await get(`/documents/${id}.json`, { expand: 'details' })
    const expandedDetails = detailItems(expanded.value) || []
    const expandedDetailsEnvelope = expanded.value?.details && !Array.isArray(expanded.value.details)
      ? expanded.value.details
      : null
    let offset = 0
    let detailCount = 0
    let pages = 0
    let relatedDetailIdCount = 0
    while (true) {
      const page = await get(`/documents/${id}/details.json`, { limit: 50, offset })
      const items = Array.isArray(page.value.items) ? page.value.items : []
      pages++
      detailCount += items.length
      relatedDetailIdCount += items.filter((item) => Object.prototype.hasOwnProperty.call(item, 'relatedDetailId')).length
      if (items.length < 50) break
      offset += 50
    }
    results.push({
      documentTypeId: Number(type),
      id,
      expandDetailCount: expandedDetails.length,
      expandReportedCount: expandedDetailsEnvelope?.count ?? null,
      expandReportedLimit: expandedDetailsEnvelope?.limit ?? null,
      endpointDetailCount: detailCount,
      endpointDetailPages: pages,
      expandIncludesRelatedDetailId: expandedDetails.some((item) => Object.prototype.hasOwnProperty.call(item, 'relatedDetailId')),
      endpointRelatedDetailIdCount: relatedDetailIdCount,
      expandBytes: expanded.bytes,
      expandDurationMs: expanded.durationMs,
    })
  }
  return results
}

const startedAt = Date.now()
const result = {
  readOnly: true,
  companyId,
  baseUrl,
  expand: 'details',
  salesOrders: await inspectType(23),
  invoices: await inspectType(5),
  knownDocumentComparisons: await compareKnownDocuments(),
  requests,
  durationMs: Date.now() - startedAt,
}
console.log(JSON.stringify(result, null, 2))
