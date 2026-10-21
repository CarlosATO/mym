import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  cacheMissingCostLinesForNvs,
  countPreparationNvsWithMissingCost,
  getCachedMissingCostLinesForNvs,
  getMissingCostLineNvsToLoad,
  invalidatePreparationMissingCostLinesCache,
  sumPreparationMissingCostNet,
} from '../src/modules/logistica/preparacion-pedidos/preparation-profitability.ts'

const root = new URL('../', import.meta.url)
const migration = await readFile(new URL('supabase/migrations/20261020180000_logistica_preparation_missing_cost_lines_v1.sql', root), 'utf8')
const profitabilityMigration = await readFile(new URL('supabase/migrations/20261020170000_logistica_preparation_profitability_v1.sql', root), 'utf8')
const action = await readFile(new URL('src/app/actions/logistica/sales-order-preparation-profitability.ts', root), 'utf8')
const panel = await readFile(new URL('src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx', root), 'utf8')
const dialog = await readFile(new URL('src/modules/logistica/preparacion-pedidos/preparation-missing-cost-dialog.tsx', root), 'utf8')
const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

const summary = {
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
}

test('1. KPI usa la etiqueta Costo identificado', () => {
  assert.match(panel, /label="Costo identificado"/)
  assert.doesNotMatch(panel, /label="Cobertura costo"/)
})

test('2. desaparece la palabra Parcial del KPI', () => {
  const kpi = panel.slice(panel.indexOf('const profitabilityCoverageLabel'), panel.indexOf('const canOpenMissingCostDetail'))
  assert.doesNotMatch(kpi, /Parcial/)
  assert.doesNotMatch(panel, /· Parcial/)
})

test('3. contador NV = PARTIAL + UNAVAILABLE', () => {
  const count = countPreparationNvsWithMissingCost([1, 2, 3], {
    '1': { ...summary, bsale_nv_id: 1, cost_status: 'COMPLETE' },
    '2': { ...summary, bsale_nv_id: 2, cost_status: 'PARTIAL' },
    '3': { ...summary, bsale_nv_id: 3, cost_status: 'UNAVAILABLE' },
  })
  assert.equal(count, 2)
})

test('4. 100% no agrega 0 NV', () => {
  assert.match(panel, /missingCostNvCount > 0 \? ` · \$\{missingCostNvCount\} NV` : ''/)
  assert.equal(countPreparationNvsWithMissingCost([1], { '1': { ...summary, cost_status: 'COMPLETE' } }), 0)
})

test('5. KPI permanece en una sola línea', () => {
  assert.match(panel, /whitespace-nowrap text-left/)
  assert.match(panel, /const className = 'flex min-w-0 items-baseline gap-1 whitespace-nowrap text-left'/)
})

