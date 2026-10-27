import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20261027140000_logistica_preparation_commercial_line_correspondence.sql', import.meta.url), 'utf8')

function line(variantId, sku, quantity, detailId) {
  return { variantId, sku, quantity, detailId }
}

function commercialKey(value) {
  return `${value.variantId ?? 'NULL'}|${String(value.sku ?? '').trim().toUpperCase()}|${value.quantity}`
}

function sameCommercialMultiset(left, right) {
  const count = values => values.reduce((counts, value) => counts.set(commercialKey(value), (counts.get(commercialKey(value)) ?? 0) + 1), new Map())
  assert.deepEqual(count(left), count(right))
}

const accepted = [
  line(7139, 'MP1', 1, 335938),
  line(6199, '1020', 20, 335937),
  line(6213, '556515', 1, 335936),
  line(6257, '756266', 12, 335935),
  line(6579, '754115', 2, 335934),
  line(6209, '557025', 1, 335933),
  line(6207, '558025', 1, 335932),
  line(5729, 'MUESTRA', 1, 335939),
  line(3184, 'PW12401', 1, 335940),
]

test('la migración nueva reemplaza detailId por correspondencia comercial multiconjunto', () => {
  assert.match(migration, /EXCEPT ALL/)
  assert.match(migration, /applied_actions/)
  assert.match(migration, /preparationLineId/)
  assert.match(migration, /bsale_variant_id/)
  assert.match(migration, /requested_quantity/)
  assert.doesNotMatch(migration, /accepted_line\.value->>'detailId'\)::bigint = active_line\.bsale_detail_id/)
})

test('siete KEEP con detailId histórico y dos ADD aceptados conservan multiplicidad', () => {
  const active = accepted.map((value, index) => ({ ...value, detailId: index < 7 ? 335800 + index : value.detailId }))
  sameCommercialMultiset(active, accepted)
})

test('línea faltante, sobrante, variante o cantidad incorrecta no corresponden', () => {
  assert.throws(() => sameCommercialMultiset(accepted.slice(0, -1), accepted))
  assert.throws(() => sameCommercialMultiset([...accepted, line(9999, 'EXTRA', 1, 1)], accepted))
  assert.throws(() => sameCommercialMultiset(accepted.map(value => value.variantId === 5729 ? { ...value, variantId: 9999 } : value), accepted))
  assert.throws(() => sameCommercialMultiset(accepted.map(value => value.variantId === 3184 ? { ...value, quantity: 2 } : value), accepted))
})

test('líneas duplicadas se rechazan por multiplicidad', () => {
  const duplicate = accepted.slice(0, -1).concat(accepted[accepted.length - 2])
  assert.throws(() => sameCommercialMultiset(duplicate, accepted))
})

test('con versión aceptada no hay rematerialización ni actualización automática de cantidades', () => {
  const acceptedBranch = migration.slice(migration.indexOf('IF FOUND THEN'), migration.indexOf('END IF;\n\n  -- No se reconstruye'))
  assert.doesNotMatch(acceptedBranch, /INSERT INTO logistica\.sales_order_preparation_lines/)
  assert.doesNotMatch(acceptedBranch, /UPDATE logistica\.sales_order_preparation_lines/)
  assert.match(migration, /FOR UPDATE;/)
  assert.match(migration, /RETURN 0;/)
})
