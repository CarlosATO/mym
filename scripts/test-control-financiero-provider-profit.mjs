import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { applyProviderProfit, providerProfitabilityLoadState } from '../src/lib/control-financiero/provider-profit.ts'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')
}

function loadTsx(relativePath, overrides = {}) {
  const source = read(relativePath)
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  new Function('require', 'exports', 'module', compiled)(key => overrides[key] ?? require(key), exports, { exports })
  return exports
}

const group = (overrides) => ({
  group_key: 'brand:1',
  group_name: 'PROVEEDOR A',
  months: { '1': '1000', '2': '0' },
  ytd: '1000',
  line_count: 2,
  children: [],
  ...overrides,
})

test('utilidad = ventas - COGS del mismo proveedor y porcentaje propio', () => {
  const result = applyProviderProfit([group({})], [{ provider_key: 'brand:1', provider_name: 'PROVEEDOR A', gross_cogs_ytd: '900', credit_note_reversal_ytd: '50', net_cogs_ytd: '850' }], [])
  assert.equal(result[0].cogsYtd, '850')
  assert.equal(result[0].profitYtd, '150')
  assert.equal(result[0].profitPercentageYtd, 15)
})

test('proveedor sin COGS resuelto mantiene utilidad null para no fabricar margen', () => {
  const result = applyProviderProfit([group({ group_key: 'brand:2', group_name: 'PROVEEDOR B' })], [], [])
  assert.equal(result[0].cogsYtd, null)
  assert.equal(result[0].profitYtd, null)
  assert.equal(result[0].profitPercentageYtd, null)
})

test('rentabilidad vacía es válida sin ventas y es incompleta con ventas', () => {
  assert.equal(providerProfitabilityLoadState('0', 0, [], []), 'VALID_EMPTY')
  assert.equal(providerProfitabilityLoadState('1000', 1, [], []), 'INCOMPLETE')
  assert.equal(providerProfitabilityLoadState('1000', 1, [{ provider_key: 'brand:1', provider_name: 'A', gross_cogs_ytd: '0', credit_note_reversal_ytd: '0', net_cogs_ytd: '0' }], []), 'INCOMPLETE')
})

test('ventas cero no divide por cero', () => {
  const result = applyProviderProfit([group({ ytd: '0' })], [{ provider_key: 'brand:1', provider_name: 'PROVEEDOR A', gross_cogs_ytd: '0', credit_note_reversal_ytd: '0', net_cogs_ytd: '0' }], [])
  assert.equal(result[0].profitYtd, '0')
  assert.equal(result[0].profitPercentageYtd, null)
})

test('ventas - COGS puede ser utilidad negativa sin romper el porcentaje', () => {
  const result = applyProviderProfit([group({ ytd: '500' })], [{ provider_key: 'brand:1', provider_name: 'PROVEEDOR A', gross_cogs_ytd: '600', credit_note_reversal_ytd: '0', net_cogs_ytd: '600' }], [])
  assert.equal(result[0].profitYtd, '-100')
  assert.equal(result[0].profitPercentageYtd, -20)
})

test('las familias reciben COGS, utilidad y porcentaje con su family_key exacta', () => {
  const child = {
    family_key: 'brand:1|product_type:47',
    family_name: 'ACWS/ALIMENTO',
    detail_name: 'ALIMENTO',
    provider_key: 'brand:1',
    provider_name: 'PROVEEDOR A',
    months: { '1': '1000' },
    ytd: '1000',
    line_count: 1,
  }
  const result = applyProviderProfit(
    [group({ children: [child] })],
    [{ provider_key: 'brand:1', provider_name: 'PROVEEDOR A', gross_cogs_ytd: '900', credit_note_reversal_ytd: '50', net_cogs_ytd: '850' }],
    [{ provider_key: 'brand:1', provider_name: 'PROVEEDOR A', family_key: child.family_key, family_name: child.family_name, gross_cogs_ytd: '700', credit_note_reversal_ytd: '50', net_cogs_ytd: '650' }],
  )
  assert.equal(result[0].children[0].cogsYtd, '650')
  assert.equal(result[0].children[0].profitYtd, '350')
  assert.equal(result[0].children[0].profitPercentageYtd, 35)
})

