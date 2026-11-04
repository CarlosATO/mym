import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20261030100000_logistica_preparation_incident_verification_strict.sql', import.meta.url), 'utf8')

function compare(prepared, current, { syncProven = true } = {}) {
  if (!syncProven) return 'MISMATCHED'
  const key = (line) => line.sku ? `SKU:${line.sku.trim().toUpperCase()}` : line.variantId == null ? null : `VARIANT:${line.variantId}`
  const preparedKeys = new Map()
  const currentKeys = new Map()
  for (const line of prepared) {
    const productKey = key(line)
    const entry = preparedKeys.get(productKey) ?? { count: 0, quantity: 0 }
    entry.count += 1
    entry.quantity += line.preparedQuantity ?? 0
    preparedKeys.set(productKey, entry)
  }
  for (const line of current) {
    const productKey = key(line)
    const entry = currentKeys.get(productKey) ?? { count: 0, quantity: 0 }
    entry.count += 1
    entry.quantity += line.quantity ?? 0
    currentKeys.set(productKey, entry)
  }
  if ([...preparedKeys, ...currentKeys].some(([productKey]) => productKey == null)) return 'MISMATCHED'
  if ([...preparedKeys.values(), ...currentKeys.values()].some(entry => entry.count > 1)) return 'MISMATCHED'
  const keys = new Set([...preparedKeys.keys(), ...currentKeys.keys()])
  for (const productKey of keys) {
    const expected = preparedKeys.get(productKey)?.quantity ?? 0
    const observed = currentKeys.get(productKey)?.quantity ?? 0
    if (expected !== observed) return 'MISMATCHED'
  }
  return 'MATCHED'
}

test('la migración reemplaza sólo la función de verificación y conserva el contrato', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION logistica\.verify_open_preparation_incidents_v1\(/)
  assert.match(migration, /status = CASE WHEN c\.verification_status = 'MATCHED' THEN 'RESOLVED' ELSE 'OPEN' END/)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION logistica\.verify_open_preparation_incidents_v1\(uuid, bigint\[\]\)\s+TO service_role/)
  assert.doesNotMatch(migration, /sales_order_audits|sales_order_audit_incidents|invoice_attempt_prevalidate|begin_sales_order_invoice_submission/)
  assert.doesNotMatch(migration, /fetch\(|bsaleWrite|\/documents\.json/)
})

test('línea eliminada: sólo coincide cuando el conjunto preparado también tiene cantidad cero', () => {
  assert.equal(compare([{ sku: '43165', preparedQuantity: 0 }], []), 'MATCHED')
  assert.equal(compare([{ sku: '43165', preparedQuantity: 0 }], [{ sku: '43165', quantity: 1 }]), 'MISMATCHED')
})

test('cantidad reducida correcta y cantidad todavía incorrecta', () => {
  const prepared = [{ sku: 'A', preparedQuantity: 2 }]
  assert.equal(compare(prepared, [{ sku: 'A', quantity: 2 }]), 'MATCHED')
  assert.equal(compare(prepared, [{ sku: 'A', quantity: 3 }]), 'MISMATCHED')
})

test('cambio de detail_id se acepta sólo con identidad comercial única', () => {
  assert.equal(compare([{ detailId: 10, sku: 'A', preparedQuantity: 2 }], [{ detailId: 99, sku: 'A', quantity: 2 }]), 'MATCHED')
  assert.equal(compare([{ detailId: 10, sku: 'A', preparedQuantity: 2 }], [{ detailId: 99, sku: 'B', quantity: 2 }]), 'MISMATCHED')
})

test('SKU repetido, variante ambigua o identidad incompleta permanecen pendientes', () => {
  assert.equal(compare([{ sku: 'A', preparedQuantity: 1 }], [{ sku: 'A', quantity: 1 }, { sku: 'A', quantity: 0 }]), 'MISMATCHED')
  assert.equal(compare([{ variantId: 7, preparedQuantity: 1 }], [{ variantId: 7, quantity: 1 }, { variantId: 7, quantity: 1 }]), 'MISMATCHED')
  assert.equal(compare([{ preparedQuantity: 1 }], [{ quantity: 1 }]), 'MISMATCHED')
})

test('NV canónica diferente, snapshot incompleto o desactualizado no resuelven', () => {
  assert.match(migration, /COALESCE\(c\.current_bsale_nv_id, c\.bsale_nv_id\)/)
  assert.match(migration, /d\.sync_completed_at >= d\.latest_incident_at/)
  assert.match(migration, /d\.document_synced_at >= d\.latest_incident_at/)
  assert.match(migration, /stale_detail\.bsale_sync_run_id IS DISTINCT FROM d\.bsale_sync_run_id/)
  assert.equal(compare([{ sku: 'A', preparedQuantity: 1 }], [{ sku: 'A', quantity: 1 }], { syncProven: false }), 'MISMATCHED')
})

test('la repetición sólo actualiza incidencias OPEN y no crea registros', () => {
  assert.match(migration, /i\.status = 'OPEN'/)
  assert.match(migration, /UPDATE logistica\.sales_order_preparation_incidents i/)
  assert.doesNotMatch(migration, /INSERT INTO logistica\.sales_order_preparation_incidents/)
  assert.match(migration, /verification_basis', 'FULL_CARD_PRODUCT_QUANTITY_SET'/)
})

test('la auditoría física y el movimiento de tarjeta quedan fuera de MEJ-01B', () => {
  assert.doesNotMatch(migration, /UPDATE logistica\.sales_order_preparation_cards/)
  assert.doesNotMatch(migration, /UPDATE logistica\.sales_order_audits/)
  assert.doesNotMatch(migration, /INVOICED_READY_FOR_ROUTE/)
})
