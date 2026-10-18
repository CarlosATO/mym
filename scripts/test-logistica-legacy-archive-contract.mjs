import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const migration = await readFile(
  new URL('supabase/migrations/20261017120000_logistica_bodega_legacy_backfill_archive.sql', root),
  'utf8',
)
const boardMigration = await readFile(
  new URL('supabase/migrations/20261016140000_logistica_bodega_exclusions_integration.sql', root),
  'utf8',
)
const coveredMigration = await readFile(
  new URL('supabase/migrations/20261016160000_logistica_bodega_covered_bsale_lifecycle.sql', root),
  'utf8',
)

const promotion = migration.slice(
  migration.indexOf('WITH promotable AS'),
  migration.indexOf('-- (4) CIERRE REVERSIBLE'),
)
const reopen = migration.slice(
  migration.indexOf('-- (5) REAPERTURA'),
  migration.indexOf('RETURN jsonb_build_object'),
)

test('1. LEGACY_BACKFILL_ARCHIVED es un valor valido y conserva los cuatro motivos previos', () => {
  assert.match(migration, /ALTER TABLE logistica\.sales_order_preparation_cards[\s\S]*DROP CONSTRAINT IF EXISTS sales_order_preparation_cards_closure_reason_check/)
  assert.match(migration, /'INVOICED', 'CANCELLED_BSALE', 'NON_OPERATIONAL_BSALE', 'COVERED_BSALE',\s*'LEGACY_BACKFILL_ARCHIVED'/)
  assert.match(migration, /COMMENT ON COLUMN logistica\.sales_order_preparation_cards\.closure_reason/)
  assert.match(migration, /NO implica anulacion, facturacion, cobertura ni cancelacion comercial/)
})

