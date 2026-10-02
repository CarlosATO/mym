import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const report = await readFile(new URL('../src/modules/logistica/mermas/mermas-report.tsx', import.meta.url), 'utf8')
const analytics = await readFile(new URL('../src/lib/integraciones/mermas-analytics.ts', import.meta.url), 'utf8')
const action = await readFile(new URL('../src/app/actions/logistica/mermas.ts', import.meta.url), 'utf8')

test('UI-5 uses a fixed compact 180-day period without manual date inputs', () => {
  assert.match(report, /Últimos 180 días/)
  assert.match(report, /useMemo\(\(\) => defaultFrom\(\), \[\]\)/)
  assert.doesNotMatch(report, /type="date"/)
})

test('monthly management chart is driven by net monthly cost and units', () => {
  assert.match(report, /title="Merma mensual"/)
  assert.match(report, /Math\.abs\(row\.net_cost\)/)
  assert.match(report, /formatSignedMoney\(row\.net_cost\)/)
  assert.match(report, /formatNumber\(row\.net_units\)/)
})

test('impact table includes product behavior and opens on double click', () => {
  for (const label of ['Nº ingresos', 'Unidades mermadas', 'Costo neto', 'Venta (u.)', 'Venta ($)', 'Prom. días', 'Último ingreso', '% impacto']) {
    assert.ok(report.includes(label), `missing column: ${label}`)
  }
  assert.match(report, /onDoubleClick=\{\(\) => onSelectProduct\(row\)\}/)
  assert.match(report, /Comportamiento del producto/)
  assert.match(report, /Ingresos a merma/)
  assert.match(report, /Ventas desde merma/)
  assert.match(report, /Reintegros Bsale/)
})

test('existing analytics query exposes product income and return events', () => {
  assert.match(analytics, /entries: Array<\{ date: string; units: number; cost: number \}>/)
  assert.match(analytics, /returns: Array<\{ date: string; units: number; value: number \}>/)
  assert.match(action, /internal_sale_lines/)
  assert.match(action, /entries: Array<\{ date: string; units: number; value: number \}>/)
})
