import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const sharedPath = new URL('../src/components/ui/operational-table.tsx', import.meta.url)
const catalogPath = new URL('../src/modules/adquisiciones/catalogo/catalog-panel.tsx', import.meta.url)
const actionPath = new URL('../src/app/actions/adquisiciones/products.ts', import.meta.url)
const [shared, catalog, action] = await Promise.all([
  readFile(sharedPath, 'utf8'),
  readFile(catalogPath, 'utf8'),
  readFile(actionPath, 'utf8'),
])

test('el primitive define widths, límites y columnas sticky por id', () => {
  assert.match(shared, /defaultWidth: number/)
  assert.match(shared, /minWidth: number/)
  assert.match(shared, /maxWidth\?: number/)
  assert.match(shared, /sticky\?: 'left' \| 'right'/)
  assert.match(shared, /clampWidth/)
  assert.match(shared, /sortable\?: boolean/)
  assert.match(shared, /sortKey\?: string/)
  assert.match(shared, /sortType\?: OperationalTableSortType/)
  assert.match(catalog, /id: 'description', defaultWidth: 360, minWidth: 220, maxWidth: 560/)
  assert.match(catalog, /id: 'actions'.*sticky: 'right'/)
})

test('resize es inmediato, respeta límites y persiste sólo al finalizar', () => {
  assert.match(shared, /setColumnWidth = useCallback/)
  assert.match(shared, /Math\.min\(upper, Math\.max\(column\.minWidth/)
  assert.match(shared, /onResizeEnd\(\)/)
  assert.match(shared, /stopPropagation\(\)/)
  assert.match(shared, /dragging \? 'border-theme-accent bg-theme-accent\/50'/)
  assert.match(shared, /localStorage\.setItem\(tableKey, JSON\.stringify/)
  assert.match(catalog, /OperationalTableResizeHandle/)
  assert.doesNotMatch(catalog, /getProducts\([^)]*resize|onResize[^\n]*getProducts/)
})

test('sorting compartido alterna ASC, DESC y default con persistencia independiente', () => {
  assert.match(shared, /useOperationalTableSort/)
  assert.match(shared, /direction: 'asc'/)
  assert.match(shared, /direction: 'desc'/)
  assert.match(shared, /sort\.direction === 'asc'/)
  assert.match(shared, /sort: next/)
  assert.match(shared, /OperationalTableSortIndicator/)
  assert.match(catalog, /cycleSort\(column\)/)
  assert.match(catalog, /setFilters\(current => current\.page === 1 \? current : \{ \.\.\.current, page: 1 \}\)/)
})

test('sorting del dataset ocurre server-side antes de paginar y usa allowlist', () => {
  assert.match(catalog, /sortBy: activeSort\?\.sortKey/)
  assert.match(catalog, /sortDirection: sort\?\.direction/)
  assert.match(catalog, /headerLabel\('description', 'Descripción'\)/)
})

test('refresh conserva filas, diferencia carga inicial y descarta respuestas antiguas', () => {
  assert.match(catalog, /initialLoading/)
  assert.match(catalog, /refreshing/)
  assert.match(catalog, /requestSequence\.current/)
  assert.match(catalog, /if \(requestId !== requestSequence\.current\) return/)
  assert.match(catalog, /left-1\/2 top-2 z-50 inline-flex -translate-x-1\/2/)
  assert.match(catalog, /LoaderCircle.*animate-spin/)
  assert.match(catalog, /Actualizando\.\.\./)
  assert.match(catalog, /pointer-events-none/)
  assert.match(catalog, /setProducts\(res\.data\)/)
  assert.doesNotMatch(catalog, /refreshing \? \(/)
})

test('un error durante refresh conserva el dataset existente', () => {
  assert.match(catalog, /if \(res\.error\)/)
  assert.match(catalog, /No se pudo actualizar el catálogo/)
  assert.match(action, /error\?: string/)
})

test('preferencias inválidas se ignoran y reset borra sólo la key de la tabla', () => {
  assert.match(shared, /typeof width !== 'number' \|\| !Number\.isFinite\(width\)/)
  assert.match(shared, /window\.localStorage\.removeItem\(tableKey\)/)
  assert.match(catalog, /mym:table:adquisiciones:catalogo/)
  assert.match(catalog, /Restablecer ancho de columnas/)
})

test('Catálogo conserva truncado, tooltip, scroll y sticky Actions', () => {
  assert.match(catalog, /table-fixed whitespace-nowrap/)
  assert.match(catalog, /title=\{p\.description\}/)
  assert.match(catalog, /min-w-\[1500px\]/)
  assert.match(catalog, /sticky right-0 z-30/)
  assert.match(catalog, /sticky right-0 z-20/)
})

test('doble clic sólo edita filas y excluye controles interactivos', () => {
  assert.match(shared, /button, a, input, select, textarea/)
  assert.match(catalog, /onDoubleClick=\{event => \{ if \(!shouldIgnoreOperationalRowDoubleClick\(event\.target\)\) openEdit\(p\)/)
  assert.match(catalog, /<button onClick=\{\(\) => openEdit\(p\)\}/)
  assert.match(catalog, /handleDeactivate\(p\)/)
  assert.doesNotMatch(catalog, /onDoubleClick=\{.*handleDeactivate/)
})

test('PROV-1E sigue usando Proveedor en Bsale sin mezclar Proveedor Real', () => {
  assert.match(catalog, /Proveedor en Bsale/)
  assert.match(catalog, /bsale_supplier_link_status === 'LINKED'/)
  assert.match(catalog, /bsale_supplier_link_status === 'PENDING'/)
  assert.match(catalog, /bsale_supplier_link_status === 'NO_BRAND'/)
  assert.match(catalog, /p\.real_supplier_name/)
})
