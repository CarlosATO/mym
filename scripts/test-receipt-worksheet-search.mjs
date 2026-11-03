import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { receiptItemSku } from '../src/lib/logistica/receipt-display.ts'

const root = new URL('..', import.meta.url)
const worksheet = await readFile(new URL('src/modules/logistica/recepciones/receipt-worksheet.tsx', root), 'utf8')

function deriveSource() {
  const start = worksheet.indexOf('const visibleReceiptItems = useMemo(')
  assert.ok(start >= 0, 'visibleReceiptItems derive block not found')
  return worksheet.slice(start, worksheet.indexOf('}, [poDetail, receiptSearchQuery, receiptLineFilter, selectedInvoice])', start))
}

test('A. receipt worksheet exposes a SKU/product search input above the lines table', () => {
  assert.match(worksheet, /const \[receiptSearchQuery, setReceiptSearchQuery\] = useState\(''\)/)
  assert.match(worksheet, /placeholder="Buscar por SKU o producto\.\.\."/)
  assert.match(worksheet, /type="search"[\s\S]{0,120}value=\{receiptSearchQuery\}/)
  assert.match(worksheet, /onChange=\{e => setReceiptSearchQuery\(e\.target\.value\)\}/)
  assert.match(worksheet, /Líneas a Recepcionar/)
})

test('B/C/D. search matches SKU and description partially via includes', () => {
  const source = deriveSource()
  assert.match(source, /\[receiptItemSku\(item\), item\.product_description\]\.some/)
  assert.match(source, /\.includes\(query\)/)
})

test('E/F. search is case-insensitive, trimmed, and shows every line with no query', () => {
  const source = deriveSource()
  assert.match(source, /const query = receiptSearchQuery\.trim\(\)\.toLocaleLowerCase\('es-CL'\)/)
  assert.match(source, /if \(!query\) return statusFiltered/)
  assert.match(source, /toLocaleLowerCase\('es-CL'\)\.includes\(query\)/)
})

test('G. visibleReceiptItems is derived from the canonical poDetail.items without mutating it', () => {
  const source = deriveSource()
  assert.match(source, /const items: any\[\] = poDetail\?\.items \?\? \[\]/)
  assert.match(source, /items\.map\(\(item, originalIndex\) => \(\{ item, originalIndex \}\)\)/)
  assert.match(source, /indexed\.filter\(\(\{ item \}\) =>/)
  assert.doesNotMatch(worksheet, /setPoDetail\([^\n]*filter/)
  assert.doesNotMatch(worksheet, /poDetail\.items = /)
})

test('H. itemInputs stays an independent state and is not recreated while searching', () => {
  assert.match(worksheet, /const \[itemInputs, setItemInputs\] = useState<Record<string, ItemSplit\[\]>>\(\{\}\)/)
   assert.match(worksheet, /\}, \[poDetail, receiptSearchQuery, receiptLineFilter, selectedInvoice\]\)/)
  assert.doesNotMatch(deriveSource(), /itemInputs|setItemInputs/)
})

