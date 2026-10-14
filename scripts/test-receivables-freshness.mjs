import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { formatReceivablesSnapshotAt, getReceivablesFreshness } from '../src/lib/control-financiero/receivables-freshness.ts'

const require = createRequire(import.meta.url)
const noticeSource = readFileSync(new URL('../src/modules/analisis-comercial/components/cobranza-freshness-notice.tsx', import.meta.url), 'utf8')
const noticeCompiled = ts.transpileModule(noticeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText
const noticeModule = {}
new Function('require', 'exports', noticeCompiled)(name => {
  if (name === '@/lib/control-financiero/receivables-freshness') return { }
  return require(name)
}, noticeModule)
const { CobranzaFreshnessNotice } = noticeModule

const now = new Date('2026-10-14T13:00:00Z')

test('snapshot de 20 minutos queda FRESH', () => {
  assert.deepEqual(getReceivablesFreshness('2026-10-14T12:40:00Z', now), { status: 'FRESH', ageMinutes: 20 })
})

test('snapshot de 2 horas queda FRESH', () => {
  assert.deepEqual(getReceivablesFreshness('2026-10-14T11:00:00Z', now), { status: 'FRESH', ageMinutes: 120 })
})

test('snapshot de 4 horas queda STALE', () => {
  assert.deepEqual(getReceivablesFreshness('2026-10-14T09:00:00Z', now), { status: 'STALE', ageMinutes: 240 })
})

test('sin snapshot queda sin información vigente', () => {
  assert.deepEqual(getReceivablesFreshness(null, now), { status: 'NO_DATA', ageMinutes: null })
  assert.deepEqual(getReceivablesFreshness('not-a-date', now), { status: 'NO_DATA', ageMinutes: null })
})

test('la fecha visible usa hora de Santiago', () => {
  assert.equal(formatReceivablesSnapshotAt('2026-10-14T13:38:24Z'), '14-10-2026 10:38')
})

test('la consulta canónica usa el último COMPLETED y no un FAILED posterior', () => {
  const source = readFileSync(new URL('../services/finance-api/app/financial/receivables.py', import.meta.url), 'utf8')
  assert.match(source, /r\.status = 'COMPLETED'/)
  assert.match(source, /ORDER BY r\.snapshot_at DESC/)
  assert.match(source, /LIMIT 1/)
})

test('render FRESH muestra fecha de actualización', () => {
  const html = renderToStaticMarkup(createElement(CobranzaFreshnessNotice, { status: 'FRESH', snapshotLabel: '14-10-2026 10:38' }))
  assert.match(html, /Datos de deuda actualizados al/)
  assert.match(html, /14-10-2026 10:38/)
  assert.doesNotMatch(html, /desactualizados/)
})

test('render STALE muestra alerta y fecha', () => {
  const html = renderToStaticMarkup(createElement(CobranzaFreshnessNotice, { status: 'STALE', snapshotLabel: '08-10-2026 08:34' }))
  assert.match(html, /Datos de deuda desactualizados/)
  assert.match(html, /Última actualización: 08-10-2026 08:34/)
  assert.match(html, /no representar la posición vigente en BSale/)
})
