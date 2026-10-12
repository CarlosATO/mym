import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { todayInSantiago } from '../src/lib/datetime.ts'
import * as metrics from '../src/lib/control-financiero/receivables-metrics.ts'
import * as analysisCache from '../src/lib/control-financiero/receivables-analysis-cache.ts'
import { buildCurrentCobranzaPosition } from '../src/lib/control-financiero/current-cobranza-position.ts'

const require = createRequire(import.meta.url)
const sectionSource = readFileSync(new URL('../src/app/dashboard/analisis-comercial/control-financiero/receivables-drilldown.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(sectionSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
const component = {}
new Function('require', 'exports', compiled)(name => {
  if (name === '@/components/ui/sheet') return { Sheet: () => null }
  if (name === '@/lib/control-financiero/receivables-metrics') return metrics
  if (name === '@/lib/control-financiero/receivables-analysis-cache') return analysisCache
  return require(name)
}, component)

const monthly = Array.from({ length: 12 }, (_, index) => ({ month: index + 1, receivable_amount: String(10000000 + index * 1000), overdue_amount: String(5000000 - index * 1000) }))
const current = { allPortfolio: { receivableAmount: 43140174 }, defaultScope: { overdueAmount: 19580345, receivableAmount: 99999999 }, activeDocumentCount: 123, visibleDocumentCount: 64, clientsUnqueryable: 2, asOfDate: '2026-10-10' }
function renderPosition(today = '2026-10-10', year = 2026, months = monthly) {
  return renderToStaticMarkup(createElement(component.ReceivablesSection, { data: { company_id: 'test', months }, current, currentAnalysis: null, year, today }))
}
function historicalCells(html) {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].slice(1).map(row => [...row[1].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map(cell => cell[1]))
}

test('current collection position uses the same snapshot, confirmed overlay and default overdue-client KPI rules', () => {
  const document = (id, client, amount, overdue) => ({ document_id: id, client_id: client, pending_amount: String(amount), overdue, expiration_date: overdue ? '2026-10-01' : '2026-10-20' })
  const snapshot = { close_date: '2026-10-08', snapshot_date: '2026-10-08', snapshot_at: '2026-10-08T11:30:00Z', receivables_source: 'BSALE_UNPAID_DOCUMENTS_SNAPSHOT', summary: { pending_documents: 4 }, documents: [document(1, 10, 100, true), document(2, 10, 70, false), document(3, 20, 90, false), document(4, 30, 30, true)] }
  const position = buildCurrentCobranzaPosition(snapshot, [{ documentId: 1, pendingAmount: 40 }, { documentId: 4, pendingAmount: 0 }])
  assert.deepEqual(position.defaultScope, { receivableAmount: 110, overdueAmount: 40, clientCount: 1 })
  assert.deepEqual(position.allPortfolio, { receivableAmount: 200, overdueAmount: 40, clientCount: 2 })
  assert.equal(position.snapshotDocumentCount, 4)
  assert.equal(position.activeDocumentCount, 3)
  assert.equal(position.visibleDocumentCount, 2)
  assert.equal(position.documents.length, 2)
  assert.equal(position.asOfDate, '2026-10-08')
  assert.equal(snapshot.documents[0].pending_amount, '100')
})

test('EERR reads period-0 Cobranza and its same confirmed overlay; historical columns stay financial', () => {
  const page = readFileSync(new URL('../src/app/dashboard/analisis-comercial/control-financiero/estado-resultados/page.tsx', import.meta.url), 'utf8')
  const collection = readFileSync(new URL('../src/modules/analisis-comercial/views/cobranza.tsx', import.meta.url), 'utf8')
  const excel = readFileSync(new URL('../src/app/dashboard/analisis-comercial/control-financiero/estado-resultados-excel.tsx', import.meta.url), 'utf8')
  const section = readFileSync(new URL('../src/app/dashboard/analisis-comercial/control-financiero/receivables-drilldown.tsx', import.meta.url), 'utf8')
  assert.match(page, /getFinanceReceivablesAnalysis\(2026, 0\)/)
  assert.match(page, /getCollectionPaymentOverlay\(/)
  assert.match(page, /buildCurrentCobranzaPosition\(collectionAnalysis, collectionOverlay\)/)
  assert.match(collection, /getCollectionPaymentOverlay\(/)
  assert.match(collection, /applyCobranzaPaymentOverlay\(data\.documents, paymentOverlay\)/)
  assert.match(collection, /scope === 'all' \|\| client\.overdueAmount > 0/)
  assert.match(page, /getFinanceReceivables\(2026\)/)
   assert.match(excel, /input\.currentCollection\?\.allPortfolio\.receivableAmount/)
   for (const label of ['Cartera vigente total', 'Monto vencido', 'Documentos', 'Fecha de corte']) {
    assert.ok(excel.includes(label), `Excel: ${label}`)
  }
  for (const label of ['Cartera vigente total', 'Monto vencido', 'Documentos vigentes', 'Vista priorizada']) assert.ok(section.includes(label), `EERR UI: ${label}`)
  assert.doesNotMatch(section, /Cartera de clientes con deuda vencida/)
  assert.match(page, /today=\{today\}/)
  assert.match(page, /const today = todayInSantiago\(\)/)
   assert.doesNotMatch(excel, /input\.receivables!\.months\.find/)
   assert.doesNotMatch(excel, /input\.receivables\.actual\.receivable_amount/)
})

test('Cobranza shows three KPIs followed by always-visible monthly closings', () => {
  const section = readFileSync(new URL('../src/app/dashboard/analisis-comercial/control-financiero/receivables-drilldown.tsx', import.meta.url), 'utf8')
  const summary = section.indexOf('aria-label="Indicadores actuales de cobranza"')
  const history = section.indexOf('aria-label="Evolución de cierres mensuales"', summary)
  const table = section.indexOf('<table ', history)
  assert.ok(summary > 0 && history > summary && table > history)
  assert.doesNotMatch(section, /<details|<summary|Ver evolución histórica/)
  for (const label of ['Cartera vigente total', 'Monto vencido', 'Documentos vigentes']) assert.ok(section.slice(summary, history).includes(label))
  assert.match(section, /Vista priorizada: \{current\?\.visibleDocumentCount/)
  assert.match(section, /Evolución de cierres mensuales/)
  for (const label of ['CxC pendientes al cierre', 'CxC vencidas al cierre']) assert.ok(section.slice(history).includes(label))
  assert.match(section, /Evolución cartera vencida vs mes anterior/)
  assert.match(section.slice(history), /<EvolutionRow values=\{overdueEvolution\}/)
  assert.match(section, /closedMonths\.map\(item => item\.receivable_amount\)/)
})

test('rendered EERR contains exactly three canonical KPIs and the prioritized count', () => {
  const html = renderPosition()
  const kpis = html.match(/aria-label="Indicadores actuales de cobranza">[\s\S]*?<\/strong><\/div><\/div>/)[0]
  assert.equal([...kpis.matchAll(/<strong /g)].length, 3)
  for (const value of ['Cartera vigente total', '$43.140.174', 'Monto vencido', '$19.580.345', 'Documentos vigentes', '>123</strong>']) assert.ok(kpis.includes(value), value)
  assert.doesNotMatch(html, /Cartera de clientes con deuda vencida|99\.999\.999/)
  assert.match(html, /Vista priorizada: 64 documentos/)
  assert.match(html, /2 clientes no consultables/)
})

test('October open: January–September remain real; October–December and their evolution are unavailable', () => {
  const before = JSON.stringify(monthly)
  const rows = historicalCells(renderPosition())
  assert.equal(rows.length, 3)
  assert.ok(rows.every(row => row.length === 12))
  assert.equal(rows[0][8], '$10.008.000')
  assert.equal(rows[1][8], '$4.992.000')
  assert.notEqual(rows[2][8], '—')
  for (const row of rows) assert.deepEqual(row.slice(9), ['—', '—', '—'])
  assert.equal(JSON.stringify(monthly), before)
})

test('calendar cutoff rolls forward and handles January, past years and future years', () => {
  assert.equal(historicalCells(renderPosition('2026-11-01'))[0][9], '$10.009.000')
  assert.ok(historicalCells(renderPosition('2026-01-15')).flat().every(value => value === '—'))
  assert.ok(historicalCells(renderPosition('2026-10-10', 2027)).flat().every(value => value === '—'))
  assert.equal(historicalCells(renderPosition('2026-10-10', 2025))[0][11], '$10.011.000')
  const sparse = historicalCells(renderPosition('2026-10-10', 2026, [monthly[8]]))
  assert.equal(sparse[0][8], '$10.008.000')
  assert.equal(sparse[2][8], '—')
})

test('month boundary follows Santiago rather than UTC', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-01T02:30:00Z') })
  assert.equal(todayInSantiago(), '2026-10-31')
  assert.equal(historicalCells(renderPosition(todayInSantiago()))[0][9], '—')
  t.mock.timers.tick(60 * 60 * 1000)
  assert.equal(todayInSantiago(), '2026-11-01')
  assert.equal(historicalCells(renderPosition(todayInSantiago()))[0][9], '$10.009.000')
})