test('provider COGS usa un retry real y no publica una matriz incompleta', () => {
  const financeApi = read('src/lib/control-financiero/finance-api.ts')
  const page = read('src/app/dashboard/analisis-comercial/control-financiero/estado-resultados/page.tsx')
  const providerStart = financeApi.indexOf('export async function getFinanceProviderCogs')
  const providerEnd = financeApi.indexOf('export async function getFinancePersonnel', providerStart)
  const providerSource = financeApi.slice(providerStart, providerEnd)
  assert.match(providerSource, /for \(let attempt = 0; attempt < 2; attempt \+= 1\)/)
  assert.match(providerSource, /new AbortController\(\)\.signal/)
  assert.equal((providerSource.match(/new AbortController\(\)\.signal/g) ?? []).length, 1)
  assert.match(providerSource, /provider profitability transient failure; retrying once/)
  assert.match(page, /if \(!providerCogsResult\.ok\)/)
  assert.match(page, /providerProfitabilityLoadState\(/)
  assert.match(page, /Rentabilidad no disponible\. Reintenta el módulo/)
})

test('un fallo transitorio de provider COGS ejecuta una segunda request real', async () => {
  const financeApi = read('src/lib/control-financiero/finance-api.ts')
  const compiled = ts.transpileModule(financeApi, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exports = {}
  const module = { exports }
  const calls = []
  const originalFetch = globalThis.fetch
  const originalBaseUrl = process.env.FINANCE_API_BASE_URL
  process.env.FINANCE_API_BASE_URL = 'http://finance.test'
  globalThis.fetch = async (_input, init) => {
    calls.push(init?.signal)
    if (calls.length === 1) return new Response(JSON.stringify({ detail: 'transient' }), { status: 503 })
    return new Response(JSON.stringify({ has_information: true, providers: [], families: [] }), { status: 200 })
  }
  try {
    new Function('require', 'exports', 'module', compiled)(key => {
      if (key === '@/lib/supabase/server') return { createClient: async () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) } }) }
      if (key === '@/app/actions/companies') return { getActiveCompanyId: async () => 'company' }
      return require(key)
    }, exports, module)
    const result = await module.exports.getFinanceProviderCogs(2026)
    assert.equal(result.ok, true)
    assert.equal(calls.length, 2)
    assert.ok(calls[0] instanceof AbortSignal)
    assert.ok(calls[1] instanceof AbortSignal)
    assert.notEqual(calls[0], calls[1])
  } finally {
    globalThis.fetch = originalFetch
    if (originalBaseUrl === undefined) delete process.env.FINANCE_API_BASE_URL
    else process.env.FINANCE_API_BASE_URL = originalBaseUrl
  }
})

test('familia con ventas cero mantiene porcentaje de utilidad nulo', () => {
  const child = { family_key: 'brand:1|product_type:0', family_name: 'Sin clasificar', detail_name: 'Sin clasificar', provider_key: 'brand:1', months: {}, ytd: '0', line_count: 1 }
  const result = applyProviderProfit(
    [group({ children: [child] })],
    [{ provider_key: 'brand:1', provider_name: 'PROVEEDOR A', gross_cogs_ytd: '0', credit_note_reversal_ytd: '0', net_cogs_ytd: '0' }],
    [{ provider_key: 'brand:1', provider_name: 'PROVEEDOR A', family_key: child.family_key, family_name: child.family_name, gross_cogs_ytd: '0', credit_note_reversal_ytd: '0', net_cogs_ytd: '0' }],
  )
  assert.equal(result[0].children[0].profitYtd, '0')
  assert.equal(result[0].children[0].profitPercentageYtd, null)
})

test('la vista SQL reutiliza el motor COGS y no reparte por ventas', () => {
  const migration = read('supabase/migrations/20261010120000_bsale_provider_cogs_monthly_view.sql')
  assert.match(migration, /CREATE OR REPLACE VIEW integraciones\.vw_bsale_provider_cogs_monthly/)
  assert.doesNotMatch(migration, /CREATE TABLE/i)
  assert.match(migration, /bsale_document_costs/)
  assert.match(migration, /status IN \('OBSERVED', 'ZERO_WITH_EVIDENCE'\)/)
  assert.match(migration, /bsale_document_cost_details/)
  assert.match(migration, /bsale_credit_note_cogs_resolution_details/)
  assert.match(migration, /vw_bsale_sales_provider_family_lines/)
  assert.match(migration, /COALESCE\(provider_key, 'unassigned'\)/)
  // No proportional distribution of COGS by sales: the view never reads sales net amounts.
  assert.doesNotMatch(migration, /net_amount/)
  assert.match(migration, /GRANT SELECT ON integraciones\.vw_bsale_provider_cogs_monthly TO petgroup_backend_runtime;/)
  assert.match(migration, /REVOKE ALL ON integraciones\.vw_bsale_provider_cogs_monthly FROM PUBLIC, anon, authenticated;/)
  assert.doesNotMatch(migration, /GRANT .* TO (anon|authenticated|PUBLIC)/i)
  const familyMigration = read('supabase/migrations/20261010130000_bsale_provider_family_cogs_monthly_view.sql')
  assert.match(familyMigration, /vw_bsale_provider_family_cogs_monthly/)
  assert.match(familyMigration, /family_key/)
  assert.match(familyMigration, /bsale_credit_note_cogs_resolution_details/)
  assert.doesNotMatch(familyMigration, /net_amount/)
  assert.match(familyMigration, /REVOKE ALL ON integraciones\.vw_bsale_provider_family_cogs_monthly FROM PUBLIC, anon, authenticated;/)
  assert.match(familyMigration, /GRANT SELECT ON integraciones\.vw_bsale_provider_family_cogs_monthly TO petgroup_backend_runtime;/)
})

