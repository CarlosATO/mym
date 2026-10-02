import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const report = await readFile(new URL('../src/modules/logistica/mermas/mermas-report.tsx', import.meta.url), 'utf8')

test('UI-6 removes redundant header and executive equation content', () => {
  assert.doesNotMatch(report, /Mermas · Reportes/)
  assert.doesNotMatch(report, /Impacto económico, recuperación y productos con mayor pérdida\./)
  assert.doesNotMatch(report, /ExecutiveEquation/)
  assert.match(report, /min-h-12 flex-wrap items-center/)
})

test('UI-6 keeps five compact executive metrics and secondary Bsale detail', () => {
  assert.match(report, /CompactMetric label="Merma neta"/)
  assert.match(report, /CompactMetric label="Merma bruta"/)
  assert.match(report, /CompactMetric label="Venta de merma"/)
  assert.match(report, /CompactMetric label="Productos afectados"/)
  assert.match(report, /CompactMetric label="Recuperado por venta"/)
  assert.match(report, /Reintegro Bsale:/)
})

test('UI-6 keeps only the compact monthly bar chart, without redundant monthly table', () => {
  assert.match(report, /title="Merma mensual"/)
  assert.match(report, /Math\.abs\(row\.net_cost\)/)
  assert.doesNotMatch(report, /key=\{`table-\$\{row\.month\}`\}/)
  assert.doesNotMatch(report, /<th[^>]*>Merma bruta<\/th>/)
})
