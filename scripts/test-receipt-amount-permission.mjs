import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const action = await readFile(new URL('src/app/actions/logistica/recepciones.ts', root), 'utf8')
const page = await readFile(new URL('src/app/dashboard/logistica/recepciones/[poId]/page.tsx', root), 'utf8')
const worksheet = await readFile(new URL('src/modules/logistica/recepciones/receipt-worksheet.tsx', root), 'utf8')
const migration = await readFile(new URL('supabase/migrations/20261028150000_logistica_receipt_amounts_permission.sql', root), 'utf8')

test('permission is registered and assigned only to the active warehouse operator role', () => {
  assert.match(migration, /logistica\.receptions\.amounts\.view/)
  assert.match(migration, /name = 'OPERADOR_BODEGA'/)
  assert.match(migration, /ON CONFLICT \(role_id, permission_id\) DO NOTHING/)
  assert.doesNotMatch(migration, /role_permissions[\s\S]{0,300}adquisiciones\.po\.view/)
})

test('receipt amount authorization is server-side and separate from general purchase-order economics', () => {
  assert.match(action, /requireWmsPermission\('logistica\.receptions\.create'\)/)
  assert.match(action, /logistica\.receptions\.amounts\.view/)
  assert.match(action, /canViewReceiptAmounts = canViewEconomics \|\| await hasWmsPermission/)
  assert.match(action, /PO_ITEM_RECEIPT_AMOUNT_FIELDS = 'unit_price'/)
  assert.match(page, /canViewReceiptAmounts = canViewEconomics \|\| await hasWmsPermission/)
  assert.doesNotMatch(page, /roles\?\.name.*OPERADOR_BODEGA/)
})

test('worksheet shows summary for receipt-amount access but keeps line economics restricted', () => {
  assert.match(worksheet, /canViewReceiptAmounts: boolean/)
  assert.match(worksheet, /if \(canViewReceiptAmounts && poDetail\)/)
  assert.match(worksheet, /\{canViewReceiptAmounts && <div className=/)
  assert.match(worksheet, /if \(Number\(poItem\.quantity_pending \|\| 0\) <= 0\) return/)
  assert.match(worksheet, /canViewEconomics && <th[^>]*>P\. Unitario/)
})
