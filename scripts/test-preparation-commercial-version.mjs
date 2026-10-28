import test from 'node:test'
import assert from 'node:assert/strict'
import { compareCommercialVersions, fingerprintCommercialVersion, preparationCommercialLineFromSnapshot } from '../src/lib/logistica/preparation-commercial-version.ts'

const identity = (historicalBsaleId, currentBsaleId = historicalBsaleId) => ({
  canonicalToken: 'd6fc7d5b5c21', historicalBsaleId, currentBsaleId, folio: '5129',
})

const line = (variantId, sku, quantity, lineNumber, extra = {}) => ({
  variantId, sku, productName: sku, quantity, lineNumber, unitNetValue: 1000, lineNetAmount: quantity * 1000, ...extra,
})

const version = (physicalId, lines, totalAmount = 0, overrides = {}) => ({
  identity: identity(92706, physicalId), physicalId, lines, netAmount: totalAmount, taxAmount: 0, totalAmount, ...overrides,
})

test('NV 5129 identifica identidad, altas, baja, cantidades estables y total', () => {
  const previous = version(92706, [
    line(1, 'SKU-1', 1, 1), line(2, 'SKU-2', 2, 2), line(3, 'SKU-3', 1, 3), line(4, 'SKU-4', 1, 4),
    line(5, 'SKU-5', 1, 5), line(6, 'SKU-6', 1, 6), line(7, 'SKU-7', 1, 7), line(8, 'MGMYM', 1, 8),
  ], 237162)
  const current = version(92714, [
    line(1, 'SKU-1', 1, 1), line(2, 'SKU-2', 2, 2), line(3, 'SKU-3', 1, 3), line(4, 'SKU-4', 1, 4),
    line(5, 'SKU-5', 1, 5), line(6, 'SKU-6', 1, 6), line(7, 'SKU-7', 1, 7), line(9, 'MUESTRA', 1, 8), line(10, 'PW12401', 1, 9),
  ], 254055)
  const result = compareCommercialVersions(previous, current)
  assert.equal(result.sameIdentity, true)
  assert.equal(result.differences.filter(item => item.kind === 'ADDED').length, 2)
  assert.equal(result.differences.filter(item => item.kind === 'REMOVED').length, 1)
  assert.deepEqual(result.differences.filter(item => item.kind === 'ADDED').map(item => item.current?.sku).sort(), ['MUESTRA', 'PW12401'])
  assert.deepEqual(result.differences.filter(item => item.kind === 'REMOVED').map(item => item.previous?.sku), ['MGMYM'])
  assert.equal(result.differences.filter(item => item.kind.startsWith('QUANTITY_')).length, 0)
  assert.equal(result.totals.totalDelta, 16893)
})

test('IDs físicos distintos con contenido idéntico no producen alerta comercial', () => {
  const previous = version(92706, [line(1, 'A', 2, 1)], 2000)
  const current = version(92714, [line(1, 'A', 2, 1)], 2000)
  const result = compareCommercialVersions(previous, current)
  assert.equal(result.contentEquivalent, true)
  assert.deepEqual(result.differences, [])
})

test('detecta agregado, eliminado, aumento, disminución y precio', () => {
  const previous = version(1, [line(1, 'A', 1, 1), line(2, 'B', 4, 2), line(3, 'C', 2, 3)], 0)
  const current = version(2, [line(1, 'A', 3, 1, { unitNetValue: 2000, lineNetAmount: 6000 }), line(2, 'B', 1, 2), line(4, 'D', 1, 4)], 0)
  const result = compareCommercialVersions(previous, current)
  assert.equal(result.differences.some(item => item.kind === 'QUANTITY_INCREASED' && item.current?.sku === 'A'), true)
  assert.equal(result.differences.some(item => item.kind === 'QUANTITY_DECREASED' && item.current?.sku === 'B'), true)
  assert.equal(result.differences.some(item => item.kind === 'VALUE_CHANGED' && item.current?.sku === 'A'), true)
  assert.equal(result.differences.some(item => item.kind === 'ADDED' && item.current?.sku === 'D'), true)
  assert.equal(result.differences.some(item => item.kind === 'REMOVED' && item.previous?.sku === 'C'), true)
})

test('variantes repetidas se emparejan por lineNumber', () => {
  const previous = version(1, [line(10, 'A', 1, 1), line(10, 'A', 2, 2)], 0)
  const current = version(2, [line(10, 'A', 4, 2), line(10, 'A', 1, 1)], 0)
  const result = compareCommercialVersions(previous, current)
  assert.equal(result.conflicts.length, 0)
  assert.equal(result.differences.filter(item => item.kind === 'QUANTITY_INCREASED').length, 1)
})

test('líneas sin variante se emparejan por contenido y las ambiguas generan conflicto', () => {
  const exact = compareCommercialVersions(version(1, [{ quantity: 1, productName: 'Especial', lineNumber: 1 }]), version(2, [{ quantity: 1, productName: 'Especial', lineNumber: 1 }]))
  assert.equal(exact.conflicts.length, 0)
  const ambiguous = compareCommercialVersions(version(1, [{ quantity: 1, productName: 'Especial' }, { quantity: 2, productName: 'Especial' }]), version(2, [{ quantity: 3, productName: 'Especial' }]))
  assert.equal(ambiguous.conflicts.length, 1)
  assert.equal(ambiguous.conflicts[0].reason, 'AMBIGUOUS_SPECIAL_LINE')
})

