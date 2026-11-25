import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRequire } from 'node:module'
import * as decimal from '../src/lib/adquisiciones/purchase-order-decimal.ts'

const helperPath = new URL('../src/lib/adquisiciones/commercial-supplier-review.ts', import.meta.url)
const decimalUrl = new URL('../src/lib/adquisiciones/purchase-commercial-decimal.ts', import.meta.url).href
const source = (await readFile(helperPath, 'utf8')).replace("'./purchase-commercial-decimal'", JSON.stringify(decimalUrl))
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText
const { commercialReviewConvert, commercialReviewValidQuantity, commercialReviewChangedFields, commercialReviewFingerprint } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
const ui = await readFile(new URL('../src/modules/adquisiciones/ordenes-compra/purchase-order-supplier-review.tsx', import.meta.url), 'utf8')
const panel = await readFile(new URL('../src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx', import.meta.url), 'utf8')
const fieldsSource = await readFile(new URL('../src/modules/adquisiciones/ordenes-compra/purchase-order-commercial-fields.tsx', import.meta.url), 'utf8')
const fieldsJs = ts.transpileModule(fieldsSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 } }).outputText
const require = createRequire(import.meta.url)
const fields = { exports: {} }
new Function('require', 'module', 'exports', fieldsJs)(name => name === '@/lib/adquisiciones/purchase-order-decimal' ? decimal : require(name), fields, fields.exports)

test('historical factor conversions and multiples are exact in both directions', () => {
  assert.equal(commercialReviewConvert('100.5', 6, 'multiply', true), '603')
  assert.equal(commercialReviewConvert('603', 6, 'divide', false), '100.5')
  assert.equal(commercialReviewConvert('10000', 6, 'divide', false), '')
  assert.equal(commercialReviewConvert('1666.6667', 6, 'multiply', false), '10000.0002')
  assert.equal(commercialReviewValidQuantity(600, 6), true)
  assert.equal(commercialReviewValidQuantity(605, 6), false)
})

test('the shared creation and review fields display the six-unit presentation and 110 displays', () => {
  const quantity = commercialReviewConvert('660', 6, 'divide', false)
  const markup = renderToStaticMarkup(React.createElement('div', null,
    React.createElement(fields.exports.PurchaseCommercialPresentation, { unit: 'DISPLAY', factor: 6 }),
    React.createElement(fields.exports.PurchaseCommercialQuantity, { description: '513135', unit: 'DISPLAY', value: quantity, onChange() {} }),
    React.createElement(fields.exports.PurchaseCommercialPrice, { description: '513135', unit: 'DISPLAY', value: '10000', onChange() {} }),
  ))
  assert.match(markup, /DISPLAY de 6 unidades/)
  assert.match(markup, /Total DISPLAY/)
  assert.match(markup, /value="110"/)
  assert.match(markup, /Precio DISPLAY/)
  assert.match(markup, /value="10000"/)
  assert.equal((10000 / 6).toFixed(4), '1666.6667')
  assert.match(ui, /Total unidades/)
  for (const component of ['PurchaseCommercialPresentation', 'PurchaseCommercialQuantity', 'PurchaseCommercialPrice']) {
    assert.ok(ui.includes(`<${component}`))
    assert.ok(panel.includes(`<${component}`))
  }
})

test('navigation retains commercial identity after detail is cleared and enables guarded confirmation', () => {
  assert.match(panel, /setSupplierReview\(\{ poId, commercial: detail\.po\.commercial_managed \}\)[\s\S]*?setDetail\(null\)/)
  assert.match(panel, /commercial=\{supplierReview\.commercial\}/)
  assert.doesNotMatch(panel, /commercial=\{detail\?\.po\.commercial_managed/)
  assert.match(ui, /disabled=\{Boolean\(confirmDisabledReason\) \|\| saving \|\| confirming\}/)
  assert.match(ui, /confirmCommercialPurchaseOrder\(poId, revision!\)/)
  assert.match(ui, /changesPending \? 'Guarda la revisión/)
})

test('comparison includes exact commercial price, zero IVA and fixed discounts', () => {
  const original = { quantity: 6, unit_price: 1666.6667, commercial_unit_price_snapshot: 10000, discount_percent: 0, discount_unit_amount: 0, tax_rate: 0, notes: null }
  const current = { ...original, commercial_unit_price: '10000.0001', discount_unit_amount: 2, notes: null }
  assert.deepEqual(commercialReviewChangedFields(original, current).map(field => field.field), ['commercial_unit_price', 'discount_unit_amount'])
  assert.equal(commercialReviewFingerprint([current]), commercialReviewFingerprint([{ ...current }]))
  assert.notEqual(commercialReviewFingerprint([current]), commercialReviewFingerprint([{ ...current, quantity: 12 }]))
  assert.equal(commercialReviewChangedFields({ ...original, commercial_unit_price_snapshot: '99999999999999.0001' }, { ...current, commercial_unit_price: '99999999999999.0002', discount_unit_amount: 0 }).some(field => field.field === 'commercial_unit_price'), true)
})

test('commercial integration retains request, revision and safe restore while traditional confirmation remains separate', () => {
  assert.match(ui, /getCommercialSupplierReviewState\(poId\)/)
  assert.match(ui, /before\.data\.revision !== after\.data\.revision/)
  assert.match(ui, /sessionStorage\.setItem\(requestKey, JSON\.stringify\(request\)\)/)
  assert.match(ui, /pendingRequest \?\? \{ poId, requestId: crypto\.randomUUID\(\), revision: revision!/)
  assert.match(ui, /saveCommercialSupplierReview\(request\)/)
  assert.match(ui, /result\.definite/)
  assert.match(ui, /restore_pending: commercial/)
  assert.match(ui, /pendingRequest \? 'Verifica el guardado pendiente/)
  assert.match(ui, /calculateCommercialDraftTotals\(lines\)/)
  assert.match(panel, /commercial=\{supplierReview\.commercial\}/)
  assert.match(panel, /const updated = await getPurchaseOrderDetail\(poId\)/)
})

test('confirmation guards pending changes and concurrent operations, recovers conflicts and refreshes the confirmed detail', () => {
  assert.match(ui, /conflict \? 'Recarga la revisión antes de confirmar/)
  assert.match(ui, /if \(confirmInFlight\.current \|\| confirming \|\| saving \|\| confirmDisabledReason\) return/)
  assert.match(ui, /commercial \? await confirmCommercialPurchaseOrder\(poId, revision!\) : await confirmPurchaseOrderSupplierReview\(poId\)/)
  assert.match(ui, /result\.error\.includes\('La revisión cambió'\)[\s\S]*?setConflict\(true\)[\s\S]*?setConfirmDialogOpen\(false\)/)
  assert.match(ui, /setConfirmationUncertain\(true\)/)
  assert.match(ui, /disabled=\{saving \|\| confirming \|\| confirmationUncertain \|\| Boolean\(pendingRequest\) \|\| conflict\}/)
  assert.match(panel, /handleSupplierReviewConfirmed[\s\S]*?invalidatePurchaseOrderListCache\(\)[\s\S]*?getPurchaseOrderDetail\(poId\)[\s\S]*?await load\(\)[\s\S]*?setDetail\(updated\)[\s\S]*?setSelectedPo\(updated\.po as PurchaseOrder\)/)
  assert.match(panel, /Cantidad comercial/)
  assert.match(panel, /commercial_unit_price_snapshot/)
})
