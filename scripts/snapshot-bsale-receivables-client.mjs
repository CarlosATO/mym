import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { getBsaleConfigForCompany, KNOWN_COMPANY_IDS } from '../src/lib/bsale/company-config.ts'
import { snapshotReceivablesForClients } from '../src/lib/integraciones/bsale-receivable-snapshot.ts'

const COMPANY_ID = KNOWN_COMPANY_IDS.CAYLO
const CLIENT_IDS = [208, 557]

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
}

if (process.argv.length > 2) {
  throw new Error('Etapa controlada: este runner sólo procesa la lista fija de 2 clientes.')
}

const { baseUrl, accessToken } = getBsaleConfigForCompany(COMPANY_ID)
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

let bsaleCalls = 0
const result = await snapshotReceivablesForClients({
  db,
  companyId: COMPANY_ID,
  clientIds: CLIENT_IDS,
  fetchJson: async path => {
    bsaleCalls += 1
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { access_token: accessToken, Accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`Bsale HTTP ${response.status}: ${body.slice(0, 300)}`)
    return JSON.parse(body)
  },
})

console.log(JSON.stringify({
  company_id: COMPANY_ID,
  client_ids: CLIENT_IDS,
  source: 'BSALE_UNPAID_DOCUMENTS',
  run_id: result.runId,
  status: result.status,
  bsale_calls: bsaleCalls,
  clients: result.clients.map(client => ({
    client_id: client.client_id,
    state: client.client_state,
    commerciallyBlocked: client.commercially_blocked,
    result: client.result,
    http_status: client.http_status,
    documents_returned: client.documents_returned,
  })),
  documents: result.documents.map(document => ({
    folio: document.folio,
    bsale_document_id: document.bsale_document_id,
    total_amount: document.total_amount,
    total_amount_owed: document.total_amount_owed,
    status: document.status,
  })),
  total_amount_owed: result.totalAmountOwed,
}, null, 2))