test('2. el board no se modifica y sigue ocultando por closed_at', () => {
  assert.doesNotMatch(migration, /CREATE OR REPLACE VIEW logistica\.vw_sales_order_preparation_board/)
  assert.match(boardMigration, /WHERE c\.closed_at IS NULL/)
  assert.match(boardMigration, /AND c\.status IN \('PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT'\)/)
  assert.match(boardMigration, /AND NOT EXISTS \([\s\S]*sales_order_preparation_exclusions/)
})

test('3. la reapertura automatica sigue limitada exclusivamente a COVERED_BSALE', () => {
  assert.match(reopen, /c\.closure_reason = 'COVERED_BSALE'/)
  assert.match(reopen, /cov\.is_pending = true/)
  assert.doesNotMatch(reopen, /LEGACY_BACKFILL_ARCHIVED/)
})

test('4. el archivo de legado no se convierte automaticamente a COVERED_BSALE', () => {
  const closeable = migration.slice(
    migration.indexOf('WITH closeable AS'),
    migration.indexOf('-- (5) REAPERTURA'),
  )
  assert.match(closeable, /c\.closed_at IS NULL/)
  assert.match(closeable, /cov\.coverage_status = 'COMPLETA'/)
  assert.doesNotMatch(closeable, /LEGACY_BACKFILL_ARCHIVED/)
})

test('5. la promocion incluye INVOICED con precedencia existente', () => {
  assert.match(promotion, /THEN 'INVOICED'[\s\S]*WHEN nv\.state = 1 THEN 'CANCELLED_BSALE'[\s\S]*WHEN nv\.state = 8888 THEN 'NON_OPERATIONAL_BSALE'/)
  assert.match(promotion, /c\.closure_reason IN \('COVERED_BSALE', 'LEGACY_BACKFILL_ARCHIVED'\)/)
})

test('6. la promocion incluye CANCELLED_BSALE y NON_OPERATIONAL_BSALE', () => {
  assert.match(promotion, /WHEN nv\.state = 1 THEN 'CANCELLED_BSALE'/)
  assert.match(promotion, /WHEN nv\.state = 8888 THEN 'NON_OPERATIONAL_BSALE'/)
  assert.match(promotion, /AND c\.closure_reason IN \('COVERED_BSALE', 'LEGACY_BACKFILL_ARCHIVED'\)/)
})

test('7. la promocion conserva closed_at y no lo reemplaza por now()', () => {
  const update = promotion.slice(promotion.indexOf('UPDATE logistica.sales_order_preparation_cards c'), promotion.indexOf('RETURNING c.id'))
  assert.match(update, /SET closure_reason = p\.definitive_reason,\s*updated_at = now\(\)/)
  assert.doesNotMatch(update, /closed_at\s*=/)
  assert.match(promotion, /'closed_at_preserved', closed_at/)
})

test('8. la promocion conserva card_id y status', () => {
  assert.match(promotion, /UPDATE logistica\.sales_order_preparation_cards c[\s\S]*FROM promotable p[\s\S]*WHERE c\.id = p\.id/)
  assert.match(promotion, /SELECT company_id, id, status, status, NULL/)
  assert.doesNotMatch(promotion, /SET status\s*=/)
})

test('9. el movement de promocion legacy es SYSTEM e idempotente', () => {
  assert.match(promotion, /WHEN previous_closure_reason = 'LEGACY_BACKFILL_ARCHIVED' THEN 'SYSTEM' ELSE 'SYNC'/)
  assert.match(promotion, /'BODEGA_LEGACY_PROMOTION:' \|\| definitive_reason/)
  assert.match(promotion, /ON CONFLICT DO NOTHING/)
  assert.doesNotMatch(promotion, /BODEGA_LEGACY_PROMOTION:.*now\(\)/)
})

test('10. el movement de promocion registra evidencia y motivo previo', () => {
  assert.match(promotion, /'previous_closure_reason', previous_closure_reason/)
  assert.match(promotion, /'new_closure_reason', definitive_reason/)
  assert.match(promotion, /'evidence_source'/)
  assert.match(promotion, /'bsale_invoice_sales_order_link'/)
  assert.match(promotion, /'bsale_nv_state_1'/)
  assert.match(promotion, /'bsale_nv_state_8888'/)
})

test('11. no se promueve por coverage SIN_CIERRE, PARCIAL ni is_pending', () => {
  assert.doesNotMatch(promotion, /is_pending\s*=\s*true/)
  assert.doesNotMatch(promotion, /coverage_status\s*=\s*'PARCIAL'/)
  assert.doesNotMatch(promotion, /coverage_status\s*=\s*'SIN_CIERRE'/)
})

test('12. la creacion no recrea tarjetas legacy existentes', () => {
  const creation = migration.slice(
    migration.indexOf('WITH inserted AS (', migration.indexOf('v_skipped_invoiced')),
    migration.indexOf('-- CIERRES DEFINITIVOS'),
  )
  assert.match(creation, /NOT EXISTS \([\s\S]*FROM logistica\.sales_order_preparation_cards c[\s\S]*c\.company_id = p_company_id AND c\.bsale_nv_id = candidate\.nv_bsale_id/)
  assert.match(creation, /candidate\.emission_date >= v_business_date - 30/)
  assert.doesNotMatch(creation, /c\.closed_at IS NULL/)
})

test('13. COVERED_BSALE mantiene su cierre y reapertura sin cambios semanticos', () => {
  assert.match(coveredMigration, /COVERED_BSALE es REVERSIBLE/)
  assert.match(migration, /SET closed_at = now\(\),\s*closure_reason = 'COVERED_BSALE'/)
  assert.match(reopen, /SET closed_at = NULL,\s*closure_reason = NULL/)
})

test('14. los cierres definitivos siguen siendo irreversibles', () => {
  assert.match(migration, /AND c\.closed_at IS NULL[\s\S]*nv\.state IN \(1, 8888\)/)
  assert.match(reopen, /AND c\.closure_reason = 'COVERED_BSALE'/)
  assert.doesNotMatch(reopen, /INVOICED|CANCELLED_BSALE|NON_OPERATIONAL_BSALE/)
})

test('15. esta migracion no contiene lista de NV ni data-fix de tarjetas reales', () => {
  assert.doesNotMatch(migration, /83326|83327|83878|90045|91741|92172/)
  assert.doesNotMatch(migration, /UPDATE logistica\.sales_order_preparation_cards[\s\S]{0,300}SET closure_reason = 'LEGACY_BACKFILL_ARCHIVED'/)
  assert.doesNotMatch(migration, /INSERT INTO logistica\.sales_order_preparation_cards[\s\S]{0,300}LEGACY_BACKFILL_ARCHIVED/)
})
