import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/components/layout/app-topbar.tsx', import.meta.url), 'utf8')

test('Mermas routes use the executive financial topbar theme', () => {
  assert.match(source, /const isMermasSurface = pathname\.startsWith\('\/dashboard\/logistica\/mermas'\)/)
  assert.match(source, /const usesExecutiveTheme = isAnalysisCommercialSurface \|\| isAdquisicionesSurface \|\| isMermasSurface/)
  assert.match(source, /usesExecutiveTheme \? 'border-\[#D1C7BD\] bg-\[#EFE9E1\]\/95'/)
})

test('Mermas route name takes precedence over normal WMS', () => {
  const mermasIndex = source.indexOf("{ prefix: '/dashboard/logistica/mermas', name: 'Mermas' }")
  const wmsIndex = source.indexOf("{ prefix: '/dashboard/logistica',        name: 'WMS · Logística' }")
  assert.ok(mermasIndex >= 0)
  assert.ok(wmsIndex > mermasIndex)
})

test('normal WMS is not included in the financial surface predicate', () => {
  assert.doesNotMatch(source, /pathname\.startsWith\('\/dashboard\/logistica'\)\s*\n\s*const usesExecutiveTheme/)
  assert.match(source, /'WMS · Logística'/)
})
