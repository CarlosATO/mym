import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/modules/logistica/guias-ruta/components/route-guide-form.tsx', import.meta.url), 'utf8')

test('verifica folios sólo al crear o despachar, no al abrir el formulario', () => {
  assert.match(source, /syncBsaleDocumentsForRouteGuide\(/)
  assert.match(source, /if \(!guideId\)/)
  assert.match(source, /verifyBeforeDispatch/)
  assert.match(source, /ready !== verification\.requested/)
  assert.match(source, /setTimeout\(\(\) => \{[\s\S]*?void startBsaleVerification/)
})

test('bloquea persistencia y conserva el formulario cuando Bsale no está completo', () => {
  assert.match(source, /if \(!verification\.success[\s\S]*?return;/)
  assert.match(source, /No fue posible verificar todas las facturas en Bsale\./)
  assert.match(source, /Reintentar verificación/)
  assert.match(source, /invoice_numbers: numbers/)
})

test('usa mensajes operacionales y evita doble submit', () => {
  assert.match(source, /Factura aún no disponible en Bsale\./)
  assert.match(source, /No fue posible obtener el detalle de la factura\./)
  assert.match(source, /No fue posible identificar el cliente de la factura\./)
  assert.match(source, /isVerifyingBsale/)
  assert.match(source, /Verificando facturas\.\.\./)
  assert.match(source, /verificationRef/)
  assert.match(source, /verificationSequence/)
  assert.match(source, /actionInProgress/)
  assert.match(source, /verificationRef\.current\?\.key === key\) verificationRef\.current = null/)
  assert.match(source, /\}, \[guideId, readOnly, invoiceSetKey\]\)/)
})
