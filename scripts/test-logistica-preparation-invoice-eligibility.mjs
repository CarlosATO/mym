import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20261030130000_logistica_preparation_invoice_eligibility_strict.sql', import.meta.url), 'utf8')
const mej01b = await readFile(new URL('../supabase/migrations/20261030100000_logistica_preparation_incident_verification_strict.sql', import.meta.url), 'utf8')

test('MEJ-01C es incremental y posterior a MEJ-01B', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION logistica\.get_sales_order_preparation_commercial_consistency_v1/)
  assert.match(migration, /CREATE OR REPLACE VIEW logistica\.vw_sales_order_route_readiness/)
  assert.match(migration, /CREATE OR REPLACE FUNCTION logistica\.invoice_attempt_prevalidate/)
  assert.match(migration, /CREATE OR REPLACE FUNCTION logistica\.begin_sales_order_invoice_submission/)
  assert.match(mej01b, /FULL_CARD_PRODUCT_QUANTITY_SET/)
  assert.doesNotMatch(migration, /INSERT INTO integraciones\.bsale_documents|UPDATE integraciones\.bsale_documents|DELETE FROM integraciones\.bsale_documents/)
  assert.doesNotMatch(migration, /sales_order_audits|sales_order_audit_incidents|CREATE TABLE|ALTER TABLE/)
})

test('readiness requiere coincidencia comercial además de NV activa y tarjeta AUDITED', () => {
  assert.match(migration, /c\.status = 'AUDITED'/)
  assert.match(migration, /consistency\.payload->>'status' IS DISTINCT FROM 'MATCHED' THEN 'BLOCKED'/)
  assert.match(migration, /d\.state IS DISTINCT FROM 0 OR c\.closed_at IS NOT NULL THEN 'BLOCKED'/)
  assert.match(migration, /COALESCE\(oc\.open_count, 0\) > 0 THEN 'INCIDENTS'/)
})

test('prevalidación bloquea diferencias aun cuando no haya incidencias OPEN', () => {
  assert.match(migration, /get_sales_order_preparation_commercial_consistency_v1\(p_company_id, p_card_id\)/)
  assert.match(migration, /COMMERCIAL_RECONCILIATION_REQUIRED:/)
  assert.match(migration, /OPEN_COMMERCIAL_INCIDENTS/)
  assert.match(migration, /commercial_consistency', consistency/)
})

test('el inicio efectivo de emisión vuelve a validar la consistencia antes de insertar SUBMITTING', () => {
  const begin = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION logistica.begin_sales_order_invoice_submission'))
  assert.match(begin, /consistency := logistica\.get_sales_order_preparation_commercial_consistency_v1/)
  assert.match(begin, /COMMERCIAL_RECONCILIATION_REQUIRED/)
  assert.match(begin, /INSERT INTO logistica\.sales_order_invoice_attempts/)
  assert.ok(begin.indexOf('COMMERCIAL_RECONCILIATION_REQUIRED') < begin.indexOf('INSERT INTO logistica.sales_order_invoice_attempts'))
})

test('la consistencia exige NV canónica, sincronización reciente y detalles del mismo run', () => {
  assert.match(migration, /COALESCE\(c\.current_bsale_nv_id, c\.bsale_nv_id\)/)
  assert.match(migration, /cd\.sync_status = 'COMPLETED'/)
  assert.match(migration, /cd\.sync_completed_at >= cd\.relevant_at/)
  assert.match(migration, /cd\.document_synced_at >= cd\.relevant_at/)
  assert.match(migration, /stale_detail\.bsale_sync_run_id IS DISTINCT FROM cd\.bsale_sync_run_id/)
})

test('la consistencia reutiliza cantidades físicas, identidad comercial y duplicados de MEJ-01B', () => {
  assert.match(migration, /prepared_quantity/)
  assert.match(migration, /det\.quantity/)
  assert.match(migration, /SKU:/)
  assert.match(migration, /VARIANT:/)
  assert.match(migration, /duplicate_prepared_key/)
  assert.match(migration, /duplicate_current_key/)
  assert.match(migration, /quantity_mismatch/)
  assert.match(migration, /full-card commercial|FULL_CARD_PRODUCT_QUANTITY_SET/)
})

test('se conservan permisos, idempotencia y los estados físicos', () => {
  assert.match(migration, /PREPARATION_MANAGE_DENIED|logistica\.preparation\.manage/)
  assert.match(migration, /ACTIVE_INCOMPATIBLE_ATTEMPT/)
  assert.match(migration, /ON CONFLICT|unique_violation/)
  assert.match(migration, /c\.status IS DISTINCT FROM 'AUDITED'/)
  assert.doesNotMatch(migration, /UPDATE logistica\.sales_order_preparation_cards/)
  assert.doesNotMatch(migration, /UPDATE logistica\.sales_order_preparation_incidents/)
})

test('MEJ-01C no recalcula valores monetarios ni implementa sincronización Bsale', () => {
  assert.doesNotMatch(migration, /net_amount|tax_amount|net_discount|total_amount/)
  assert.doesNotMatch(migration, /fetch\(|bsaleWrite|\/documents\.json|sync_sales_order/)
})
