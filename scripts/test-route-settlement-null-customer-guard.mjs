import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const path = new URL('../src/modules/adquisiciones/rendicion-rutas/components/route-settlement-client-view.tsx', import.meta.url)
const source = await readFile(path, 'utf8')

test('el drawer usa una clave UI distinta de customer_bsale_id', () => {
  assert.match(source, /useState<string \| null>\(null\)/)
  assert.match(source, /bsale:\$\{client\.customer_bsale_id\}/)
  assert.match(source, /unresolved:\$\{client\.invoices\[0\]\?\.settlement_item_id/)
  assert.match(source, /uiClients\.find\(client => clientUiKey\(client\) === selectedClientKey\)/)
  assert.match(source, /setSelectedClientKey\(null\)/)
})

test('los clientes NULL se separan por settlement_item_id sin inventar identidad', () => {
  assert.match(source, /function splitUnidentifiedClients/)
  assert.match(source, /client\.customer_bsale_id !== null \|\| client\.invoices\.length <= 1/)
  assert.match(source, /invoices: \[invoice\]/)
  assert.match(source, /Cliente sin ID Bsale/)
  assert.doesNotMatch(source, /customer_bsale_id = [0-9]/)
})
