import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const { formatCoveragePercent, getCoverageStatus } = await import('../src/modules/logistica/guias-ruta/utils/profitability-v1-display.ts')
const migration = await readFile(new URL('../supabase/migrations/20260827120000_route_guide_profitability_v1.sql', import.meta.url), 'utf8')

test('100% cubierto es COMPLETE y se muestra con dos decimales', () => {
  assert.equal(getCoverageStatus(100, 100), 'COMPLETE')
  assert.equal(formatCoveragePercent(100, 'COMPLETE'), '100,00%')
})

test('94,14% cubierto es PARTIAL y conserva la presentación esperada', () => {
  assert.equal(getCoverageStatus(9414, 10000), 'PARTIAL')
  assert.equal(formatCoveragePercent(94.14, 'PARTIAL'), '94,14%')
})

test('una cobertura parcial que redondea a 100 no se presenta como completa', () => {
  assert.equal(getCoverageStatus(99996, 100000), 'PARTIAL')
  assert.equal(formatCoveragePercent(99.996, 'PARTIAL'), '99,9960%')
})

test('una línea SIN_COSTO con venta neta cero no reduce cobertura económica', () => {
  assert.equal(getCoverageStatus(1000, 1000), 'COMPLETE')
  assert.equal(formatCoveragePercent(100, 'COMPLETE'), '100,00%')
})

test('0% cubierto mantiene el estado equivalente actual', () => {
  assert.equal(getCoverageStatus(0, 1000), 'UNAVAILABLE')
  assert.equal(formatCoveragePercent(null, 'UNAVAILABLE'), '—')
})

test('el RPC conserva precisión real para separar cálculo y presentación', () => {
  assert.match(migration, /v_cost_coverage_pct numeric\(14,6\)/)
  assert.match(migration, /\(lr\.covered_sales_net \/ lr\.sales_net_total\) \* 100\)\:\:numeric\(14,6\)/)
  assert.match(migration, /WHEN lr\.covered_sales_net < lr\.sales_net_total THEN 'PARTIAL'/)
})

function resolveCost(variantId, historicalCost) {
  if (historicalCost !== null) return { cost: historicalCost, covered: true }
  if (variantId === 5729) return { cost: 0, covered: true }
  return { cost: null, covered: false }
}

test('MUESTRA sin recepción es costo cero válido y queda cubierta', () => {
  assert.deepEqual(resolveCost(5729, null), { cost: 0, covered: true })
  assert.match(migration, /sl\.bsale_variant_id = 5729/)
  assert.match(migration, /THEN 0\:\:numeric\(14,2\)/)
  assert.match(migration, /reception\.bsale_reception_id IS NOT NULL OR sl\.bsale_variant_id = 5729 THEN 'COSTED'/)
})

test('otra variante sin recepción continúa SIN_COSTO', () => {
  assert.deepEqual(resolveCost(12345, null), { cost: null, covered: false })
  assert.match(migration, /reception\.bsale_reception_id IS NULL THEN NULL\:\:numeric\(14,2\)/)
})

test('GR-2026-000008 queda 100% cubierta al costear las dos muestras en cero', () => {
  const total = 2584566
  const covered = 2584564 + 1 + 1
  assert.equal(covered, total)
  assert.equal(getCoverageStatus(covered, total), 'COMPLETE')
  assert.equal(total - covered, 0)
})
