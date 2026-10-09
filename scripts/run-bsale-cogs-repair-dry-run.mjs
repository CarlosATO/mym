import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { selectIncrementalDocumentCogsDocuments } from '../src/lib/integraciones/bsale-document-cogs-sync.ts'
import { selectIncrementalCreditNotes } from '../src/lib/integraciones/bsale-credit-note-cogs-sync.ts'

for (const line of fs.readFileSync('.env.local', 'utf8').split('\n')) {
  const trimmed = line.trim()
  if (trimmed && !trimmed.startsWith('#')) {
    const index = trimmed.indexOf('=')
    if (index > 0 && !process.env[trimmed.slice(0, index)]) process.env[trimmed.slice(0, index)] = trimmed.slice(index + 1).trim()
  }
}

const companyId = process.argv[2] || 'd1000000-0000-0000-0000-000000000001'
const year = Number(process.argv[3] || new Date().getUTCFullYear())
const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

async function selectAll(table, select, build = query => query) {
  const rows = []
  for (let offset = 0;; offset += 1000) {
    const result = await build(client.schema('integraciones').from(table).select(select)).range(offset, offset + 999)
    if (result.error) throw new Error(`${table}: ${result.error.message}`)
    rows.push(...(result.data || []))
    if (!result.data || result.data.length < 1000) return rows
  }
}

const [documents, costs, creditNotes, resolutions] = await Promise.all([
  selectAll('bsale_documents', 'bsale_id,document_type_id,number,emission_date,net_amount,total_amount,state', query => query
    .eq('company_id', companyId).eq('state', 0).in('document_type_id', [1, 5])
    .gte('emission_date', `${year}-01-01T00:00:00Z`).lt('emission_date', `${year + 1}-01-01T00:00:00Z`).order('emission_date')),
  selectAll('bsale_document_costs', 'bsale_document_id,status,source', query => query.eq('company_id', companyId)),
  selectAll('bsale_documents', 'bsale_id,emission_date,state,total_amount', query => query
    .eq('company_id', companyId).eq('state', 0).eq('document_type_id', 2)
    .gte('emission_date', `${year}-01-01T00:00:00Z`).lt('emission_date', `${year + 1}-01-01T00:00:00Z`).order('emission_date')),
  selectAll('bsale_credit_note_cogs_resolutions', 'bsale_credit_note_id,resolution_status', query => query.eq('company_id', companyId)),
])

const normalizedDocuments = documents.map(row => ({ ...row, bsale_id: Number(row.bsale_id), document_type_id: Number(row.document_type_id), state: Number(row.state) }))
const normalizedCreditNotes = creditNotes.filter(row => Number(row.total_amount || 0) !== 0).map(row => ({ ...row, bsale_id: Number(row.bsale_id), state: Number(row.state) }))
const documentSelection = selectIncrementalDocumentCogsDocuments(normalizedDocuments, costs, { recentDays: 30, catchUpLimit: 200 })
const ncSelection = selectIncrementalCreditNotes(normalizedCreditNotes, resolutions, { recentDays: 30, catchUpLimit: 100 })
const monthCounts = rows => Object.fromEntries(rows.reduce((map, row) => {
  const month = row.emission_date.slice(0, 7)
  map.set(month, (map.get(month) || 0) + 1)
  return map
}, new Map()))
const existingByDocument = new Map(costs.map(row => [Number(row.bsale_document_id), row]))
const missingOrAbsent = normalizedDocuments.filter(row => existingByDocument.get(row.bsale_id)?.status !== 'OBSERVED')
const ncResolutionById = new Map(resolutions.map(row => [Number(row.bsale_credit_note_id), row]))
const noCostRows = normalizedDocuments.filter(row => !existingByDocument.has(row.bsale_id))
const retryableStatuses = normalizedDocuments.filter(row => existingByDocument.get(row.bsale_id)?.status !== 'OBSERVED' && existingByDocument.has(row.bsale_id))

console.log(JSON.stringify({
  dryRun: true,
  writes: 0,
  companyId,
  year,
  documentCogs: {
    eligible: normalizedDocuments.length,
    observed: normalizedDocuments.length - missingOrAbsent.length,
    missingOrNoRow: missingOrAbsent.length,
    noCostRows: noCostRows.length,
    retryableStatuses: retryableStatuses.length,
    selectedRecent: documentSelection.recent.length,
    selectedHistoricalCatchUp: documentSelection.historical.length,
    estimatedRequests: documentSelection.recent.length + documentSelection.historical.length,
    byMonth: monthCounts(missingOrAbsent),
    firstMissing: missingOrAbsent[0]?.emission_date?.slice(0, 10) ?? null,
    lastMissing: missingOrAbsent.at(-1)?.emission_date?.slice(0, 10) ?? null,
  },
  creditNotes: {
    eligible: normalizedCreditNotes.length,
    existingResolutions: ncResolutionById.size,
    selectedRecent: ncSelection.recent.length,
    selectedHistoricalCatchUp: ncSelection.historical.length,
    estimatedRequests: (ncSelection.recent.length + ncSelection.historical.length) * 2,
    byMonth: monthCounts([...ncSelection.recent, ...ncSelection.historical]),
  },
}, null, 2))
