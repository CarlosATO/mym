import assert from 'node:assert/strict'
import test from 'node:test'
import { getSafeHttpsHostname, openConfirmedInvoicePdf, prepareInvoicePrintWindow, validateBsalePdfUrl, validateBsaleRedirectUrl } from '../src/lib/integraciones/invoice-print-assistant.ts'

const officialPdf = 'https://app2.bsale.cl/view/56713/9abd963d8a28.pdf?sfd=99'

test('only accepts official HTTPS Bsale PDF URLs', () => {
  assert.equal(validateBsalePdfUrl(officialPdf), officialPdf)
  assert.equal(validateBsalePdfUrl('http://app2.bsale.cl/view/56713/file.pdf'), null)
  assert.equal(validateBsalePdfUrl('https://evil.example/file.pdf'), null)
  assert.equal(validateBsaleRedirectUrl('https://app2.bsale.cl/login'), null)
  assert.equal(getSafeHttpsHostname(officialPdf), 'app2.bsale.cl')
})

test('prepares one window and navigates only after validation', () => {
  let opens = 0
  const target = { closed: false, location: { href: '' }, focus() {}, print() {} }
  const prepared = prepareInvoicePrintWindow(() => { opens += 1; return target })
  assert.equal(prepared, target)
  assert.equal(opens, 1)
  assert.deepEqual(openConfirmedInvoicePdf(prepared, officialPdf, () => undefined), { opened: true, printable: true })
  assert.equal(target.location.href, officialPdf)
  assert.deepEqual(openConfirmedInvoicePdf(prepared, 'https://evil.example/file.pdf'), { opened: false, printable: false, reason: 'INVALID_URL' })
})

test('reports a programmatic print failure without changing document navigation', async () => {
  const target = { closed: false, location: { href: '' }, focus() {}, print() { throw new Error('blocked-by-browser') } }
  const errors = []
  openConfirmedInvoicePdf(target, officialPdf, targetWindow => targetWindow.print(), message => errors.push(message))
  await new Promise(resolve => setTimeout(resolve, 850))
  assert.equal(target.location.href, officialPdf)
  assert.deepEqual(errors, ['blocked-by-browser'])
})
