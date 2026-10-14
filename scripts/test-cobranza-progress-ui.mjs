import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const view = await readFile(new URL('../src/modules/analisis-comercial/views/cobranza.tsx', import.meta.url), 'utf8')
const observer = view.slice(view.indexOf('const paymentBatchStatusLabel'), view.indexOf('export function Cobranza'))
const detail = view.slice(view.indexOf('function PaymentProgressDetail'), view.indexOf('function PaymentProgressSheet'))
const main = view.slice(view.indexOf('export function Cobranza'))

test('A: estado vacío muestra ambos indicadores en cero y el mensaje del drawer', () => {
  assert.match(observer, /const activeCount = listing\?\.activeCount \?\? 0/)
  assert.match(observer, /const requiresReviewCount = listing\?\.requiresReviewCount \?\? 0/)
  assert.match(observer, /Pagos en proceso:/)
  assert.match(observer, /Requieren revisión:/)
  assert.match(observer, /No hay pagos en procesamiento\./)
})

test('B: activeCount alimenta Pagos en proceso', () => {
  assert.match(observer, /Pagos en proceso: <strong>\{activeCount\}<\/strong>/)
})

test('C: requiresReviewCount alimenta Requieren revisión', () => {
  assert.match(observer, /Requieren revisión: <strong>\{requiresReviewCount\}<\/strong>/)
})

test('D-F: estados CREATED, PROCESSING y UNKNOWN tienen etiquetas de usuario', () => {
  assert.match(observer, /CREATED: 'En espera'/)
  assert.match(observer, /PROCESSING: 'Procesando'/)
  assert.match(observer, /UNKNOWN: 'Requiere revisión'/)
})

test('G-I: estados terminales tienen etiquetas de usuario', () => {
  assert.match(observer, /COMPLETED: 'Completado'/)
  assert.match(observer, /PARTIAL: 'Completado parcialmente'/)
  assert.match(observer, /FAILED: 'No procesado'/)
})

test('J: detalle conserva el orden sequenceNumber', () => {
  assert.match(detail, /sort\(\(left, right\) => left\.sequenceNumber - right\.sequenceNumber\)/)
  assert.match(detail, /documents\.map\(document/)
})

test('K-P: detalle usa visualStatus y message del contrato', () => {
  assert.match(detail, /paymentDocumentTone\[document\.visualStatus\]/)
  assert.match(detail, /\{document\.message\}/)
  for (const status of ['PENDING', 'PROCESSING', 'CONFIRMED', 'REQUIRES_REVIEW', 'FAILED', 'CANCELLED']) assert.match(observer, new RegExp(`${status}:`))
})

test('Q-R: polling de cinco segundos se activa con trabajo o revisión', () => {
  assert.match(observer, /listing\.activeCount > 0 \|\| listing\.requiresReviewCount > 0/)
  assert.match(observer, /setInterval\(\(\) => \{ void refreshProgress\(\) \}, 5000\)/)
})

test('S: polling no se mantiene sin trabajo activo ni revisión', () => {
  assert.match(observer, /if \(!listing \\|\\| \(!\(listing\.activeCount > 0 \|\| listing\.requiresReviewCount > 0\) && !detailIsActive\)\) return/)
})

test('T: batch terminal detiene polling de detalle', () => {
  assert.match(observer, /\['CREATED', 'PROCESSING', 'UNKNOWN'\]\.includes\(selectedBatch\.status\)/)
})

test('U: error de progreso es discreto y no sustituye la vista', () => {
  assert.match(observer, /No se pudo actualizar el estado de pagos\./)
  assert.match(observer, /Cobranzas debe seguir funcionando|PaymentProgressObserver/)
})

test('V: Actualizar refresca listado y detalle sin recargar página', () => {
  assert.match(observer, /listCollectionPaymentBatchProgress\(\)/)
  assert.match(observer, /getCollectionPaymentBatchProgress\(selectedBatchId\)/)
  assert.match(observer, />Actualizar</)
  assert.doesNotMatch(observer, /window\.location|location\.reload|router\.refresh/)
})

test('W-X: nueva UI no conecta enqueue ni worker', () => {
  assert.doesNotMatch(observer, /enqueueCollectionCustomerBatch|runCollectionPaymentWorker|collection-payment-worker/)
})

test('Y: Pagar todas sigue usando el registro síncrono existente', () => {
  assert.ok(view.includes('registerCollectionCustomerBatch({ clientId: client.clientId, paymentTypeId: batchPreview.paymentTypeId })'))
})

test('el drawer sólo muestra secciones con registros y no expone detalles técnicos', () => {
  assert.match(observer, /renderSection\('En proceso', listing\.batches\.active\)/)
  assert.match(observer, /renderSection\('Requieren revisión', listing\.batches\.requiresReview\)/)
  assert.match(observer, /renderSection\('Recientes', listing\.batches\.recent\)/)
  assert.doesNotMatch(observer, /ASYNC_V1|worker_token|lease_expires_at|claim_collection_payment_batch/)
})
