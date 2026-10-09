import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

for (const line of fs.readFileSync('.env.local', 'utf8').split('\n')) {
  const trimmed = line.trim()
  if (trimmed && !trimmed.startsWith('#')) {
    const index = trimmed.indexOf('=')
    if (index > 0 && !process.env[trimmed.slice(0, index)]) process.env[trimmed.slice(0, index)] = trimmed.slice(index + 1).trim()
  }
}

const companyId = process.argv[2] || 'd1000000-0000-0000-0000-000000000001'
const year = Number(process.argv[3] || 2026)
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

function cents(value) {
  const text = String(value ?? '0')
  const [whole, fraction = ''] = text.split('.')
  return BigInt(whole || '0') * 100n + BigInt((fraction + '00').slice(0, 2))
}

function money(value) {
  const amount = BigInt(value)
  return `${amount / 100n}.${String(amount % 100n).padStart(2, '0')}`
}

const [documents, costs, resolutions] = await Promise.all([
  selectAll('bsale_documents', 'bsale_id,document_type_id,emission_date,state,total_amount', query => query
    .eq('company_id', companyId).eq('state', 0).in('document_type_id', [1, 5])
    .gte('emission_date', `${year}-01-01T00:00:00Z`).lt('emission_date', `${year + 1}-01-01T00:00:00Z`).order('emission_date')),
  selectAll('bsale_document_costs', 'company_id,bsale_document_id,status,total_cost', query => query.eq('company_id', companyId)),
  selectAll('bsale_credit_note_cogs_resolutions', 'company_id,bsale_credit_note_id,resolution_status,reversal_cogs', query => query.eq('company_id', companyId)),
])

const eligible = documents.map(row => ({ ...row, bsale_id: Number(row.bsale_id), month: row.emission_date.slice(0, 7) }))
const costByDocument = new Map(costs.map(row => [Number(row.bsale_document_id), row]))
const resolutionByNote = new Map(resolutions.map(row => [Number(row.bsale_credit_note_id), row]))
const months = new Map(Array.from({ length: 12 }, (_, index) => [`${year}-${String(index + 1).padStart(2, '0')}`, {
  eligible: 0, observed: 0, zero_with_evidence: 0, resolved: 0, missing: 0, no_cost_row: 0, errors: 0, gross_cogs_cents: 0n, reversal_cogs_cents: 0n,
}]))

for (const document of eligible) {
  const row = months.get(document.month)
  row.eligible++
  const cost = costByDocument.get(document.bsale_id)
  if (!cost) {
    row.no_cost_row++
  } else if (cost.status === 'OBSERVED') {
    row.observed++
    row.resolved++
    row.gross_cogs_cents += cents(cost.total_cost)
  } else if (cost.status === 'ZERO_WITH_EVIDENCE') {
    row.zero_with_evidence++
    row.resolved++
    row.gross_cogs_cents += cents(cost.total_cost)
  } else if (cost.status === 'MISSING') {
    row.missing++
  } else {
    row.errors++
  }
}

const creditNotes = await selectAll('bsale_documents', 'bsale_id,document_type_id,emission_date,state,total_amount', query => query
  .eq('company_id', companyId).eq('state', 0).eq('document_type_id', 2)
  .gte('emission_date', `${year}-01-01T00:00:00Z`).lt('emission_date', `${year + 1}-01-01T00:00:00Z`))
for (const note of creditNotes.filter(row => Number(row.total_amount || 0) !== 0)) {
  const resolution = resolutionByNote.get(Number(note.bsale_id))
  const row = months.get(String(note.emission_date).slice(0, 7))
  if (row && resolution) row.reversal_cogs_cents += cents(resolution.reversal_cogs)
}

const report = [...months.entries()].map(([month, row]) => ({
  month,
  eligible: row.eligible,
  observed: row.observed,
  zero_with_evidence: row.zero_with_evidence,
  resolved: row.resolved,
  missing: row.missing,
  no_cost_row: row.no_cost_row,
  errors: row.errors,
  coverage_status: row.missing === 0 && row.no_cost_row === 0 && row.errors === 0 ? 'COMPLETE' : 'INCOMPLETE',
  gross_cogs: money(row.gross_cogs_cents),
  reversal_cogs: money(row.reversal_cogs_cents),
  net_cogs: row.resolved === 0 && row.missing > 0 ? null : money(row.gross_cogs_cents - row.reversal_cogs_cents),
}))

console.log(JSON.stringify({
  companyId,
  year,
  documents: {
    eligible: eligible.length,
    observed: eligible.filter(row => costByDocument.get(row.bsale_id)?.status === 'OBSERVED').length,
    zero_with_evidence: eligible.filter(row => costByDocument.get(row.bsale_id)?.status === 'ZERO_WITH_EVIDENCE').length,
    resolved: eligible.filter(row => ['OBSERVED', 'ZERO_WITH_EVIDENCE'].includes(costByDocument.get(row.bsale_id)?.status)).length,
    missing: eligible.filter(row => costByDocument.get(row.bsale_id)?.status === 'MISSING').length,
    no_row: eligible.filter(row => !costByDocument.has(row.bsale_id)).length,
    errors: eligible.filter(row => costByDocument.get(row.bsale_id) && !['OBSERVED', 'ZERO_WITH_EVIDENCE', 'MISSING'].includes(costByDocument.get(row.bsale_id).status)).length,
  },
  credit_notes: {
    eligible: creditNotes.filter(row => Number(row.total_amount || 0) !== 0).length,
    resolved: creditNotes.filter(row => Number(row.total_amount || 0) !== 0 && resolutionByNote.has(Number(row.bsale_id))).length,
    unresolved: creditNotes.filter(row => Number(row.total_amount || 0) !== 0 && !resolutionByNote.has(Number(row.bsale_id))).length,
    ambiguous: [...resolutionByNote.values()].filter(row => row.resolution_status === 'AMBIGUOUS').length,
  },
  months: report,
  focus: report.filter(row => row.month === `${year}-09` || row.month === `${year}-10`),
}, null, 2))
