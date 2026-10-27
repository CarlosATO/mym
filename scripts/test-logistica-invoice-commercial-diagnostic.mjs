import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { evaluateInvoiceCommercialValidation } from '../src/lib/integraciones/invoice-commercial-validation.ts'

const selection = { payment_type_id: 18, sale_condition_id: 15, expiration_date: '2026-10-26' }

function fixture(overrides = {}) {
  return {
    currentNvId: 92558,
    nv: { id: 92558, document_type: { id: '23' }, state: 0, client: { id: '215' }, office: { id: '1' }, priceList: { id: '4' }, details: { items: [{ id: 335112, quantity: 4 }] } },
    sellers: { count: 1, items: [{ id: 41 }] },
    paymentTypes: { count: 8, limit: 25, offset: 0, items: [{ id: 18 }] },
    saleConditions: { count: 8, limit: 25, offset: 0, items: [{ id: 15 }] },
    client: { id: 215 },
    clientError: false,
    syncedClientError: false,
    paymentTypeId: 18,
    selection,
    ...overrides,
  }
}

test('diagnóstico reproduce la validación comercial sin bloqueo', () => {
  const result = evaluateInvoiceCommercialValidation(fixture({ client: { id: 215, code: '76123456-7', businessName: 'Cliente Bsale' } }))
  assert.equal(result.missingCommercialFields, false)
  assert.equal(result.commercialBlockTriggered, false)
  assert.ok(result.requiredFields.every(predicate => predicate.result))
  assert.ok(result.commercialPredicates.every(predicate => !predicate.result))
})

test('cliente Bsale ausente o con otro ID sigue bloqueando', () => {
  for (const client of [null, { id: 999 }]) {
    const result = evaluateInvoiceCommercialValidation(fixture({ client }))
    const predicate = result.commercialPredicates.find(item => item.name === 'cliente coincide')
    assert.equal(predicate?.result, true)
    assert.equal(result.commercialBlockTriggered, true)
  }
})

test('diagnóstico identifica un catálogo de forma de pago ausente', () => {
  const result = evaluateInvoiceCommercialValidation(fixture({ paymentTypes: { count: 8, limit: 25, offset: 0, items: [] } }))
  const predicate = result.commercialPredicates.find(item => item.name === 'forma de pago está en catálogo')
  assert.equal(predicate?.result, true)
  assert.equal(result.commercialBlockTriggered, true)
})

test('server action de diagnóstico no contiene rutas de escritura', async () => {
  const source = await readFile(new URL('../src/app/actions/logistica/sales-order-invoice-diagnostics.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /bsaleWriteForCompany|begin_sales_order_invoice_submission|prepare_sales_order_invoice_attempt/)
  assert.match(source, /bsaleFetchForCompany|bsaleFetchResourceForCompany/)
  assert.match(source, /NODE_ENV === 'production'/)
  assert.match(source, /const \[client, \{ data: syncedClient, error: syncedClientError \}\]/)
})

test('emisión interpreta el recurso cliente Bsale directamente', async () => {
  const source = await readFile(new URL('../src/app/actions/logistica/sales-order-invoice-attempts.ts', import.meta.url), 'utf8')
  assert.match(source, /const \[client, \{ data: syncedClient, error: syncedClientError \}\]/)
  assert.doesNotMatch(source, /\{ data: client, error: clientError \}/)
})

test('botón dev-only sólo conecta la acción diagnóstica', async () => {
  const panel = await readFile(new URL('../src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx', import.meta.url), 'utf8')
  const modal = await readFile(new URL('../src/modules/logistica/preparacion-pedidos/invoice-flow-ui.tsx', import.meta.url), 'utf8')
  assert.match(panel, /process\.env\.NODE_ENV === 'development'/)
  assert.match(panel, /LOCAL_INVOICE_DIAGNOSTIC_CARD_ID/)
  assert.match(panel, /onDiagnose=\{isLocalInvoiceDiagnosticTarget\(invoiceReviewSnapshot\) \? diagnoseInvoiceCommercial : undefined\}/)
  assert.match(panel, /diagnoseSalesOrderInvoiceCommercial\(snapshot\.card_id, snapshot\.commercial_selection \?\? null\)/)
  assert.match(modal, /Diagnosticar sin emitir/)
  assert.doesNotMatch(modal, /emitSalesOrderInvoice/)
})
