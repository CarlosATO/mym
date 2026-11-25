import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function load(path, prefix = '') {
  const source = (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/^import .*$/gm, '')
  return import(`data:text/javascript;base64,${Buffer.from(prefix + ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString('base64')}`)
}
const { fetchAllPages } = await load('../src/modules/adquisiciones/unidades-compra/catalog-data.ts')
globalThis.__commercialDeps = { fetchAllPages }
const { loadBsaleBrandSuppliers } = await load('../src/modules/adquisiciones/lib/bsale-brand-suppliers.ts', 'const { fetchAllPages } = globalThis.__commercialDeps;\n')
globalThis.__commercialDeps.loadBsaleBrandSuppliers = loadBsaleBrandSuppliers
const { resolvePurchaseCommercial, resolvePurchaseCommercialEvidence } = await load('../src/modules/adquisiciones/lib/purchase-commercial-resolver.ts', 'const { fetchAllPages, loadBsaleBrandSuppliers } = globalThis.__commercialDeps;\n')

const real = { id: 'real', business_name: 'Proveedor', supplier_kind: 'REAL', parent_supplier_id: null, is_active: true, status: 'ACTIVE' }
const pseudo = { id: 'pseudo', business_name: 'Operativo', supplier_kind: 'BSALE_OPERATIVE', parent_supplier_id: null, is_active: false, status: 'INACTIVE' }
const base = { product: { id: 'p', source: 'BSALE', bsale_brand_id: 48 }, realSupplier: real, brandSupplierId: 'real', brandLinkCount: 1, suppliers: [pseudo], mappings: [{ id: 'm', supplier_id: 'pseudo', purchase_unit: 'DISPLAY', purchase_unit_factor: 6 }] }

test('configured purchase factor is independent of sales factor and inactive operative supplier', () => {
  assert.deepEqual(resolvePurchaseCommercialEvidence({ ...base, product: { ...base.product, sales_unit_factor: 99 } }), { success: true, real_supplier: { id: 'real', business_name: 'Proveedor' }, mapping_id: 'm', purchase_unit: 'DISPLAY', purchase_unit_factor: 6, configuration_status: 'CONFIGURED' })
})
test('pending preserves mapping identity and defaults to one; missing mapping also pending', () => {
  const pending = resolvePurchaseCommercialEvidence({ ...base, mappings: [{ ...base.mappings[0], purchase_unit: null, purchase_unit_factor: 1 }] })
  assert.equal(pending.configuration_status, 'PENDING'); assert.equal(pending.purchase_unit_factor, 1); assert.equal(pending.mapping_id, 'm')
  assert.equal(resolvePurchaseCommercialEvidence({ ...base, mappings: [] }).mapping_id, null)
})
test('missing brand, contradictory supplier, duplicate brand or mappings fail explicitly', () => {
  for (const [overrides, code] of [
    [{ product: { ...base.product, bsale_brand_id: null }, brandSupplierId: null, brandLinkCount: 0 }, 'BRAND_UNRESOLVED'],
    [{ brandSupplierId: 'other' }, 'SUPPLIER_MISMATCH'],
    [{ brandLinkCount: 2 }, 'AMBIGUOUS_BRAND'],
    [{ mappings: [...base.mappings, { ...base.mappings[0], id: 'm2' }] }, 'AMBIGUOUS_MAPPING'],
    [{ mappings: [{ ...base.mappings[0], purchase_unit: null, purchase_unit_factor: 6 }] }, 'INVALID_MAPPING'],
    [{ suppliers: [] }, 'INVALID_MAPPING'],
    [{ realSupplier: { ...real, is_active: false } }, 'INVALID_SUPPLIER'],
  ]) assert.equal(resolvePurchaseCommercialEvidence({ ...base, ...overrides }).code, code)
})
test('non-Bsale mappings are scoped to the selected real supplier', () => {
  const local = { ...base, product: { ...base.product, source: 'LOCAL' }, suppliers: [{ ...pseudo, parent_supplier_id: 'real' }, { ...real, id: 'other' }], mappings: [...base.mappings, { ...base.mappings[0], id: 'other-m', supplier_id: 'other' }] }
  assert.equal(resolvePurchaseCommercialEvidence(local).mapping_id, 'm')
})

test('database adapter applies company and active mapping filters and reuses brand lookup', async () => {
  const tables = {
    products: [{ ...base.product, company_id: 'c', is_active: true }],
    suppliers: [{ ...real, company_id: 'c' }, { ...pseudo, company_id: 'c' }],
    product_supplier_mappings: [{ ...base.mappings[0], company_id: 'c', product_id: 'p', is_active: true }, { ...base.mappings[0], id: 'foreign', company_id: 'other', product_id: 'p', is_active: true }, { ...base.mappings[0], id: 'inactive', company_id: 'c', product_id: 'p', is_active: false }],
    bsale_brand_supplier_links: [{ company_id: 'c', bsale_brand_id: 48, supplier_id: 'real' }],
  }
  function from(table) {
    const filters = []; let lo = 0, hi = 999, single = false
    const q = { select() { return q }, eq(k,v) { filters.push(r => r[k] === v); return q }, in(k,v) { filters.push(r => v.includes(r[k])); return q }, order() { return q }, range(a,b) { lo=a; hi=b; return q }, maybeSingle() { single=true; return q }, then(ok,bad) { const rows = tables[table].filter(r => filters.every(f => f(r))); return Promise.resolve({ data: single ? rows[0] ?? null : rows.slice(lo, hi+1), count: rows.length, error: null }).then(ok,bad) } }
    return q
  }
  const db = { from, schema: () => ({ from }) }
  const result = await resolvePurchaseCommercial(db, 'c', 'p', 'real')
  assert.equal(result.mapping_id, 'm', JSON.stringify(result)); assert.equal(result.purchase_unit_factor, 6)
  assert.equal((await resolvePurchaseCommercial(db, 'other', 'p', 'real')).code, 'PRODUCT_NOT_FOUND')
})
