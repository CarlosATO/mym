import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getPreparationComuna,
  groupCardsByComuna,
  matchesPreparationSearch,
  prunePreparationSelection,
  sortPreparationCards,
  summarizePreparationSelection,
} from '../src/modules/logistica/preparacion-pedidos/preparation-board-utils.ts'
import { generatePreparationOrdersPdf } from '../src/lib/pdf/generate-preparation-orders-pdf.ts'

const cards = [
  {
    card_id: 'card-4961',
    nv_folio: '4961',
    client_name: 'Comercial X',
    normalized_city: 'Talca',
    municipality_raw: 'Talca',
    city_raw: 'Talca',
    address_raw: 'Av. Principal 123',
    seller_name: 'Ana Pérez',
    nv_emission_date: '2026-10-17T12:00:00.000Z',
    status: 'PENDING_ROUTE_PREP',
    total_quantity: 2,
  },
  {
    card_id: 'card-4994',
    nv_folio: '4994',
    client_name: 'Pet Shop Linares',
    normalized_city: 'Linares',
    municipality_raw: 'Linares',
    city_raw: 'Linares',
    address_raw: 'Calle Sur 45',
    seller_name: 'Bruno Díaz',
    nv_emission_date: '2026-10-19T12:00:00.000Z',
    status: 'PENDING_ROUTE_PREP',
    total_quantity: 5,
  },
  {
    card_id: 'card-5021',
    nv_folio: '5021',
    client_name: 'Agro Talca',
    normalized_city: 'Talca',
    municipality_raw: 'Talca',
    city_raw: 'Talca',
    address_raw: 'Ruta 5 km 4',
    seller_name: 'Ana Pérez',
    nv_emission_date: '2026-10-18T12:00:00.000Z',
    status: 'IN_PREPARATION',
    total_quantity: 3,
  },
]

test('buscador encuentra por NV, cliente, comuna y fecha', () => {
  assert.equal(matchesPreparationSearch(cards[0], '4961'), true)
  assert.equal(matchesPreparationSearch(cards[0], 'Comercial X'), true)
  assert.equal(matchesPreparationSearch(cards[0], 'Talca'), true)
  assert.equal(matchesPreparationSearch(cards[0], '17-10-2026'), true)
  assert.equal(matchesPreparationSearch(cards[0], '17/10/2026'), true)
  assert.equal(matchesPreparationSearch(cards[0], '2026-10-17'), true)
  assert.equal(matchesPreparationSearch(cards[0], 'Linares'), false)
})

test('buscador ignora acentos y exige todos los términos', () => {
  assert.equal(matchesPreparationSearch(cards[0], 'ana perez'), true)
  assert.equal(matchesPreparationSearch(cards[0], 'Comercial Talca'), true)
  assert.equal(matchesPreparationSearch(cards[0], 'Comercial Linares'), false)
})

test('orden por comuna agrupa y deja Talca contiguo', () => {
  const sorted = sortPreparationCards(cards, 'comuna')
  assert.deepEqual(sorted.map(card => getPreparationComuna(card)), ['Linares', 'Talca', 'Talca'])
  assert.equal(sorted[1].card_id, 'card-4961')
  assert.equal(sorted[2].card_id, 'card-5021')
})

test('orden por NV y por fecha son deterministas', () => {
  assert.deepEqual(sortPreparationCards(cards, 'nv').map(card => card.nv_folio), ['4961', '4994', '5021'])
  assert.deepEqual(sortPreparationCards(cards, 'date').map(card => card.nv_folio), ['4961', '5021', '4994'])
  assert.deepEqual(sortPreparationCards(cards, 'default').map(card => card.nv_folio), ['4961', '4994', '5021'])
})

test('la selección se conserva por card_id y se poda si deja de ser válida', () => {
  const selected = new Set(['card-4961', 'card-5021', 'card-inexistente'])
  const pruned = prunePreparationSelection(selected, cards)

  assert.deepEqual([...pruned], ['card-4961'])
  assert.equal(pruned.has('card-5021'), false, 'una tarjeta en preparación no sigue seleccionada')
})

test('la selección no depende del orden ni del filtro', () => {
  const selected = new Set(['card-4961', 'card-5021'])
  const reordered = sortPreparationCards(cards, 'comuna')
  const filtered = cards.filter(card => matchesPreparationSearch(card, 'Talca'))

  assert.deepEqual([...prunePreparationSelection(selected, reordered)].sort(), ['card-4961'])
  assert.deepEqual([...prunePreparationSelection(selected, filtered)].sort(), ['card-4961'])
})

test('resumen de selección cuenta NV, unidades y comunas', () => {
  const summary = summarizePreparationSelection([cards[0], cards[2]])
  assert.equal(summary.nvCount, 2)
  assert.equal(summary.units, 5)
  assert.deepEqual(summary.comunas, ['Talca'])
})

test('agrupación por comuna respeta el orden recibido', () => {
  const groups = groupCardsByComuna(sortPreparationCards(cards, 'comuna'))
  assert.deepEqual(groups.map(group => group.comuna), ['Linares', 'Talca'])
  assert.deepEqual(groups[1].cards.map(card => card.card_id), ['card-4961', 'card-5021'])
})

function makePdfEntry(folio) {
  return {
    card: {
      card_id: `card-${folio}`,
      company_id: 'company-1',
      status: 'PENDING_ROUTE_PREP',
      priority: 0,
      assigned_user_id: null,
      route_date: null,
      normalized_city: 'Talca',
      nv_bsale_id: Number(folio),
      nv_folio: String(folio),
      nv_emission_date: '2026-10-19T12:00:00.000Z',
      nv_generation_date: '2026-10-19T12:00:00.000Z',
      client_name: `Cliente ${folio}`,
      city_raw: 'Talca',
      municipality_raw: 'Talca',
      address_raw: 'Calle Uno 123',
      seller_bsale_id: null,
      seller_name: 'Ana Pérez',
      total_quantity: 7,
      total_amount: 11900,
      net_amount: 10000,
      tax_amount: 1900,
      gross_amount: 11900,
      invoice_folio: null,
      is_invoiced: false,
      created_at: '2026-10-19T12:00:00.000Z',
      updated_at: '2026-10-19T12:00:00.000Z',
    },
    items: [{
      detail_id: Number(folio),
      company_id: 'company-1',
      nv_bsale_id: Number(folio),
      nv_folio: Number(folio),
      variant_id: null,
      sku: `SKU-${folio}`,
      product_name: `Producto ${folio}`,
      quantity: 7,
      unit_value: 1000,
      total_amount: 11900,
      unit_net_value: 840,
      line_net_amount: 5880,
      line_tax_amount: 1117,
      line_gross_amount: 6997,
    }],
    clientData: { rut: '77.196.005-7', phone: null, email: null },
  }
}

test('PDF masivo contiene las 3 NV y una página por NV', async () => {
  const blob = generatePreparationOrdersPdf([
    makePdfEntry('4961'),
    makePdfEntry('4994'),
    makePdfEntry('5021'),
  ])
  const raw = Buffer.from(await blob.arrayBuffer()).toString('latin1')

  assert.equal(blob.type, 'application/pdf')
  assert.equal((raw.match(/\/Type \/Page\b/g) || []).length, 3)
  assert.match(raw, /NV N° 4961/)
  assert.match(raw, /NV N° 4994/)
  assert.match(raw, /NV N° 5021/)
  assert.match(raw, /SKU-4961/)
  assert.match(raw, /SKU-4994/)
  assert.match(raw, /SKU-5021/)
  assert.match(raw, /Cantidad/)
})
