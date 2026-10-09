import assert from 'node:assert/strict'
import { test } from 'node:test'
// The standalone Node test runner loads the TypeScript source directly.
import { classifyExcelCogsDocument, decimalToString, groupHistoricalCogsRows } from '../src/lib/integraciones/bsale-historical-cogs-excel.ts'

test('groups invoice/boleta rows and excludes NC/NV by document type', () => {
  const documents = groupHistoricalCogsRows([
    { 'Tipo de Documento': 'FACTURA ELECTRÓNICA', 'Numero del documento': '10', 'Fecha de Emisión': '01/01/2026', 'Venta Total Neta': 100, 'Costo Total Neto': 60 },
    { 'Tipo de Documento': 'BOLETA ELECTRÓNICA T', 'Numero del documento': '20', 'Fecha de Emisión': '02/01/2026', 'Venta Total Neta': 50, 'Costo Total Neto': 0 },
    { 'Tipo de Documento': 'NOTA DE CRÉDITO ELECTRÓNICA', 'Numero del documento': '30', 'Fecha de Emisión': '03/01/2026', 'Venta Total Neta': -10, 'Costo Total Neto': -5 },
    { 'Tipo de Documento': 'NOTA DE VENTA', 'Numero del documento': '40', 'Fecha de Emisión': '04/01/2026', 'Venta Total Neta': 20, 'Costo Total Neto': 10 },
  ], 2026)
  assert.equal(documents.length, 2)
  assert.equal(documents[0].totalCostExcel, '60')
  assert.equal(documents[1].zeroCost, true)
})

test('uses Decimal-style integer arithmetic and detects duplicate source rows', () => {
  const documents = groupHistoricalCogsRows([
    { 'Tipo de Documento': 'FACTURA ELECTRÓNICA', 'Numero del documento': '10', 'Fecha de Emisión': '01/01/2026', 'Venta Total Neta': '0.10', 'Costo Total Neto': '0.10' },
    { 'Tipo de Documento': 'FACTURA ELECTRÓNICA', 'Numero del documento': '10', 'Fecha de Emisión': '01/01/2026', 'Venta Total Neta': '0.20', 'Costo Total Neto': '0.20' },
  ], 2026)
  assert.equal(documents[0].netAmountExcel, '0.3')
  assert.equal(documents[0].duplicateSourceRows, 0)
  assert.equal(decimalToString({ integer: BigInt(30), scale: 2 }), '0.3')
})

test('API OBSERVED has priority over Excel and Excel never overwrites it', () => {
  const document = groupHistoricalCogsRows([{ 'Tipo de Documento': 'FACTURA ELECTRÓNICA', 'Numero del documento': '10', 'Fecha de Emisión': '01/01/2026', 'Venta Total Neta': 100, 'Costo Total Neto': 60 }])[0]
  assert.equal(classifyExcelCogsDocument(document, { petGroup: { bsale_id: 10, document_type_id: 5, number: '10', emission_date: '2026-01-01', net_amount: 100 }, ambiguous: false, apiCost: { bsale_document_id: 10, total_cost: 55, status: 'OBSERVED', source: 'BSALE_DOCUMENT_COSTS' }, netMatches: true, dateMatches: true }), 'API_ALREADY_OBSERVED')
})

test('positive, zero, invalid, ambiguous and net difference statuses are safe', () => {
  const base = groupHistoricalCogsRows([{ 'Tipo de Documento': 'FACTURA ELECTRÓNICA', 'Numero del documento': '10', 'Fecha de Emisión': '01/01/2026', 'Venta Total Neta': 100, 'Costo Total Neto': 60 }], 2026)[0]
  const match = { petGroup: { bsale_id: 10, document_type_id: 5, number: '10', emission_date: '2026-01-01', net_amount: 100 }, ambiguous: false, apiCost: null, netMatches: true, dateMatches: true }
  assert.equal(classifyExcelCogsDocument(base, match), 'EXCEL_CANDIDATE_OBSERVED')
  const zero = groupHistoricalCogsRows([{ ...base.rows[0], 'Costo Total Neto': 0 }], 2026)[0]
  assert.equal(classifyExcelCogsDocument(zero, match), 'EXCEL_MISSING_ZERO')
  assert.equal(classifyExcelCogsDocument(base, { ...match, netMatches: false }), 'NET_DIFFERENCE')
  assert.equal(classifyExcelCogsDocument(base, { ...match, ambiguous: true }), 'AMBIGUOUS_MATCH')
})
