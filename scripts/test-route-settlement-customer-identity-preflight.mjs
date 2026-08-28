import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const action = await readFile(new URL('../src/app/actions/adquisiciones/rendicion-rutas.ts', import.meta.url), 'utf8')
const sync = await readFile(new URL('../src/app/actions/integraciones/bsale-sync.ts', import.meta.url), 'utf8')
const migration = await readFile(new URL('../supabase/migrations/20260828110000_route_settlement_bulk_identity_error.sql', import.meta.url), 'utf8')

test('el preflight sólo sincroniza folios faltantes y bloquea antes del bulk', () => {
  assert.match(action, /export async function ensureRouteSettlementCustomerIdentities\(/)
  assert.match(action, /customer_bsale_id == null/)
  assert.match(action, /invoice_numbers: invoiceNumbers/)
  assert.match(action, /identityPreflight\.status === 'BLOCKED'/)
  assert.match(action, /record_route_settlement_bulk/)
})

test('la convergencia sólo actualiza identidades NULL', () => {
  assert.match(action, /update\(\{ customer_bsale_id: customerId \}\)[\s\S]{0,180}is\('customer_bsale_id', null\)/)
  assert.match(action, /document_type_id === 5/)
  assert.match(action, /Number\(document\.state\) === 0/)
  assert.match(action, /current\.length !== 1/)
})

test('el RPC diferencia item ajeno de cliente Bsale no identificado', () => {
  assert.match(migration, /IF NOT FOUND THEN RAISE EXCEPTION 'La factura no pertenece a la rendición\.'/)
  assert.match(migration, /No se puede grabar la factura % porque no se pudo identificar su cliente en Bsale\./)
  assert.match(migration, /v_invoice_number/)
})

test('el preflight conserva la ambigüedad informada por Bsale', () => {
  assert.match(sync, /Más de un documento/)
  assert.match(action, /multiple/)
  assert.match(action, /ambig/)
  assert.match(action, /CUSTOMER_AMBIGUOUS/)
})