test('I. submit/payload keeps iterating the whole canonical poDetail.items', () => {
  assert.match(worksheet, /for \(const item of poDetail\.items\) \{[\s\S]*?const splits = itemInputs\[item\.id\] \|\| \[\]/)
  assert.doesNotMatch(worksheet, /for \(const \{ item \} of visibleReceiptItems\)/)
  assert.doesNotMatch(worksheet, /for \(const item of visibleReceiptItems\)/)
  assert.match(worksheet, /items: payloadItems/)
})

test('J. split state keyed by item id is preserved even when a row is hidden', () => {
  assert.match(worksheet, /function updateSplitField\(itemId: string, splitId: string/)
  assert.match(worksheet, /setItemInputs\(prev => \{[\s\S]*?\[itemId\]: updated/)
  assert.match(worksheet, /function addSplit\(itemId: string\)/)
  assert.match(worksheet, /const splits = itemInputs\[item\.id\] \|\| \[\]/)
})

test('K. services stay searchable by description', () => {
  assert.equal(receiptItemSku({ item_type: 'SERVICE', sku: null }), '—')
  assert.match(worksheet, /item\.item_type === 'SERVICE'/)
  const source = deriveSource()
  assert.match(source, /item\.product_description/)
})

test('L. original OC line numbering is preserved through the filter', () => {
  const source = deriveSource()
  assert.match(source, /\{ item, originalIndex \}/)
  assert.match(worksheet, /\{originalIndex \+ 1\}/)
  assert.doesNotMatch(worksheet, /visibleReceiptItems\.map\(\([^)]*idx[^)]*\)/)
})

test('counter keeps the real OC total and shows X of Y only while searching', () => {
  assert.match(worksheet, /\{poDetail\.items\.length\} ítems en total/)
  assert.match(worksheet, /Mostrando \{visibleReceiptItems\.length\} de \{poDetail\.items\.length\}/)
  assert.match(worksheet, /Mostrando \{visibleReceiptItems\.length\} de \{poDetail\.items\.length\}/)
})

test('M. pending-only filter uses quantity_pending without changing canonical items', () => {
  assert.match(worksheet, /const \[receiptLineFilter, setReceiptLineFilter\] = useState<'ALL' \| 'PENDING'>\('ALL'\)/)
  assert.match(worksheet, /receiptLineFilter === 'PENDING'[\s\S]*?Number\(item\.quantity_pending \|\| 0\) > 0/)
  assert.match(worksheet, /Solo pendientes/)
  assert.match(worksheet, /No hay líneas pendientes por recepcionar\./)
})

test('N. complete lines do not render split controls or enter the payload', () => {
  assert.match(worksheet, /const isComplete = Number\(item\.quantity_pending \|\| 0\) <= 0/)
  assert.match(worksheet, /!isComplete && splits\.map/)
  assert.match(worksheet, /!isComplete && <tr className=/)
  assert.match(worksheet, /if \(qtyPending <= 0\) continue/)
  assert.match(worksheet, /Completa/)
})

test('O. when filters hide lines with entered quantities, silent save is prevented and review action clears filters without deleting inputs', () => {
  // Derivation of hidden lines with quantities
  assert.match(worksheet, /const hiddenItemsWithQuantities = useMemo\(\(\) => \{/)
  assert.match(worksheet, /const visibleIds = new Set\(visibleReceiptItems\.map\(\(\{ item \}\) => item\.id\)\)/)
  assert.match(worksheet, /splits\.some\(\(s: ItemSplit\) => Number\(s\.quantity \|\| 0\) > 0\)/)

  // Guard against silent saving in handleSaveReceipt
  assert.match(worksheet, /if \(hiddenItemsWithQuantities\.length > 0\) \{[\s\S]*?toast\.error\([\s\S]*?línea\(s\) con cantidades ingresadas ocultas[\s\S]*?onClick: handleShowAllLines[\s\S]*?return\n\s*\}/)

  // Proactive banner informing user
  assert.match(worksheet, /hiddenItemsWithQuantities\.length > 0 && \([\s\S]*?role="alert"/)
  assert.match(worksheet, /Revisar todas las líneas/)

  // Review action clears filters without mutating or wiping itemInputs
  assert.match(worksheet, /function handleShowAllLines\(\) \{[\s\S]*?setReceiptSearchQuery\(''\)[\s\S]*?setSelectedInvoiceId\(null\)[\s\S]*?setReceiptLineFilter\('ALL'\)/)
  const showAllSource = worksheet.slice(worksheet.indexOf('function handleShowAllLines'), worksheet.indexOf('}', worksheet.indexOf('function handleShowAllLines')) + 1)
  assert.doesNotMatch(showAllSource, /setItemInputs/)
})

test('P. simultaneous filter combination: invoice, pending-only, and search apply together', () => {
  const source = deriveSource()

  // Verify the composable pipeline in visibleReceiptItems
  assert.match(source, /const invoiceFiltered = selectedInvoice[\s\S]*?selectedInvoice\.purchase_order_item_ids\.includes\(item\.id\)/)
  assert.match(source, /const statusFiltered = receiptLineFilter === 'PENDING'[\s\S]*?invoiceFiltered\.filter[\s\S]*?Number\(item\.quantity_pending \|\| 0\) > 0/)
  assert.match(source, /if \(!query\) return statusFiltered/)
  assert.match(source, /statusFiltered\.filter\(\(\{ item \}\) =>/)

  // Verify toggleInvoiceFilter toggles selection without wiping search or line filter
  const toggleSource = worksheet.slice(worksheet.indexOf('function toggleInvoiceFilter'), worksheet.indexOf('}', worksheet.indexOf('function toggleInvoiceFilter')) + 1)
  assert.doesNotMatch(toggleSource, /setReceiptSearchQuery/)
  assert.doesNotMatch(toggleSource, /setReceiptLineFilter/)

  // Simulate simultaneous combination with mock data
  const mockItems = [
    { id: 'item-1', product_description: 'Alimento Perro Adulto', sku: 'ALIM-01', quantity_pending: 10 },
    { id: 'item-2', product_description: 'Alimento Perro Cachorro', sku: 'ALIM-02', quantity_pending: 0 },
    { id: 'item-3', product_description: 'Snack Dental Perro', sku: 'SNK-01', quantity_pending: 5 },
    { id: 'item-4', product_description: 'Alimento Gato Adulto', sku: 'ALIM-03', quantity_pending: 8 },
  ]
  const mockInvoice = {
    id: 'inv-1',
    purchase_order_item_ids: ['item-1', 'item-2', 'item-3'],
  }

  function evaluateVisibleItems(items, selectedInvoice, receiptLineFilter, receiptSearchQuery) {
    const query = receiptSearchQuery.trim().toLocaleLowerCase('es-CL')
    const indexed = items.map((item, originalIndex) => ({ item, originalIndex }))
    const invoiceFiltered = selectedInvoice
      ? indexed.filter(({ item }) => selectedInvoice.purchase_order_item_ids.includes(item.id))
      : indexed
    const statusFiltered = receiptLineFilter === 'PENDING'
      ? invoiceFiltered.filter(({ item }) => Number(item.quantity_pending || 0) > 0)
      : invoiceFiltered
    if (!query) return statusFiltered
    return statusFiltered.filter(({ item }) =>
      [item.sku, item.product_description].some(value => (value ?? '').toLocaleLowerCase('es-CL').includes(query))
    )
  }

  // Baseline: all 4 items
  assert.equal(evaluateVisibleItems(mockItems, null, 'ALL', '').length, 4)

  // 1. Invoice filter only: items 1, 2, 3
  const invoiceOnly = evaluateVisibleItems(mockItems, mockInvoice, 'ALL', '')
  assert.deepEqual(invoiceOnly.map(r => r.item.id), ['item-1', 'item-2', 'item-3'])

  // 2. Invoice + Pending: items 1, 3 (item 2 has pending = 0)
  const invoiceAndPending = evaluateVisibleItems(mockItems, mockInvoice, 'PENDING', '')
  assert.deepEqual(invoiceAndPending.map(r => r.item.id), ['item-1', 'item-3'])

  // 3. Invoice + Pending + Search "Snack": item 3 only
  const allThree = evaluateVisibleItems(mockItems, mockInvoice, 'PENDING', 'snack')
  assert.deepEqual(allThree.map(r => r.item.id), ['item-3'])

  // 4. Invoice + Pending + Search "Gato": empty because Gato is not in mockInvoice
  const noMatch = evaluateVisibleItems(mockItems, mockInvoice, 'PENDING', 'gato')
  assert.equal(noMatch.length, 0)
})
