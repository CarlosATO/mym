import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { buildPayrollPreview } from '../src/lib/control-financiero/payroll-parser.ts'
import { REQUIRED_PAYROLL_IMPORT_NUMERIC_FIELDS, validatePayrollImportMetadata } from '../src/lib/control-financiero/payroll-import-contract.ts'

const actionSource = await readFile(new URL('../src/app/actions/control-financiero/payroll.ts', import.meta.url), 'utf8')
const migrationSource = await readFile(new URL('../supabase/migrations/20261003130000_financial_payroll_atomic_import.sql', import.meta.url), 'utf8')
const hotfixSource = await readFile(new URL('../supabase/migrations/20261003140000_financial_payroll_atomic_import_totals_hotfix.sql', import.meta.url), 'utf8')

function fixture() {
  const codes = ['1101', '1102', '1115', '2101', '2106', '5201', '5210', '5230', '5240', '5301', '5302', '5341', '5410', '5501', '5502', '5564', '5565']
  const values = Object.fromEntries(codes.map(code => [code, '0']))
  Object.assign(values, { 1101: '77.196.005-7', 1102: '1/1/2026', 1115: '30', 2101: '700', 2106: '300', 5201: '1000', 5210: '1000', 5301: '200', 5302: '0', 5341: '200', 5410: '100', 5501: '800' })
  return `${codes.map(code => `Campo(${code})`).join(';')}\n${codes.map(code => values[code]).join(';')}\n`
}

test('preview contract keeps year explicit and never imports', () => {
  const withoutYear = buildPayrollPreview(fixture(), { filename: 'Enero.csv' })
  assert.equal(withoutYear.file.selectedYear, null)
  assert.equal(withoutYear.validation.canImport, false)
  assert.equal(withoutYear.totals.totalLaborCost, 1100)
  assert.equal(withoutYear.totals.recurringLaborCost, 1100)
  assert.match(actionSource, /export async function previewPayrollFileAction/)
  assert.match(actionSource, /export async function confirmPayrollImportAction/)
})

test('confirmation reparses and sends normalized snapshots to atomic boundary', () => {
  assert.equal((actionSource.match(/buildPayrollPreview\(/g) ?? []).length >= 2, true)
  assert.match(actionSource, /import_financial_payroll_atomic/)
  assert.match(actionSource, /total_salary: preview\.totals\.totalSalary/)
  assert.match(actionSource, /p_entries: preview\.parsedFile\.rows\.map\(snapshotRow\)/)
  assert.doesNotMatch(actionSource, /p_entries: preview\.parsedFile\.rows\}/)
  assert.match(migrationSource, /security definer/)
  assert.match(migrationSource, /La verificación post-inserción no coincide/)
  assert.match(hotfixSource, /PAYROLL_METADATA_FIELD_MISSING:%/)
  assert.match(hotfixSource, /\(p_metadata->>'total_salary'\)::bigint/)
})

test('numeric import metadata rejects missing total_salary before RPC', () => {
  const metadata = Object.fromEntries(REQUIRED_PAYROLL_IMPORT_NUMERIC_FIELDS.map(field => [field, 0]))
  metadata.total_salary = 5426311
  assert.equal(validatePayrollImportMetadata(metadata), null)
  delete metadata.total_salary
  assert.equal(validatePayrollImportMetadata(metadata), 'total_salary')
  metadata.total_salary = null
  assert.equal(validatePayrollImportMetadata(metadata), 'total_salary')
})

test('atomic contract guards duplicate hash and active period', () => {
  assert.match(migrationSource, /Este archivo ya fue importado/)
  assert.match(migrationSource, /Este período ya tiene una importación activa/)
  assert.match(migrationSource, /financial_payroll_entries/)
})
