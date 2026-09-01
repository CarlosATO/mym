import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const action = await readFile(new URL('../src/app/actions/adquisiciones/rendicion-rutas.ts', import.meta.url), 'utf8')

function groupInvoices(rows, clients) {
  const groups = new Map()
  for (const row of rows) {
    const key = row.customer_bsale_id == null ? `unresolved:${row.settlement_item_id}` : `bsale:${row.customer_bsale_id}`
    const group = groups.get(key) ?? { customer_bsale_id: row.customer_bsale_id, invoices: [], customer_name: row.customer_name }
    const canonical = clients.get(row.customer_bsale_id)
    group.customer_name = canonical?.business_name || row.customer_name
    group.invoices.push(row.invoice_number)
    groups.set(key, group)
  }
  return [...groups.values()]
}

test('usa business_name de Bsale como nombre canonico y conserva fallback', () => {
  const groups = groupInvoices([
    { settlement_item_id: 'a', invoice_number: '1', customer_bsale_id: 123, customer_name: 'Eli' },
    { settlement_item_id: 'b', invoice_number: '2', customer_bsale_id: 456, customer_name: 'Otro histórico' },
    { settlement_item_id: 'c', invoice_number: '3', customer_bsale_id: 789, customer_name: 'Sin maestro' },
  ], new Map([[123, { business_name: 'Elizabeth González SpA' }], [456, { business_name: 'Cliente Dos' }]]))
  assert.deepEqual(groups.map(group => group.customer_name), ['Elizabeth González SpA', 'Cliente Dos', 'Sin maestro'])
})

test('agrupa IDs iguales, separa IDs distintos y nunca colapsa NULL', () => {
  const groups = groupInvoices([
    { settlement_item_id: 'a', invoice_number: '1', customer_bsale_id: 123, customer_name: 'A' },
    { settlement_item_id: 'b', invoice_number: '2', customer_bsale_id: 123, customer_name: 'A histórica' },
    { settlement_item_id: 'c', invoice_number: '3', customer_bsale_id: 456, customer_name: 'B' },
    { settlement_item_id: 'd', invoice_number: '4', customer_bsale_id: null, customer_name: 'X' },
    { settlement_item_id: 'e', invoice_number: '5', customer_bsale_id: null, customer_name: 'Y' },
  ], new Map())
  assert.equal(groups.length, 4)
  assert.deepEqual(groups.map(group => group.invoices), [['1', '2'], ['3'], ['4'], ['5']])
})

test('la capa de aplicacion consulta Bsale en batch y separa NULL por settlement_item_id', () => {
  assert.match(action, /normalizeRouteSettlementCustomerNames\(/)
  assert.match(action, /\.from\('bsale_clients'\)/)
  assert.match(action, /\.in\('bsale_client_id', customerIds\)/)
  assert.match(action, /client\.invoices\.map\(invoice =>/)
  assert.match(action, /settlement_item_id/)
  assert.match(action, /business_name/)
})
