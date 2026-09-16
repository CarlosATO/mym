const base = process.env.BSALE_API_BASE_URL || 'https://api.bsale.cl/v1'
const token = process.env.BSALE_ACCESS_TOKEN
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const companyId = 'd1000000-0000-0000-0000-000000000001'
if (!token) throw new Error('Missing BSALE_ACCESS_TOKEN')
if (!supabaseUrl || !serviceKey) throw new Error('Missing Supabase audit variables')
import { createClient } from '@supabase/supabase-js'
const db = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
const calls = []
async function get(path, params = {}) {
  const url = new URL(`${base}${path}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  const started = performance.now()
  const response = await fetch(url, { headers: { access_token: token, Accept: 'application/json' } })
  const elapsedMs = Math.round(performance.now() - started)
  let body
  try { body = await response.json() } catch { body = null }
  calls.push({ path, params, status: response.status, elapsedMs, count: body?.count ?? null })
  return { status: response.status, body }
}
async function all(path, params = {}) {
  const items = []
  for (let offset = 0; ; offset += 50) {
    const result = await get(path, { ...params, limit: 50, offset })
    if (result.status >= 400) return { items, error: result.body }
    items.push(...(result.body?.items || []))
    if ((result.body?.items || []).length < 50 || items.length >= Number(result.body?.count ?? items.length)) return { items }
  }
}
async function main() {
  const stocks = await all('/stocks.json', { officeid: 1 })
  const selected = stocks.items.filter(row => Number(row.quantityReserved) > 0).sort((a, b) => Number(b.quantityReserved) - Number(a.quantityReserved)).slice(0, 3)
  const variants = await Promise.all(selected.map(row => get(`/variants/${row.variant.id}.json`, { expand: 'product' })))
  const openNotesPage = await get('/documents.json', { documenttypeid: 23, officeid: 1, state: 0, expand: 'details', limit: 50, offset: 0 })
  const variantIds = selected.map(stock => Number(stock.variant.id))
  const mirroredDetails = await db.schema('integraciones').from('bsale_document_details').select('variant_id,quantity,bsale_document_id').eq('company_id', companyId).in('variant_id', variantIds)
  const mirroredDocIds = [...new Set((mirroredDetails.data || []).map(row => Number(row.bsale_document_id)).filter(Boolean))]
  const mirroredDocs = mirroredDocIds.length ? await db.schema('integraciones').from('bsale_documents').select('bsale_id,number,emission_date,generation_date,expiration_date,document_type_id,office_id,state').eq('company_id', companyId).in('bsale_id', mirroredDocIds).eq('document_type_id', 23).eq('office_id', 1).eq('state', 0) : { data: [], error: null }
  const openDocMap = new Map((mirroredDocs.data || []).map(row => [Number(row.bsale_id), row]))
  const noteDetails = (mirroredDetails.data || []).filter(row => openDocMap.has(Number(row.bsale_document_id))).map(row => ({ document: openDocMap.get(Number(row.bsale_document_id)), detail: row }))
  const openNoteIds = [...openDocMap.keys()]
  const directOpenNotes = await Promise.all(openNoteIds.slice(0, 20).map(id => get(`/documents/${id}.json`, { expand: 'details' })))
  const reservationProbes = []
  for (const path of ['/stocks/reservations.json', '/stock_reservations.json', '/reservations.json', '/documents/pending.json', '/orders.json']) reservationProbes.push({ path, ...(await get(path, { officeid: 1 })) })
  const output = { testedAt: new Date().toISOString(), officeId: 1, selected: selected.map((stock, index) => ({ stock, variant: variants[index].body, variantStatus: variants[index].status })), openNotes: { apiCount: openNotesPage.body?.count ?? null, apiPageItems: openNotesPage.body?.items?.length ?? 0, apiSample: (openNotesPage.body?.items || []).slice(0, 5), mirrorCount: openDocMap.size, directFetched: directOpenNotes.length, directSample: directOpenNotes.map(result => result.body) }, noteDetails, reservationProbes, calls }
  process.stdout.write(JSON.stringify(output, null, 2))
}
main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1 })
