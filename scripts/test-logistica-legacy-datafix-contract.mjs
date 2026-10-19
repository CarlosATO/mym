import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const migration = await readFile(
  new URL('supabase/migrations/20261019100000_logistica_archive_legacy_backfill_cards.sql', root),
  'utf8',
)

const values = [...migration.matchAll(/\(v_company_id,\s*(\d+)\)/g)].map((match) => Number(match[1]))
const excluded = [83326, 83327, 83878, 90045, 91741, 92172]
const expected = [
  83836, 83932, 83960, 84113, 84231, 84455, 84459, 84649, 84940, 84958,
  85250, 85434, 85478, 85709, 85764, 85882, 85942, 85954, 86051, 86287,
  86611, 86777, 86887, 87033, 87164, 87192, 87332, 87404, 87512, 87513,
  87643, 87922, 87973, 88041, 88146, 88315, 88451, 88452, 88553, 88601,
  88677, 88682, 88792, 89119, 89285, 89387, 89521, 90006, 90021, 90427,
  90431, 90453, 90467, 90468, 90555, 90583, 90699, 90706, 90901, 90996,
  91220,
]

test('lista congelada exacta: 61 identidades unicas', () => {
  assert.deepEqual(values, expected)
  assert.equal(new Set(values).size, 61)
  assert.equal(values.length, 61)
  assert.equal(values.some((id) => excluded.includes(id)), false)
  assert.match(migration, /v_company_id uuid := 'd1000000-0000-0000-0000-000000000001'/)
})

test('estructura transaccional y aborta ante drift, sin skip individual', () => {
  assert.match(migration, /DO \$\$/)
  assert.match(migration, /RAISE EXCEPTION 'LEGACY guard/)
  assert.match(migration, /set_config\('lock_timeout', '5s', true\)/)
  assert.match(migration, /LOCK TABLE logistica\.sales_order_preparation_cards IN ACCESS EXCLUSIVE MODE/)
  assert.ok(migration.indexOf('ACCESS EXCLUSIVE MODE') < migration.indexOf('INSERT INTO legacy_backfill_targets'))
  assert.match(migration, /FOR UPDATE/)
  assert.match(migration, /v_updated <> v_expected/)
  assert.match(migration, /LEGACY guard movements total previo/)
  assert.doesNotMatch(migration, /WHERE elegible|skip individual|continuar con/) 
})

test('guards reales y update exacto', () => {
  for (const expression of [
    'closed_at IS NOT NULL', 'closure_reason IS NOT NULL', "status <> 'PENDING_ROUTE_PREP'",
    'document_type_id IS DISTINCT FROM 23', 'state IS DISTINCT FROM 0',
    'is_pending IS DISTINCT FROM true', 'remaining_qty', "coverage_status IS DISTINCT FROM 'SIN_CIERRE'",
    'bsale_invoice_sales_order_links', 'sales_order_preparation_exclusions',
    'locked_by_user_id', 'locked_at', 'assigned_user_id', 'route_date', 'movements_count',
  ]) assert.match(migration, new RegExp(expression.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  for (const id of [89521, 90006, 90021, 90431, 90453, 90583, 90699, 90901]) {
    assert.match(migration, new RegExp(`\\(v_company_id, ${id}\\)`))
  }
  assert.match(migration, /future route event/)
  assert.match(migration, /SET closed_at = v_batch_at,[\s\S]*closure_reason = 'LEGACY_BACKFILL_ARCHIVED',[\s\S]*updated_at = v_batch_at/)
  assert.doesNotMatch(migration, /CREATE OR REPLACE VIEW logistica\.vw_sales_order_preparation_board/)
})

test('movement SYSTEM, metadata, automation key e invariantes', () => {
  assert.match(migration, /NULL, 'SYSTEM', false/)
  assert.match(migration, /moved_by IS NULL/)
  for (const hash of [
    '5bb6cc27ab3a759c8ffee8ae1c9b9f4a7e5f92f361e4580618a83292f74bac0a',
    '76c3621cba547834b245a3208af26e8cab837638ed537a4fb690beecff4e29ef',
    '8a015816352bc9637c9692b1a500e9428438b4d64285c13ec88721455d192cff',
  ]) assert.match(migration, new RegExp(hash))
  assert.match(migration, /BODEGA_LEGACY_ARCHIVE:20261016:/)
  assert.match(migration, /route_event_count/)
  assert.match(migration, /status <> s\.status/)
  assert.match(migration, /LEGACY assert movements totales/)
  assert.match(migration, /LEGACY assert movements por card/)
  assert.match(migration, /LEGACY assert movements externos/)
  assert.match(migration, /movement_count_total/)
  assert.match(migration, /movement_count_batch/)
  assert.match(migration, /RAISE NOTICE 'LEGACY_BACKFILL_20261016 ya aplicado/)
})

test('no API, tokens, Bsale writes, exclusions ni route-event deletes', () => {
  assert.doesNotMatch(migration, /fetch\(|axios|http:\/\/|https:\/\//i)
  assert.doesNotMatch(migration, /token|authorization/i)
  assert.doesNotMatch(migration, /INSERT INTO integraciones\.bsale_|UPDATE integraciones\.bsale_|DELETE FROM/)
  assert.doesNotMatch(migration, /DELETE FROM logistica\.sales_order_preparation_route_events/)
  assert.doesNotMatch(migration, /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+)?logistica\.sales_order_preparation_exclusions/)
})

test('resultado simulado y escenarios de abort total estan documentados en el contrato', () => {
  assert.match(migration, /61 tarjetas y 61 movements/)
  assert.match(migration, /ROLLBACK|transaccion/i)
  assert.match(migration, /canonical view cardinality/)
  assert.match(migration, /active exclusion/)
  assert.match(migration, /invoice link/)
  assert.match(migration, /movements_count/)
})
