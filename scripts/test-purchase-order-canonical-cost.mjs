import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const action = await readFile(new URL('../src/app/actions/adquisiciones/products.ts', import.meta.url), 'utf8')
const catalogLoader = action.slice(action.indexOf('async function loadPurchaseOrderProductCatalog'))

test('el catálogo de OC consume exclusivamente el read model canónico por empresa y chunks', () => {
  assert.match(catalogLoader, /vw_bsale_variant_last_purchase_cost/)
  assert.match(catalogLoader, /\.eq\('company_id', companyId\)/)
  assert.match(catalogLoader, /\.in\('bsale_variant_id', ids\)/)
  assert.match(catalogLoader, /for \(let offset = 0; offset < variantIds\.length; offset \+= 500\)/)
  assert.match(catalogLoader, /\.select\('bsale_variant_id, last_purchase_cost'\)/)
  assert.doesNotMatch(catalogLoader, /bsale_reception_details/)
  assert.doesNotMatch(catalogLoader, /bsale_receptions/)
  assert.doesNotMatch(catalogLoader, /updated_at/)
})

test('la ausencia canónica conserva null y el numeric válido se normaliza a number', () => {
  assert.match(action, /function normalizePurchaseCost\(value: unknown\): number \| null/)
  assert.match(action, /value === null \|\| value === undefined/)
  assert.match(action, /Number\.isFinite\(numeric\) \? numeric : null/)
  assert.match(action, /costByVariant\.get\(product\.bsale_variant_id\) \?\? null/)
  assert.doesNotMatch(action, /last_purchase_unit_cost: .*\?\? 0/)
})
