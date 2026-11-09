import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationPath = path.join(root, 'supabase/migrations/20261109120000_logistica_sales_order_audit_cycles.sql')
const actionsPath = path.join(root, 'src/app/actions/logistica/sales-order-audit.ts')
const migration = await readFile(migrationPath, 'utf8')
const actions = await readFile(actionsPath, 'utf8')

test('el siguiente ciclo se calcula despues del maximo y no reemplaza el historial', () => {
  assert.match(migration, /max\(cycle_no\), 0\) \+ 1/)
  assert.match(migration, /UNIQUE.*company_id, card_id, cycle_no|ON CONFLICT \(company_id, card_id, cycle_no\)/s)
  assert.match(migration, /status = 'OPEN'/)
  assert.match(migration, /prepared_quantity_snapshot/)
})

test('una toma repetida reutiliza la sesion abierta', () => {
  assert.match(migration, /status = 'OPEN'[\s\S]*?ORDER BY cycle_no DESC[\s\S]*?IF FOUND THEN[\s\S]*?v_audit_id := v_audit\.id/)
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_order_audits_active_card|ON CONFLICT \(company_id, card_id, cycle_no\)/)
})

test('la lectura por defecto resuelve el ciclo operativo y permite consultar uno historico', () => {
  assert.match(migration, /p_cycle_no integer DEFAULT NULL/)
  assert.match(migration, /ORDER BY \(status = 'OPEN'\) DESC, cycle_no DESC/)
  assert.match(migration, /AND cycle_no = p_cycle_no/)
  assert.match(actions, /cycleNo\?: number \| null/)
  assert.match(actions, /p_cycle_no: cycleNo \?\? null/)
})

test('la toma sigue bloqueando tarjetas fuera de IN_AUDIT y conserva la separacion de roles', () => {
  assert.match(migration, /IF v_card\.status <> 'IN_AUDIT'/)
  assert.match(migration, /IF v_card\.assigned_user_id = v_actor AND NOT portal\.is_super_usuario\(v_actor\) THEN/)
  assert.match(migration, /IF v_audit\.prepared_by_user_id_snapshot = v_actor AND NOT portal\.is_super_usuario\(v_actor\) THEN/)
  assert.match(migration, /authorize_exception/)
})

test('el snapshot ignora líneas retiradas al validar y materializar', () => {
  assert.match(migration, /AND card_id = p_card_id\n      AND retired_at IS NULL\n      AND prepared_quantity IS NULL/)
  assert.match(migration, /AND pl\.card_id = p_card_id\n      AND pl\.retired_at IS NULL\n    ON CONFLICT/)
})

test('la migracion no implementa la recuperacion de AUDITED', () => {
  assert.doesNotMatch(migration, /UPDATE logistica\.sales_order_preparation_cards[\s\S]*?AUDITED[\s\S]*?IN_AUDIT/)
  assert.doesNotMatch(migration, /reopen|recovery/i)
})
