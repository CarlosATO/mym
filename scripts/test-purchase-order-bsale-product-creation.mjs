import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'

const core = await import('../src/lib/integraciones/bsale-product-creation-core.ts')
const action = await readFile(new URL('../src/app/actions/adquisiciones/bsale-product-creation.ts', import.meta.url), 'utf8')
const client = await readFile(new URL('../src/lib/bsale/write-client.ts', import.meta.url), 'utf8')

const input = {
  companyId: 'company-a',
  userId: 'user-a',
  supplier: { id: 'supplier-real', business_name: 'Proveedor Real', rut: null },
  sku: 'SKU-001',
  barcode: '000001',
  description: 'Producto nuevo',
  productType: { id: 37, name: 'Alimentos' },
  expectedBrandId: 37,
}

function dependencies(overrides = {}) {
  const calls = { find: 0, products: [], variants: [], persisted: [], mappings: [] }
  return {
    calls,
    findExistingVariant: async () => { calls.find += 1; return null },
    createProduct: async payload => { calls.products.push(payload); return { id: 501, state: 0 } },
    createVariant: async payload => { calls.variants.push(payload); return { id: 601, productId: payload.productId, state: 0 } },
    persistProduct: async value => {
      calls.persisted.push(value)
      return { id: 'erp-product', sku: value.sku, barcode: value.barcode, description: value.description, tax_rate: 19, bsale_product_id: value.bsaleProductId, bsale_variant_id: value.bsaleVariantId, bsale_product_type_id: value.productType.id, bsale_product_type_name: value.productType.name }
    },
    ensureSupplierMapping: async value => { calls.mappings.push(value) },
    ...overrides,
  }
}

test('contract writes Product then Variant with documented payloads only', async () => {
  const deps = dependencies()
  const result = await core.createBsaleProductAndVariant(input, deps)
  assert.equal(result.success, true)
  assert.deepEqual(deps.calls.products[0], {
    name: 'Producto nuevo', description: 'Producto nuevo', classification: 0, allowDecimal: 0,
    stockControl: 1, productTypeId: 37, serialNumber: 0, isLot: 0, taxId: 1,
  })
  assert.deepEqual(deps.calls.variants[0], {
    productId: 501, description: 'Producto nuevo', unlimitedStock: 0, allowNegativeStock: 0,
    code: 'SKU-001', barCode: '000001',
  })
  assert.equal('brandId' in deps.calls.products[0], false)
  assert.equal('unit' in deps.calls.variants[0], false)
  assert.equal(deps.calls.mappings[0].supplierId, 'supplier-real')
  assert.equal(result.brand.assignment_status, 'PENDING_MANUAL')
  assert.equal(deps.calls.persisted[0].companyId, 'company-a')
  assert.equal(typeof deps.calls.variants[0].barCode, 'string')
})

test('preflight gate and backend contract exclude UI/items and real writes', () => {
  assert.match(action, /const preflight = await preflightPurchaseOrderNewProduct\(poId, input\)/)
  assert.match(action, /!preflight\.success \|\| !preflight\.can_create/)
  assert.match(action, /company_id: input\.companyId/)
  assert.match(action, /source: 'BSALE'/)
  assert.match(action, /is_preferred: true/)
  assert.doesNotMatch(action, /\n\s+bsale_brand_id\s*:/)
  assert.doesNotMatch(action, /purchase_order_items/)
  assert.doesNotMatch(action, /purchase-order-supplier-review\.tsx/)
  assert.match(client, /method: 'POST'/)
})

test('Product timeout does not retry POST and requires reconciliation', async () => {
  let productPosts = 0
  const deps = dependencies({
    createProduct: async () => { productPosts += 1; const error = new Error('timeout'); error.name = 'AbortError'; throw error },
    findExistingVariant: async () => null,
  })
  const result = await core.createBsaleProductAndVariant(input, deps)
  assert.equal(result.status, 'RECONCILIATION_REQUIRED')
  assert.equal(productPosts, 1)
  assert.equal(deps.calls.variants.length, 0)
})

test('Product created and Variant failure returns partial state without deleting Product', async () => {
  const deps = dependencies({
    createVariant: async () => { throw new Error('variant failed') },
  })
  const result = await core.createBsaleProductAndVariant(input, deps)
  assert.equal(result.status, 'BSALE_PRODUCT_CREATED_VARIANT_FAILED')
  assert.equal(result.bsale_product_id, 501)
  assert.equal(deps.calls.persisted.length, 0)
})

test('existing Variant is detected before Product POST', async () => {
  const deps = dependencies({
    findExistingVariant: async () => ({ variantId: 601, productId: 501, code: 'SKU-001', barcode: '000001' }),
  })
  const result = await core.createBsaleProductAndVariant(input, deps)
  assert.equal(result.status, 'BSALE_VARIANT_EXISTS')
  assert.equal(deps.calls.products.length, 0)
  assert.equal(deps.calls.variants.length, 0)
})

test('Variant found after Product POST is reconciled without creating a duplicate', async () => {
  let findCount = 0
  const deps = dependencies({
    findExistingVariant: async () => {
      findCount += 1
      return findCount === 2 ? { variantId: 601, productId: 501, code: 'SKU-001', barcode: '000001' } : null
    },
  })
  const result = await core.createBsaleProductAndVariant(input, deps)
  assert.equal(result.status, 'BSALE_VARIANT_EXISTS')
  assert.equal(result.success, false)
  assert.equal(deps.calls.variants.length, 0)
  assert.equal(deps.calls.persisted[0].bsaleVariantId, 601)
})

test('ERP persistence failure returns both Bsale IDs for reconciliation', async () => {
  const deps = dependencies({
    persistProduct: async () => { throw new Error('ERP unavailable') },
  })
  const result = await core.createBsaleProductAndVariant(input, deps)
  assert.equal(result.status, 'ERP_PERSIST_FAILED')
  assert.equal(result.bsale_product_id, 501)
  assert.equal(result.bsale_variant_id, 601)
  assert.equal(deps.calls.mappings.length, 0)
})

test('Variant recovered after uncertain Variant POST is persisted without another POST', async () => {
  let findCount = 0
  const deps = dependencies({
    findExistingVariant: async () => {
      findCount += 1
      return findCount === 3 ? { variantId: 601, productId: 501, code: 'SKU-001', barcode: '000001' } : null
    },
    createVariant: async () => { throw new Error('network failure') },
  })
  const result = await core.createBsaleProductAndVariant(input, deps)
  assert.equal(result.success, true)
  assert.equal(deps.calls.variants.length, 0)
  assert.equal(deps.calls.persisted[0].bsaleVariantId, 601)
})
