import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const migration = await readFile(new URL('supabase/migrations/20261020190000_logistica_route_readiness_incidents_v1.sql', root), 'utf8')
const sync = await readFile(new URL('src/app/actions/integraciones/bsale-sync.ts', root), 'utf8')
const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

test('1. incidencias comerciales aceptan RESOLVED sin tocar SUPERSEDED', () => {
  assert.match(migration, /CHECK \(status IN \('OPEN', 'RESOLVED', 'SUPERSEDED'\)\)/)
  assert.doesNotMatch(migration, /status = 'SUPERSEDED'[\s\S]{0,80}verification_status = 'MATCHED'/)
})

test('2. verification_status usa valores explícitos', () => {
  for (const value of ['MATCHED', 'MISMATCHED', 'NOT_FOUND', 'NV_CANCELLED', 'ERROR']) {
    assert.match(migration, new RegExp(`'${value}'`))
  }
})

test('3. verificación es batch y usa el espejo, no API Bsale', () => {
  assert.match(migration, /p_bsale_nv_ids bigint\[\] DEFAULT NULL/)
  assert.match(migration, /FROM integraciones\.bsale_document_details/)
  assert.match(migration, /UPDATE logistica\.sales_order_preparation_incidents/)
  assert.doesNotMatch(migration, /https?:\/\/|bsaleFetch|fetch\(/)
})

test('4. identificación exacta y fallback controlado', () => {
  assert.match(migration, /det\.bsale_id = s\.bsale_detail_id/)
  assert.match(migration, /s\.bsale_variant_id IS NOT NULL AND det\.variant_id = s\.bsale_variant_id/)
  assert.match(migration, /s\.bsale_variant_id IS NULL AND s\.sku IS NOT NULL AND det\.variant_code = s\.sku/)
  assert.match(migration, /AMBIGUOUS/)
})

test('5. RESOLVED sólo con MATCHED', () => {
  assert.match(migration, /status = CASE WHEN o\.verification_status = 'MATCHED' THEN 'RESOLVED' ELSE 'OPEN' END/)
})

test('6. NV anulada no resuelve y readiness la bloquea', () => {
  assert.match(migration, /WHEN nd\.state IS DISTINCT FROM 0 THEN 'NV_CANCELLED'/)
  assert.match(migration, /d\.state IS DISTINCT FROM 0 OR c\.closed_at IS NOT NULL THEN 'BLOCKED'/)
})

test('7. readiness usa sólo incidencias comerciales', () => {
  assert.match(migration, /FROM logistica\.sales_order_preparation_incidents i/)
  assert.doesNotMatch(migration, /sales_order_audit_incidents/)
})

test('8. readiness expone INCIDENTS / READY_TO_INVOICE / BLOCKED', () => {
  assert.match(migration, /THEN 'INCIDENTS'/)
  assert.match(migration, /ELSE 'READY_TO_INVOICE'/)
  assert.match(migration, /'BLOCKED'/)
})

test('9. read model y RPC tienen permisos y aislamiento', () => {
  assert.match(migration, /security_invoker = true/)
  assert.match(migration, /module\.logistica\.view/)
  assert.match(migration, /core\.has_company_access/)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION logistica\.get_sales_order_route_readiness_v1/)
})

test('10. verificación automática queda service_role', () => {
  assert.match(migration, /GRANT EXECUTE ON FUNCTION logistica\.verify_open_preparation_incidents_v1\(uuid, bigint\[\]\) TO service_role/)
  assert.doesNotMatch(migration, /verify_open_preparation_incidents_v1\(uuid, bigint\[\]\) TO authenticated/)
})

test('11. hook canónico ocurre después de reconcile', () => {
  const helper = sync.slice(sync.indexOf('async function materializePreparationAfterSalesSync'), sync.indexOf('async function fetchPreparationDocumentDetails'))
  const reconcileIndex = helper.indexOf("rpc('reconcile_bodega_preparation_cards'")
  const verifyIndex = helper.indexOf("rpc('verify_open_preparation_incidents_v1'")
  assert.ok(reconcileIndex >= 0)
  assert.ok(verifyIndex > reconcileIndex)
})

test('12. fallo de verificación no rompe sync y se observa', () => {
  const helper = sync.slice(sync.indexOf('async function materializePreparationAfterSalesSync'), sync.indexOf('async function fetchPreparationDocumentDetails'))
  assert.match(helper, /verification\.error\?\.message/)
  assert.match(helper, /catch \(error\)/)
  assert.match(helper, /from\('sync_errors'\)/)
  assert.match(helper, /VERIFICATION_FAILED/)
  assert.doesNotMatch(helper, /throw new Error\(message\)/)
})

test('13. todos los caminos de reconcile pasan runId al hook', () => {
  assert.equal((sync.match(/materializePreparationAfterSalesSync\(companyId, runId\)/g) ?? []).length, 2)
  assert.match(sync, /materializePreparationAfterSalesSync\(companyId, run\?\.id\)/)
})

test('14. no crea un cron paralelo para incidencias', () => {
  assert.doesNotMatch(sync, /api\/cron\/.*incident/i)
  assert.doesNotMatch(migration, /pg_cron|cron\.schedule/)
})

test('15. migración no toca auditoría ni rentabilidad', () => {
  assert.doesNotMatch(migration, /sales_order_audits|sales_order_audit_incidents/)
  assert.doesNotMatch(migration, /profitability|get_sales_order_preparation_missing_cost_lines_v1/)
})

test('16. script registrado', () => {
  assert.equal(
    packageJson.scripts['test:logistica-route-readiness'],
    'node --experimental-strip-types --test scripts/test-logistica-route-readiness.mjs',
  )
})
