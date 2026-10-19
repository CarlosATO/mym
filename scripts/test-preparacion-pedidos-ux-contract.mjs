import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const panel = await readFile(new URL('src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx', root), 'utf8')
const card = await readFile(new URL('src/modules/logistica/preparacion-pedidos/sales-order-card.tsx', root), 'utf8')
const drawer = await readFile(new URL('src/modules/logistica/preparacion-pedidos/sales-order-drawer.tsx', root), 'utf8')
const actions = await readFile(new URL('src/app/actions/logistica/sales-order-preparation.ts', root), 'utf8')
const pdf = await readFile(new URL('src/lib/pdf/generate-preparation-orders-pdf.ts', root), 'utf8')

test('buscador superior client-side con debounce cero y campos operacionales', () => {
  assert.match(panel, /matchesPreparationSearch\(card, searchTerm\)/)
  assert.match(panel, /placeholder="Buscar NV, cliente, comuna, fecha\.\.\."/)
  assert.match(panel, /onChange=\{e => setSearchTerm\(e\.target\.value\)\}/)
  assert.doesNotMatch(panel, /setTimeout\([^)]*searchTerm/)
  assert.doesNotMatch(panel, /getSalesOrderPreparationBoard\([^)]*searchTerm/)
})

test('orden normal, NV, fecha y comuna con agrupación visual', () => {
  assert.match(panel, /<option value="default">Orden normal<\/option>/)
  assert.match(panel, /<option value="comuna">Ordenar por comuna<\/option>/)
  assert.match(panel, /<option value="nv">Ordenar por NV<\/option>/)
  assert.match(panel, /<option value="date">Ordenar por fecha<\/option>/)
  assert.match(panel, /sortPreparationCards\(searchFilteredCards, sortBy\)/)
  assert.match(panel, /showComunaDivider/)
})

