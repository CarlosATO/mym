import assert from 'node:assert/strict'
import test from 'node:test'
import { extractBsaleRelationIdFromHref, normalizeBsaleClientCommercialFields } from '../src/lib/integraciones/bsale-client-commercial-normalization.ts'

test('sale condition ID comes only from href, never the inconsistent embedded id', () => {
  assert.equal(extractBsaleRelationIdFromHref({ id: '18', href: 'https://api.bsale.io/v1/sale_conditions/7.json' }, 'sale_conditions'), 7)
  assert.equal(extractBsaleRelationIdFromHref({ id: '18' }, 'sale_conditions'), null)
  assert.equal(extractBsaleRelationIdFromHref(null, 'sale_conditions'), null)
})

test('client commercial fields normalize catalog names, credit and region', () => {
  const normalized = normalizeBsaleClientCommercialFields({
    payment_type: { id: '20', href: 'https://api.bsale.io/v1/payment_types/20.json' },
    sale_condition: { id: '20', href: 'https://api.bsale.io/v1/sale_conditions/14.json' },
    price_list: { id: '4', href: 'https://api.bsale.io/v1/price_lists/4.json' },
    hasCredit: 1,
    maxCredit: 2000000,
    region: 'Maule',
  }, {
    paymentTypeNames: new Map([[20, 'CREDITO']]),
    saleConditionNames: new Map([[14, 'CREDITO 12 DIAS']]),
  })

  assert.deepEqual(normalized, {
    payment_type_id: 20,
    payment_type_name: 'CREDITO',
    sale_condition_id: 14,
    sale_condition_name: 'CREDITO 12 DIAS',
    has_credit: true,
    credit_limit: 2000000,
    price_list_id: 4,
    price_list_name: null,
    region: 'Maule',
  })
})

test('incomplete client stays incomplete without invented defaults', () => {
  assert.deepEqual(normalizeBsaleClientCommercialFields({ hasCredit: 0, maxCredit: null, region: 'Maule' }), {
    payment_type_id: null,
    payment_type_name: null,
    sale_condition_id: null,
    sale_condition_name: null,
    has_credit: false,
    credit_limit: null,
    price_list_id: null,
    price_list_name: null,
    region: 'Maule',
  })
})
