import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const action = await readFile(new URL('../src/app/actions/logistica/sales-order-invoice-attempts.ts', import.meta.url), 'utf8')
const contract = await readFile(new URL('../src/lib/integraciones/invoice-emission-contract.ts', import.meta.url), 'utf8')
const reconciliation = await readFile(new URL('../supabase/migrations/20261030120743_logistica_invoice_reconciliation_strict.sql', import.meta.url), 'utf8')

test('la emisión verifica stock antes de confirmar y conserva identidad/comercio', () => {
  assert.match(action, /verifyInvoiceStockDispatch/)
  assert.match(action, /companyId: auth\.companyId[\s\S]*invoiceId[\s\S]*invoiceNumber: invoice\.number[\s\S]*salesId: attemptSalesId[\s\S]*officeId[\s\S]*details: snapshotDetails\.map/)
  assert.match(action, /const stockVerification = await verifyStockWithBoundedReads/)
  assert.match(action, /stockVerification\.status !== 'VERIFIED'/)
  assert.match(action, /mark_sales_order_invoice_reconciliation_required/)
  assert.match(action, /confirm_sales_order_invoice_attempt/)
  assert.equal((action.match(/bsaleWriteForCompany/g) ?? []).length, 2)
  assert.equal((action.match(/path: '\/documents\.json'/g) ?? []).length, 1)
})

test('PENDING y UNABLE_TO_VERIFY no confirman ni generan una segunda emisión', () => {
  const guardStart = action.indexOf("if (stockVerification.status !== 'VERIFIED')")
  const guardEnd = action.indexOf('const { data: confirmed', guardStart)
  const guard = action.slice(guardStart, guardEnd)
  assert.match(guard, /markAttempt\(db, 'mark_sales_order_invoice_reconciliation_required'/)
  assert.doesNotMatch(guard, /bsaleWriteForCompany|confirm_sales_order_invoice_attempt/)
  assert.match(action, /STOCK_\$\{stockVerification\.status\}/)
})

test('la política de propagación tiene un máximo explícito de dos lecturas', () => {
  assert.match(action, /STOCK_VERIFICATION_MAX_READS = 2/)
  assert.match(action, /read < STOCK_VERIFICATION_MAX_READS/)
  assert.match(action, /STOCK_VERIFICATION_RETRY_DELAY_MS = 250/)
})

test('FAC-STOCK-01A conserva dispatch numérico y salesId', () => {
  assert.match(contract, /documentTypeId: 5/)
  assert.match(contract, /dispatch: 1/)
  assert.match(contract, /salesId: string/)
  assert.match(action, /salesId: attemptSalesId/)
})

test('las RPC de reconciliación actuales son un bypass documentado para el siguiente bloque', () => {
  assert.match(reconciliation, /CREATE OR REPLACE FUNCTION logistica\.reconcile_sales_order_invoice_attempt/)
  assert.match(reconciliation, /CREATE OR REPLACE FUNCTION logistica\.confirm_sales_order_invoice_attempt/)
  assert.doesNotMatch(reconciliation, /shippings\.json|stockVerification|verifyInvoiceStockDispatch/)
})
