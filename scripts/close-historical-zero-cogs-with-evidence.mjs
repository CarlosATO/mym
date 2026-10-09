import fs from 'node:fs'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'

for (const line of fs.readFileSync('.env.local', 'utf8').split('\n')) {
  const trimmed = line.trim()
  if (trimmed && !trimmed.startsWith('#')) {
    const index = trimmed.indexOf('=')
    if (index > 0 && !process.env[trimmed.slice(0, index)]) process.env[trimmed.slice(0, index)] = trimmed.slice(index + 1).trim()
  }
}

const companyId = 'd1000000-0000-0000-0000-000000000001'
const documentIds = [83046, 84386, 84387]
const businessReason = 'Mercadería recibida como obsequio y posteriormente vendida.'
const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const { data: before, error: beforeError } = await client.schema('integraciones').from('bsale_document_costs')
  .select('company_id,bsale_document_id,status,total_cost,source,raw_json,observed_at')
  .eq('company_id', companyId).in('bsale_document_id', documentIds)
if (beforeError) throw new Error(beforeError.message)
assert.equal(before.length, documentIds.length, 'all three COGS rows must already exist')
assert.ok(before.every(row => row.status === 'MISSING' || row.status === 'ZERO_WITH_EVIDENCE'), 'only the authorized unresolved/evidenced rows may be handled')
assert.ok(before.every(row => String(row.raw_json?.totalCost ?? '0') === '0'), 'BSale totalCost evidence must be zero')

const beforeById = new Map(before.map(row => [Number(row.bsale_document_id), row]))
console.log(JSON.stringify({ phase: 'BEFORE', companyId, documentIds, rows: before.map(row => ({ id: row.bsale_document_id, status: row.status, total_cost: row.total_cost, source: row.source })) }, null, 2))

for (const documentId of documentIds) {
  const row = beforeById.get(documentId)
  let updated = row
  if (row.status === 'MISSING') {
    const result = await client.schema('integraciones').from('bsale_document_costs')
      .update({ status: 'ZERO_WITH_EVIDENCE', total_cost: '0.00', observed_at: new Date().toISOString() })
      .eq('company_id', companyId).eq('bsale_document_id', documentId).eq('status', 'MISSING')
      .select('company_id,bsale_document_id,status,total_cost,source,raw_json,observed_at').single()
    if (result.error) throw new Error(`document ${documentId}: ${result.error.message}`)
    updated = result.data
  }
  assert.equal(updated.company_id, companyId)
  assert.equal(updated.status, 'ZERO_WITH_EVIDENCE')
  assert.equal(Number(updated.total_cost), 0)
  assert.deepEqual(updated.raw_json, row.raw_json, `raw_json changed for ${documentId}`)

  const { error: auditError } = await client.schema('portal').from('audit_logs').insert({
    table_name: 'bsale_document_costs',
    action: 'UPDATE',
    old_data: { company_id: companyId, bsale_document_id: documentId, status: row.status, total_cost: row.total_cost },
    new_data: { company_id: companyId, bsale_document_id: documentId, status: 'ZERO_WITH_EVIDENCE', total_cost: '0.00', reason: businessReason, evidence: 'BSale totalCost=0 and variantCost=0' },
    schema_name: 'integraciones',
    module_code: 'FINANCE_COGS',
    event_type: 'COGS_ZERO_WITH_EVIDENCE',
    severity: 'INFO',
    metadata: { company_id: companyId, bsale_document_id: documentId, reason: businessReason },
  })
  if (auditError) throw new Error(`audit ${documentId}: ${auditError.message}`)
}

const { data: after, error: afterError } = await client.schema('integraciones').from('bsale_document_costs')
  .select('company_id,bsale_document_id,status,total_cost,raw_json')
  .eq('company_id', companyId).in('bsale_document_id', documentIds)
if (afterError) throw new Error(afterError.message)
assert.equal(after.length, 3)
assert.ok(after.every(row => row.status === 'ZERO_WITH_EVIDENCE' && Number(row.total_cost) === 0))
assert.ok(after.every(row => String(row.raw_json?.totalCost ?? '0') === '0'))
console.log(JSON.stringify({ phase: 'AFTER', companyId, documentIds, status: 'ZERO_WITH_EVIDENCE', total_cost: '0.00', businessReason, raw_json_preserved: true }, null, 2))
