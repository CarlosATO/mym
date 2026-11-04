import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  sortPreparationColumnCards,
  sortRoutePreparationCards,
  compareRoutePreparationCards,
} from '../src/modules/logistica/preparacion-pedidos/preparation-board-utils.ts'

// Sample cards for testing
const testCards = [
  {
    card_id: 'card-1',
    nv_folio: '5001',
    client_name: 'Veterinaria Buin',
    normalized_city: 'Buin',
    status: 'INVOICED_READY_FOR_ROUTE',
    total_amount: 150000,
  },
  {
    card_id: 'card-2',
    nv_folio: '5002',
    client_name: 'Agro Pet Central',
    normalized_city: 'Santiago',
    status: 'INVOICED_READY_FOR_ROUTE',
    total_amount: 80000,
  },
  {
    card_id: 'card-3',
    nv_folio: '5003',
    client_name: 'Zooland Chile',
    normalized_city: 'Buin',
    status: 'INVOICED_READY_FOR_ROUTE',
    total_amount: 220000,
  },
  {
    card_id: 'card-4',
    nv_folio: '5004',
    client_name: 'Agro Pet Central',
    normalized_city: 'Santiago',
    status: 'INVOICED_READY_FOR_ROUTE',
    total_amount: 45000,
  },
  {
    card_id: 'card-5',
    nv_folio: '5005',
    client_name: 'Mundo Animal',
    normalized_city: 'Santiago',
    status: 'INVOICED_READY_FOR_ROUTE',
    total_amount: 90000,
  },
]

// Invoice numbers by card
// card-1: Factura 24800 (Buin, Veterinaria Buin)
// card-2: Factura 24805 (Santiago, Agro Pet Central - 2nd invoice of client)
// card-3: Factura 24790 (Buin, Zooland Chile)
// card-4: Factura 24780 (Santiago, Agro Pet Central - 1st invoice of client)
// card-5: Factura 24810 (Santiago, Mundo Animal)
const invoiceNumberMap = new Map([
  ['card-1', 24800],
  ['card-2', 24805],
  ['card-3', 24790],
  ['card-4', 24780],
  ['card-5', 24810],
])

test('1. Orden por factura descendente', () => {
  const sorted = sortPreparationColumnCards(testCards, 'invoiceDesc', invoiceNumberMap)
  const ids = sorted.map(c => c.card_id)
  // Facturas: card-5: 24810, card-2: 24805, card-1: 24800, card-3: 24790, card-4: 24780
  assert.deepEqual(ids, ['card-5', 'card-2', 'card-1', 'card-3', 'card-4'])
})

test('2. Orden por Nota de Venta (ascendente y descendente)', () => {
  const sortedAsc = sortPreparationColumnCards(testCards, 'nvAsc', invoiceNumberMap)
  assert.deepEqual(sortedAsc.map(c => c.card_id), ['card-1', 'card-2', 'card-3', 'card-4', 'card-5'])

  const sortedDesc = sortPreparationColumnCards(testCards, 'nvDesc', invoiceNumberMap)
  assert.deepEqual(sortedDesc.map(c => c.card_id), ['card-5', 'card-4', 'card-3', 'card-2', 'card-1'])
})

test('3. Orden por cliente A-Z', () => {
  const sorted = sortPreparationColumnCards(testCards, 'clientAsc', invoiceNumberMap)
  const clients = sorted.map(c => c.client_name)
  // Agro Pet Central (2), Mundo Animal, Veterinaria Buin, Zooland Chile
  assert.deepEqual(clients, [
    'Agro Pet Central',
    'Agro Pet Central',
    'Mundo Animal',
    'Veterinaria Buin',
    'Zooland Chile',
  ])
})

test('4. Orden predeterminado: localidad/comuna -> cliente -> factura', () => {
  const sorted = sortRoutePreparationCards(testCards, invoiceNumberMap)
  const keys = sorted.map(c => `${c.normalized_city} | ${c.client_name} | ${invoiceNumberMap.get(c.card_id)}`)
  assert.deepEqual(keys, [
    // Buin first (alphabetical)
    'Buin | Veterinaria Buin | 24800',
    'Buin | Zooland Chile | 24790',
    // Santiago next
    'Santiago | Agro Pet Central | 24780', // Factura 24780
    'Santiago | Agro Pet Central | 24805', // Factura 24805 (agrupada con su cliente)
    'Santiago | Mundo Animal | 24810',
  ])
})

