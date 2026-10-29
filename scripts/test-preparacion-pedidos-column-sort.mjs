import assert from 'node:assert/strict'
import test from 'node:test'
import { getPreparationColumnSelectionIds, sortPreparationColumnCards } from '../src/modules/logistica/preparacion-pedidos/preparation-board-utils.ts'

const cards = [
  { card_id: 'a', nv_folio: '20', client_name: 'Zeta', normalized_city: 'Santiago', nv_emission_date: '2026-10-03', total_amount: 200 },
  { card_id: 'b', nv_folio: '10', client_name: 'Alfa', normalized_city: 'Talca', nv_emission_date: '2026-10-01', total_amount: 100 },
  { card_id: 'c', nv_folio: '30', client_name: 'Beta', normalized_city: 'Santiago', nv_emission_date: '2026-10-02', total_amount: 300 },
]

const ids = (sort, invoiceNumbers) => sortPreparationColumnCards(cards, sort, invoiceNumbers).map(card => card.card_id)

test('ordena independientemente por NV, fecha, cliente, comuna y monto', () => {
  assert.deepEqual(ids('nvAsc'), ['b', 'a', 'c'])
  assert.deepEqual(ids('nvDesc'), ['c', 'a', 'b'])
  assert.deepEqual(ids('dateAsc'), ['b', 'c', 'a'])
  assert.deepEqual(ids('clientAsc'), ['b', 'c', 'a'])
  assert.deepEqual(ids('comunaAsc'), ['a', 'c', 'b'])
  assert.deepEqual(ids('amountDesc'), ['c', 'a', 'b'])
})

test('mantiene el subconjunto filtrado y orden original', () => {
  const filtered = cards.filter(card => card.client_name !== 'Zeta')
  assert.deepEqual(sortPreparationColumnCards(filtered, 'default').map(card => card.card_id), ['b', 'c'])
})

test('ordena por el menor número de factura confirmado y deja faltantes al final', () => {
  const invoiceNumbers = new Map([['a', 24758], ['b', null], ['c', 24750]])
  assert.deepEqual(ids('invoiceAsc', invoiceNumbers), ['c', 'a', 'b'])
  assert.deepEqual(ids('invoiceDesc', invoiceNumbers), ['a', 'c', 'b'])
})

test('selecciona sólo tarjetas visibles elegibles de cada columna', () => {
  const board = [
    ...cards.map(card => ({ ...card, status: card.card_id === 'a' ? 'PENDING_ROUTE_PREP' : 'IN_PREPARATION' })),
    { ...cards[2], card_id: 'route', status: 'INVOICED_READY_FOR_ROUTE' },
  ]
  assert.deepEqual(getPreparationColumnSelectionIds('PENDING_ROUTE_PREP', board), ['a'])
  assert.deepEqual(getPreparationColumnSelectionIds('INVOICED_READY_FOR_ROUTE', board), ['route'])
  assert.deepEqual(getPreparationColumnSelectionIds('IN_AUDIT', board), [])
})
