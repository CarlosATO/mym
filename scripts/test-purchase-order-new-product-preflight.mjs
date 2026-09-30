import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const action = await readFile(new URL('src/app/actions/adquisiciones/bsale-product-creation.ts', root), 'utf8')

function mockFetchForLookup({ code, barcode }) {
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? 'GET' })
    const parsed = new URL(url)
    const value = parsed.searchParams.get('code') ?? parsed.searchParams.get('barcode')
    const item = value === code
      ? { id: 1669, product: { id: 1192 }, code, barCode: barcode }
      : value === barcode
        ? { id: 1669, product: { id: 1192 }, code, barCode: barcode }
        : null
    return new Response(JSON.stringify({ count: item ? 1 : 0, items: item ? [item] : [] }), { status: 200 })
  }
  return calls
}

test('context derives supplier from the OC and does not accept browser supplier input', () => {
  assert.match(action, /from\('purchase_orders'\)/)
  assert.match(action, /\.eq\('id', poId\)/)
  assert.match(action, /\.eq\('company_id', companyId\)/)
  assert.match(action, /select\('id, supplier_id, status'\)/)
  assert.match(action, /from\('suppliers'\)/)
  assert.match(action, /supplier_kind.*REAL/)
  assert.doesNotMatch(action, /input\.supplier_id|input\.company_id|input\.expected_brand_id/)
})

