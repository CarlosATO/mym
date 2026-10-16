import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { receiptItemSku } from '../src/lib/logistica/receipt-display.ts'

const root = new URL('..', import.meta.url)
const worksheet = await readFile(new URL('src/modules/logistica/recepciones/receipt-worksheet.tsx', root), 'utf8')

function deriveSource() {
  const start = worksheet.indexOf('const visibleReceiptItems = useMemo(')
  assert.ok(start >= 0, 'visibleReceiptItems derive block not found')
  return worksheet.slice(start, worksheet.indexOf('}, [poDetail, receiptSearchQuery])', start))
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
  assert.match(source, /if \(!query\) return indexed/)
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
  assert.match(worksheet, /\}, \[poDetail, receiptSearchQuery\]\)/)
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
  assert.match(worksheet, /receiptSearchQuery\.trim\(\) && \(/)
})
