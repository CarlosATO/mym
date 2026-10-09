import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const sync = await readFile(new URL('../src/app/actions/integraciones/bsale-sync.ts', import.meta.url), 'utf8')
const manual = await readFile(new URL('../src/app/actions/integraciones/sync.ts', import.meta.url), 'utf8')
const scheduled = await readFile(new URL('../src/app/api/cron/sync-replenishment/route.ts', import.meta.url), 'utf8')
const documentCogs = await readFile(new URL('../src/lib/integraciones/bsale-document-cogs-sync.ts', import.meta.url), 'utf8')
const creditNoteCogs = await readFile(new URL('../src/lib/integraciones/bsale-credit-note-cogs-sync.ts', import.meta.url), 'utf8')

test('scheduled and manual replenishment share the automatic COGS pipeline', () => {
  assert.match(manual, /runReplenishmentBsaleSync\(companyId, 'MANUAL'\)/)
  assert.match(scheduled, /runReplenishmentBsaleSync\(companyId, 'SCHEDULED'\)/)
  assert.ok(sync.indexOf('await syncBsaleSales(companyId') < sync.indexOf('await syncRecentDocumentCogs'))
  assert.ok(sync.indexOf('await syncRecentDocumentCogs') < sync.indexOf('await syncRecentCreditNoteCogs'))
  assert.match(sync, /costs:/)
  assert.match(sync, /cogs_no_cost_row_recent/)
})

test('incremental COGS remains scoped and reuses existing parsers/resolvers', () => {
  assert.match(documentCogs, /selectHistoricalCogsUniverse\(options\.client, options\.companyId/)
  assert.match(documentCogs, /fetchHistoricalCogsPayload\(options\.companyId/)
  assert.match(documentCogs, /mapDocumentCostPayload\(options\.companyId/)
  assert.match(documentCogs, /upsertDocumentCostDetails\(options\.companyId/)
  assert.match(creditNoteCogs, /mapCreditNoteReturnPayload\(options\.companyId/)
  assert.match(creditNoteCogs, /resolveCreditNoteCogs\(/)
  assert.match(creditNoteCogs, /upsertCreditNoteCogsResolution\(options\.companyId/)
  assert.match(creditNoteCogs, /eq\('company_id', options\.companyId\)/)
})
