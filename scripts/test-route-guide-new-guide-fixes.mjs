import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const syncSource = await readFile(new URL('../src/app/actions/integraciones/bsale-sync.ts', import.meta.url), 'utf8')
const gridSource = await readFile(new URL('../src/modules/logistica/guias-ruta/components/route-guide-grid.tsx', import.meta.url), 'utf8')
const normalizerSource = await readFile(new URL('../src/modules/logistica/guias-ruta/utils/payment-normalizer.ts', import.meta.url), 'utf8')

function selectInvoiceWithoutGuideContext(documents) {
  const validInvoices = documents.filter(document => document.documentTypeId === 5 && document.state === 0)
  if (validInvoices.length === 1) return validInvoices[0]
  return null
}

test('los 15 folios seleccionan la factura tipo 5 y no el documento histórico tipo 1', () => {
  const invoiceNumbers = ['24000', '23999', '23996', '24007', '24002', '24005', '24003', '23995', '23998', '24004', '23994', '23997', '23993', '24006', '24001']
  const selected = invoiceNumbers.map(number => selectInvoiceWithoutGuideContext([
    { number, id: Number(number) + 11593, documentTypeId: 1, state: 0 },
    { number, id: Number(number) + 66679, documentTypeId: 5, state: 0 },
  ]))

  assert.equal(selected.length, 15)
  assert.equal(selected.filter(Boolean).length, 15)
  assert.ok(selected.every(document => document.documentTypeId === 5))
  assert.match(syncSource, /if \(!scope\)[\s\S]*?directedDocumentTypeId\(document\) === 5[\s\S]*?toNumber\(document\.state\) === 0/)
  assert.doesNotMatch(syncSource, /if \(matches\.length <= 1 \|\| !scope\) return matches\[0\]/)
})

test('múltiples facturas tipo 5 no se resuelven arbitrariamente', () => {
  assert.equal(selectInvoiceWithoutGuideContext([
    { id: 1, documentTypeId: 5, state: 0 },
    { id: 2, documentTypeId: 5, state: 0 },
  ]), null)
  assert.match(syncSource, /DirectedDocumentSelectionError\('AMBIGUOUS'/)
})

test('23998 selecciona el documento electrónico vigente que coincide con el Excel', () => {
  const selected = selectInvoiceWithoutGuideContext([
    { id: 35591, number: 23998, documentTypeId: 1, state: 0, totalAmount: 79700 },
    { id: 90677, number: 23998, documentTypeId: 5, state: 0, totalAmount: 246724, clientId: 998, address: 'cruz 352 null', municipality: 'Constitución' },
  ])
  assert.deepEqual(selected, {
    id: 90677,
    number: 23998,
    documentTypeId: 5,
    state: 0,
    totalAmount: 246724,
    clientId: 998,
    address: 'cruz 352 null',
    municipality: 'Constitución',
  })
  assert.match(syncSource, /\? 'PARTIAL'/)
})

test('las variantes de Al día se normalizan como AL_DIA', () => {
  assert.match(normalizerSource, /normalized === 'al dia' \|\| normalized === 'aldia'/)
  assert.match(normalizerSource, /normalized: 'AL_DIA'/)
  assert.match(normalizerSource, /normalize\('NFD'\)/)
  assert.match(normalizerSource, /normalized\.includes\('credito'\)/)
  assert.match(gridSource, /item\.payment_method_normalized === 'AL_DIA'/)
  assert.match(gridSource, />Al día<\/option>/)
})
