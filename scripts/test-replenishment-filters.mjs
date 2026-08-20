import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const filtersPath = new URL('../src/modules/adquisiciones/ordenes-compra/replenishment-filters.tsx', import.meta.url)
const analysisPath = new URL('../src/modules/adquisiciones/ordenes-compra/replenishment-analysis-panel.tsx', import.meta.url)
const columnsPath = new URL('../src/modules/adquisiciones/ordenes-compra/replenishment-columns.ts', import.meta.url)
const [filters, analysis, columns] = await Promise.all([
  readFile(filtersPath, 'utf8'),
  readFile(analysisPath, 'utf8'),
  readFile(columnsPath, 'utf8'),
])

test('cada filtro principal tiene un label descriptivo permanente', () => {
  for (const label of [
    'Período de análisis',
    'Cobertura objetivo',
    'Proveedor',
    'Línea de artículos',
    'SKU / Producto',
    'Estado',
    'Productos',
    'Vista de análisis',
    'Detalle temporal',
  ]) {
    assert.match(filters, new RegExp(`>${label}<|>${label}\\s`), `falta label: ${label}`)
  }
})

test('labels de proveedor y línea sobreviven al loading y a selecciones aplicadas', () => {
  assert.match(filters, /Proveedor<\/label>[\s\S]*Cargando proveedores\.\.\./)
  assert.match(filters, /Línea de artículos<\/label>[\s\S]*Cargando líneas\.\.\./)
  assert.match(filters, /value=\{open === 'proveedor' \? proveedorQuery : draftSupplier\}/)
  assert.match(filters, /value=\{open === 'linea' \? lineaQuery : draftLine\}/)
})

test('los labels reflejan el contrato real de períodos, cobertura, vistas e historial', () => {
  assert.match(analysis, /label: '28 días \(4 bloques\)', value: 28/)
  assert.match(analysis, /label: '2 semanas', value: 2/)
  assert.match(columns, /label: 'Compra'/)
  assert.match(columns, /label: 'Ventas'/)
  assert.match(columns, /label: 'Completa'/)
  assert.match(filters, /Análisis por semanas · \{historialVisible === 'Oculto' \? 'Oculto' : historialVisible\}/)
})

test('clear/X, filtros, responsive y estrategia de dropdown permanecen intactos', () => {
  for (const pattern of [
    /onClick=\{clearSupplier\}/,
    /onClick=\{clearLine\}/,
    /onClick=\{clearSearch\}/,
    /onDraftSupplierChange/,
    /onDraftLineChange/,
    /onDraftSearchChange/,
    /onDraftStatusChange/,
    /onDraftShowAllChange/,
    /onSelectView/,
    /onSelectHistorial/,
    /flex flex-wrap items-center gap-2/,
    /mt-2 rounded-lg border border-theme-border bg-theme-surface p-2 shadow-sm/,
  ]) {
    assert.match(filters, pattern)
  }
  assert.doesNotMatch(filters, /operational-table/)
})

test('Configuración conserva su acción y usa spacer estructural sin label visible', () => {
  assert.match(filters, /<span aria-hidden="true" className="h-\[15px\]" \/>\s*<button\s+onClick=\{onOpenConfig\}/)
  assert.match(filters, /title="Configuración de columnas"[\s\S]*>\s*<Settings2/)
  assert.match(filters, /onClick=\{onOpenConfig\}/)
  assert.doesNotMatch(filters, /Configuración<\/label>/)
})
