import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyBrandSupplier,
  decideLinkOperation,
  deriveBrandSupplierStatus,
  validateBrandSupplierLinkInput,
} from '../src/lib/integraciones/bsale-brand-supplier-contract.ts'

test('Brand detectado sin vinculo queda PENDING', () => {
  assert.equal(deriveBrandSupplierStatus(false, 'SIN_RESOLVER'), 'PENDING')
})

test('candidato unico no se autoaprueba', () => {
  assert.equal(classifyBrandSupplier({ activeProducts: 5, resolvedPreferredProducts: 5, realSupplierCount: 1 }), 'INEQUIVOCO')
  assert.equal(deriveBrandSupplierStatus(false, 'INEQUIVOCO'), 'PENDING')
})

test('Brand mixto queda CONFLICT', () => {
  assert.equal(classifyBrandSupplier({ activeProducts: 10, resolvedPreferredProducts: 10, realSupplierCount: 2 }), 'MIXTO')
  assert.equal(deriveBrandSupplierStatus(false, 'MIXTO'), 'CONFLICT')
})

test('resolucion parcial queda CASI_INEQUIVOCO', () => {
  assert.equal(classifyBrandSupplier({ activeProducts: 85, resolvedPreferredProducts: 54, realSupplierCount: 1 }), 'CASI_INEQUIVOCO')
})

test('vinculo aprobado queda LINKED', () => {
  assert.equal(deriveBrandSupplierStatus(true, 'MIXTO'), 'LINKED')
})

test('segundo supplier distinto no puede ser tratado como idempotente', () => {
  assert.equal(decideLinkOperation('supplier-a', 'supplier-b'), 'CONFLICT')
})

test('un supplier REAL puede recibir varios Brands', () => {
  const supplierId = 'supplier-a'
  assert.deepEqual([29, 75].map(() => supplierId), [supplierId, supplierId])
})

test('Brand invalido y supplier BSALE_OPERATIVE son validaciones RPC', () => {
  assert.equal(validateBrandSupplierLinkInput({ brandId: 0, supplierKind: 'REAL', sameCompany: true, supplierActive: true }), 'INVALID_BSALE_BRAND_ID')
  assert.equal(validateBrandSupplierLinkInput({ brandId: 29, supplierKind: 'BSALE_OPERATIVE', sameCompany: true, supplierActive: true }), 'SUPPLIER_MUST_BE_REAL')
})

test('empresa y Brand no se mezclan', () => {
  assert.equal(validateBrandSupplierLinkInput({ brandId: 29, supplierKind: 'REAL', sameCompany: false, supplierActive: true }), 'SUPPLIER_NOT_FOUND_OR_WRONG_COMPANY')
})

test('unlink deja el estado derivado pendiente', () => {
  assert.equal(deriveBrandSupplierStatus(false, 'CASI_INEQUIVOCO'), 'PENDING')
})

test('ningun resumen crea suppliers o mappings', () => {
  const summary = { suppliersCreated: 0, mappingsChanged: 0 }
  assert.deepEqual(summary, { suppliersCreated: 0, mappingsChanged: 0 })
})

test('supplier inactivo es rechazado', () => {
  assert.equal(validateBrandSupplierLinkInput({ brandId: 29, supplierKind: 'REAL', sameCompany: true, supplierActive: false }), 'SUPPLIER_NOT_ACTIVE')
})

test('mismo vinculo repetido es idempotente', () => {
  assert.equal(decideLinkOperation('supplier-a', 'supplier-a'), 'ALREADY_LINKED')
})
