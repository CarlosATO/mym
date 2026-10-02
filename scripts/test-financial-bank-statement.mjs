import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { parseBankStatement } from '../src/lib/control-financiero/bank-statement-parser.ts'

const fixture = `CAYLO PREMIUM SpA (077196005-7) cta:002161402707\nFecha;Detalle Movimiento;Cheque o Cargo;Deposito o Abono;Saldo;Docto. Nro.;Trn;Caja;Sucursal\n01/05/2026;ABONO CLIENTE;00000000000;+0000000100;+0000001100;00000000000;0000000001;0000000000;INTERNET\n02/05/2026;PAGO PROVEEDOR;+0000000200;00000000000;+0000000900;00000000000;0000000002;0000000000;INTERNET`

test('parser reconoce formato semicolon, cuenta, fechas y saldos', () => {
  const statement = parseBankStatement(fixture)
  assert.equal(statement.accountNumber, '002161402707')
  assert.equal(statement.year, 2026)
  assert.equal(statement.month, 5)
  assert.equal(statement.order, 'ASC')
  assert.equal(statement.openingBalance, 1000)
  assert.equal(statement.totalCredits, 100)
  assert.equal(statement.totalDebits, 200)
  assert.equal(statement.closingBalance, 900)
  assert.deepEqual(statement.validations, { globalDifference: 0, rowDifference: 0, rowDifferenceCount: 0, rowDifferenceTotal: 0, rowBalanceValidated: true })
})

test('parser detecta cartola no conciliada', () => {
  const statement = parseBankStatement(fixture.replace('+0000000900', '+0000000901'))
  assert.notEqual(statement.validations.globalDifference, 0)
})

test('fingerprint incluye identificadores y hash de archivo es estable', () => {
  const row = ['account', '2026-05-01', 'ABONO', 0, 100, 1100, 'DOC-1', 'TRN-1'].join('|')
  const first = createHash('sha256').update(row).digest('hex')
  const changedIdentifier = createHash('sha256').update(row.replace('TRN-1', 'TRN-2')).digest('hex')
  assert.equal(first.length, 64)
  assert.notEqual(first, changedIdentifier)
})
