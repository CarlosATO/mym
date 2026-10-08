#!/usr/bin/env node

// GET-only audit. It never imports Supabase and never writes to Bsale.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function loadDotEnvLocal() {
  try {
    const content = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const separator = trimmed.indexOf('=')
      if (separator < 0) continue
      const key = trimmed.slice(0, separator).trim()
      const value = trimmed.slice(separator + 1).trim()
      if (key && !process.env[key]) process.env[key] = value
    }
  } catch {
    // Environment variables may already be provided by the runner.
  }
}

loadDotEnvLocal()

const companyId = process.env.BSALE_WAREHOUSE_AUDIT_COMPANY_ID || 'd1000000-0000-0000-0000-000000000001'
const baseUrl = process.env.BSALE_API_BASE_URL?.trim() || 'https://api.bsale.cl/v1'
const token = companyId === 'd3000000-0000-0000-0000-000000000003'
  ? process.env.BSALE_ACCESS_TOKEN_AMIMASCOTA
  : process.env.BSALE_ACCESS_TOKEN_CAYLO || process.env.BSALE_ACCESS_TOKEN

if (!token) throw new Error(`No hay token Bsale configurado para ${companyId}`)

const limit = 50
const rateHeaders = new Set()
let requestCount = 0

async function get(path, params = {}) {
  const url = new URL(`${baseUrl}${path}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  const response = await fetch(url, {
    method: 'GET',
    headers: { access_token: token, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  })
  requestCount++
  for (const [key, value] of response.headers.entries()) {
    if (/rate|retry|limit|remaining|reset/i.test(key)) rateHeaders.add(`${key}: ${value}`)
  }
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}`)
  return response.json()
}

async function auditDocumentType(documentTypeId) {
  let offset = 0
  let pages = 0
  let totalCount = null
  const states = new Map()
  let numberZero = 0
  let documents = 0
  const clientIds = new Set()
  const samples = []

  while (true) {
    const payload = await get('/documents.json', { documenttypeid: documentTypeId, limit, offset })
    const items = Array.isArray(payload.items) ? payload.items : []
    pages++
    totalCount = Number.isFinite(Number(payload.count)) ? Number(payload.count) : totalCount
    for (const item of items) {
      documents++
      const state = String(item.state ?? 'NULL')
      states.set(state, (states.get(state) || 0) + 1)
      if (Number(item.number) === 0) numberZero++
      const clientId = Number(item.client?.id ?? item.clientId)
      if (Number.isFinite(clientId)) clientIds.add(clientId)
      if (samples.length < 5) samples.push({ id: item.id, number: item.number, state: item.state })
    }
    if (items.length < limit) break
    offset += limit
  }

  return {
    documentTypeId,
    pages,
    reportedCount: totalCount,
    documents,
    numberZero,
    uniqueClientIds: clientIds.size,
    states: Object.fromEntries(states),
    samples,
  }
}

async function auditDirectDocuments() {
  const ids = (process.env.BSALE_WAREHOUSE_AUDIT_IDS || '91785,91794,91807,91810')
    .split(',').map((value) => Number(value.trim())).filter(Number.isFinite)
  const documents = []
  for (const id of ids) {
    try {
      const document = await get(`/documents/${id}.json`)
      documents.push({ id, found: true, number: document.number ?? null, state: document.state ?? null, documentTypeId: document.documentTypeId ?? document.document_type?.id ?? null })
    } catch (error) {
      documents.push({ id, found: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return documents
}

async function main() {
  const startedAt = Date.now()
  if (process.env.BSALE_WAREHOUSE_AUDIT_DIRECT_ONLY === '1') {
    console.log(JSON.stringify({ read_only: true, company_id: companyId, direct_documents: await auditDirectDocuments(), total_get_requests: requestCount, rate_limit_headers: [...rateHeaders], duration_ms: Date.now() - startedAt }, null, 2))
    return
  }
  const limitProbe = await get('/documents.json', { documenttypeid: 23, limit: 100, offset: 0 })
  const nv = await auditDocumentType(23)
  if (process.env.BSALE_WAREHOUSE_AUDIT_NV_ONLY === '1') {
    console.log(JSON.stringify({ read_only: true, company_id: companyId, sales_orders: nv, total_get_requests: requestCount, rate_limit_headers: [...rateHeaders], duration_ms: Date.now() - startedAt }, null, 2))
    return
  }
  const invoices = await auditDocumentType(5)
  const directDocuments = await auditDirectDocuments()
  const estimated = {
    list_pages: nv.pages + invoices.pages,
    document_detail_requests: nv.documents + invoices.documents,
    invoice_reference_requests: invoices.documents,
    document_seller_requests: nv.documents + invoices.documents,
    list_and_related_requests: nv.pages + invoices.pages + nv.documents + invoices.documents * 2,
    estimated_without_client_catalog: nv.pages + invoices.pages + (nv.documents + invoices.documents) * 2 + invoices.documents,
  }
  console.log(JSON.stringify({
    read_only: true,
    company_id: companyId,
    base_url: baseUrl,
    page_limit: limit,
    limit_probe: { requested: 100, returned: Array.isArray(limitProbe.items) ? limitProbe.items.length : 0, reported_count: limitProbe.count },
    sales_orders: nv,
    invoices,
    direct_documents: directDocuments,
    total_get_requests: requestCount,
    rate_limit_headers: [...rateHeaders],
    estimated_full_requests: estimated,
    duration_ms: Date.now() - startedAt,
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
