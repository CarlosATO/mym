import assert from 'node:assert/strict'
import test from 'node:test'

import { getBsaleAvailableStockQuantity, resolveBsaleStockIdentity } from '../src/lib/integraciones/bsale-stock-identity.ts'

test('resuelve stock sin variant_code por bsale_variant_id y usa stock disponible', () => {
  const catalog = new Map([['7062', { sku: 'TQ107' }]])
  const stock = { variant_id: 7062, variant_code: null, quantity: 50, quantity_available: 50 }
  const identity = resolveBsaleStockIdentity(stock.variant_id, stock.variant_code, catalog)

  assert.equal(identity.sku, 'TQ107')
  assert.equal(identity.method, 'stock_identity_from_catalog')
  assert.equal(stock.quantity_available, 50)
})

test('la cantidad normalizada de reposición es quantity_available, no quantity', () => {
  const stock = { variant_id: 1234, variant_code: 'NORMAL', quantity: 28, quantity_available: 25 }

  assert.equal(getBsaleAvailableStockQuantity(stock.quantity_available), 25)
  assert.notEqual(stock.quantity_available, stock.quantity)
})

test('no inventa SKU cuando no hay catálogo ni variant_code', () => {
  const identity = resolveBsaleStockIdentity(9999, null, new Map())

  assert.equal(identity.sku, null)
  assert.equal(identity.method, 'stock_identity_unresolved')
})

test('mantiene el fallback por variant_code cuando no hay match de catálogo', () => {
  const identity = resolveBsaleStockIdentity(9999, ' normal-01 ', new Map())

  assert.equal(identity.sku, 'NORMAL-01')
  assert.equal(identity.method, 'stock_identity_from_variant_code')
})
