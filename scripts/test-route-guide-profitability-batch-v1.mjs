import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20260828120000_route_guide_profitability_batch_v1.sql', import.meta.url), 'utf8')
const action = await readFile(new URL('../src/app/actions/logistica/guias-ruta.ts', import.meta.url), 'utf8')
const panel = await readFile(new URL('../src/modules/logistica/guias-ruta/route-guides-panel.tsx', import.meta.url), 'utf8')

test('el batch devuelve sólo el resumen consumido por el listado', () => {
  assert.match(migration, /RETURNS TABLE \(/)
  assert.match(migration, /route_guide_id uuid/)
  assert.match(migration, /estimated_gross_profit numeric\(14,2\)/)
  assert.match(migration, /uncovered_lines integer/)
  assert.doesNotMatch(migration, /jsonb_agg/)
  assert.doesNotMatch(migration, /FOR .* LOOP/)
})

test('el batch es set-based y recibe IDs restringidos a una empresa', () => {
  assert.match(migration, /p_route_guide_ids uuid\[\]/)
  assert.match(migration, /rg\.company_id = p_company_id/)
  assert.match(migration, /rg\.id = ANY\(/)
  assert.match(migration, /GROUP BY gs\.id, gs\.guide_number/)
  assert.match(migration, /core\.has_company_access/)
  assert.match(migration, /logistica\.route_guides\.view/)
})

test('el batch conserva las reglas económicas V1', () => {
  assert.match(migration, /r\.admission_date <= sl\.document_date/)
  assert.match(migration, /sl\.bsale_variant_id = 5729/)
  assert.match(migration, /THEN 'COSTED'/)
  assert.match(migration, /THEN 'UNAVAILABLE'/)
  assert.match(migration, /THEN 'PARTIAL'/)
  assert.match(migration, /NOT LIKE '%NOTA DE CREDITO%'/)
})

test('el wrapper realiza una sola llamada RPC para el conjunto', () => {
  assert.match(action, /getRouteGuidesProfitabilitySummaryV1\(/)
  assert.match(action, /supabase\.rpc\('get_route_guides_profitability_summary_v1'/)
  assert.match(action, /p_route_guide_ids: uniqueGuideIds/)
})

test('50 guías requieren una llamada batch, no 50 llamadas', () => {
  const guideIds = Array.from({ length: 50 }, (_, index) => `guide-${index}`)
  assert.equal(guideIds.length, 50)
  assert.equal((action.match(/\.rpc\('get_route_guides_profitability_summary_v1'/g) || []).length, 1)
  assert.equal((panel.match(/getRouteGuideProfitabilityV1/g) || []).length, 0)
  assert.equal((panel.match(/getRouteGuidesProfitabilitySummaryV1/g) || []).length, 2)
})
