import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parseItauStatementText } from '../src/lib/control-financiero/bank-statement-parser.ts'

const fixture = `Banco Itaú
Cartola Histórica
Período: 01/02/2026 - 28/02/2026
Número de cuenta: 00123456789
Nombre: CAYLO PREMIUM SpA
Saldo anterior cuenta corriente: 10.000.000
Monto línea de crédito: 50.000.000
Monto utilizado: 4.000.000
Monto disponible: 46.000.000
Fecha Nº Operación Sucursal Descripción Depósitos o abonos Giros o cargos Saldo diario
01/02/2026 1001 001 Abono Desde Linea De Credito 148.798.500 - 158.798.500
02/02/2026 1002 001 Cuota Prestamo - 4.757.601 154.040.899
03/02/2026 1003 001 Cargo Ctacte Por Traspaso Lc - 200.000.000 -45.959.101`
const currentFixture = fs.readFileSync(new URL('./fixtures/itau-current-open.txt', import.meta.url), 'utf8')

test('parsea columnas Itaú, cuenta, período y línea de crédito', () => {
  const parsed = parseItauStatementText(fixture)
  assert.equal(parsed.sourceFormat, 'ITAU_PDF')
  assert.equal(parsed.bankName, 'Itaú')
  assert.equal(parsed.accountNumber, '00123456789')
  assert.equal(parsed.year, 2026)
  assert.equal(parsed.month, 2)
  assert.equal(parsed.openingBalance, 10000000)
  assert.equal(parsed.creditLineTotal, 50000000)
  assert.equal(parsed.creditLineUsed, 4000000)
  assert.equal(parsed.creditLineAvailable, 46000000)
  assert.equal(parsed.movements[0].credit, 148798500)
  assert.equal(parsed.movements[1].debit, 4757601)
  assert.equal(parsed.movements[2].balance, -45959101)
  assert.equal(parsed.totalCredits, 148798500)
  assert.equal(parsed.totalDebits, 204757601)
})

test('rechaza una cartola Itaú con más de un período mensual', () => {
  assert.throws(
    () => parseItauStatementText(fixture.replace('03/02/2026', '03/03/2026')),
    /un solo período mensual/,
  )
})

test('acepta fechas de movimiento DD/MM usando el año del período', () => {
  const shortDateFixture = fixture
    .replace('01/02/2026 1001', '01/02 1001')
    .replace('02/02/2026 1002', '02/02 1002')
    .replace('03/02/2026 1003', '03/02 1003')
  const parsed = parseItauStatementText(shortDateFixture)
  assert.equal(parsed.firstTransactionDate, '2026-02-01')
  assert.equal(parsed.lastTransactionDate, '2026-02-03')
})

test('mantiene el parser Banco de Chile independiente del formato Itaú', () => {
  assert.throws(
    () => parseItauStatementText(fixture.replace('Banco Itaú', 'Banco de Chile')),
    /Itaú Empresas/,
  )
})

test('parsea Itaú de mes abierto, conserva columnas vacías y calcula continuidad', () => {
  const parsed = parseItauStatementText(currentFixture)
  assert.equal(parsed.sourceFormat, 'ITAU_CURRENT_PDF')
  assert.equal(parsed.accountNumber, '0231417323')
  assert.equal(parsed.year, 2026)
  assert.equal(parsed.month, 10)
  assert.equal(parsed.order, 'DESC')
  assert.equal(parsed.openingBalance, -2603267)
  assert.equal(parsed.totalCredits, 14987671)
  assert.equal(parsed.totalDebits, 12384404)
  assert.equal(parsed.closingBalance, 0)
  assert.equal(parsed.lastTransactionDate, '2026-10-07')
  assert.equal(parsed.creditLineAvailable, 213425)
  assert.equal(parsed.rowCount, 14)
  assert.equal(parsed.validations.rowDifference, 0)
  assert.equal(parsed.validations.globalDifference, 0)
  assert.equal(parsed.movements[0].credit, 5000000)
  assert.equal(parsed.movements[1].credit, 5000000)
  const salary = parsed.movements.find(row => row.description === 'Sueldo Sep 2026')
  assert.deepEqual(
    { debit: salary?.debit, credit: salary?.credit, balance: salary?.balance, document: salary?.documentNumber, branch: salary?.branch },
    { debit: 7396733, credit: 0, balance: 0, document: '526252201', branch: '1980' },
  )
  const emptyDocument = parsed.movements.find(row => row.description === 'Abono Desde Linea De Credito')
  assert.equal(emptyDocument?.documentNumber, null)
  assert.equal(emptyDocument?.branch, '0029')
  assert.equal(parsed.movements.find(row => row.description === 'Cuota Prestamo')?.debit, 4757601)
})

test('parsea el reflujo PDF con documento y sucursal en líneas separadas', () => {
  const multiline = currentFixture.replace(
    '01/10/2026 526252201 1980 Sueldo Sep 2026 $ 7.396.733 $ 0',
    '01/10/2026\ndocumento 526252201\nsucursal 1980\nSueldo Sep 2026\n$ 7.396.733\n$ 0',
  )
  const parsed = parseItauStatementText(multiline)
  const salary = parsed.movements.find(row => row.description === 'Sueldo Sep 2026')
  assert.equal(salary?.documentNumber, '526252201')
  assert.equal(salary?.branch, '1980')
  assert.equal(salary?.debit, 7396733)
  assert.equal(salary?.balance, 0)
})

test('rechaza una consulta Itaú de múltiples meses', () => {
  assert.throws(
    () => parseItauStatementText(currentFixture.replace('07/10/2026 0011', '30/09/2026 0011')),
    /un solo período mensual/,
  )
})
