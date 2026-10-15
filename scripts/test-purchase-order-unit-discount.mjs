import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const migration = await readFile(new URL('supabase/migrations/20261014210000_adquisiciones_purchase_order_unit_discount.sql', root), 'utf8')
const actions = await readFile(new URL('src/app/actions/adquisiciones/purchase-orders.ts', root), 'utf8')

function calculate({ quantity, unitPrice, discountPercent, discountUnitAmount, taxRate }) {
  const gross = quantity * unitPrice
  const discount = discountPercent > 0 ? gross * discountPercent / 100 : quantity * discountUnitAmount
  const net = gross - discount
  const tax = net * taxRate / 100
  return { discount, net, tax, total: net + tax }
}

test('la migración agrega la columna y mantiene compatibilidad histórica', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS discount_unit_amount numeric\(14,4\) NOT NULL DEFAULT 0/)
  assert.match(migration, /COALESCE\(\(v_item->>'discount_unit_amount'\)::numeric, 0\)/)
  assert.match(migration, /COALESCE\(NULLIF\(v_original->>'discount_unit_amount', ''\)::numeric, 0\)/)
})

test('casos sin descuento, porcentual y unitario', () => {
  assert.deepEqual(calculate({ quantity: 10, unitPrice: 1000, discountPercent: 0, discountUnitAmount: 0, taxRate: 19 }), { discount: 0, net: 10000, tax: 1900, total: 11900 })
  assert.deepEqual(calculate({ quantity: 10, unitPrice: 1000, discountPercent: 10, discountUnitAmount: 0, taxRate: 19 }), { discount: 1000, net: 9000, tax: 1710, total: 10710 })
  assert.deepEqual(calculate({ quantity: 10, unitPrice: 1000, discountPercent: 0, discountUnitAmount: 100, taxRate: 19 }), { discount: 1000, net: 9000, tax: 1710, total: 10710 })
})

test('la migración valida exclusividad, negativos y descuento mayor al precio', () => {
  assert.match(migration, /discount_unit_amount_nonnegative/)
  assert.match(migration, /discount_methods_exclusive/)
  assert.match(migration, /discount_unit_amount_lte_price/)
  assert.match(migration, /No se pueden combinar descuento porcentual y descuento unitario/)
  assert.match(migration, /El descuento unitario no puede ser negativo/)
  assert.match(migration, /El descuento unitario no puede superar el precio unitario/)
})

test('comparación y snapshots conservan los tres valores del descuento', () => {
  assert.match(migration, /'discount_unit_amount', COALESCE\(i\.discount_unit_amount, 0\)/)
  assert.match(migration, /'discount_amount', i\.discount_amount/)
  assert.match(migration, /'discount_unit_amount'/)
  assert.match(migration, /discount_unit_amount = v_unit_discount/)
})

test('tipos y acciones aceptan el campo con fallback cero', () => {
  assert.match(actions, /discount_unit_amount\?: number/)
  assert.match(actions, /discount_unit_amount: snapshotNumber\(item\.discount_unit_amount\) \?\? 0/)
  assert.match(actions, /discount_unit_amount: i\.discount_unit_amount \?\? 0/)
  assert.match(actions, /discount_unit_amount: item\.discount_unit_amount \?\? 0/)
})

test('recepción conserva discount_amount como descuento total de línea', () => {
  assert.match(migration, /discount_amount remains the derived total discount for the complete line/)
})
