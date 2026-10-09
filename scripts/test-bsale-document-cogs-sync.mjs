import assert from 'node:assert/strict'
import test from 'node:test'
import { selectIncrementalDocumentCogsDocuments } from '../src/lib/integraciones/bsale-document-cogs-sync.ts'
import { selectIncrementalCreditNotes } from '../src/lib/integraciones/bsale-credit-note-cogs-sync.ts'

const now = new Date('2026-10-09T12:00:00Z')
const document = (bsale_id, emission_date) => ({
  bsale_id,
  document_type_id: 5,
  number: bsale_id,
  emission_date,
  net_amount: '100',
  total_amount: '119',
  state: 0,
})

test('selects recent no-row and MISSING documents, skips OBSERVED, and bounds catch-up', () => {
  const documents = [
    document(1, '2026-10-08'),
    document(2, '2026-10-07'),
    document(3, '2026-08-01'),
    document(4, '2026-08-02'),
    document(5, '2026-09-20'),
  ]
  const existing = [
    { bsale_document_id: 1, status: 'MISSING', source: 'BSALE_DOCUMENT_COSTS' },
    { bsale_document_id: 2, status: 'OBSERVED', source: 'BSALE_DOCUMENT_COSTS' },
    { bsale_document_id: 3, status: 'MISSING', source: 'BSALE_DOCUMENT_COSTS' },
    { bsale_document_id: 4, status: 'MISSING', source: 'BSALE_DOCUMENT_COSTS' },
  ]

  const selected = selectIncrementalDocumentCogsDocuments(documents, existing, { now, recentDays: 30, catchUpLimit: 1 })
  assert.deepEqual(selected.recent.map(row => row.bsale_id), [1, 5])
  assert.deepEqual(selected.historical.map(row => row.bsale_id), [3])
  assert.equal(selected.existingByDocument.get(2).status, 'OBSERVED')
})

test('retries unresolved credit notes and skips resolved notes', () => {
  const documents = [
    { bsale_id: 10, emission_date: '2026-10-08', state: 0, total_amount: '100' },
    { bsale_id: 11, emission_date: '2026-10-07', state: 0, total_amount: '100' },
    { bsale_id: 12, emission_date: '2026-08-01', state: 0, total_amount: '100' },
  ]
  const resolutions = [
    { bsale_credit_note_id: 10, resolution_status: 'AMBIGUOUS' },
    { bsale_credit_note_id: 11, resolution_status: 'RESOLVED_PHYSICAL_RETURN' },
    { bsale_credit_note_id: 12, resolution_status: 'MISSING_RETURN' },
  ]
  const selected = selectIncrementalCreditNotes(documents, resolutions, { now, recentDays: 30, catchUpLimit: 1 })
  assert.deepEqual(selected.recent.map(row => row.bsale_id), [10])
  assert.deepEqual(selected.historical.map(row => row.bsale_id), [12])
})
