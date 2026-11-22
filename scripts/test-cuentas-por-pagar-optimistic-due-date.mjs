import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveInboxDueDate, saveOptimisticDueDate } from '../src/modules/cuentas-por-pagar/inbox-due-date.ts'

const row = { candidate_id: 'receipt', invoice_id: null, purchase_type: 'PRODUCTS' }
const due = { candidate_id: 'receipt', invoice_id: null, due_date: '2027-01-20', suggested_due_date: '2027-01-20', due_date_source: 'PURCHASE_ORDER' }
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function harness() {
  const locks = new Set()
  const pending = new Map()
  const confirmed = new Map()
  const errors = []
  let requests = 0
  function save(id, date, request, keys = [id]) {
    return saveOptimisticDueDate({
      locks, keys,
      start: () => pending.set(id, { date, baseKey: 'old', confirmed: true, source: 'MANUAL' }),
      request: () => { requests++; return request },
      success: result => confirmed.set(id, { date: result, baseKey: 'old', confirmed: true, source: 'MANUAL' }),
      failure: error => errors.push(error.message),
      finish: () => pending.delete(id),
    })
  }
  return { save, pending, confirmed, errors, get requests() { return requests } }
}

test('la fecha pendiente sobrevive a nuevas propiedades y se consolida con el resultado del servidor', async () => {
  const h = harness()
  const response = deferred()
  const saving = h.save('receipt', '2027-02-10', response.promise)
  const changedProps = { ...due, due_date: '2027-01-25' }
  assert.equal(resolveInboxDueDate(row, undefined, changedProps, h.pending.get('receipt')).date, '2027-02-10')
  assert.equal(h.confirmed.size, 0)
  response.resolve('2027-02-11')
  await saving
  assert.equal(h.pending.size, 0)
  assert.equal(resolveInboxDueDate(row, undefined, changedProps, h.confirmed.get('receipt')).date, '2027-02-11')
})

test('un error restaura la corrección previa, informa el error y permite reintentar', async () => {
  const h = harness()
  h.confirmed.set('receipt', { date: '2027-02-01', baseKey: 'old', confirmed: true, source: 'MANUAL' })
  const response = deferred()
  const saving = h.save('receipt', null, response.promise)
  assert.equal(resolveInboxDueDate(row, undefined, due, h.pending.get('receipt')).date, null)
  response.reject(new Error('Fecha rechazada'))
  await saving
  assert.deepEqual(h.errors, ['Fecha rechazada'])
  assert.equal(resolveInboxDueDate(row, undefined, due, h.confirmed.get('receipt')).date, '2027-02-01')
  await h.save('receipt', null, Promise.resolve(null))
  assert.equal(h.confirmed.get('receipt').date, null)
})

test('bloquea duplicados por identidad y permite guardar otra factura simultáneamente', async () => {
  const h = harness()
  const first = deferred()
  const second = deferred()
  const a = h.save('receipt', '2027-02-01', first.promise, ['candidate:receipt', 'invoice:1'])
  assert.equal(await h.save('other-key', '2027-03-01', Promise.resolve(null), ['invoice:1']), false)
  const b = h.save('other', '2027-04-01', second.promise, ['invoice:2'])
  assert.equal(h.requests, 2)
  assert.equal(h.pending.size, 2)
  second.resolve('2027-04-01')
  first.resolve('2027-02-01')
  await Promise.all([a, b])
  assert.equal(h.pending.size, 0)
  assert.equal(h.confirmed.size, 2)
})
