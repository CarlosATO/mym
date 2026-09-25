import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const filtersPath = new URL('../src/modules/adquisiciones/ordenes-compra/replenishment-filters.tsx', import.meta.url)
const analysisPath = new URL('../src/modules/adquisiciones/ordenes-compra/replenishment-analysis-panel.tsx', import.meta.url)
const columnsPath = new URL('../src/modules/adquisiciones/ordenes-compra/replenishment-columns.ts', import.meta.url)
const excelPath = new URL('../src/modules/adquisiciones/ordenes-compra/replenishment-excel.ts', import.meta.url)
const [filters, analysis, columns, excel] = await Promise.all([
  readFile(filtersPath, 'utf8'),
  readFile(analysisPath, 'utf8'),
  readFile(columnsPath, 'utf8'),
  readFile(excelPath, 'utf8'),
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
    'Vista',
    'Detalle temporal',
  ]) {
    // Acepta: >Label< | >Label\s | label="Label" (FilterCell prop) | label={`...Label...`}
    assert.match(filters, new RegExp(`>${label}<|>${label}\\s|label="${label}"|'${label}'`), `falta label: ${label}`)
  }
})

test('labels de proveedor y línea sobreviven al loading y a selecciones aplicadas', () => {
  // Nuevo layout: labels como spans dentro de FilterCell, placeholder simplificado
  assert.match(filters, /Proveedor/)
  assert.match(filters, /Línea de artículos/)
  assert.match(filters, /Cargando\.\.\./)
  assert.match(filters, /value=\{open === 'proveedor' \? proveedorQuery : draftSupplier\}/)
  assert.match(filters, /value=\{open === 'linea' \? lineaQuery : draftLine\}/)
})

test('los labels reflejan el contrato real de períodos, cobertura, vistas e historial', () => {
  assert.match(analysis, /label: '28 días \(4 bloques\)', value: 28/)
  assert.match(analysis, /label: '2 semanas', value: 2/)
  assert.match(columns, /label: 'Compra'/)
  assert.match(columns, /label: 'Ventas'/)
  assert.match(columns, /label: 'Completa'/)
  assert.match(columns, /id: 'ventas',[\s\S]*visible: [^\n]*'sugerido', 'cantidad', 'confirmar'/)
  assert.match(analysis, /suggestedQty: r\.suggestedQty,[\s\S]*confirmedQty: r\.confirmedQty,[\s\S]*confirmed: confirmedSet\.has\(r\.sku\.SKU\)/)
  assert.match(excel, /case 'sugerido': return row\.suggestedQty/)
  assert.match(excel, /case 'cantidad': return row\.confirmedQty/)
  assert.match(excel, /case 'confirmar': return row\.confirmed \? 'Sí' : 'No'/)
  assert.match(excel, /id => visibleFixedCols\.includes\(id\) \|\| ALWAYS_VISIBLE_COLUMNS\.includes\(id\)/)
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
    // Layout actualizado: grid con gridTemplateColumns inline (no clase grid-cols-1)
    /gridTemplateColumns/,
    // Panel dropdown actualizado: border-t en lugar de mt-2
    /border-t border-\[#D1C7BD\] bg-\[#EFE9E1\] px-4 py-2/,
  ]) {
    assert.match(filters, pattern)
  }
  assert.doesNotMatch(filters, /operational-table/)
})

test('Configuración conserva su acción sin label adicional', () => {
  assert.match(filters, /<button\s+onClick=\{onOpenConfig\}/)
  assert.match(filters, /title="Configuración de columnas"[\s\S]*>\s*<Settings2/)
  assert.match(filters, /onClick=\{onOpenConfig\}/)
  assert.doesNotMatch(filters, /Configuración<\/label>/)
})
