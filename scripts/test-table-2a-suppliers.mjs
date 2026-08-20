import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const suppliersPath = new URL('../src/modules/adquisiciones/proveedores/suppliers-panel.tsx', import.meta.url)
const brandPath = new URL('../src/modules/adquisiciones/proveedores/bsale-brand-supplier-panel.tsx', import.meta.url)
const [suppliers, brand] = await Promise.all([
  readFile(suppliersPath, 'utf8'),
  readFile(brandPath, 'utf8'),
])

test('las tres tablas usan el primitive y tableKeys independientes', () => {
  assert.match(suppliers, /useOperationalTableWidths\(REAL_TABLE_KEY, REAL_COLUMNS\)/)
  assert.match(suppliers, /useOperationalTableWidths\(PSEUDO_TABLE_KEY, PSEUDO_COLUMNS\)/)
  assert.match(brand, /useOperationalTableWidths\(BRAND_TABLE_KEY, BRAND_COLUMNS\)/)
  assert.match(suppliers, /mym:table:adquisiciones:proveedores-reales/)
  assert.match(suppliers, /mym:table:adquisiciones:pseudoproveedores/)
  assert.match(brand, /mym:table:adquisiciones:proveedor-bsale/)
})

test('resize, reset, separadores y sticky Actions están configurados', () => {
  assert.equal((suppliers.match(/OperationalTableResizeHandle/g) ?? []).length >= 2, true)
  assert.match(suppliers, /resetRealWidths/)
  assert.match(suppliers, /resetPseudoWidths/)
  assert.match(brand, /OperationalTableResizeHandle/)
  assert.match(brand, /resetWidths/)
  assert.match(suppliers, /sticky right-0 z-30/)
  assert.match(suppliers, /sticky right-0 z-20/)
  assert.match(brand, /sticky right-0 z-30/)
  assert.match(brand, /sticky right-0 z-20/)
})

test('sorting es local sobre datasets completos y no ofrece sorting falso', () => {
  assert.match(suppliers, /sortOperationalRows\(filteredSuppliers/)
  assert.match(suppliers, /sortOperationalRows\(pseudos/)
  assert.match(brand, /sortOperationalRows\(visibleCandidates/)
  assert.doesNotMatch(suppliers, /id: 'actions'.*sortable: true/)
  assert.doesNotMatch(suppliers, /id: 'status'.*sortKey: 'parent_supplier_id'/)
  assert.doesNotMatch(brand, /id: 'coverage'.*sortable: true/)
})

test('Proveedor Real conserva Editar y doble clic; pseudoproveedores no inventan edición', () => {
  assert.match(suppliers, /onDoubleClick=.*openEdit\(s\)/)
  assert.match(suppliers, /onClick=\{\(\) => openEdit\(s\)\}/)
  assert.match(suppliers, /handleDeactivate\(s\)/)
  assert.doesNotMatch(suppliers, /sortedPseudos\.map\(p =>[\s\S]*onDoubleClick/)
})

test('refresh conserva tablas y Proveedor en Bsale mantiene permisos/mutaciones', () => {
  assert.match(suppliers, /initialLoading/)
  assert.match(suppliers, /refreshing/)
  assert.match(suppliers, /requestSequence\.current/)
  assert.match(brand, /canWrite/)
  assert.match(brand, /linkBsaleBrandSupplier\(/)
  assert.match(brand, /unlinkBsaleBrandSupplier\(/)
  assert.match(brand, /getSuppliers\(undefined, 'REAL'\)/)
  assert.match(brand, /supplier\.is_active && supplier\.status === 'ACTIVE'/)
})
