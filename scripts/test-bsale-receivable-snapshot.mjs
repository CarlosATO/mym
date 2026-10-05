import assert from 'node:assert/strict'
import test from 'node:test'
import { classifySnapshotError, localSnapshotDate, mapUnpaidDocuments, resolveClientState } from '../src/lib/integraciones/bsale-receivable-snapshot.ts'

const companyId = 'd1000000-0000-0000-0000-000000000001'

test('uses Bsale list membership for status and amount owed', () => {
  const rows = mapUnpaidDocuments({
    overdue_documents: [{ id: 88606, number: 23121, totalAmountOwed: 290731 }],
    upcoming_documents: [{ id: 88607, number: 23122, totalAmountOwed: 220611 }],
  }, 'run-1', companyId, 208, '2026-10-05T12:00:00.000Z', '2026-10-05', [
    { bsale_id: 88606, number: 23121, emission_date: '2026-07-20', total_amount: 290731, raw_json: {} },
    { bsale_id: 88607, number: 23122, emission_date: '2026-07-20', total_amount: 276611, raw_json: {} },
  ])

  assert.deepEqual(rows.map(row => [row.folio, row.total_amount, row.total_amount_owed, row.status]), [
    [23121, 290731, 290731, 'OVERDUE'],
    [23122, 276611, 220611, 'UPCOMING'],
  ])
})

test('reads state and commercial block independently', () => {
  assert.deepEqual(resolveClientState({ bsale_client_id: 208, raw_payload: { state: 0, commerciallyBlocked: 1 } }), {
    clientState: 0,
    commerciallyBlocked: true,
  })
  assert.deepEqual(resolveClientState({ bsale_client_id: 557, raw_payload: { state: 97, commerciallyBlocked: 1 } }), {
    clientState: 97,
    commerciallyBlocked: true,
  })
})

test('formats the local Santiago snapshot date', () => {
  assert.equal(localSnapshotDate(new Date('2026-10-05T02:00:00.000Z')), '2026-10-04')
  assert.equal(localSnapshotDate(new Date('2026-10-05T15:00:00.000Z')), '2026-10-05')
})

test('classifies only the known Bsale invalid-client response as unqueryable', () => {
  assert.equal(classifySnapshotError(new Error('Bsale HTTP 400: invalid client code or id')).result, 'UNPAID_DOCUMENTS_CLIENT_INVALID')
  assert.equal(classifySnapshotError(new Error('Bsale HTTP 400: validation error')).result, 'HTTP_ERROR')
  assert.equal(classifySnapshotError(new Error('request timeout')).result, 'HTTP_ERROR')
})
