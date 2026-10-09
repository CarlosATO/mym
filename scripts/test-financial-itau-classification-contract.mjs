import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20261008120000_financial_itau_safe_classification.sql', import.meta.url), 'utf8')

test('financial classification migration defines scoped AUTO rules', () => {
  assert.equal((migration.match(/::uuid/g) ?? []).length >= 15, true)
  assert.match(migration, /on conflict \(id\) do update set/)
  assert.match(migration, /mode = 'AUTO'/)
  assert.match(migration, /classification_source is distinct from 'MANUAL'/)
  assert.match(migration, /TRASPASO A CAYLO PREMIUM SPA/)
  assert.match(migration, /TRASPASO DE CAYLO PREMIUM SPA/)
  assert.match(migration, /TRANSFERENCIA A CAYLO PREMIUM/)
  assert.match(migration, /TRANSF DE 77196005 7 CAYLO PR/)
  assert.match(migration, /IMPUESTO AL VALOR AGREGADO/)
})

test('Banco de Chile correction is guarded to the existing ten generic-rule movements', () => {
  assert.match(migration, /v_old_chile_rule_id uuid := '95c10a1e-7a67-4d82-83eb-6b1da4003d7b'/)
  assert.match(migration, /normalized_description = 'TRASPASO A CAYLO PREMIUM SPA'\) <> 10/)
  assert.match(migration, /classification_rule_id in \(v_old_chile_rule_id, v_chile_exact_rule_id\)/)
  assert.match(migration, /classification_source is distinct from 'MANUAL'/)
})

test('rules stay account-scoped and do not use broad transfer matching', () => {
  assert.match(migration, /bank_account_id = movement\.bank_account_id/)
  assert.match(migration, /rule\.match_type = 'EXACT'/)
  assert.doesNotMatch(migration, /match_type.*'CONTAINS'/)
  assert.doesNotMatch(migration, /match_type.*'STARTS_WITH'/)
})
