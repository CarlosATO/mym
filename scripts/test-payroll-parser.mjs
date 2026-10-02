import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { buildPayrollPreview, isValidRut, normalizeRut, parsePayrollCsv } from '../src/lib/control-financiero/payroll-parser.ts'

const requiredCodes = ['1101', '1102', '1103', '1115', '1116', '1117', '2101', '2106', '2161', '2301', '2302', '2303', '2311', '2313', '3141', '3143', '3151', '3161', '3188', '4151', '4152', '4155', '5201', '5210', '5220', '5230', '5240', '5301', '5302', '5341', '5361', '5410', '5501', '5502', '5564', '5565']
const codeLabels = {
  1101: 'Rut trabajador', 1102: 'Fecha inicio contrato', 1103: 'Fecha término de contrato', 1115: 'Días trabajados',
  1116: 'Días licencia', 1117: 'Días vacaciones', 2101: 'Sueldo', 2106: 'Gratificación', 2161: 'Sueldo empresarial',
  2301: 'Colación', 2302: 'Movilización', 2303: 'Viáticos', 2311: 'Asignación familiar', 2313: 'Indemnización feriado',
  3141: 'AFP', 3143: 'Salud', 3151: 'AFC trabajador', 3161: 'Impuesto', 3188: 'Anticipos', 4151: 'AFC empleador',
  4152: 'Accidentes SANNA', 4155: 'SIS', 5201: 'Total haberes', 5210: 'Haberes imponibles', 5220: 'Haberes imponibles no tributables',
  5230: 'Haberes no imponibles', 5240: 'Haberes no imponibles tributables', 5301: 'Total descuentos', 5302: 'Otros descuentos',
  5341: 'Cotizaciones trabajador', 5361: 'Impuestos', 5410: 'Aportes empleador', 5501: 'Total líquido', 5502: 'Indemnizaciones',
  5564: 'Indemnizaciones tributables', 5565: 'Indemnizaciones no tributables',
}

function fixture({ rut = '77.196.005-7', earnings = 1000, deductions = 200, employer = 100, indemnities = 0, trailing = '' } = {}) {
  const values = Object.fromEntries(requiredCodes.map(code => [code, '']))
  Object.assign(values, { 1101: rut, 1102: '1/1/2026', 1115: '30', 2101: '700', 2106: '300', 5201: earnings, 5210: earnings, 5220: '0', 5230: '0', 5240: '0', 5301: deductions, 5302: deductions, 5341: deductions, 5410: employer, 5501: earnings - deductions, 5502: indemnities, 5564: '0', 5565: indemnities })
  const headers = requiredCodes.map(code => `${codeLabels[code] ?? 'Campo'}(${code})`).join(';')
  return `${headers};\r\n${requiredCodes.map(code => values[code]).join(';')};${trailing}\r\n`
}

test('decodifica Latin-1, CRLF, columna final vacía y hash', () => {
  const csv = fixture()
  const bytes = Buffer.from(csv, 'latin1')
  const parsed = parsePayrollCsv(bytes, 'Enero.csv')
  assert.equal(parsed.encoding, 'ISO-8859-1')
  assert.equal(parsed.headers.length, requiredCodes.length)
  assert.equal(parsed.rows.length, 1)
  assert.equal(parsed.detectedMonth, 1)
  assert.equal(parsed.hash, createHash('sha256').update(bytes).digest('hex'))
})

test('normaliza y valida RUT', () => {
  assert.equal(normalizeRut('77.196.005-7'), '77196005-7')
  assert.equal(isValidRut('77.196.005-7'), true)
  assert.equal(isValidRut('77.196.005-8'), false)
})

test('preview requiere año y calcula costo sin duplicar indemnizaciones', () => {
  const previewWithoutYear = buildPayrollPreview(fixture({ indemnities: 50 }), { filename: 'Marzo.csv' })
  assert.equal(previewWithoutYear.file.detectedMonth, 3)
  assert.equal(previewWithoutYear.file.selectedYear, null)
  assert.equal(previewWithoutYear.validation.canImport, false)
  assert.equal(previewWithoutYear.totals.totalLaborCost, 1100)
  assert.equal(previewWithoutYear.totals.recurringLaborCost, 1050)

  const preview = buildPayrollPreview(fixture({ indemnities: 50 }), { filename: 'Marzo.csv', selectedYear: 2026 })
  assert.equal(preview.validation.canImport, true)
})

test('detecta RUT inválido y columna requerida faltante', () => {
  const invalid = fixture({ rut: '77.196.005-8' })
  const preview = buildPayrollPreview(invalid, { filename: 'Enero.csv', selectedYear: 2026 })
  assert.equal(preview.workers.invalidRutCount, 1)
  assert.equal(preview.validation.canImport, false)

  const missing = invalid.replace('Total líquido(5501);', '')
  const missingPreview = buildPayrollPreview(missing, { filename: 'Enero.csv', selectedYear: 2026 })
  assert.equal(missingPreview.structure.recognized, false)
  assert.equal(missingPreview.validation.canImport, false)
})

test('preserva valores vacíos y expone raw values', () => {
  const parsed = parsePayrollCsv(fixture({ trailing: '' }), 'Agosto.csv')
  assert.equal(parsed.rows[0].salary, 700)
  assert.equal(parsed.rows[0].contractEndDate, null)
  assert.equal(parsed.rows[0].rawValuesByCode['1101'], '77.196.005-7')
})