test('cambio exclusivamente de precio se clasifica como VALUE_CHANGED', () => {
  const result = compareCommercialVersions(version(1, [line(1, 'A', 1, 1, { unitNetValue: 1000, lineNetAmount: 1000 })]), version(2, [line(1, 'A', 1, 1, { unitNetValue: 1200, lineNetAmount: 1200 })]))
  assert.deepEqual(result.differences.map(item => item.kind), ['VALUE_CHANGED'])
})

test('cambio de nombre descriptivo no altera una línea identificada por variante', () => {
  const result = compareCommercialVersions(
    version(1, [{ variantId: 10, sku: 'A', productName: 'Nombre anterior', quantity: 1 }]),
    version(2, [{ variantId: 10, sku: 'A', productName: 'Nombre del catálogo actual', quantity: 1 }]),
  )
  assert.equal(result.contentEquivalent, true)
  assert.deepEqual(result.differences, [])
})

test('aceptación seguida de una nueva detección conserva agregados camelCase y devuelve UNCHANGED', () => {
  const acceptedLines = [
    preparationCommercialLineFromSnapshot({ detailId: 335939, variantId: 5729, sku: 'MUESTRA', productName: 'SURTIDOS MUESTRAS', quantity: 1, lineNetAmount: 1, lineGrossAmount: 1 }),
    preparationCommercialLineFromSnapshot({ detailId: 335940, variantId: 3184, sku: 'PW12401', productName: 'PAWISE 3 EN 1 CAMA/MANTA/COJIN AZUL', quantity: 1, lineNetAmount: 14196, lineGrossAmount: 16893 }),
  ]
  const accepted = version(92714, acceptedLines, 16894)
  const current = version(92714, [
    { ...acceptedLines[0], productName: 'MUESTRAS' },
    { ...acceptedLines[1], productName: 'AZUL' },
  ], 16894)

  const result = compareCommercialVersions(accepted, current)
  assert.equal(result.contentEquivalent, true)
  assert.deepEqual(result.differences, [])
  assert.equal(result.conflicts.length, 0)
})

test('una cantidad posterior genuina sigue produciendo CHANGED después de la aceptación', () => {
  const accepted = version(92714, [
    preparationCommercialLineFromSnapshot({ detailId: 335939, variantId: 5729, sku: 'MUESTRA', productName: 'SURTIDOS MUESTRAS', quantity: 1 }),
  ])
  const current = version(92714, [
    preparationCommercialLineFromSnapshot({ detailId: 335939, variantId: 5729, sku: 'MUESTRA', productName: 'SURTIDOS MUESTRAS', quantity: 2 }),
  ])

  const result = compareCommercialVersions(accepted, current)
  assert.equal(result.contentEquivalent, false)
  assert.equal(result.differences.some(item => item.kind === 'QUANTITY_INCREASED'), true)
})

test('declara sustitución solo cuando existe un único emparejamiento posicional seguro', () => {
  const result = compareCommercialVersions(version(1, [line(1, 'A', 1, 1)]), version(2, [line(2, 'B', 1, 1)]))
  assert.deepEqual(result.differences.map(item => item.kind), ['SUBSTITUTION'])
})

test('resultado y fingerprint son deterministas respecto del orden de lectura', () => {
  const first = version(1, [line(2, 'B', 1, 2), line(1, 'A', 1, 1)], 2000)
  const second = version(2, [line(1, 'A', 1, 1), line(2, 'B', 1, 2)], 2000)
  assert.equal(fingerprintCommercialVersion(first).value, fingerprintCommercialVersion(second).value)
  const one = compareCommercialVersions(first, second)
  const two = compareCommercialVersions(first, second)
  assert.deepEqual(one, two)
})

test('identidad canónica distinta no se compara como la misma NV', () => {
  const current = version(2, [line(1, 'A', 1, 1)], 0, { identity: { ...identity(1, 2), canonicalToken: 'other-token' } })
  const result = compareCommercialVersions(version(1, [line(1, 'A', 1, 1)], 0), current)
  assert.equal(result.sameIdentity, false)
  assert.equal(result.conflicts[0].reason, 'IDENTITY_MISMATCH')
})

test('primera preparación: lineNumber ausente frente a lineNumber 0 no produce alerta comercial', () => {
  const original = version(92674, [
    { variantId: 5873, sku: 'SKU-A', productName: 'Producto A', quantity: 24, unitNetValue: 1134, lineNetAmount: 27227, lineTaxAmount: 5173, lineGrossAmount: 32400 },
    { variantId: 6246, sku: 'SKU-B', productName: 'Producto B', quantity: 18, unitNetValue: 2882, lineNetAmount: 51882, lineTaxAmount: 9858, lineGrossAmount: 61740 },
  ], 94140, { netAmount: 79109, taxAmount: 15031 })
  const current = version(92674, original.lines.map(item => ({ ...item, lineNumber: 0 })), 94140, { netAmount: 79109, taxAmount: 15031 })
  const result = compareCommercialVersions(original, current)
  assert.equal(result.contentEquivalent, true)
  assert.deepEqual(result.differences, [])

  const actualChange = version(92674, current.lines.map((item, index) =>
    index === 0 ? { ...item, quantity: 25 } : item
  ), 94140, { netAmount: 79109, taxAmount: 15031 })
  const changed = compareCommercialVersions(original, actualChange)
  assert.equal(changed.contentEquivalent, false)
  assert.equal(changed.differences.some(item => item.kind === 'QUANTITY_INCREASED'), true)
})