test('el EERR separa Ventas y Gastos y ordena UTILIDAD YTD | % VENTAS | % UTILIDAD', () => {
  const matrix = read('src/app/dashboard/analisis-comercial/control-financiero/financial-matrix.tsx')
  assert.match(matrix, /aria-label="Ingresos y ventas"/)
  assert.match(matrix, /aria-label="Gastos y resultados"/)
  assert.match(matrix, /INGRESOS Y VENTAS/)
  assert.match(matrix, /GASTOS Y RESULTADOS/)
  const header = matrix.slice(matrix.indexOf('>YTD</th>'), matrix.indexOf('</tr>', matrix.indexOf('>YTD</th>')))
  const order = ['>YTD</th>', '>Utilidad YTD</th>', '>% Ventas</th>', '>% Utilidad</th>'].map(token => header.indexOf(token))
  assert.ok(order.every(index => index >= 0), 'missing profitability headers')
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'profitability columns are out of order')
})

test('el Excel contiene UTILIDAD YTD y % UTILIDAD con las mismas cifras que la UI', async () => {
  const { buildEstadoResultadosWorkbook } = loadTsx('src/app/dashboard/analisis-comercial/control-financiero/estado-resultados-excel.tsx')
  const row = (label, ytd, percentageYtd, extra = {}) => ({ label, values: Array(12).fill(null), ytd, percentageYtd, missing: Array(12).fill(null), ytdMissing: null, ...extra })
  const input = {
    companyName: 'CAYLO PREMIUM SPA',
    tradeName: 'MYM DISTRIBUIDORA',
    year: 2026,
    coverage: ['Datos 2026'],
    rows: [
      row('Ventas Netas', '1000', 100),
      row('Costo de Ventas', '850', 85),
      row('Margen Bruto', '150', 15),
      row('GASTOS DE PERSONAL', '40', 4, { group: true, children: [] }),
      row('RESULTADO GERENCIAL', '110', 11),
    ],
    groups: [group({
      profitYtd: '150',
      profitPercentageYtd: 15,
      cogsYtd: '850',
      children: [{
        family_key: 'brand:1|product_type:47',
        family_name: 'ACWS/ALIMENTO',
        detail_name: 'ALIMENTO',
        provider_key: 'brand:1',
        provider_name: 'PROVEEDOR A',
        months: { '1': '100' },
        ytd: '100',
        line_count: 1,
        profitYtd: '20',
        profitPercentageYtd: 20,
      }],
    })],
    nonPnl: null,
    currentBalance: 0,
    accountBalances: [],
    receivables: null,
  }
  const workbook = await buildEstadoResultadosWorkbook(input)
  const detail = workbook.getWorksheet('ESTADO DE RESULTADOS')
  assert.equal(detail.columns.length, 17)
  const header = detail.getRows(1, detail.rowCount).find(candidate => candidate.getCell(1).value === 'CONCEPTO')
  assert.deepEqual([14, 15, 16, 17].map(column => header.getCell(column).value), ['YTD', 'UTILIDAD YTD', '% VENTAS', '% UTILIDAD'])
  const providerRow = detail.getRows(6, detail.rowCount - 5).find(candidate => candidate.getCell(1).value === 'PROVEEDOR A')
  assert.ok(providerRow, 'missing provider row')
  assert.equal(providerRow.getCell(14).value, 1000)
  assert.equal(providerRow.getCell(15).value, 150)
  assert.equal(providerRow.getCell(16).value, 1)
  assert.equal(providerRow.getCell(17).value, 0.15)
  const familyRow = detail.getRows(6, detail.rowCount - 5).find(candidate => candidate.getCell(1).value === '  ALIMENTO')
  assert.ok(familyRow, 'missing family row')
  assert.equal(familyRow.getCell(15).value, 20)
  assert.equal(familyRow.getCell(17).value, 0.2)
  const sections = detail.getRows(6, detail.rowCount - 5).map(candidate => candidate.getCell(1).value)
  assert.ok(sections.includes('GASTOS Y RESULTADOS'), 'missing GASTOS Y RESULTADOS section')
  assert.ok(sections.indexOf('INGRESOS Y VENTAS') < sections.indexOf('GASTOS Y RESULTADOS'))
})
