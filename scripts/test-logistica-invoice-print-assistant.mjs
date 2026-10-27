import assert from 'node:assert/strict'
import test from 'node:test'
import { getSafeHttpsHostname, openConfirmedInvoicePdf, prepareInvoicePrintWindow, validateBsalePdfResponseUrl, validateBsalePdfUrl, validateBsaleRedirectUrl } from '../src/lib/integraciones/invoice-print-assistant.ts'

const officialPdf = 'https://app2.bsale.cl/view/56713/9abd963d8a28.pdf?sfd=99'

test('only accepts HTTPS PDF URLs from official Bsale hosts', () => {
  assert.equal(validateBsalePdfUrl(officialPdf), officialPdf)
  assert.equal(validateBsalePdfUrl('http://app2.bsale.cl/view/56713/file.pdf'), null)
  assert.equal(validateBsalePdfUrl('https://evil.example/view/56713/file.pdf'), null)
  assert.equal(validateBsalePdfUrl('https://app2.bsale.cl/documents/92668'), null)
})

test('redirect validation allows only known Bsale hosts and never generic storage', () => {
  const initial = 'https://app2.bsale.cl/view/56713/document.pdf?sfd=99'
  const relay = 'https://app2.bsale.cl/view/show_pdf?document=opaque'
  assert.equal(validateBsaleRedirectUrl(relay), relay)
  assert.equal(getSafeHttpsHostname(relay), 'app2.bsale.cl')
  assert.equal(validateBsalePdfResponseUrl(initial, relay), relay)
  assert.equal(validateBsalePdfUrl(relay), null)
  assert.equal(validateBsalePdfResponseUrl(relay, relay), null)
  assert.equal(validateBsaleRedirectUrl('https://app2.bsale.cl/login'), null)
  assert.equal(validateBsaleRedirectUrl('https://app2.bsale.cl/view/56713/not-a-pdf'), null)
  assert.equal(validateBsaleRedirectUrl('https://storage.example.com/file.pdf'), null)
  assert.equal(validateBsaleRedirectUrl('http://app2.bsale.cl/file.pdf'), null)
  assert.equal(validateBsaleRedirectUrl('https://127.0.0.1/file.pdf'), null)
})

test('prepares exactly one auxiliary window from the user gesture', () => {
  let opens = 0
  const target = { closed: false, location: { href: '' }, focus() {}, print() {} }
  const prepared = prepareInvoicePrintWindow(() => { opens += 1; return target })
  assert.equal(prepared, target)
  assert.equal(opens, 1)
})

test('confirmed PDF navigation does not create another window or emit', () => {
  let opens = 0
  let printed = 0
  const target = { closed: false, location: { href: '' }, focus() {}, print() {} }
  const prepared = prepareInvoicePrintWindow(() => { opens += 1; return target })
  const result = openConfirmedInvoicePdf(prepared, officialPdf, () => { printed += 1 })
  assert.deepEqual(result, { opened: true, printable: true })
  assert.equal(opens, 1)
  assert.equal(target.location.href, officialPdf)
  assert.equal(printed, 0)
})

test('native print failures are observable without changing PDF navigation', async () => {
  const target = { closed: false, location: { href: '' }, focus() {}, print() { throw new Error('blocked-by-browser') } }
  const errors = []
  const result = openConfirmedInvoicePdf(target, officialPdf, targetWindow => targetWindow.print(), message => errors.push(message))
  assert.deepEqual(result, { opened: true, printable: true })
  await new Promise(resolve => setTimeout(resolve, 850))
  assert.equal(target.location.href, officialPdf)
  assert.deepEqual(errors, ['blocked-by-browser'])
})

test('blocked or invalid targets never navigate', () => {
  assert.deepEqual(openConfirmedInvoicePdf(null, officialPdf), { opened: false, printable: false, reason: 'POPUP_BLOCKED' })
  assert.deepEqual(openConfirmedInvoicePdf(null, 'https://evil.example/file.pdf'), { opened: false, printable: false, reason: 'INVALID_URL' })
})
