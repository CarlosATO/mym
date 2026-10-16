import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const review = await readFile(new URL('src/modules/adquisiciones/ordenes-compra/purchase-order-supplier-review.tsx', root), 'utf8')

test('A. supplier review exposes a SKU/product search input above the lines table', () => {
  assert.match(review, /const \[searchQuery, setSearchQuery\] = useState\(''\)/)
  assert.match(review, /placeholder="Buscar por SKU o producto\.\.\."/)
  assert.match(review, /type="search"[^>]*value=\{searchQuery\}/)
  assert.match(review, /onChange=\{\(event\) => setSearchQuery\(event\.target\.value\)\}/)
  assert.match(review, /Agregar descuentos/)
})

test('B/C/D. search matches SKU and description partially via includes', () => {
  const filterStart = review.indexOf('const visibleLines = useMemo(')
  assert.ok(filterStart >= 0, 'visibleLines derive block not found')
  const filterSource = review.slice(filterStart, review.indexOf('}, [lines, searchQuery])', filterStart))
  assert.match(filterSource, /\[line\.sku, line\.product_description\]\.some/)
  assert.match(filterSource, /\.includes\(query\)/)
})

test('E/F/J. search is case-insensitive, trimmed, and shows every line with no query', () => {
  const filterStart = review.indexOf('const visibleLines = useMemo(')
  const filterSource = review.slice(filterStart, review.indexOf('}, [lines, searchQuery])', filterStart))
  assert.match(filterSource, /const query = searchQuery\.trim\(\)\.toLocaleLowerCase\('es-CL'\)/)
  assert.match(filterSource, /if \(!query\) return lines/)
  assert.match(filterSource, /toLocaleLowerCase\('es-CL'\)\.includes\(query\)/)
})

test('G. filteredLines is derived from the canonical lines array and never replaces it', () => {
  assert.match(review, /const visibleLines = useMemo\(\(\) => \{[\s\S]*?return lines\.filter\(\(line\)/)
  assert.match(review, /\}, \[lines, searchQuery\]\)/)
  assert.doesNotMatch(review, /setLines\(lines\.filter/)
  assert.doesNotMatch(review, /setLines\(visibleLines/)
  assert.match(review, /\{visibleLines\.map\(\(line\) => \{/)
})

test('H. KPIs and totals keep computing over the complete lines array', () => {
  assert.match(review, /const preview = useMemo\(\(\) => calculatePurchaseOrderTotals\(lines\), \[lines\]\)/)
  assert.match(review, /summaryCards\.map/)
  assert.doesNotMatch(review, /calculatePurchaseOrderTotals\(visibleLines\)/)
  assert.doesNotMatch(review, /summary\.(unchanged_count|modified_count|removed_count|added_count)[\s\S]{0,40}visibleLines/)
})

test('I. editing a row keeps mutating the canonical lines state even when filtered out', () => {
  assert.match(review, /function updateLine\([\s\S]*?setLines\(\(current\) =>\s*current\.map/)
  assert.doesNotMatch(review, /function updateLine\([\s\S]*?setVisibleLines/)
  assert.match(review, /onChange=\{\(event\) => updateLine\(line\.item_id, 'quantity', event\.target\.value\)\}/)
  assert.match(review, /onChange=\{\(event\) => updateLine\(line\.item_id, 'unit_price', event\.target\.value\)\}/)
})

test('search surface is client-side only; no backend/RPC changes for filtering', () => {
  assert.doesNotMatch(review, /searchPurchaseOrder|filterPurchaseOrder|rpc\([^)]*search/i)
  assert.match(review, /Mostrando \{visibleLines\.length\} de \{lines\.length\} productos/)
})
