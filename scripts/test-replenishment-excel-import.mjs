import assert from 'node:assert/strict'
import test from 'node:test'
import * as XLSX from 'xlsx'
import { getVisibleReplenishmentExcelRows, parseReplenishmentExcel } from '../src/modules/adquisiciones/ordenes-compra/replenishment-excel-import.ts'

const catalog = [
  { id: 'product-1', sku: 'SKU-1', description: 'Producto uno' },
  { id: 'product-2', sku: 'SKU-2', description: 'Producto dos' },
].map(product => ({
  ...product,
  barcode: null,
  unit_of_measure: 'UNIDAD',
  tax_rate: 19,
  bsale_variant_id: null,
  last_purchase_unit_cost: null,
}))

function excelFile(name, headers, rows, provider = 'Proveedor Uno') {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['ANÁLISIS DE REPOSICIÓN — CONTEXTO DE EXPORTACIÓN'],
    ['Proveedor', provider],
    [],
  ]), 'Contexto')
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, ...rows]), 'Detalle')
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
  return { name, arrayBuffer: async () => buffer }
}

test('detecta Compra, Ventas y Completa por encabezados', async () => {
  const base = ['SKU', 'Producto / desc.', 'Sugerido', 'Cantidad confirmada', 'Confirmado']
  const compra = await parseReplenishmentExcel(excelFile('compra.xlsx', [...base, 'Monto estimado'], [['SKU-1', 'Uno', 8, 3, 'Sí', 100]]), catalog)
  const ventas = await parseReplenishmentExcel(excelFile('ventas.xlsx', [...base, 'Total vendido', 'Promedio semanal', 'Costo unitario'], [['SKU-1', 'Uno', 8, 3, 'Sí', 20, 2, 100]]), catalog)
  const completa = await parseReplenishmentExcel(excelFile('completa.xlsx', [...base, 'Monto estimado', 'Total vendido', 'Promedio semanal', 'Costo unitario'], [['SKU-1', 'Uno', 8, 3, 'Sí', 100, 20, 2, 100]]), catalog)
  assert.equal(compra.format, 'COMPRA')
  assert.equal(ventas.format, 'VENTAS')
  assert.equal(completa.format, 'COMPLETA')
})

test('usa Cantidad, no Sugerido, preserva el valor manual y valida estados', async () => {
  const preview = await parseReplenishmentExcel(excelFile('manual.xlsx', ['Confirmado', 'Producto', 'SKU', 'Sugerido', 'Cantidad'], [
    ['Sí', 'Uno', 'SKU-1', 99, 4],
    ['No', 'Uno', 'SKU-3', 20, 7],
    ['Sí', 'Desconocido', 'SKU-X', 5, 2],
    ['Sí', 'Duplicado', 'SKU-2', 5, 1],
    ['Sí', 'Duplicado', 'SKU-2', 5, 1],
    ['Sí', 'Cero', 'SKU-4', 5, 0],
  ]), catalog)
  assert.equal(preview.provider, 'Proveedor Uno')
  assert.equal(preview.selectionBasis, 'CONFIRMADO_Y_CANTIDAD')
  assert.equal(preview.rows[0].quantity, 4)
  assert.equal(preview.rows[0].status, 'VALIDO')
  assert.equal(preview.rows[1].status, 'NO_CONFIRMADO')
  assert.equal(preview.rows[2].status, 'SKU_NO_ENCONTRADO')
  assert.equal(preview.rows[3].status, 'DUPLICADO')
  assert.equal(preview.rows[5].status, 'CANTIDAD_INVALIDA')
})

test('sin Confirmado selecciona por Cantidad > 0 y deja proveedor sin inventar', async () => {
  const preview = await parseReplenishmentExcel(excelFile('sin-confirmar.xlsx', ['Cantidad', 'SKU', 'Producto'], [[2, 'SKU-1', 'Uno']], 'Todos'), catalog)
  assert.equal(preview.selectionBasis, 'CANTIDAD')
  assert.equal(preview.rows[0].status, 'VALIDO')
  assert.equal(preview.provider, 'Proveedor por seleccionar')
})

test('oculta No confirmado por defecto y permite mostrar todas las filas', async () => {
  const rows = [
    ['SKU-1', 'Uno', 5, 2, 'Sí'],
    ['SKU-2', 'Dos', 5, 3, 'Sí'],
    ...Array.from({ length: 49 }, (_, index) => [`NO-${index}`, `No confirmado ${index}`, 5, 0, 'No']),
  ]
  const preview = await parseReplenishmentExcel(excelFile('compra-51.xlsx', ['SKU', 'Producto', 'Sugerido', 'Cantidad confirmada', 'Confirmado'], rows), catalog)
  assert.equal(preview.totalRows, 51)
  assert.equal(preview.validRows, 2)
  assert.equal(getVisibleReplenishmentExcelRows(preview.rows, false).length, 2)
  assert.equal(getVisibleReplenishmentExcelRows(preview.rows, true).length, 51)
})

test('mantiene visibles los errores junto a las filas válidas', async () => {
  const rows = [
    ['SKU-1', 'Uno', 5, 2, 'Sí'],
    ['SKU-2', 'Dos', 5, 3, 'Sí'],
    ['SKU-INEXISTENTE', 'No existe', 5, 1, 'Sí'],
    ...Array.from({ length: 48 }, (_, index) => [`NO-${index}`, `No confirmado ${index}`, 5, 0, 'No']),
  ]
  const preview = await parseReplenishmentExcel(excelFile('compra-error.xlsx', ['SKU', 'Producto', 'Sugerido', 'Cantidad confirmada', 'Confirmado'], rows), catalog)
  const visibleRows = getVisibleReplenishmentExcelRows(preview.rows, false)
  assert.equal(preview.totalRows, 51)
  assert.equal(preview.validRows, 2)
  assert.equal(visibleRows.length, 3)
  assert.equal(visibleRows.filter(row => row.status === 'VALIDO').length, 2)
  assert.equal(visibleRows.filter(row => row.status === 'SKU_NO_ENCONTRADO').length, 1)
  assert.equal(getVisibleReplenishmentExcelRows(preview.rows, true).length, 51)
})
