import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
  EXPECTED_CREDIT_NOTE_TOTAL_CLP,
  EXPECTED_EXCEL_SHA256,
  EXPECTED_ORIGINAL_TOTAL_CLP,
  EXPECTED_PENDING_COUNT,
  EXPECTED_PENDING_TOTAL_CLP,
  extractPendingInvoicesFromWorkbookBuffer,
} from './import-cxp-historical-pending-excel.mjs'

const migrationPath = path.join(
  process.cwd(),
  'supabase/migrations/20261123201000_cxp_excel_historical_pending_evidence.sql',
)
const migrationSql = fs.readFileSync(migrationPath, 'utf8')

test('Contrato SQL de migración 20261123201000: integridad, inmutabilidad y permisos', () => {
  assert.match(migrationSql, /CREATE TABLE cuentas_por_pagar\.historical_pending_excel_batches/)
  assert.match(migrationSql, /CREATE TABLE cuentas_por_pagar\.historical_pending_excel_records/)
  assert.match(
    migrationSql,
    /round\(original_amount_clp - credit_note_amount_clp, 2\) = round\(pending_balance_clp, 2\)/,
  )
  assert.match(migrationSql, /UNIQUE \(company_id, issuer_rut_normalized, document_folio\)/)
  assert.match(migrationSql, /prevent_historical_pending_batch_mutation/)
  assert.match(migrationSql, /prevent_historical_pending_record_mutation/)
  assert.match(migrationSql, /WITH \(security_invoker = true\)/)
  assert.match(migrationSql, /CREATE OR REPLACE FUNCTION public\.cxp_historical_pending_excel_sii_matches\(\)/)
  assert.match(migrationSql, /cuentas_por_pagar\.can_access\(v_company_id\)/)
  assert.match(migrationSql, /GRANT EXECUTE ON FUNCTION public\.cxp_historical_pending_excel_sii_matches\(\) TO authenticated/)
  assert.doesNotMatch(migrationSql, /UPDATE cuentas_por_pagar\.invoices/)
  assert.doesNotMatch(migrationSql, /INSERT INTO cuentas_por_pagar\.invoice_payments/)
  assert.doesNotMatch(migrationSql, /historical_paid_excel_records/)
})

test('Extracción, cuadratura exacta e idempotencia del lote de 70 facturas pendientes', () => {
  const candidatePaths = [
    path.join(process.env.HOME || '', 'Downloads', 'COMPRAS(1).xlsx'),
    path.join(process.env.HOME || '', 'Downloads', 'COMPRAS.xlsx'),
  ]
  const excelPath = candidatePaths.find(p => fs.existsSync(p))
  if (!excelPath) {
    return
  }

  const buf = fs.readFileSync(excelPath)
  const first = extractPendingInvoicesFromWorkbookBuffer(buf)
  const second = extractPendingInvoicesFromWorkbookBuffer(buf)

  assert.match(first.sha256, /^[a-f0-9]{64}$/)
  assert.equal(first.sha256, second.sha256)
  assert.equal(first.totals.count, EXPECTED_PENDING_COUNT)
  assert.equal(first.totals.originalAmountClp, EXPECTED_ORIGINAL_TOTAL_CLP)
  assert.equal(first.totals.creditNoteAmountClp, EXPECTED_CREDIT_NOTE_TOTAL_CLP)
  assert.equal(first.totals.pendingBalanceClp, EXPECTED_PENDING_TOTAL_CLP)
  assert.deepEqual(first.pendingRecords, second.pendingRecords)
})
