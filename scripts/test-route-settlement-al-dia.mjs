import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const clientViewPath = new URL('../src/modules/adquisiciones/rendicion-rutas/components/route-settlement-client-view.tsx', import.meta.url)
const formatterPath = new URL('../src/modules/adquisiciones/rendicion-rutas/utils/route-settlement-formatters.ts', import.meta.url)
const bulkMigrationPath = new URL('../supabase/migrations/20260826120000_route_settlement_bulk_record.sql', import.meta.url)
const [clientView, formatters, bulkMigration] = await Promise.all([
  readFile(clientViewPath, 'utf8'),
  readFile(formatterPath, 'utf8'),
  readFile(bulkMigrationPath, 'utf8'),
])

test('AL_DIA no tiene resultado rápido preseleccionado y se etiqueta Al día', () => {
  assert.match(clientView, /expected_payment_method === 'AL_DIA'\) return ''/)
  assert.match(clientView, /<option value="">Seleccionar resultado…<\/option>/)
  assert.match(clientView, /if \(method === 'AL_DIA'\) return 'Al día'/)
  assert.match(formatters, /case 'AL_DIA': return 'Al día'/)
})

test('AL_DIA bloquea el bulk seleccionado hasta elegir un resultado real', () => {
  assert.match(clientView, /Hay facturas seleccionadas con forma de pago \\'Al día\\'/)
  assert.match(clientView, /if \(!result\) return totals/)
  assert.match(bulkMigration, /v_result NOT IN \('CASH', 'CHECK', 'TRANSFER', 'CREDIT'\)/)
  assert.doesNotMatch(bulkMigration, /v_result NOT IN \('CASH', 'AL_DIA'/)
})