test('tarjeta con comuna protagonista y selección por card_id', () => {
  assert.match(card, /getPreparationComuna\(card\)/)
  assert.match(card, /font-bold uppercase tracking-\[0\.08em\] text-\[#72383D\]/)
  assert.match(card, /role="checkbox"/)
  assert.match(card, /onToggleSelected\?\.\(card\)/)
  assert.match(panel, /selectedCardIds\.has\(card\.card_id\)/)
  assert.doesNotMatch(panel, /selectedIndex|selectedRow|selectedPosition/)
})

test('selección preservada y podada con sync/mutaciones', () => {
  assert.match(panel, /prunePreparationSelection\(current, rows\)/)
  assert.match(panel, /selectedCardIds\.has\(card\.card_id\) && card\.status === 'PENDING_ROUTE_PREP'/)
  assert.match(panel, /const next = new Set\(current\)[\s\S]*next\.delete\(card\.card_id\)/)
})

test('barra de acciones de selección con ambas impresiones y limpieza', () => {
  assert.match(panel, /NV seleccionada/)
  assert.match(panel, /Imprimir y preparar \(\$\{selectionSummary\.nvCount\}\)/)
  assert.match(panel, /Imprimir sin mover/)
  assert.match(panel, /Limpiar selección/)
  assert.match(panel, /handleBulkPrint\('prepare'\)/)
  assert.match(panel, /handleBulkPrint\('print'\)/)
})

test('detalle se abre con clic normal sin confundir checkbox ni drag', () => {
  assert.match(card, /onClick=\{!isOverlay \? handleClick : undefined\}/)
  assert.match(card, /onOpen\?\.\(\)/)
  assert.match(card, /data-card-action/)
  assert.match(card, /if \(moved > 6\) return/)
  assert.match(panel, /onOpen=\{\(\) => onOpenCardDetails\(card\)\}/)
})

test('detalle muestra encabezado, direcciones y líneas SKU/descripción/cantidad', () => {
  assert.match(drawer, /RUT/)
  assert.match(drawer, /Dirección/)
  assert.match(drawer, /Comuna/)
  assert.match(drawer, /Ciudad/)
  assert.match(drawer, /Vendedor/)
  assert.match(drawer, /Cantidad total/)
  assert.match(drawer, /<span>SKU<\/span>/)
  assert.match(drawer, /Descripción \/ presentación/)
  assert.match(drawer, /item\.sku/)
  assert.match(drawer, /item\.quantity/)
})

test('impresión individual: PDF antes de mover y opción sin cambiar estado', () => {
  const start = drawer.indexOf('const handlePrintAndPrepare')
  const end = drawer.indexOf('return (', start)
  const block = drawer.slice(start, end)

  assert.ok(start >= 0 && end > start)
  assert.ok(block.indexOf('generatePreparationOrdersPdf') < block.indexOf("onTransition(card, 'IN_PREPARATION')"))
  assert.match(drawer, /Imprimir y preparar/)
  assert.match(drawer, /Imprimir sin cambiar estado/)
  assert.match(drawer, /No se movió la NV/)
})

test('PDF usa un documento con page break por NV y tablas legibles', () => {
  assert.match(pdf, /entries\.forEach\(\(entry, index\) => \{/)
  assert.match(pdf, /if \(index > 0\) doc\.addPage\(\)/)
  assert.match(pdf, /autoTable\(doc/)
  assert.match(pdf, /'SKU', 'Descripción \/ presentación', 'Cantidad'/)
  assert.match(pdf, /doc\.output\('blob'\)/)
})

test('impresión masiva reutiliza una carga batch y no N+1', () => {
  assert.match(actions, /export async function getSalesOrderPreparationPrintData/)
  assert.match(actions, /\.in\('nv_bsale_id', nvIds\)/)
  assert.match(actions, /\.in\('bsale_id', nvIds\)/)
  assert.match(actions, /\.in\('bsale_client_id', clientIds\)/)
  assert.match(panel, /getSalesOrderPreparationPrintData\(\s*companyId,\s*targets\.map/)
  assert.match(panel, /generatePreparationOrdersPdf\(entries\)/)
})

test('lote genera primero el documento y mueve después con rollback individual', () => {
  const start = panel.indexOf('const handleBulkPrint = async')
  const end = panel.indexOf('const handleDragStart', start)
  const block = panel.slice(start, end)

  assert.ok(start >= 0 && end > start)
  assert.ok(block.indexOf('generatePreparationOrdersPdf(entries)') < block.indexOf('moveCardsToPreparation(targets)'))
  assert.match(block, /mode === 'prepare'/)
  assert.match(panel, /const moveResult = mode === 'prepare'/)
  assert.match(panel, /failedIds[\s\S]*status: 'PENDING_ROUTE_PREP'/)
  assert.match(panel, /setTransitionError\(message\)/)
})

test('fallo de PDF no mueve tarjetas y fallo server no deja UI falsa', () => {
  const start = drawer.indexOf('const handlePrintAndPrepare')
  const end = drawer.indexOf('return (', start)
  const block = drawer.slice(start, end)

  assert.ok(block.indexOf('generatePreparationOrdersPdf') < block.indexOf("onTransition(card, 'IN_PREPARATION')"))
  assert.match(block, /closePdfWindow\(printWindow\)/)
  assert.match(panel, /status: 'PENDING_ROUTE_PREP'/)
  assert.match(panel, /setBulkPrintError\(message\)/)
})

test('optimistic UI mantiene contadores derivados y protección stale', () => {
  assert.match(panel, /const optimisticCards = cardsRef\.current\.map/)
  assert.match(panel, /setCards\(optimisticCards\)/)
  assert.match(panel, /pendingStatusByCardRef\.current\.set\(card\.card_id, 'IN_PREPARATION'\)/)
  assert.match(panel, /boardRequestSeqRef\.current \+= 1/)
  assert.match(panel, /mergePreparationBoardRows/)
  assert.match(panel, /\{colCards\.length\}/)
  assert.doesNotMatch(panel, /window\.location\.reload/)
})

test('no se agregó auditoría, picking, rutas formales ni migraciones', () => {
  assert.doesNotMatch(panel, /picking|ubicaci[oó]n de picking|optimizaci[oó]n de ruta/i)
  assert.doesNotMatch(drawer, /picking|auditor[ií]a autom[aá]tica/i)
  assert.doesNotMatch(actions, /CREATE TABLE|CREATE OR REPLACE FUNCTION/)
})
