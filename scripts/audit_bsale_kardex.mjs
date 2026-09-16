import { createClient } from '@supabase/supabase-js'

const base = process.env.BSALE_API_BASE_URL || 'https://api.bsale.cl/v1'
const token = process.env.BSALE_ACCESS_TOKEN
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const companyId = 'd1000000-0000-0000-0000-000000000001'
const officeId = 1
const to = new Date('2026-09-16T23:59:59Z')
const from = new Date(to)
from.setUTCDate(from.getUTCDate() - 59)
const epoch = date => Math.floor(date.getTime() / 1000)
const iso = date => date.toISOString()
const dateOnly = date => date.toISOString().slice(0, 10)

if (!token || !supabaseUrl || !serviceKey) throw new Error('Missing audit environment variables')
const db = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
const metrics = { requests: 0, pages: 0, movements: 0, startedAt: iso(new Date()) }
const calls = []

async function api(path, params = {}) {
  const url = new URL(`${base}${path}`)
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value))
  const started = performance.now()
  const response = await fetch(url, { headers: { access_token: token, Accept: 'application/json' } })
  const elapsedMs = Math.round(performance.now() - started)
  metrics.requests++
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = text.slice(0, 500) }
  calls.push({ path, params, status: response.status, elapsedMs, count: body?.count ?? null })
  return { ok: response.ok, status: response.status, body }
}

async function all(path, params = {}) {
  let offset = 0
  const items = []
  for (;;) {
    const result = await api(path, { ...params, limit: 50, offset })
    if (!result.ok) return { items, error: { status: result.status, body: result.body } }
    const page = Array.isArray(result.body?.items) ? result.body.items : []
    metrics.pages++
    items.push(...page)
    if (page.length < 50 || items.length >= Number(result.body?.count ?? items.length)) break
    offset += 50
  }
  return { items }
}

async function allDays(path, param) {
  const dates = []
  for (let cursor = new Date(from); cursor <= to; cursor.setUTCDate(cursor.getUTCDate() + 1)) dates.push(new Date(cursor))
  const items = []
  for (let offset = 0; offset < dates.length; offset += 10) {
    const batch = await Promise.all(dates.slice(offset, offset + 10).map(date => all(path, { [param]: epoch(date) })))
    for (const result of batch) items.push(...result.items)
  }
  return { items }
}

const result = { auditWindow: { from: dateOnly(from), to: dateOnly(to), fromEpoch: epoch(from), toEpoch: epoch(to) }, probes: [], sources: {}, sample: [], metrics, calls }