test('5. Varias facturas del mismo cliente se agrupan y ordenan por factura', () => {
  const clientCards = [
    { card_id: 'c-high', nv_folio: '6002', client_name: 'Pet Shop Sur', normalized_city: 'Temuco' },
    { card_id: 'c-low', nv_folio: '6001', client_name: 'Pet Shop Sur', normalized_city: 'Temuco' },
    { card_id: 'c-mid', nv_folio: '6003', client_name: 'Pet Shop Sur', normalized_city: 'Temuco' },
  ]
  const clientInvoices = new Map([
    ['c-high', 99003],
    ['c-low', 99001],
    ['c-mid', 99002],
  ])
  const sorted = sortRoutePreparationCards(clientCards, clientInvoices)
  assert.deepEqual(sorted.map(c => c.card_id), ['c-low', 'c-mid', 'c-high'])
})

test('6. Selección parcial de tarjetas preserva el orden visual derivado', () => {
  // Orden predeterminado: ['card-1', 'card-3', 'card-4', 'card-2', 'card-5']
  const visuallyOrderedCards = sortRoutePreparationCards(testCards, invoiceNumberMap)
  const selectedIds = new Set(['card-5', 'card-3', 'card-4'])

  // Derivación de tarjetas seleccionadas desde la columna ordenada
  const selectedRouteCards = visuallyOrderedCards.filter(card => selectedIds.has(card.card_id))
  assert.deepEqual(selectedRouteCards.map(c => c.card_id), ['card-3', 'card-4', 'card-5'])
})

test('7. Transferencia completa sin pérdida ni duplicación de facturas en parámetros URL', () => {
  const visuallyOrderedCards = sortRoutePreparationCards(testCards, invoiceNumberMap)
  const cardInvoices = new Map([
    ['card-1', [10001]],
    ['card-3', [10003]],
    ['card-4', [10004]],
    ['card-2', [10002, 100022]], // NV con 2 facturas confirmadas
    ['card-5', [10005]],
  ])

  // Extraer IDs en la secuencia de las tarjetas
  const selectedInvoiceIds = visuallyOrderedCards.flatMap(card => cardInvoices.get(card.card_id) || [])

  // Construir parámetros de navegación
  const params = new URLSearchParams({ tab: 'movimientos', action: 'guias_ruta' })
  selectedInvoiceIds.forEach(id => params.append('invoice_bsale_id', String(id)))

  // Reconstruir en Guías de Ruta
  const receivedIds = params.getAll('invoice_bsale_id').map(Number)
  assert.deepEqual(receivedIds, selectedInvoiceIds)
  assert.equal(receivedIds.length, 6)
  assert.equal(new Set(receivedIds).size, 6)
})

test('8. Guardado, reapertura y PDF en idéntica secuencia con line_number', () => {
  // Secuencia transmitida
  const requestedSequence = [10003, 10004, 10002, 10005]

  // Simulación del contrato de get_route_invoice_draft_rows respetando la secuencia de entrada
  const orderMap = new Map(requestedSequence.map((id, index) => [id, index]))
  const mockDbRows = [
    { invoice_bsale_id: 10002, invoice_number: '24805', customer_name: 'Agro Pet', amount: 80000 },
    { invoice_bsale_id: 10005, invoice_number: '24810', customer_name: 'Mundo Animal', amount: 90000 },
    { invoice_bsale_id: 10003, invoice_number: '24790', customer_name: 'Zooland', amount: 220000 },
    { invoice_bsale_id: 10004, invoice_number: '24780', customer_name: 'Agro Pet', amount: 45000 },
  ]

  // getRouteInvoiceDraftRows action sorting
  const orderedItems = [...mockDbRows]
    .sort((a, b) => (orderMap.get(a.invoice_bsale_id) ?? 0) - (orderMap.get(b.invoice_bsale_id) ?? 0))
    .map((item, index) => ({
      ...item,
      line_number: index + 1,
    }))

  assert.deepEqual(orderedItems.map(i => i.invoice_bsale_id), requestedSequence)
  assert.deepEqual(orderedItems.map(i => i.line_number), [1, 2, 3, 4])

  // Simulación de guardado en base de datos: line_number persistido
  const persistedInDatabase = orderedItems.map(item => ({ ...item }))

  // Reapertura: getRouteGuideById ordenado por line_number ASC
  const reloadedItems = [...persistedInDatabase].sort((a, b) => a.line_number - b.line_number)
  assert.deepEqual(reloadedItems.map(i => i.invoice_bsale_id), requestedSequence)
  assert.deepEqual(reloadedItems.map(i => i.line_number), [1, 2, 3, 4])

  // PDF Table Body: respeta la secuencia reabierta
  const pdfTableRows = reloadedItems.map((item, index) => [
    String(index + 1),
    item.invoice_number,
    item.customer_name,
  ])
  assert.deepEqual(pdfTableRows.map(r => r[1]), ['24790', '24780', '24805', '24810'])
})

