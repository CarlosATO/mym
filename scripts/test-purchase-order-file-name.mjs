import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPurchaseOrderFileNameBase } from '../src/lib/adquisiciones/purchase-order-file-name.ts'

test('builds the requested HAGEN filename', () => {
  assert.equal(
    buildPurchaseOrderFileNameBase('HAGEN CHILE S.P.A.', 'OC-2026-000027'),
    'OC_HAGEN_CHILE_SPA_2026-000027',
  )
})

test('removes accents, invalid characters, and duplicate separators', () => {
  assert.equal(
    buildPurchaseOrderFileNameBase(' Comercial José / Pérez | Ltda. ', 'OC-2026-000027'),
    'OC_COMERCIAL_JOSE_PEREZ_LTDA_2026-000027',
  )
})

test('removes only the OC- prefix from the correlative', () => {
  assert.equal(buildPurchaseOrderFileNameBase('Proveedor', 'OC-OC-2026-000027'), 'OC_PROVEEDOR_OC-2026-000027')
})