async function main() {
  const probes = [
    ['/stocks.json', { officeid: officeId }],
    ['/stocks/receptions.json', { officeid: officeId, admissiondate: epoch(from) }],
    ['/stocks/consumptions.json', { officeid: officeId, consumptiondate: epoch(from) }],
    ['/stocks/dispatches.json', { officeid: officeId }],
    ['/stocks/inventories.json', { officeid: officeId }],
    ['/stocks/adjustments.json', { officeid: officeId }],
    ['/stocks/transfers.json', { officeid: officeId }],
    ['/shippings.json', { officeid: officeId }],
    ['/returns.json', { officeid: officeId }],
    ['/stock_consumption_types.json', {}],
    ['/webhooks.json', {}],
  ]
  for (const [path, params] of probes) {
    const response = await api(path, params)
    result.probes.push({ path, params, status: response.status, count: response.body?.count ?? null, sampleKeys: response.body?.items?.[0] ? Object.keys(response.body.items[0]) : Object.keys(response.body || {}) })
  }

  const stock = await all('/stocks.json', { officeid: officeId })
  const variants = await all('/variants.json', { expand: 'product', state: 0 })
  const current = await db.schema('integraciones').from('bsale_stock_current').select('variant_id,variant_code,quantity,quantity_available,office_id,synced_at').eq('company_id', companyId).eq('office_id', officeId)
  let snapshots = await db.schema('integraciones').from('bsale_stock_daily_snapshots').select('variant_id,variant_code,quantity,quantity_available,snapshot_date,captured_at').eq('company_id', companyId).eq('office_id', officeId).gte('snapshot_date', dateOnly(from)).lte('snapshot_date', dateOnly(to)).order('snapshot_date')
  const details = await db.schema('integraciones').from('bsale_document_details').select('variant_id,variant_code,quantity,bsale_document_id').eq('company_id', companyId).gte('synced_at', iso(from)).lte('synced_at', iso(to))
  if (current.error || snapshots.error || details.error) throw new Error(JSON.stringify({ current: current.error, snapshots: snapshots.error, details: details.error }))

  const currentMap = new Map((current.data || []).map(row => [Number(row.variant_id), row]))
  const variantMap = new Map((variants.items || []).map(row => [Number(row.id), row]))
  const salesCount = new Map()
  for (const row of details.data || []) salesCount.set(Number(row.variant_id), (salesCount.get(Number(row.variant_id)) || 0) + 1)
  const candidates = [...currentMap.values()].map(row => ({ id: Number(row.variant_id), row, variant: variantMap.get(Number(row.variant_id)), sales: salesCount.get(Number(row.variant_id)) || 0 }))
  const chosen = []
  const add = candidate => { if (candidate && !chosen.some(x => x.id === candidate.id)) chosen.push(candidate) }
  add(candidates.find(x => x.variant?.code === '20001'))
  add(candidates.find(x => x.variant?.code === '3000'))
  add(candidates.find(x => Number(x.row.quantity_available) === 0))
  add(candidates.sort((a, b) => b.sales - a.sales)[0])
  add(candidates.sort((a, b) => a.sales - b.sales)[0])
  for (const candidate of candidates.sort((a, b) => b.sales - a.sales)) { if (chosen.length >= 5) break; add(candidate) }

  // PostgREST caps an un-ranged response at 1,000 rows; query the sample
  // explicitly so snapshots are not hidden by variant ordering.
  if (chosen.length) snapshots = await db.schema('integraciones').from('bsale_stock_daily_snapshots').select('variant_id,variant_code,quantity,quantity_available,snapshot_date,captured_at').eq('company_id', companyId).eq('office_id', officeId).in('variant_id', chosen.map(x => x.id)).gte('snapshot_date', dateOnly(from)).lte('snapshot_date', dateOnly(to)).order('snapshot_date')
  const sampleDetailQuery = chosen.length
    ? await db.schema('integraciones').from('bsale_document_details').select('variant_id,variant_code,quantity,bsale_document_id').eq('company_id', companyId).in('variant_id', chosen.map(x => x.id))
    : { data: [], error: null }
  const sampleDetails = sampleDetailQuery.data || []
  const sampleDocIds = [...new Set(sampleDetails.map(row => Number(row.bsale_document_id)).filter(Boolean))]
  const sampleDocsQuery = sampleDocIds.length
    ? await db.schema('integraciones').from('bsale_documents').select('bsale_id,emission_date,generation_date,document_type_id,office_id,state,number').eq('company_id', companyId).in('bsale_id', sampleDocIds)
    : { data: [], error: null }
  const sampleDocs = new Map((sampleDocsQuery.data || []).map(row => [Number(row.bsale_id), row]))
  const stockDocs = [...sampleDocs.values()].filter(row => [5, 7, 23].includes(Number(row.document_type_id)) && Number(row.state) === 0)
  const shippingLookups = await Promise.all(stockDocs.map(row => all('/shippings.json', { documentid: row.bsale_id })))
  const shippingHeaders = shippingLookups.flatMap(result => result.items || []).filter(row => Number(row.office?.id) === officeId && Number(row.state) === 0)
  const shippingDetails = []
  for (const header of shippingHeaders) {
    const detail = await all(`/shippings/${header.id}/details.json`)
    for (const row of detail.items || []) shippingDetails.push({ headerId: header.id, date: new Date(Number(header.shippingDate) * 1000).toISOString(), variantId: Number(row.variant?.id), quantity: Number(row.quantity), variantStock: row.variantStock == null ? null : Number(row.variantStock) })
  }

  // The tenant accepts admissiondate/consumptiondate as an exact-day filter,
  // not as a range. Fetch headers once and apply the 60-day window locally.
  const receptions = await allDays('/stocks/receptions.json', 'admissiondate')
  const consumptions = await allDays('/stocks/consumptions.json', 'consumptiondate')
  const movementRows = []
  for (const header of receptions.items || []) {
    const d = new Date(Number(header.admissionDate) * 1000)
    if (d < from || d > to || Number(header.office?.id) !== officeId) continue
    const detail = await all(`/stocks/receptions/${header.id}/details.json`)
    for (const row of detail.items || []) movementRows.push({ source: 'reception', headerId: header.id, date: d.toISOString(), officeId: Number(header.office?.id), variantId: Number(row.variant?.id), quantity: Number(row.quantity), variantStock: row.variantStock == null ? null : Number(row.variantStock), raw: row })
  }
  for (const header of consumptions.items || []) {
    const d = new Date(Number(header.consumptionDate) * 1000)
    if (d < from || d > to || Number(header.office?.id) !== officeId) continue
    const detail = await all(`/stocks/consumptions/${header.id}/details.json`)
    for (const row of detail.items || []) movementRows.push({ source: 'consumption', headerId: header.id, date: d.toISOString(), officeId: Number(header.office?.id), variantId: Number(row.variant?.id), quantity: Number(row.quantity), variantStock: row.variantStock == null ? null : Number(row.variantStock), raw: row })
  }
  metrics.movements = movementRows.length
  for (const candidate of chosen) {
    const v = candidate.variant || {}
    const rows = movementRows.filter(row => row.variantId === candidate.id).sort((a, b) => a.date.localeCompare(b.date))
    const snaps = (snapshots.data || []).filter(row => Number(row.variant_id) === candidate.id)
    const sales = sampleDetails.filter(row => Number(row.variant_id) === candidate.id).map(row => ({ ...row, document: sampleDocs.get(Number(row.bsale_document_id)) || null })).filter(row => row.document && Number(row.document.office_id) === officeId && row.document.emission_date >= dateOnly(from) && row.document.emission_date <= dateOnly(to))
    const shippings = shippingDetails.filter(row => row.variantId === candidate.id && row.date >= iso(from) && row.date <= iso(to))
    result.sample.push({ variantId: candidate.id, sku: v.code || null, product: v.product?.name || null, bsaleCurrent: stock.items?.find(row => Number(row.variant?.id) === candidate.id) || null, supabaseCurrent: candidate.row, snapshots: snaps, salesRows: sales.length, sales, shippings, movements: rows })
  }
  const variantNames = new Map((variants.items || []).map(row => [Number(row.id), { sku: row.code || null, product: row.product?.name || null }]))
  const byVariant = new Map()
  for (const row of movementRows) byVariant.set(row.variantId, [...(byVariant.get(row.variantId) || []), row])
  const zeroThenRecovery = []
  for (const [variantId, rows] of byVariant) {
    const ordered = rows.sort((a, b) => a.date.localeCompare(b.date))
    for (let index = 0; index < ordered.length; index++) {
      if (ordered[index].variantStock !== 0) continue
      const recovery = ordered.slice(index + 1).find(row => row.variantStock > 0)
      if (recovery) { zeroThenRecovery.push({ ...(variantNames.get(variantId) || {}), variantId, zero: ordered[index], recovery }); break }
    }
    if (zeroThenRecovery.length >= 2) break
  }
  result.intradayChecks = { zeroThenRecovery, multipleEventsSameDay: [...byVariant.entries()].flatMap(([variantId, rows]) => { const grouped = new Map(); for (const row of rows) grouped.set(row.date.slice(0, 10), [...(grouped.get(row.date.slice(0, 10)) || []), row]); return [...grouped].filter(([, events]) => events.length > 1).slice(0, 5).map(([date, events]) => ({ ...(variantNames.get(variantId) || {}), variantId, date, events })) }) }
  result.sources = { stock: { count: stock.items.length, error: stock.error || null }, variants: { count: variants.items.length, error: variants.error || null }, receptions: { count: receptions.items.length, error: receptions.error || null }, consumptions: { count: consumptions.items.length, error: consumptions.error || null }, shippings: { headers: shippingHeaders.length, details: shippingDetails.length }, supabase: { currentRows: current.data?.length || 0, snapshotRows: snapshots.data?.length || 0, salesDetailRows: details.data?.length || 0 } }
  result.metrics.finishedAt = iso(new Date())
  process.stdout.write(JSON.stringify(result, null, 2))
}
main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1 })