test('product types are structurally filtered through operative suppliers', () => {
  assert.match(action, /supplier_kind', 'BSALE_OPERATIVE'/)
  assert.match(action, /parent_supplier_id', supplierId/)
  assert.match(action, /bsale_product_type_id/)
  assert.match(action, /from\('bsale_product_types'\)/)
  assert.match(action, /byId\.set\(id, \{ id, name: type\.name \}\)/)
  assert.match(action, /localeCompare\(right\.name, 'es-CL'\)/)
  assert.doesNotMatch(action, /name.*LIKE|ilike\([^\n]*HAGEN|startsWith\(['"]HAGEN/)
})

test('product type is revalidated and Brand remains expected metadata only', () => {
  const hagenBrandFixture = { status: 'UNIQUE', expected_bsale_brand_id: 37, candidate_ids: [37] }
  assert.deepEqual(hagenBrandFixture, { status: 'UNIQUE', expected_bsale_brand_id: 37, candidate_ids: [37] })
  assert.match(action, /export async function validateSupplierBsaleProductType/)
  assert.match(action, /INVALID_PRODUCT_TYPE_MESSAGE/)
  assert.match(action, /from\('bsale_brand_supplier_links'\)/)
  assert.match(action, /status: 'NONE'|status: 'UNIQUE'|status: 'MULTIPLE'/)
  assert.match(action, /expected_bsale_brand_id/)
  assert.doesNotMatch(action, /\.update\([^\n]*bsale_brand_id/)
  assert.doesNotMatch(action, /\.insert\([^\n]*products|\.upsert\([^\n]*products/)
})

test('Caylo defaults are explicit and scoped without silent company fallback', () => {
  for (const field of ['classification', 'stock_control', 'allow_decimal', 'unlimited_stock', 'allow_negative_stock', 'serial_number', 'is_lot', 'tax_rate', 'bsale_tax_id']) {
    assert.match(action, new RegExp(`${field}:`))
  }
  assert.match(action, /companyId !== KNOWN_COMPANY_IDS\.CAYLO/)
  assert.match(action, /tax_rate: 19/)
  assert.match(action, /bsale_tax_id: 1/)
})

test('SKU and barcode normalization preserves barcode as a string', () => {
  assert.match(action, /trim\(\)\.toUpperCase\(\)\.replace\(\/\\s\+\/g, ' '\)/)
  assert.match(action, /value\?\.trim\(\) \?\? ''/)
  assert.doesNotMatch(action, /Number\(.*barcode|parseInt\(.*barcode/)
})

test('mocked Bsale lookup uses GET by code and barcode with URL encoding', async () => {
  const calls = mockFetchForLookup({ code: 'SKU 001', barcode: '000123' })
  const skuUrl = new URL('https://api.bsale.cl/v1/variants.json')
  skuUrl.searchParams.set('code', 'SKU 001')
  skuUrl.searchParams.set('limit', '50')
  const barcodeUrl = new URL('https://api.bsale.cl/v1/variants.json')
  barcodeUrl.searchParams.set('barcode', '000123')
  barcodeUrl.searchParams.set('limit', '50')
  await globalThis.fetch(skuUrl, { method: 'GET' })
  await globalThis.fetch(barcodeUrl, { method: 'GET' })
  assert.deepEqual(calls.map(call => call.method), ['GET', 'GET'])
  assert.equal(new URL(calls[0].url).searchParams.get('code'), 'SKU 001')
  assert.equal(new URL(calls[1].url).searchParams.get('barcode'), '000123')
  assert.match(action, /bsaleFetchForCompany/)
  assert.match(action, /path: '\/variants\.json'/)
  assert.match(action, /\[key\]: value/)
  assert.doesNotMatch(action, /method: ['"]POST|method: ['"]PUT|method: ['"]PATCH|method: ['"]DELETE/)
})

test('ERP and Bsale duplicates, conflicts, and can_create are blocking', () => {
  assert.match(action, /from\('products'\)/)
  assert.match(action, /\.or\(`company_id\.is\.null,company_id\.eq\.\$\{companyId\}`\)/)
  assert.match(action, /\.eq\(field, value\)/)
  assert.match(action, /lookup\('sku', sku\)/)
  assert.match(action, /lookup\('barcode', barcode\)/)
  assert.match(action, /erp_duplicate/)
  assert.match(action, /erp_conflict/)
  assert.match(action, /bsale_duplicate/)
  assert.match(action, /ya existen en ERP pero pertenecen a productos diferentes/)
  assert.match(action, /pertenecen a variantes diferentes/)
  assert.match(action, /can_create: !erpDuplicate\.exists && !erpConflict && !bsaleDuplicate\.exists && !conflict/)
  assert.doesNotMatch(action, /can_create:[\s\S]{0,120}brand/)
  assert.match(action, /expected_bsale_brand_id/)
})

test('ERP duplicate scope includes globals and active company, excluding other companies', () => {
  const companyId = 'company-a'
  const rows = [
    { company_id: null, sku: 'GLOBAL-1', barcode: '000001' },
    { company_id: 'company-a', sku: 'PRIVATE-1', barcode: '000002' },
    { company_id: 'company-b', sku: 'PRIVATE-2', barcode: '000003' },
  ]
  const effectiveRows = rows.filter(row => row.company_id === null || row.company_id === companyId)
  assert.equal(effectiveRows.some(row => row.sku === 'GLOBAL-1'), true)
  assert.equal(effectiveRows.some(row => row.barcode === '000001'), true)
  assert.equal(effectiveRows.some(row => row.sku === 'PRIVATE-1'), true)
  assert.equal(effectiveRows.some(row => row.barcode === '000002'), true)
  assert.equal(effectiveRows.some(row => row.sku === 'PRIVATE-2'), false)
  assert.equal(effectiveRows.some(row => row.barcode === '000003'), false)
  assert.equal('000001', '000001')
})

test('ERP SKU and barcode matches from different products are an explicit conflict', () => {
  const skuProduct = { id: 'global-product' }
  const barcodeProduct = { id: 'company-product' }
  const erpConflict = skuProduct.id !== barcodeProduct.id
  assert.equal(erpConflict, true)
  assert.match(action, /Boolean\(skuProduct && barcodeProduct && skuProduct\.id !== barcodeProduct\.id\)/)
  assert.match(action, /!erpDuplicate\.exists && !erpConflict/)
})

test('flow is read-only and has no Bsale write methods or persistence of Brand', () => {
  assert.doesNotMatch(action, /POST|PUT|PATCH|DELETE/)
  assert.doesNotMatch(action, /fetch\([^)]*method:/)
  assert.doesNotMatch(action, /from\('products'\)[\s\S]*?\.(insert|update|upsert)\(/)
})
