import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { invoiceEmissionEnabled } from '../src/lib/integraciones/invoice-emission-contract.ts'
import { createControlledInvoiceCoordinator } from '../src/lib/integraciones/invoice-emission-coordinator.ts'

const actionSource = await readFile(new URL('../src/app/actions/logistica/sales-order-invoice-attempts.ts', import.meta.url), 'utf8')

test('invoiceEmissionEnabled() implementa política segura por defecto (Secure by Default)', () => {
  const originalEnv = process.env.BSALE_INVOICE_EMISSION_ENABLED

  try {
    // Exact match 'true' enables
    process.env.BSALE_INVOICE_EMISSION_ENABLED = 'true'
    assert.equal(invoiceEmissionEnabled(), true)

    // Explicit 'false' disables
    process.env.BSALE_INVOICE_EMISSION_ENABLED = 'false'
    assert.equal(invoiceEmissionEnabled(), false)

    // Undefined (not set) defaults safely to false
    delete process.env.BSALE_INVOICE_EMISSION_ENABLED
    assert.equal(invoiceEmissionEnabled(), false)

    // Empty string defaults safely to false
    process.env.BSALE_INVOICE_EMISSION_ENABLED = ''
    assert.equal(invoiceEmissionEnabled(), false)

    // Other truthy values or numbers ('1', 'TRUE', 'yes') default safely to false
    process.env.BSALE_INVOICE_EMISSION_ENABLED = '1'
    assert.equal(invoiceEmissionEnabled(), false)

    process.env.BSALE_INVOICE_EMISSION_ENABLED = 'TRUE'
    assert.equal(invoiceEmissionEnabled(), false)

    process.env.BSALE_INVOICE_EMISSION_ENABLED = 'yes'
    assert.equal(invoiceEmissionEnabled(), false)
  } finally {
    if (originalEnv !== undefined) {
      process.env.BSALE_INVOICE_EMISSION_ENABLED = originalEnv
    } else {
      delete process.env.BSALE_INVOICE_EMISSION_ENABLED
    }
  }
})

test('emitSalesOrderInvoice() rechaza inmediatamente cuando el interruptor está desactivado', () => {
  // Verify guard exists before any database or Bsale operations
  const emitStart = actionSource.indexOf('export async function emitSalesOrderInvoice')
  assert.ok(emitStart > 0, 'emitSalesOrderInvoice must exist')

  const emitCode = actionSource.slice(emitStart)
  const authCheck = emitCode.indexOf('requireWmsPermission')
  const switchCheck = emitCode.indexOf('if (!invoiceEmissionEnabled())')
  const dbInit = emitCode.indexOf('const db = await createClient()')
  const postCall = emitCode.indexOf('bsaleWriteForCompany')

  assert.ok(switchCheck > authCheck, 'Switch check must follow auth check')
  assert.ok(switchCheck < dbInit, 'Switch check must occur before database client creation / prevalidation')
  assert.ok(switchCheck < postCall, 'Switch check must occur before Bsale POST write call')

  // Check controlled return structure
  assert.match(emitCode, /if \(!invoiceEmissionEnabled\(\)\)\s*return\s*\{\s*status:\s*'EMISSION_DISABLED'\s*as const,\s*error:\s*'La emisión de facturas está temporalmente suspendida\.'\s*\}/)
})

test('El interruptor desactivado garantiza cero llamadas POST y cero escrituras en Bsale', async () => {
  let postCount = 0
  const coordinator = createControlledInvoiceCoordinator({
    post: async () => {
      postCount += 1
      return { id: 100 }
    },
  })

  const fakeInput = {
    salesId: 'PETGROUP:FACTURA:switch-test',
    fingerprint: 'fp-switch-test',
    payload: { details: [] },
    expected: { clientId: 1, officeId: 1, totals: { net: 10, tax: 1.9, total: 11.9 }, details: [] },
  }

  // When disabled (enabled = false)
  const result = await coordinator.emit(fakeInput, false)
  assert.equal(result.reason, 'EMISSION_DISABLED')
  assert.equal(postCount, 0, 'Must make zero POST calls when emission switch is false')
})

test('La pausa de emisión NO afecta ni bloquea la recuperación / reconciliación (reconcile)', () => {
  const reconcileStart = actionSource.indexOf('async function findUniqueCandidateInvoice')
  assert.ok(reconcileStart > 0, 'findUniqueCandidateInvoice must exist')

  const reconcileCode = actionSource.slice(reconcileStart)

  // reconcile must NEVER be blocked by invoiceEmissionEnabled
  assert.doesNotMatch(reconcileCode, /invoiceEmissionEnabled/)
  assert.doesNotMatch(reconcileCode, /EMISSION_DISABLED/)

  // Reconcile retains read-only GET queries
  assert.match(reconcileCode, /bsaleFetchResourceForCompany/)
  assert.match(reconcileCode, /verifyStockWithBoundedReads/)
})

test('El interruptor no modifica el estado de intentos existentes en base de datos', () => {
  // Verify that the switch rejection is a purely stateless return without database updates
  const emitStart = actionSource.indexOf('export async function emitSalesOrderInvoice')
  const emitCode = actionSource.slice(emitStart)
  const switchCheckStart = emitCode.indexOf('if (!invoiceEmissionEnabled())')
  const switchCheckEnd = emitCode.indexOf('const db = await createClient()')
  const switchBlock = emitCode.slice(switchCheckStart, switchCheckEnd)

  assert.doesNotMatch(switchBlock, /markAttempt/)
  assert.doesNotMatch(switchBlock, /\.update\(/)
  assert.doesNotMatch(switchBlock, /\.rpc\(/)
})
