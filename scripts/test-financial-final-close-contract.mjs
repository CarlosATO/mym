import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parseDefinitiveBankStatement } from '../src/lib/control-financiero/bank-statement-parser.ts'
import { buildOpenMovementKeys, compareOpenMovements } from '../src/lib/control-financiero/open-bank-statement.ts'

const migration = fs.readFileSync('supabase/migrations/20261003220000_financial_finalize_open_bank_statement.sql', 'utf8')

const fixture = `CAYLO PREMIUM SpA (077196005-7) cta:002161402707
Fecha;Detalle Movimiento;Cheque o Cargo;Deposito o Abono;Saldo;Docto. Nro.;Trn;Caja;Sucursal
01/05/2026;ABONO CLIENTE;00000000000;+0000000100;+0000001100;00000000000;0000000001;0000000000;INTERNET
02/05/2026;PAGO PROVEEDOR;+0000000200;00000000000;+0000000900;00000000000;0000000002;0000000000;INTERNET`

test('definitive parser accepts the semicolon export and requires exact reconciliation', () => {
  const parsed = parseDefinitiveBankStatement(fixture)
  assert.equal(parsed.sourceFormat, 'HISTORICAL_SEMICOLON')
  assert.equal(parsed.validations.globalDifference, 0)
  assert.equal(parsed.validations.rowDifference, 0)
})

test('definitive comparison preserves existing rows and identifies missing rows', () => {
  const parsed = parseDefinitiveBankStatement(fixture)
  const keys = buildOpenMovementKeys('account-caylo', parsed.movements)
  const partial = compareOpenMovements(keys, [keys[0]])
  assert.deepEqual(partial, { existing: 1, new: 1, conflicts: 0, newIndexes: [1], conflictIndexes: [] })
})

test('finalization migration is atomic, OPEN-only and service-role restricted', () => {
  assert.match(migration, /BANK_STATEMENT_FINAL_CLOSE/)
  assert.match(migration, /status <> 'OPEN'/)
  assert.match(migration, /omite movimientos ya confirmados/)
  assert.match(migration, /status = 'CLOSED'/)
  assert.match(migration, /revoke all on function comercial\.finalize_financial_bank_statement_open[\s\S]*grant execute[\s\S]*to service_role/)
})
