import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveInboxDueDate } from '../src/modules/cuentas-por-pagar/inbox-due-date.ts'

const product = { candidate_id: 'receipt', invoice_id: null, purchase_type: 'PRODUCTS' }
const suggestion = { candidate_id: 'receipt', invoice_id: null, due_date: '2027-01-20', suggested_due_date: '2027-01-20', due_date_source: 'PURCHASE_ORDER' }

test('muestra sugerencia de Bodega y permite corrección vacía sin perderla localmente', () => {
  const initial = resolveInboxDueDate(product, undefined, suggestion, undefined)
  assert.equal(initial.date, '2027-01-20')
  assert.equal(initial.source, 'PURCHASE_ORDER')
  const changed = resolveInboxDueDate(product, undefined, suggestion, { date: null, baseKey: initial.baseKey })
  assert.equal(changed.date, null)
  assert.equal(changed.source, 'MANUAL')
})

test('descarta la edición local al llegar una versión distinta del servidor', () => {
  const initial = resolveInboxDueDate(product, undefined, suggestion, undefined)
  const saved = { ...suggestion, due_date: '2027-02-10', due_date_source: 'MANUAL' }
  const current = resolveInboxDueDate(product, undefined, saved, { date: '2027-02-10', baseKey: initial.baseKey })
  assert.equal(current.date, '2027-02-10')
  assert.equal(current.source, 'MANUAL')
  assert.notEqual(current.baseKey, initial.baseKey)
})

test('respeta vencimiento vacío guardado y fecha de servicios aun sin resumen', () => {
  const service = { candidate_id: 'service:1', invoice_id: '1', purchase_type: 'SERVICES', due_date: '2027-03-01' }
  assert.equal(resolveInboxDueDate(service, undefined, undefined, undefined).date, '2027-03-01')
  assert.equal(resolveInboxDueDate(service, { due_date: null }, undefined, undefined).date, null)
})