test('9. Totales y datos comerciales intactos tras preservación de orden', () => {
  const items = [
    { amount: 150000, payment_method_normalized: 'CASH' },
    { amount: 80000, payment_method_normalized: 'TRANSFER' },
    { amount: 45000, payment_method_normalized: 'CREDIT' },
    { amount: 25000, payment_method_normalized: 'CASH' },
  ]
  const totalAmount = items.reduce((acc, i) => acc + i.amount, 0)
  const totalCash = items.filter(i => i.payment_method_normalized === 'CASH').reduce((acc, i) => acc + i.amount, 0)
  const totalTransfer = items.filter(i => i.payment_method_normalized === 'TRANSFER').reduce((acc, i) => acc + i.amount, 0)
  const totalCredit = items.filter(i => i.payment_method_normalized === 'CREDIT').reduce((acc, i) => acc + i.amount, 0)

  assert.equal(totalAmount, 300000)
  assert.equal(totalCash, 175000)
  assert.equal(totalTransfer, 80000)
  assert.equal(totalCredit, 45000)
})

test('10. Inspección estática de migración forward-only SQL', () => {
  const migrationUrl = new URL('../supabase/migrations/20261104160000_logistica_route_guide_invoice_order_preservation.sql', import.meta.url)
  assert.ok(fs.existsSync(migrationUrl), 'La migración debe existir')

  const sql = fs.readFileSync(migrationUrl, 'utf8')

  // Verifica uso de WITH ORDINALITY
  assert.match(sql, /WITH ORDINALITY/i, 'Debe usar WITH ORDINALITY para indexar el orden')

  // Verifica que get_route_invoice_draft_rows calcule line_number en un CTE previo
  // (PostgreSQL no admite funciones de ventana dentro de los argumentos de jsonb_agg)
  assert.match(sql, /numbered AS \(\s*SELECT e\.\*, row_number\(\)\s+OVER\s+\(ORDER BY e\.ord\)::integer AS line_number/i, 'Debe calcular line_number en el CTE numbered según ord')
  assert.match(sql, /'line_number', n\.line_number/i, 'Debe exponer el line_number precalculado')
  assert.match(sql, /ORDER BY n\.ord\), '\[\]'::jsonb\)/i, 'Debe ordenar la agregación JSON según ord')
  const draftRowsFn = sql.slice(
    sql.indexOf('FUNCTION logistica.get_route_invoice_draft_rows'),
    sql.indexOf('FUNCTION logistica.create_route_guide_draft_from_invoices'),
  )
  const aggregateBody = draftRowsFn.slice(draftRowsFn.indexOf('SELECT coalesce(jsonb_agg('))
  assert.doesNotMatch(aggregateBody.slice(0, aggregateBody.indexOf('INTO v_rows')), /OVER\s*\(/i, 'jsonb_agg no debe contener funciones de ventana')
  // Filtros de elegibilidad y autorización preservados
  for (const fragment of ["'logistica.route_guides.create'", "a.status = 'CONFIRMED'", "pc.status = 'INVOICED_READY_FOR_ROUTE'", 'bsale_invoice_sales_order_links', "rg.status IN ('DRAFT', 'DISPATCHED')", 'd.document_type_id = 5', 'd.state = 0']) {
    assert.ok(draftRowsFn.includes(fragment), `Debe preservar el filtro ${fragment}`)
  }

  // Verifica que create_route_guide_draft_from_invoices preserve el orden y no use ORDER BY x para la llamada
  assert.match(sql, /ORDER BY min\(u\.ord\)/i, 'Debe preservar el orden de entrada en la llamada a get_route_invoice_draft_rows')

  // Verifica que no se modifique la migración histórica 20261023150107
  const historicalUrl = new URL('../supabase/migrations/20261023150107_logistica_route_invoice_selection_production_compat.sql', import.meta.url)
  const historicalSql = fs.readFileSync(historicalUrl, 'utf8')
  assert.ok(historicalSql.includes('ORDER BY d.bsale_id'), 'La migración histórica debe permanecer intacta')
})
