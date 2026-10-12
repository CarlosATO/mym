import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { extractItauPdfText, parseItauStatementText } from '../src/lib/control-financiero/bank-statement-parser.ts'

const pdfPath = process.env.ITAU_CURRENT_PDF_PATH || `${process.env.HOME}/Downloads/Itau_empresas.pdf`

test('parsea el PDF Itaú real local cuando está disponible', { skip: !fs.existsSync(pdfPath) }, async () => {
  const text = await extractItauPdfText(new Uint8Array(fs.readFileSync(pdfPath)))
  const parsed = parseItauStatementText(text)
  assert.equal(parsed.sourceFormat, 'ITAU_CURRENT_PDF')
  assert.equal(parsed.rowCount, 14)
  assert.equal(parsed.accountNumber, '0231417323')
  assert.equal(parsed.year, 2026)
  assert.equal(parsed.month, 10)
  assert.equal(parsed.order, 'DESC')
  assert.equal(parsed.firstTransactionDate, '2026-10-01')
  assert.equal(parsed.lastTransactionDate, '2026-10-07')
  assert.equal(parsed.openingBalance, -2603267)
  assert.equal(parsed.totalCredits, 14987671)
  assert.equal(parsed.totalDebits, 12384404)
  assert.equal(parsed.closingBalance, 0)
  assert.equal(parsed.validations.globalDifference, 0)
  assert.equal(parsed.validations.rowDifference, 0)
  assert.equal(parsed.creditLineAvailable, 213425)
  const salary = parsed.movements.find(row => row.description === 'Sueldo Sep 2026')
  assert.deepEqual(
    { document: salary?.documentNumber, branch: salary?.branch, credit: salary?.credit, debit: salary?.debit, balance: salary?.balance },
    { document: '526252201', branch: '1980', credit: 0, debit: 7396733, balance: 0 },
  )
  const transfer = parsed.movements.find(row => row.documentNumber === '603562347')
  assert.deepEqual(
    { credit: transfer?.credit, debit: transfer?.debit, balance: transfer?.balance },
    { credit: 5000000, debit: 0, balance: 2396733 },
  )
  assert.equal(parsed.movements.find(row => row.documentNumber === '603562349')?.balance, 7396733)
  assert.deepEqual(
    { credit: parsed.movements.find(row => row.description === 'Cuota Prestamo')?.credit, debit: parsed.movements.find(row => row.description === 'Cuota Prestamo')?.debit, balance: parsed.movements.find(row => row.description === 'Cuota Prestamo')?.balance },
    { credit: 0, debit: 4757601, balance: -4757601 },
  )
  const last = parsed.movements.at(-1)
  assert.deepEqual(
    { date: last?.date, description: last?.description, credit: last?.credit, debit: last?.debit, balance: last?.balance },
    { date: '2026-10-07', description: 'Abono Desde Linea De Credito', credit: 3079, debit: 0, balance: 0 },
  )
  console.log(JSON.stringify({ pdfPath, sourceFormat: parsed.sourceFormat, movements: parsed.rowCount, credits: parsed.totalCredits, debits: parsed.totalDebits, opening: parsed.openingBalance, closing: parsed.closingBalance }))
})
