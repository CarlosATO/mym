import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/modules/adquisiciones/ordenes-compra/replenishment-derive.ts', import.meta.url), 'utf8')

function calculateSuggestedQty({ unitsSoldWithStock, daysWithStock, salesRateWithStock, physicalStock, coverageWeeks }) {
  if (unitsSoldWithStock < 3 || daysWithStock < 3) {
    return { calculable: false, quantity: null, reason: 'Información insuficiente — requiere análisis manual' }
  }
  const targetDays = coverageWeeks * 7
  const targetUnits = salesRateWithStock * targetDays
  return {
    calculable: true,
    quantity: Math.max(0, Math.ceil(targetUnits - physicalStock)),
    targetDays,
    targetUnits,
  }
}

test('la regla de evidencia mínima está centralizada en el derivador', () => {
  assert.match(source, /MIN_UNITS_SOLD_WITH_STOCK = 3/)
  assert.match(source, /MIN_DAYS_WITH_STOCK = 3/)
  assert.match(source, /unitsSoldWithStock: breakSummary\.unitsSoldWithStock/)
  assert.match(source, /daysWithStock: breakSummary\.daysWithStock/)
})

test('casos A-C quedan para revisión manual', () => {
  for (const evidence of [
    { unitsSoldWithStock: 1, daysWithStock: 1 },
    { unitsSoldWithStock: 3, daysWithStock: 1 },
    { unitsSoldWithStock: 1, daysWithStock: 10 },
  ]) {
    const result = calculateSuggestedQty({ ...evidence, salesRateWithStock: 1, physicalStock: 0, coverageWeeks: 2 })
    assert.equal(result.calculable, false)
    assert.equal(result.quantity, null)
    assert.equal(result.reason, 'Información insuficiente — requiere análisis manual')
  }
})

test('casos D-E mantienen la fórmula y distinguen cantidad cero válida', () => {
  const sufficient = calculateSuggestedQty({
    unitsSoldWithStock: 3,
    daysWithStock: 3,
    salesRateWithStock: 1,
    physicalStock: 0,
    coverageWeeks: 2,
  })
  assert.equal(sufficient.calculable, true)
  assert.equal(sufficient.quantity, 14)

  const covered = calculateSuggestedQty({
    unitsSoldWithStock: 3,
    daysWithStock: 3,
    salesRateWithStock: 1,
    physicalStock: 14,
    coverageWeeks: 2,
  })
  assert.equal(covered.calculable, true)
  assert.equal(covered.quantity, 0)
})
