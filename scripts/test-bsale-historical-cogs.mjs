import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mapCreditNoteReturnDetailPayload,
  mapCreditNoteReturnPayload,
  mapDocumentCostPayload,
  upsertDocumentCost,
} from '../src/lib/integraciones/bsale-historical-cogs.ts'

const CAYLO = 'd1000000-0000-0000-0000-000000000001'
const AMIMASCOTA = 'd3000000-0000-0000-0000-000000000003'

const documentPayload = {
  id: 82619,
  totalCost: 122760,
  cost_detail: [{
    variant: { id: 2658, code: 'USA603' },
    shipping_detail: { id: 243145, quantity: 6, variantCost: 1273, variantTotalCost: 7638 },
  }],
}

test('maps an observed document cost and preserves official detail identity', () => {
  const mapped = mapDocumentCostPayload(CAYLO, documentPayload, { observedAt: '2026-09-25T12:00:00.000Z' })
  assert.equal(mapped.record.status, 'OBSERVED')
  assert.equal(mapped.record.total_cost, '122760')
  assert.equal(mapped.details[0].cost_detail_key, 'shipping_detail:243145')
  assert.equal(mapped.details[0].unit_cost, '1273')
  assert.equal(mapped.details[0].total_cost, '7638')
  assert.deepEqual(mapped.details[0].raw_json, documentPayload.cost_detail[0])
})

test('zero total cost remains MISSING without explicit evidence', () => {
  const mapped = mapDocumentCostPayload(CAYLO, { id: 87855, totalCost: 0, cost_detail: [] })
  assert.equal(mapped.record.status, 'MISSING')
  assert.throws(() => mapDocumentCostPayload(CAYLO, { id: 87855, totalCost: 0 }, { status: 'OBSERVED' }), /positive totalCost/)
  assert.throws(() => mapDocumentCostPayload(CAYLO, { id: 87855, totalCost: 0 }, { status: 'ZERO_WITH_EVIDENCE' }))
  const evidenced = mapDocumentCostPayload(CAYLO, { id: 87855, totalCost: 0 }, { status: 'ZERO_WITH_EVIDENCE', zeroEvidence: true })
  assert.equal(evidenced.record.status, 'ZERO_WITH_EVIDENCE')
})

test('company scope is explicit and same BSale document ID can be stored per company', () => {
  const caylo = mapDocumentCostPayload(CAYLO, { id: 100, totalCost: '10.00' })
  const amimascota = mapDocumentCostPayload(AMIMASCOTA, { id: 100, totalCost: '10.00' })
  assert.equal(caylo.record.company_id, CAYLO)
  assert.equal(amimascota.record.company_id, AMIMASCOTA)
  assert.notEqual(caylo.record.company_id, amimascota.record.company_id)
})

test('return mapping preserves price adjustment, stock quantity and raw payload', () => {
  const payload = {
    id: 4710,
    returnDate: 1786320000,
    amount: 57584,
    priceAdjustment: 0,
    editTexts: 0,
    type: 2,
    motive: 'RETORNA A BODEGA',
    reference_document: { id: 89459 },
    credit_note: { id: 89854 },
  }
  const mapped = mapCreditNoteReturnPayload(CAYLO, payload)
  assert.equal(mapped.bsale_return_id, 4710)
  assert.equal(mapped.bsale_credit_note_id, 89854)
  assert.equal(mapped.price_adjustment, false)
  assert.equal(mapped.edit_texts, false)
  assert.deepEqual(mapped.raw_json, payload)

  const detailPayload = { id: 10914, quantity: 2, quantityDevStock: 2, variantStock: 12, variantCost: 18630, documentDetailId: 316660 }
  const detail = mapCreditNoteReturnDetailPayload(CAYLO, 4710, detailPayload)
  assert.equal(detail.quantity_dev_stock, '2')
  assert.equal(detail.variant_cost, '18630')
  assert.deepEqual(detail.raw_json, detailPayload)
})

test('rejects invalid payloads explicitly', () => {
  assert.throws(() => mapDocumentCostPayload('', { id: 1, totalCost: 1 }), /companyId is required/)
  assert.throws(() => mapDocumentCostPayload(CAYLO, { id: 1, totalCost: 'not-money' }), /totalCost must be a decimal value/)
  assert.throws(() => mapDocumentCostPayload(CAYLO, { id: 1, totalCost: 1, cost_detail: [{ variant: { id: 2 } }] }), /shipping_detail is required/)
  assert.throws(() => mapCreditNoteReturnPayload(CAYLO, { id: 1 }), /credit_note.id is required/)
})

test('repository uses company-scoped idempotent upsert', async () => {
  const calls = []
  const fakeClient = {
    schema() {
      return {
        from(table) {
          return {
            async upsert(record, options) {
              calls.push({ table, record, options })
              return { error: null }
            },
          }
        },
      }
    },
  }
  const mapped = mapDocumentCostPayload(CAYLO, { id: 100, totalCost: '12.50' })
  await upsertDocumentCost(CAYLO, mapped.record, fakeClient)
  await upsertDocumentCost(CAYLO, mapped.record, fakeClient)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].record.company_id, CAYLO)
  assert.equal(calls[0].options.onConflict, 'company_id,bsale_document_id')
  assert.equal(calls[0].options.ignoreDuplicates, false)
  assert.equal(typeof calls[0].record.total_cost, 'string')
  await assert.rejects(() => upsertDocumentCost(AMIMASCOTA, mapped.record, fakeClient), /does not match companyId/)
})
