import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20261026120000_logistica_optimize_sales_order_preparation_board.sql', import.meta.url), 'utf8')

test('la optimización SQL conserva las dos reglas de elegibilidad', () => {
  assert.match(migration, /candidate_cards AS \(/)
  assert.match(migration, /c\.closed_at IS NULL[\s\S]*c\.status IN \('PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT', 'AUDITED'\)/)
  assert.match(migration, /c\.status = 'INVOICED_READY_FOR_ROUTE'/)
  assert.match(migration, /eligible\.invoice_bsale_id IS NOT NULL/)
  assert.match(migration, /rg\.status IN \('DRAFT', 'DISPATCHED'\)/)
})

test('la búsqueda lateral de facturas sólo existe en la rama facturada', () => {
  const operational = migration.match(/operational_board AS \(([\s\S]*?)\),\ninvoiced_board AS/)?.[1] ?? ''
  assert.doesNotMatch(operational, /sales_order_invoice_attempts|LATERAL/)
  assert.match(migration, /invoiced_board AS \([\s\S]*LEFT JOIN LATERAL[\s\S]*sales_order_invoice_attempts/)
})

test('la expansión Bsale se comparte entre las dos ramas', () => {
  assert.match(migration, /candidate_bsale AS MATERIALIZED[\s\S]*vw_bsale_sales_orders_for_preparation/)
  assert.equal((migration.match(/vw_bsale_sales_orders_for_preparation/g) ?? []).length, 1)
  assert.match(migration, /FROM candidate_bsale\n  WHERE status IN/)
  assert.match(migration, /FROM candidate_bsale c\n  LEFT JOIN LATERAL/)
})

test('el contrato de salida y la seguridad de la vista permanecen intactos', () => {
  assert.equal((migration.match(/FROM operational_board|FROM invoiced_board/g) ?? []).length, 2)
  assert.match(migration, /ALTER VIEW logistica\.vw_sales_order_preparation_board SET \(security_invoker = true\)/)
  for (const column of [
    'card_id', 'company_id', 'status', 'priority', 'assigned_user_id', 'route_date',
    'normalized_city', 'nv_bsale_id', 'nv_folio', 'invoice_folio', 'is_invoiced',
    'net_amount', 'tax_amount', 'gross_amount', 'locked_by_user_id', 'locked_at',
  ]) assert.match(migration, new RegExp(`\\b${column}\\b`))
})

test('no añade índices redundantes ni cambia permisos o sincronización', () => {
  assert.doesNotMatch(migration, /CREATE INDEX|DROP INDEX/)
  assert.doesNotMatch(migration, /GRANT|REVOKE|DROP TABLE|UPDATE logistica\.sales_order_preparation_cards/)
  assert.doesNotMatch(migration, /syncBsale|bsale_sync|statement_timeout/)
})
