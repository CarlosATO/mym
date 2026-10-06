import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { isSkuInScope } from '../src/lib/integraciones/bsale-auto-mapping.ts'

const mapping = await readFile(new URL('../src/lib/integraciones/bsale-auto-mapping.ts', import.meta.url), 'utf8')
const purchaseOrders = await readFile(new URL('../src/app/actions/adquisiciones/purchase-orders.ts', import.meta.url), 'utf8')
const migration = await readFile(new URL('../supabase/migrations/20261006210000_adquisiciones_product_supplier_mapping_integrity.sql', import.meta.url), 'utf8')
const followUpMigration = await readFile(new URL('../supabase/migrations/20261006210500_adquisiciones_product_supplier_mapping_active_uniqueness.sql', import.meta.url), 'utf8')

test('mapping coherence compares company, SKU, product and variant', () => {
  assert.match(mapping, /isProductSupplierMappingCoherent/)
  assert.match(mapping, /mapping\.company_id === product\.company_id/)
  assert.match(mapping, /mapping\.sku === product\.sku/)
  assert.match(mapping, /mapping\.product_id === product\.id/)
  assert.match(mapping, /mapping\.bsale_variant_id === product\.bsale_variant_id/)
})

test('auto-mapping repairs stale product identity and creates missing mappings', () => {
  assert.match(mapping, /productsBySku/)
  assert.match(mapping, /productsByVariant/)
  assert.match(mapping, /product_id: targetProduct\.id/)
  assert.match(mapping, /mappingsUpdated\+\+/)
  assert.match(mapping, /mappingsCreated\+\+/)
  assert.match(mapping, /realSupplierIds\.has\(m\.supplier_id\)/)
  assert.match(mapping, /mappingsSkippedManualConflict\+\+/)
  assert.match(mapping, /supplier_id: supplier\.id/)
})

test('preparation runs non-dry auto-repair and validates the repaired variant', () => {
  assert.match(purchaseOrders, /syncProductSupplierMappings\(companyId, \{ dryRun: false, skus \}\)/)
  assert.match(purchaseOrders, /mapping\.bsale_variant_id === product\.bsale_variant_id/)
})

test('database rejects mappings with inconsistent product identity', () => {
  assert.match(migration, /BEFORE INSERT OR UPDATE/)
  assert.match(migration, /v_product\.company_id IS DISTINCT FROM NEW\.company_id/)
  assert.match(migration, /v_product\.sku IS DISTINCT FROM NEW\.sku/)
  assert.match(migration, /v_product\.bsale_variant_id IS DISTINCT FROM NEW\.bsale_variant_id/)
  assert.match(migration, /ERRCODE = '23514'/)
})

test('active mapping uniqueness permits retired legacy rows during repair', () => {
  assert.match(followUpMigration, /DROP CONSTRAINT IF EXISTS product_supplier_mappings_company_id_supplier_id_sku_key/)
  assert.match(followUpMigration, /WHERE is_active = true/)
  assert.match(followUpMigration, /NEW\.is_active = false/)
})

test('targeted sync scopes every read/write to target SKUs', () => {
  const targetSkus = ['SKU-A', 'SKU-B', 'SKU-C']
  const simulatedMappings = [
    ...Array.from({ length: 3697 }, (_, index) => ({ sku: `OTHER-${index}` })),
    ...targetSkus.map(sku => ({ sku })),
  ]
  assert.deepEqual(simulatedMappings.filter(mapping => isSkuInScope(mapping.sku, targetSkus)).map(mapping => mapping.sku), targetSkus)
  assert.equal(isSkuInScope('SKU-A', targetSkus), true)
  assert.equal(isSkuInScope('SKU-B', targetSkus), true)
  assert.equal(isSkuInScope('SKU-C', targetSkus), true)
  assert.equal(isSkuInScope('SKU-D', targetSkus), false)
  assert.match(mapping, /query\.in\('sku', targetSkus!\)/)
  assert.match(mapping, /isSkuInScope\(mapping\.sku, targetSkus\)/)
  assert.match(mapping, /isSkuInScope\(old\.sku, targetSkus\)/)
})
