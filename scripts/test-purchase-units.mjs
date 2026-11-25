import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const root = new URL('..', import.meta.url)
const migration = await readFile(new URL('supabase/migrations/20261124120000_adquisiciones_purchase_units.sql', root), 'utf8')
const action = await readFile(new URL('src/app/actions/adquisiciones/purchase-units.ts', root), 'utf8')
const panel = await readFile(new URL('src/modules/adquisiciones/unidades-compra/purchase-units-panel.tsx', root), 'utf8')
const navigation = await readFile(new URL('src/modules/adquisiciones/lib/navigation.ts', root), 'utf8')
const bsaleMapping = await readFile(new URL('src/lib/integraciones/bsale-auto-mapping.ts', root), 'utf8')
const costView = await readFile(new URL('supabase/migrations/20261002162223_bsale_reception_purchase_classification.sql', root), 'utf8')
const helperSource = await readFile(new URL('src/modules/adquisiciones/unidades-compra/catalog-data.ts', root), 'utf8')
const helperJs = ts.transpileModule(helperSource, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const { fetchAllPages, resolveRealSupplier } = await import(`data:text/javascript;base64,${Buffer.from(helperJs).toString('base64')}`)

test('fetches every page for products, mappings and suppliers above the API limit', async () => {
  for (const count of [1269, 3717, 2000]) {
    const expected = Array.from({ length: count }, (_, id) => ({ id }))
    const ranges = []
    const actual = await fetchAllPages(async (from, to) => {
      ranges.push([from, to])
      return { data: expected.slice(from, to + 1), error: null }
    })
    assert.deepEqual(actual, expected)
    assert.deepEqual(ranges.at(-1), [Math.floor(count / 1000) * 1000, Math.floor(count / 1000) * 1000 + 999])
  }
})

test('propagates later page failures instead of returning incomplete data', async () => {
  await assert.rejects(fetchAllPages(async from => from === 0
    ? { data: Array.from({ length: 1000 }), error: null }
    : { data: null, error: new Error('page failed') }), /page failed/)
})

test('counted pages run concurrently and preserve ordering', async () => {
  const expected = Array.from({ length: 3717 }, (_, id) => id)
  let active = 0, maxActive = 0
  const actual = await fetchAllPages(async (from, to) => {
    active++
    maxActive = Math.max(maxActive, active)
    await new Promise(resolve => setTimeout(resolve, 2))
    active--
    return { data: expected.slice(from, to + 1), error: null, count: expected.length }
  })
  assert.deepEqual(actual, expected)
  assert.ok(maxActive > 1)
})

test('counted pagination rejects incomplete snapshots and later errors', async () => {
  await assert.rejects(fetchAllPages(async from => ({ data: from === 0 ? Array(1000).fill(1) : [], error: null, count: 1001 })), /catálogo cambió/)
  await assert.rejects(fetchAllPages(async from => from === 0 ? { data: Array(1000).fill(1), error: null, count: 1001 } : { data: null, error: new Error('failed'), count: null }), /failed/)
})

test('resolves only real suppliers or operative suppliers with a real parent', () => {
  const real = { supplier_kind: 'REAL', parent_supplier_id: null }
  const operative = { supplier_kind: 'BSALE_OPERATIVE', parent_supplier_id: 'real' }
  const other = { supplier_kind: 'BSALE_OPERATIVE', parent_supplier_id: 'operative' }
  const suppliers = new Map([['real', real], ['operative', operative]])
  assert.equal(resolveRealSupplier(real, suppliers), real)
  assert.equal(resolveRealSupplier(operative, suppliers), real)
  assert.equal(resolveRealSupplier(other, suppliers), null)
  assert.equal(resolveRealSupplier(undefined, suppliers), null)
})

test('purchase unit migration preserves mappings and defaults only the factor', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS purchase_unit varchar\(30\)/)
  assert.match(migration, /ADD COLUMN IF NOT EXISTS purchase_unit_factor integer NOT NULL DEFAULT 1/)
  assert.match(migration, /purchase_unit_factor >= 1/)
  assert.match(migration, /purchase_unit_factor = 1 OR NULLIF\(btrim\(purchase_unit\), ''\) IS NOT NULL/)
  assert.doesNotMatch(migration, /CREATE TABLE.*purchase_unit/i)
})

test('catalog includes active products without fabricating supplier mappings', () => {
  assert.match(action, /\.from\('products'\)[\s\S]*\.eq\('is_active', true\)/)
  assert.match(action, /const sourceMappings = productMappings\.length > 0 \? productMappings : \[null\]/)
  assert.match(action, /mapping_id: mapping\?\.id \?\? null/)
  assert.match(action, /last_purchase_unit_cost/)
  assert.match(action, /vw_bsale_variant_last_purchase_cost/)
  assert.match(costView, /classification\.cost AS last_purchase_cost/)
})

test('individual and bulk updates validate company, permission and integer factor', () => {
  assert.match(action, /authorize\('adquisiciones\.products\.update'\)/)
  assert.match(action, /if \(!purchaseUnit\) return \{ error: 'Seleccione una unidad de compra válida\.'/)
  assert.match(action, /Number\.isInteger\(factor\) && factor >= 1/)
  assert.match(action, /\.eq\('company_id', authorization\.companyId\)/)
  assert.match(action, /export async function updatePurchaseUnitsBulk/)
  assert.match(panel, /window\.confirm\(`¿Confirmar la modificación de \$\{selectedRows\.length\} productos\?`\)/)
  assert.match(panel, /Aplicar a seleccionados/)
})

test('last cost is read from the canonical internal-unit cost without commercial factor arithmetic', () => {
  assert.match(action, /vw_bsale_variant_last_purchase_cost/)
  assert.match(action, /last_purchase_unit_cost: product\.bsale_variant_id === null \? null : costs\.get\(product\.bsale_variant_id\) \?\? null/)
  assert.doesNotMatch(action, /costs\.get\(product\.bsale_variant_id\)[\s\S]{0,80}\*\s*Number\(mapping\?\.purchase_unit_factor/)
})

test('manual purchase presentation fields survive Bsale mapping synchronization', () => {
  assert.match(bsaleMapping, /commercialConfigByKey/)
  assert.match(bsaleMapping, /const existingMappings = allExistingMappings\.filter\(mapping => mapping\.is_active\)/)
  assert.match(bsaleMapping, /purchase_unit: preservedConfig\?\.purchase_unit \?\? null/)
  assert.match(bsaleMapping, /purchase_unit_factor: preservedConfig\?\.purchase_unit_factor \?\? 1/)
  assert.match(action, /updated_by: authorization\.user\.id/)
  assert.match(panel, /Unidades de compra/)
  assert.match(navigation, /label: 'Unidades de compra'/)
  assert.match(navigation, /routes\.purchaseUnits/)
})
