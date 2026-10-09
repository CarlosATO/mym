import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyNonPnlMovement, consolidatedNonPnlImpact } from '../src/lib/control-financiero/non-pnl-classification.ts'

test('internal transfers cancel in consolidated cash and loan payment remains gross', () => {
  const movements = [
    { categoryCode: 'EXPENSE_INTERNAL_TRANSFER', direction: 'DEBE', amount: 1000, description: 'Banco Chile a Itaú' },
    { categoryCode: 'INCOME_INTERNAL_TRANSFER', direction: 'HABER', amount: 1000, description: 'Abono transferencia propia' },
    { categoryCode: 'EXPENSE_FINANCING', direction: 'DEBE', amount: 1000, description: 'Cuota Prestamo' },
  ]
  const consolidatedCashImpact = movements.reduce((total, movement) => total + consolidatedNonPnlImpact(movement), 0)
  const loanPayment = movements
    .filter(movement => movement.categoryCode === 'EXPENSE_FINANCING' && classifyNonPnlMovement(movement.description) === 'LOAN_PAYMENT')
    .reduce((total, movement) => total + movement.amount, 0)
  assert.equal(consolidatedCashImpact, -1000)
  assert.equal(loanPayment, 1000)
  assert.equal(classifyNonPnlMovement('PRESTAMO'), 'LOAN_RECEIPT')
  assert.equal(classifyNonPnlMovement('ABONO DESDE LINEA DE CREDITO'), 'CREDIT_LINE_DRAW')
  assert.notEqual(consolidatedCashImpact, -2000)
})

test('internal transfer descriptions cannot become loan payments', () => {
  assert.equal(classifyNonPnlMovement('TRASPASO A ITAU'), null)
  assert.equal(classifyNonPnlMovement('Cargo Ctacte Por Traspaso Lc'), 'CREDIT_LINE_PAYMENT')
  assert.equal(classifyNonPnlMovement('CARGO CTA CTE POR TRASPASO LC'), 'CREDIT_LINE_PAYMENT')
  assert.equal(classifyNonPnlMovement('PAGO DE CREDITOS M/N'), 'LOAN_PAYMENT')
})

test('line credit payment and net balance use the real movement shape', () => {
  const repayments = [3000000, 3000000, 3000000, 3000000, 4803089]
  const draws = [4528901, 4858421, 4812500, 4802171]
  const paymentMovements = repayments.map(amount => ({ description: 'Cargo Ctacte Por Traspaso Lc', amount }))
  assert.equal(paymentMovements.filter(movement => classifyNonPnlMovement(movement.description) === 'CREDIT_LINE_PAYMENT').length, 5)
  const paymentTotal = paymentMovements.reduce((total, movement) => total + movement.amount, 0)
  const drawTotal = draws.reduce((total, amount) => total + amount, 0)
  assert.equal(paymentTotal, 16803089)
  assert.equal(drawTotal - paymentTotal, 2198904)
})
