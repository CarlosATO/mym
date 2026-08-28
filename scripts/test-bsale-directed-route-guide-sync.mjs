import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/app/actions/integraciones/bsale-sync.ts', import.meta.url), 'utf8')
const permission = await readFile(new URL('../supabase/migrations/20260828100000_route_guide_directed_bsale_sync_permission.sql', import.meta.url), 'utf8')

test('expone un contrato dirigido por empresa y folios', () => {
  assert.match(source, /export async function syncBsaleDocumentsForRouteGuide\(input:/)
  assert.match(source, /company_id: string/)
  assert.match(source, /invoice_numbers: string\[\]/)
  assert.match(source, /documents\.json\?\$\{query\.toString\(\)\}/)
  assert.match(source, /loadLocallyReadyDirectedDocuments/)
  assert.match(source, /if \(local\)/)
  assert.match(source, /bsale_document_details/)
  assert.match(source, /bsale_clients/)
  assert.doesNotMatch(source, /syncBsaleDocumentsForRouteGuide[\s\S]{0,1200}days:\s*14/)
})

test('clasifica documentos y persiste cabeceras, detalles e identidades NULL-only', () => {
  for (const status of ['READY', 'NOT_FOUND', 'INVALID_DOCUMENT', 'DETAILS_UNAVAILABLE', 'CUSTOMER_UNAVAILABLE', 'ERROR']) {
    assert.match(source, new RegExp(`'${status}'`))
  }
  assert.match(source, /from\('bsale_documents'\)\.upsert/)
  assert.match(source, /from\('bsale_document_details'\)\.upsert/)
  assert.match(source, /is\('customer_bsale_id', null\)/)
  assert.match(source, /route_settlement_items/)
  assert.match(source, /onConflict: 'company_id,bsale_id'/)
  assert.match(source, /onConflict: 'company_id,bsale_id',\n\s+ignoreDuplicates: false/)
})

test('protege el contrato con autenticación, empresa y permiso explícito', () => {
  assert.match(source, /session\.auth\.getUser\(\)/)
  assert.match(source, /has_company_access/)
  assert.match(source, /logistica\.route_guides\.view/)
  assert.match(source, /logistica\.route_guides\.sync_bsale/)
  assert.match(permission, /logistica\.route_guides\.sync_bsale/)
})
