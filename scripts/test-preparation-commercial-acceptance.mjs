import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20261027120000_logistica_preparation_commercial_acceptance.sql', import.meta.url), 'utf8')
const action = await readFile(new URL('../src/app/actions/logistica/sales-order-preparation-commercial-acceptance.ts', import.meta.url), 'utf8')
const alertAction = await readFile(new URL('../src/app/actions/logistica/sales-order-preparation-commercial.ts', import.meta.url), 'utf8')
const versionSource = await readFile(new URL('../src/lib/logistica/preparation-commercial-version.ts', import.meta.url), 'utf8')

test('la aceptación sólo está disponible para service_role y exige estado IN_PREPARATION', () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION logistica\.accept_sales_order_preparation_commercial_changes/)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION logistica\.accept_sales_order_preparation_commercial_changes\([^\n]+\) TO service_role/)
  assert.match(migration, /v_card\.status <> 'IN_PREPARATION'/)
  assert.match(migration, /FOR UPDATE;/)
})

test('la migración conserva líneas retiradas y no altera incidencias ni auditoría', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS retired_at/)
  assert.match(migration, /SET retired_at = now\(\)/)
  assert.doesNotMatch(migration, /DELETE FROM logistica\.sales_order_preparation_lines/)
  assert.doesNotMatch(migration, /UPDATE logistica\.sales_order_preparation_incidents/)
  assert.doesNotMatch(migration, /UPDATE logistica\.sales_order_audit_(lines|incidents)/)
  assert.match(migration, /sales_order_audit_lines WHERE preparation_line_id/)
})

test('la acción obtiene empresa/usuario desde sesión, fuerza lectura Bsale y valida fingerprint', () => {
  assert.match(action, /requireWmsPermission\('logistica\.preparation\.manage'\)/)
  assert.match(action, /createBsalePreparationCommercialProvider\(\)/)
  assert.match(action, /AbortSignal\.timeout\(15_000\)/)
  assert.match(action, /currentFingerprint !== params\.expectedCommercialFingerprint/)
  assert.match(action, /buildPreparationCommercialReconciliationPlan/)
  assert.doesNotMatch(action, /from\(['"]sales_order_audit/)
})

test('el flujo de aceptación no conecta ningún botón ni drawer', () => {
  assert.doesNotMatch(action, /drawer|onClick|button/i)
  assert.match(migration, /UNIQUE \(company_id, card_id, fingerprint\)/)
})

test('la nueva detección lee la versión aceptada con service_role y normaliza snapshots camelCase', () => {
  assert.match(alertAction, /createAdminClient\(\)/)
  assert.match(alertAction, /preparationCommercialLineFromSnapshot/)
  assert.match(versionSource, /'detail_id', 'detailId'/)
  assert.match(versionSource, /'variant_id', 'variantId'/)
  assert.match(versionSource, /'product_name', 'productName'/)
})