test('6. no cambia la altura estructural de la banda KPI', () => {
  assert.match(panel, /bg-\[#FCFBF9\] px-3 py-1\.5/)
  assert.match(panel, /flex flex-wrap items-center gap-x-4 gap-y-1/)
  assert.doesNotMatch(panel, /Costo identificado[\s\S]{0,200}<div className="mt-/)
})

test('7. KPI clickeable sólo con faltantes', () => {
  assert.match(panel, /onClick=\{canOpenMissingCostDetail \? \(\) => \{ void openMissingCostDetail\(\) \} : undefined\}/)
  assert.match(panel, /const canOpenMissingCostDetail = missingCostNvCount > 0 && !profitabilityLoading && !profitabilityError/)
})

test('8. RPC de detalle no corre al cargar el board', () => {
  const effect = panel.slice(panel.indexOf('useEffect(() => {\n    if (!companyId) return'), panel.indexOf('const refreshAuditLocks'))
  assert.doesNotMatch(effect, /getSalesOrderPreparationMissingCostLinesV1|missingCostLines|missingCostOpen/)
})

test('9. RPC de detalle corre al hacer clic', () => {
  const handler = panel.slice(panel.indexOf('const openMissingCostDetail'), panel.indexOf('const hasFilters'))
  assert.match(handler, /getSalesOrderPreparationMissingCostLinesV1\(\{ companyId, nvIds: toLoad \}\)/)
  assert.equal((panel.match(/getSalesOrderPreparationMissingCostLinesV1\(/g) ?? []).length, 1)
})

test('10. una sola llamada batch, sin RPC por NV', () => {
  assert.equal((action.match(/get_sales_order_preparation_missing_cost_lines_v1/g) ?? []).length, 1)
  assert.doesNotMatch(panel, /nvIds\.map\([^)]*getSalesOrderPreparationMissingCostLinesV1/)
})

test('11. usa filteredCards para el detalle y el conteo', () => {
  assert.match(panel, /const visibleProfitabilityNvIds = useMemo\([\s\S]*?filteredCards\.map/)
  assert.match(panel, /countPreparationNvsWithMissingCost\(visibleProfitabilityNvIds, profitabilityByNv\)/)
})

test('12. modal y RPC muestran sólo faltantes', () => {
  assert.match(dialog, /Costos faltantes/)
  assert.match(migration, /WHERE rl\.line_cost_status = 'SIN_COSTO'/)
  assert.match(migration, /line_cost_status AS cost_status/)
  assert.match(migration, /WHERE rl\.line_cost_status = 'SIN_COSTO'/)
})

test('13. resumen de monto faltante correcto', () => {
  const amount = sumPreparationMissingCostNet([1, 2, 3], {
    '1': { ...summary, bsale_nv_id: 1, cost_status: 'COMPLETE', uncovered_sales_net: 0 },
    '2': { ...summary, bsale_nv_id: 2, cost_status: 'PARTIAL', uncovered_sales_net: 19008 },
    '3': { ...summary, bsale_nv_id: 3, cost_status: 'UNAVAILABLE', uncovered_sales_net: 91240 },
  })
  assert.equal(amount, 110248)
  assert.match(dialog, /formatPreparationClp\(missingNetAmount\)/)
})

test('14. modal tiene loading y no bloquea el Kanban', () => {
  assert.match(dialog, /loading \? \(/)
  assert.match(dialog, /Cargando artículos sin costo/)
  assert.match(panel, /<PreparationMissingCostDialog/)
})

test('15. error del detalle no rompe el board', () => {
  assert.match(action, /error: error\.message/)
  assert.match(panel, /setMissingCostError\(result\.error\)/)
  assert.match(panel, /catch \(err: unknown\)/)
  assert.match(panel, /setMissingCostLoading\(false\)/)
})

test('16. el modal se puede cerrar', () => {
  assert.match(dialog, /onOpenChange\(next\)/)
  assert.match(dialog, /<Button variant="ghost" size="sm" onClick=\{\(\) => onOpenChange\(false\)\}[^>]*>Cerrar<\/Button>/)
})

test('17. cache por NV y reapertura sin repetir consulta', () => {
  invalidatePreparationMissingCostLinesCache()
  assert.deepEqual(getMissingCostLineNvsToLoad([10, 10, 11]), [10, 11])
  cacheMissingCostLinesForNvs([10, 11], [{
    bsale_nv_id: 10, nv_folio: '1', variant_id: 1, sku: 'A', product_name: 'A', quantity: 1, line_net_amount: 100, cost_status: 'SIN_COSTO',
  }])
  assert.deepEqual(getMissingCostLineNvsToLoad([10, 11]), [])
  assert.equal(getCachedMissingCostLinesForNvs([10, 11]).length, 1)
  invalidatePreparationMissingCostLinesCache()
})

test('18. Actualizar NV invalida cache del detalle', () => {
  assert.match(panel, /invalidatePreparationMissingCostLinesCache\(\)/)
  assert.match(panel, /setProfitabilityVersion\(current => current \+ 1\)/)
})

test('19. no modifica la fórmula de rentabilidad', () => {
  assert.match(profitabilityMigration, /covered_sales_net - .*last_purchase_cost_total/)
  assert.match(panel, /aggregatePreparationProfitability\(filteredCards, profitabilityByNv\)/)
  assert.doesNotMatch(profitabilityMigration, /missing_cost_lines_v1/)
})

test('20. no usa prepared_quantity ni audit_quantity', () => {
  assert.doesNotMatch(migration, /prepared_quantity|audit_quantity/i)
  assert.match(migration, /bsale_document_details/)
})

test('21. metodología de costo equivalente a Rentabilidad V1', () => {
  for (const source of [migration, profitabilityMigration]) {
    assert.match(source, /document_type_id = 23/)
    assert.match(source, /d\.state = 0/)
    assert.match(source, /rd\.cost > 0/)
    assert.match(source, /r\.admission_date <= [a-z_]+\.document_date/)
    assert.match(source, /cancellationStatus[\s\S]*?<> 1/)
    assert.match(source, /NOTA DE CREDITO/)
    assert.match(source, /ORDER BY r\.admission_date DESC, rd\.updated_at DESC NULLS LAST, rd\.bsale_id DESC/)
    assert.match(source, /bsale_variant_id = 5729/)
  }
})

test('22. RPC batch con security definer, grants y permiso', () => {
  assert.match(migration, /get_sales_order_preparation_missing_cost_lines_v1\(\s*p_company_id uuid,\s*p_bsale_nv_ids bigint\[\]/)
  assert.match(migration, /SECURITY DEFINER/)
  assert.match(migration, /STABLE/)
  assert.match(migration, /PARALLEL SAFE/)
  assert.match(migration, /has_company_access/)
  assert.match(migration, /module\.logistica\.view/)
  assert.match(migration, /TO authenticated, service_role/)
  assert.doesNotMatch(migration, /FOR .* IN SELECT[\s\S]*?LOOP/i)
})

test('23. script de test registrado', () => {
  assert.equal(
    packageJson.scripts['test:logistica-preparacion-cost-coverage'],
    'node --experimental-strip-types --test scripts/test-logistica-preparacion-cost-coverage.mjs',
  )
})
