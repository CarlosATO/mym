import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const report = await readFile(new URL('../src/modules/logistica/mermas/mermas-report.tsx', import.meta.url), 'utf8')
const action = await readFile(new URL('../src/app/actions/logistica/mermas.ts', import.meta.url), 'utf8')

test('report keeps a compact executive structure', () => {
  assert.match(report, /min-h-\[calc\(100vh-7\.5rem\)\].*p-2 sm:p-3/)
  assert.match(report, /title="Merma mensual"/)
  assert.match(report, /Merma bruta/)
  assert.match(report, /Reintegrado/)
  assert.match(report, /Merma neta/)
})

test('report exposes internal merma sales separately from Bsale recoveries', () => {
  assert.match(report, /Venta de merma/)
  assert.match(report, /Recuperado por venta/)
  assert.match(report, /Venta interna/)
  assert.match(report, /Reintegrado Bsale/)
  assert.doesNotMatch(report, /title="Comercialización de merma"/)
})

test('analytics enriches the existing contract from internal sales without changing Bsale analytics', () => {
  assert.match(action, /from\("internal_sales"\)/)
  assert.match(action, /from\("internal_sale_lines"\)/)
  assert.match(action, /neq\("status", "REVERSED"\)/)
  assert.match(action, /sales\.recovered_value = sales\.total_value/)
  assert.match(action, /sales,/)
})
