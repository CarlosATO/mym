import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveCasaMatrizOfficeId } from '../src/lib/integraciones/bsale-mermas-office.ts'

test('uses the uniquely named Casa Matriz office', () => {
  assert.equal(resolveCasaMatrizOfficeId([
    { bsaleId: 7, name: 'Sucursal Norte' },
    { bsaleId: 1, name: 'Casa Matriz' },
  ], []), 1)
})

test('MYM fallback uses the unique office id in current stock', () => {
  assert.equal(resolveCasaMatrizOfficeId([], [
    { officeId: 1, rawJson: { office: { name: 'Bodega principal' } } },
    { officeId: 1, rawJson: { office: { name: 'Bodega principal' } } },
  ]), 1)
})

test('stock raw_json Casa Matriz wins before the generic unique-office fallback', () => {
  assert.equal(resolveCasaMatrizOfficeId([], [
    { officeId: 1, rawJson: { office: { name: 'Casa Matriz' } } },
    { officeId: 2, rawJson: { office: { name: 'Sucursal' } } },
  ]), 1)
})

test('ambiguous offices fail closed', () => {
  assert.throws(() => resolveCasaMatrizOfficeId([], [
    { officeId: 1, rawJson: { office: { name: 'Sucursal Norte' } } },
    { officeId: 2, rawJson: { office: { name: 'Sucursal Sur' } } },
  ]), /única oficina CASA MATRIZ/)
})
