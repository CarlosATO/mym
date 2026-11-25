import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function load(path, prefix = '') {
  const source = (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/^import .*$/gm, '')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(prefix + js).toString('base64')}`)
}
const { fetchAllPages, resolveRealSupplier } = await load('../src/modules/adquisiciones/unidades-compra/catalog-data.ts')
globalThis.__brandTest = { fetchAllPages }
const { loadBsaleBrandSuppliers } = await load('../src/modules/adquisiciones/lib/bsale-brand-suppliers.ts', 'const { fetchAllPages } = globalThis.__brandTest;\n')
const company = 'company'
const fixtures = {
  products: [
    { id: 'p1', company_id: company, sku: '100501', description: 'ACWS', source: 'BSALE', bsale_brand_id: 30, is_active: true, bsale_variant_id: null, sales_unit: null, sales_unit_factor: 1 },
    { id: 'p2', company_id: company, sku: 'DDC', description: 'DDC', source: 'BSALE', bsale_brand_id: 44, is_active: true, bsale_variant_id: null, sales_unit: null, sales_unit_factor: 1 },
    { id: 'p3', company_id: company, sku: 'NO-BRAND', description: 'SIN MARCA', source: 'BSALE', bsale_brand_id: null, is_active: true, bsale_variant_id: null, sales_unit: null, sales_unit_factor: 1 },
  ],
  product_supplier_mappings: [
    { id: 'm1', company_id: company, product_id: 'p1', supplier_id: 'inactive', is_active: true, purchase_unit: 'CAJA', purchase_unit_factor: 12 },
    { id: 'm2', company_id: company, product_id: 'p2', supplier_id: 'operative', is_active: true, purchase_unit: null, purchase_unit_factor: 1 },
    { id: 'm3', company_id: company, product_id: 'p3', supplier_id: 'operative', is_active: true, purchase_unit: null, purchase_unit_factor: 1 },
  ],
  suppliers: [
    { id: 'acws', company_id: company, business_name: 'ANIMAL CARE - ACWS S.A.', supplier_kind: 'REAL', is_active: true, status: 'ACTIVE', rut: null },
    { id: 'pets', company_id: company, business_name: 'MAYORISTA PETS SPA', supplier_kind: 'REAL', is_active: true, status: 'ACTIVE', rut: null },
    { id: 'inactive', company_id: company, business_name: 'ACWS/TRASPORTE', supplier_kind: 'BSALE_OPERATIVE', is_active: false, status: 'ACTIVE' },
    { id: 'operative', company_id: company, business_name: 'OTRO', supplier_kind: 'BSALE_OPERATIVE', is_active: true, status: 'ACTIVE', parent_supplier_id: 'acws' },
  ],
  bsale_brand_supplier_links: [
    { company_id: company, bsale_brand_id: 30, supplier_id: 'acws' },
    { company_id: company, bsale_brand_id: 44, supplier_id: 'pets' },
  ],
}
function from(table) {
  const filters = []
  let low = 0, high = 999
  const q = {
    select() { return q }, eq(key, value) { filters.push(row => row[key] === value); return q },
    in(key, values) { filters.push(row => values.includes(row[key])); return q },
    order() { return q }, or() { return q }, range(from, to) { low = from; high = to; return q },
    then(resolve, reject) {
      const rows = fixtures[table].filter(row => filters.every(filter => filter(row)))
      return Promise.resolve({ data: rows.slice(low, high + 1), count: rows.length, error: null }).then(resolve, reject)
    },
  }
  return q
}
const db = { from, schema: () => ({ from }) }
globalThis.__purchaseTest = {
  fetchAllPages, resolveRealSupplier, loadBsaleBrandSuppliers,
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'user' } } }) }, rpc: async () => ({ data: true, error: null }) }),
  createSupabaseClient: () => db,
  getActiveCompanyId: async () => company,
}
const { getPurchaseUnitsCatalog } = await load('../src/app/actions/adquisiciones/purchase-units.ts', 'const { fetchAllPages, resolveRealSupplier, loadBsaleBrandSuppliers, createClient, createSupabaseClient, getActiveCompanyId } = globalThis.__purchaseTest;\n')

test('catalog uses existing brand links even if operative supplier is inactive', async () => {
  const before = JSON.stringify(fixtures.product_supplier_mappings)
  const { data, error } = await getPurchaseUnitsCatalog()
  assert.equal(error, undefined)
  const product = data.find(row => row.sku === '100501')
  assert.equal(product.real_supplier_name, 'ANIMAL CARE - ACWS S.A.')
  assert.equal(product.mapping_id, 'm1')
  assert.equal(product.purchase_unit, 'CAJA')
  assert.equal(product.purchase_unit_factor, 12)
  assert.equal(product.can_edit, true)
  assert.equal(data.find(row => row.sku === 'DDC').real_supplier_name, 'MAYORISTA PETS SPA')
  assert.equal(data.find(row => row.sku === 'NO-BRAND').supplier_status, 'UNRESOLVED')
  assert.equal(data.find(row => row.sku === 'NO-BRAND').real_supplier_id, null)
  assert.equal(data.length, 3)
  assert.equal(JSON.stringify(fixtures.product_supplier_mappings), before)
})
