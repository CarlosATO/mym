import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  aggregatePreparationProfitability,
  cachePreparationProfitability,
  formatPreparationProfitabilityPercent,
  getCachedPreparationProfitability,
  getCachedPreparationProfitabilityMap,
  invalidatePreparationProfitabilityCache,
} from '../src/modules/logistica/preparacion-pedidos/preparation-profitability.ts'

const root = new URL('../', import.meta.url)
const migration = await readFile(new URL('supabase/migrations/20261020170000_logistica_preparation_profitability_v1.sql', root), 'utf8')
const guidesMigration = await readFile(new URL('supabase/migrations/20260828120000_route_guide_profitability_batch_v1.sql', root), 'utf8')
const action = await readFile(new URL('src/app/actions/logistica/sales-order-preparation-profitability.ts', root), 'utf8')
const panel = await readFile(new URL('src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx', root), 'utf8')
const helper = await readFile(new URL('src/modules/logistica/preparacion-pedidos/preparation-profitability.ts', root), 'utf8')
const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

function summary(overrides) {
  return {
    bsale_nv_id: 1,
    nv_folio: '1',
    sales_net_total: 1000,
    covered_sales_net: 1000,
    uncovered_sales_net: 0,
    last_purchase_cost_total: 600,
    estimated_gross_profit: 400,
    estimated_margin_pct: 40,
    cost_coverage_pct: 100,
    total_lines: 1,
    covered_lines: 1,
    uncovered_lines: 0,
    cost_status: 'COMPLETE',
    ...overrides,
  }
}

