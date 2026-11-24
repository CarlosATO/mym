import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const migration = await readFile(new URL('supabase/migrations/20261124120000_adquisiciones_purchase_units.sql', root), 'utf8')
const action = await readFile(new URL('src/app/actions/adquisiciones/purchase-units.ts', root), 'utf8')
const panel = await readFile(new URL('src/modules/adquisiciones/unidades-compra/purchase-units-panel.tsx', root), 'utf8')
const navigation = await readFile(new URL('src/modules/adquisiciones/lib/navigation.ts', root), 'utf8')
const bsaleMapping = await readFile(new URL('src/lib/integraciones/bsale-auto-mapping.ts', root), 'utf8')
const costView = await readFile(new URL('supabase/migrations/20261002162223_bsale_reception_purchase_classification.sql', root), 'utf8')

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
