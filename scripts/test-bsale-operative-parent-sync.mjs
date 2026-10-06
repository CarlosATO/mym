import assert from 'node:assert/strict'
import fs from 'node:fs'
import { decideOperativeSupplierParent } from '../src/lib/integraciones/bsale-operative-parent-sync.ts'

const source = fs.readFileSync('src/lib/integraciones/bsale-operative-parent-sync.ts', 'utf8')
const catalog = fs.readFileSync('src/lib/integraciones/bsale-catalog-auto-sync.ts', 'utf8')

for (const resolution of ['NO_ACTIVE_PRODUCTS', 'WITHOUT_BRAND', 'MULTIPLE_BRANDS', 'BRAND_WITHOUT_LINK', 'INVALID_REAL_SUPPLIER', 'ALREADY_CORRECT', 'ASSIGN', 'UPDATE']) {
  assert.match(source, new RegExp(`['"]${resolution}['"]`), `missing resolution ${resolution}`)
}
assert.match(source, /supplier_kind.*REAL/)
assert.match(source, /status.*ACTIVE/)
assert.match(source, /source.*BSALE/)
assert.match(source, /parent_supplier_id/)
assert.match(catalog, /syncOperativeSupplierParents/)
assert.ok(catalog.indexOf('await syncOperativeSupplierParents') < catalog.indexOf('await syncProductSupplierMappings'))
assert.doesNotMatch(catalog, /purchase-orders|purchase_orders/i)

const base = { brandIds: ['47'], hasProductWithoutBrand: false, linkedSupplierId: 'link', validRealSupplierId: 'real' }
assert.equal(decideOperativeSupplierParent({ ...base, activeProductCount: 0 }), 'NO_ACTIVE_PRODUCTS')
assert.equal(decideOperativeSupplierParent({ ...base, activeProductCount: 1, hasProductWithoutBrand: true }), 'WITHOUT_BRAND')
assert.equal(decideOperativeSupplierParent({ ...base, activeProductCount: 1, brandIds: ['47', '55'] }), 'MULTIPLE_BRANDS')
assert.equal(decideOperativeSupplierParent({ ...base, activeProductCount: 1, linkedSupplierId: null }), 'BRAND_WITHOUT_LINK')
assert.equal(decideOperativeSupplierParent({ ...base, activeProductCount: 1, validRealSupplierId: null }), 'INVALID_REAL_SUPPLIER')
assert.equal(decideOperativeSupplierParent({ ...base, activeProductCount: 1, currentParentSupplierId: 'real' }), 'ALREADY_CORRECT')
assert.equal(decideOperativeSupplierParent({ ...base, activeProductCount: 1 }), 'ASSIGN')
assert.equal(decideOperativeSupplierParent({ ...base, activeProductCount: 1, currentParentSupplierId: 'old' }), 'UPDATE')
console.log('test-bsale-operative-parent-sync: ok')