test('1. una sola llamada batch y ninguna llamada por tarjeta', () => {
  assert.match(panel, /getSalesOrderPreparationProfitabilitySummaryV1\(\{ companyId, nvIds: missing \}\)/)
  assert.equal((panel.match(/getSalesOrderPreparationProfitabilitySummaryV1\(/g) ?? []).length, 1)
  assert.match(action, /\.rpc\('get_sales_order_preparation_profitability_summary_v1'/)
  assert.equal((action.match(/\.rpc\(/g) ?? []).length, 1)
})

test('2. el board se renderiza antes de rentabilidad', () => {
  assert.match(panel, /useState\(true\)[\s\S]*?getSalesOrderPreparationProfitabilitySummaryV1/)
  assert.match(panel, /getSalesOrderPreparationProfitabilitySummaryV1\(\{ companyId, nvIds: missing \}\)[\s\S]*?\.then\(/)
  assert.doesNotMatch(panel, /await getSalesOrderPreparationProfitabilitySummaryV1/)
})

test('3. loading de utilidad, margen y cobertura usa —', () => {
  assert.match(panel, /const profitabilityUtilityLabel = profitabilitySummary[\s\S]*?: '—'/)
  assert.match(panel, /const profitabilityMarginLabel = profitabilitySummary[\s\S]*?: '—'/)
  assert.match(panel, /profitabilityError[\s\S]*?'No disponible'[\s\S]*?: '—'/)
})

test('4. COMPLETE calcula utilidad y margen ponderado', () => {
  const result = aggregatePreparationProfitability(
    [{ nv_bsale_id: 1 }],
    { '1': summary({}) },
  )
  assert.ok(result)
  assert.equal(result.costStatus, 'COMPLETE')
  assert.equal(result.estimatedGrossProfit, 400)
  assert.equal(result.estimatedMarginPct, 40)
  assert.equal(result.costCoveragePct, 100)
})

test('5. PARTIAL usa sólo venta cubierta y cobertura agregada', () => {
  const result = aggregatePreparationProfitability(
    [{ nv_bsale_id: 1 }, { nv_bsale_id: 2 }],
    {
      '1': summary({ bsale_nv_id: 1 }),
      '2': summary({
        bsale_nv_id: 2,
        sales_net_total: 500,
        covered_sales_net: 0,
        uncovered_sales_net: 500,
        last_purchase_cost_total: 0,
        estimated_gross_profit: 0,
        estimated_margin_pct: null,
        cost_coverage_pct: 0,
        covered_lines: 0,
        uncovered_lines: 1,
        cost_status: 'UNAVAILABLE',
      }),
    },
  )
  assert.ok(result)
  assert.equal(result.salesNetTotal, 1500)
  assert.equal(result.coveredSalesNet, 1000)
  assert.equal(result.estimatedGrossProfit, 400)
  assert.equal(result.estimatedMarginPct, 40)
  assert.ok(Math.abs((result.costCoveragePct ?? 0) - (200 / 3)) < 1e-9)
  assert.equal(result.costStatus, 'PARTIAL')
})

test('6. UNAVAILABLE no falsea utilidad', () => {
  const result = aggregatePreparationProfitability(
    [{ nv_bsale_id: 1 }],
    {
      '1': summary({
        covered_sales_net: 0,
        uncovered_sales_net: 1000,
        last_purchase_cost_total: 0,
        estimated_gross_profit: 0,
        estimated_margin_pct: null,
        cost_coverage_pct: 0,
        covered_lines: 0,
        uncovered_lines: 1,
        cost_status: 'UNAVAILABLE',
      }),
    },
  )
  assert.ok(result)
  assert.equal(result.estimatedGrossProfit, 0)
  assert.equal(result.estimatedMarginPct, null)
  assert.equal(result.costCoveragePct, 0)
  assert.equal(result.costStatus, 'UNAVAILABLE')
})

test('7. margen agregado no es promedio simple', () => {
  const result = aggregatePreparationProfitability(
    [{ nv_bsale_id: 1 }, { nv_bsale_id: 2 }],
    {
      '1': summary({ bsale_nv_id: 1, sales_net_total: 1000, covered_sales_net: 1000, last_purchase_cost_total: 500, estimated_gross_profit: 500, estimated_margin_pct: 50, cost_coverage_pct: 100 }),
      '2': summary({ bsale_nv_id: 2, sales_net_total: 9000, covered_sales_net: 9000, last_purchase_cost_total: 9000, estimated_gross_profit: 0, estimated_margin_pct: 0, cost_coverage_pct: 100 }),
    },
  )
  assert.ok(result)
  assert.equal(result.estimatedGrossProfit, 500)
  assert.equal(result.estimatedMarginPct, 5)
  assert.equal(result.costCoveragePct, 100)
})

test('8. cobertura agregada usa venta cubierta / venta neta total', () => {
  const result = aggregatePreparationProfitability(
    [{ nv_bsale_id: 1 }, { nv_bsale_id: 2 }],
    {
      '1': summary({ bsale_nv_id: 1, sales_net_total: 2000, covered_sales_net: 2000 }),
      '2': summary({ bsale_nv_id: 2, sales_net_total: 3000, covered_sales_net: 0, uncovered_sales_net: 3000, last_purchase_cost_total: 0, covered_lines: 0, uncovered_lines: 1, cost_status: 'UNAVAILABLE' }),
    },
  )
  assert.ok(result)
  assert.equal(result.costCoveragePct, 40)
  assert.equal(result.costStatus, 'PARTIAL')
})

test('9. filtros recalculan sin nuevo fetch', () => {
  assert.match(panel, /aggregatePreparationProfitability\(filteredCards, profitabilityByNv\)/)
  const effect = panel.slice(panel.indexOf('useEffect(() => {\n    if (!companyId) return'), panel.indexOf('const refreshAuditLocks'))
  assert.doesNotMatch(effect, /searchTerm|selectedComunas|filterSellerKey|filteredCards/)
})

test('10. Monto bruto se mantiene independiente de rentabilidad', () => {
  assert.match(panel, /label="Monto bruto"/)
  assert.match(panel, /formatPreparationClp\(boardSummary\.amount\)/)
  assert.match(panel, /label="Utilidad est\."/)
  assert.doesNotMatch(panel, /label="Monto total"/)
})

test('11. rentabilidad usa venta neta, no monto bruto', () => {
  assert.match(migration, /det\.net_amount AS net_sales/)
  assert.match(migration, /sum\(rl\.net_sales\)/i)
  assert.doesNotMatch(migration, /gross_amount|total_amount AS net_sales/i)
})

test('12. no usa prepared_quantity ni audit_quantity', () => {
  assert.doesNotMatch(migration, /\b(rl|sl|det|ns)\.(prepared_quantity|audit_quantity)/i)
  assert.doesNotMatch(migration, /prepared_quantity_snapshot|audit_quantity_snapshot/i)
  assert.match(migration, /bsale_document_details/)
})

test('13. error RPC no rompe el board', () => {
  assert.match(action, /error: error\.message/)
  assert.match(panel, /setProfitabilityError\(result\.error\)/)
  assert.match(panel, /'No disponible'/)
  assert.match(panel, /: '—'/)
})

test('14. sync invalida y reconsulta rentabilidad', () => {
  assert.match(panel, /invalidatePreparationProfitabilityCache\(\)/)
  assert.match(panel, /setProfitabilityVersion\(current => current \+ 1\)/)
  assert.match(panel, /profitabilityVersion\]\)/)
})

test('15. cache por NV', () => {
  invalidatePreparationProfitabilityCache()
  cachePreparationProfitability([summary({ bsale_nv_id: 10 })])
  assert.equal(getCachedPreparationProfitability(10)?.bsale_nv_id, 10)
  assert.equal(getCachedPreparationProfitabilityMap([10])['10']?.bsale_nv_id, 10)
  invalidatePreparationProfitabilityCache()
  assert.equal(getCachedPreparationProfitability(10), undefined)
  assert.match(helper, /new Map<number, PreparationProfitabilitySummaryV1>\(\)/)
})

test('16. migración set-based, una fila por NV y sin loop PL/pgSQL', () => {
  assert.match(migration, /WITH requested_nvs AS/)
  assert.match(migration, /nv_scope AS/)
  assert.match(migration, /sales_lines AS/)
  assert.match(migration, /resolved_lines AS/)
  assert.match(migration, /rollup AS/)
  assert.match(migration, /RETURN QUERY/)
  assert.doesNotMatch(migration, /FOR\s+\w+\s+IN\s+SELECT[\s\S]*?LOOP/i)
})

test('17. costo seleccionado igual a Guías', () => {
  for (const source of [migration, guidesMigration]) {
    assert.match(source, /rd\.cost > 0/)
    assert.match(source, /r\.admission_date <= [a-z_]+\.document_date/)
    assert.match(source, /cancellationStatus[\s\S]*?<> 1/)
    assert.match(source, /NOTA DE CREDITO/)
    assert.match(source, /ORDER BY r\.admission_date DESC/)
    assert.match(source, /bsale_variant_id = 5729/)
    assert.match(source, /THEN 'COSTED'/)
    assert.match(source, /ELSE 'SIN_COSTO'/)
  }
})

test('18. fórmulas y estados iguales a Guías', () => {
  for (const source of [migration, guidesMigration]) {
    assert.match(source, /covered_sales_net - .*last_purchase_cost_total/)
    assert.match(source, /WHEN .*covered_sales_net = 0 THEN 'UNAVAILABLE'/)
    assert.match(source, /covered_sales_net < .*sales_net_total THEN 'PARTIAL'/)
    assert.match(source, /ELSE 'COMPLETE'/)
  }
})

test('19. formato de porcentajes', () => {
  assert.equal(formatPreparationProfitabilityPercent(27.84), '27,84%')
  assert.equal(formatPreparationProfitabilityPercent(null), '—')
})

test('20. script de test registrado', () => {
  assert.equal(
    packageJson.scripts['test:logistica-preparacion-profitability'],
    'node --experimental-strip-types --test scripts/test-logistica-preparacion-profitability.mjs',
  )
})
