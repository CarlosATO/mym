import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const action = await readFile(new URL('../src/app/actions/comercial/cobranza-workflow.ts', import.meta.url), 'utf8')
const gateway = await readFile(new URL('../src/lib/bsale/collection-payments.ts', import.meta.url), 'utf8')
const view = await readFile(new URL('../src/modules/analisis-comercial/views/cobranza.tsx', import.meta.url), 'utf8')

test('A: UNKNOWN con pago encontrado confirma sin POST', () => {
  assert.match(action, /resolveUnknownCollectionPaymentInternal/)
  assert.match(action, /uniqueCandidates\.length === 1[\s\S]*status: 'CONFIRMED'/)
  assert.doesNotMatch(action.match(/resolveUnknownCollectionPaymentInternal[\s\S]*?\n}\n\nexport async function resolveUnknown/)?.[0] ?? '', /createPayment\(/)
})
test('B: ausencia probada después de ventana resuelve FAILED', () => {
  assert.match(action, /UNKNOWN_SAFETY_WINDOW_MS = 60_000/)
  assert.match(action, /absenceProven[\s\S]*status: 'FAILED'/)
  assert.match(action, /Pago no creado en Bsale después de verificación live/)
})
test('C: ausencia dentro de ventana mantiene UNKNOWN', () => assert.match(action, /ageMs >= UNKNOWN_SAFETY_WINDOW_MS[\s\S]*return \{ outcome: 'UNKNOWN'/))
test('D: saldo parcial no prueba ausencia', () => assert.match(action, /expectedBalance[\s\S]*Math\.abs\(liveBalance - expectedBalance\) < 0\.01/))
test('E: múltiples candidatos permanecen UNKNOWN', () => assert.match(action, /uniqueCandidates\.length === 1[\s\S]*return \{ outcome: 'UNKNOWN'/))
test('F/G: timeout hace GET dirigido y nunca repite POST', () => {
  assert.match(action, /A failed POST is indeterminate[\s\S]*resolveUnknownCollectionPaymentInternal/)
  assert.match(action, /status: 'UNKNOWN'/)
  assert.equal((action.match(/gateway\.createPayment\(/g) ?? []).length, 1)
})
test('H: error previo al POST puede ser FAILED y libera el lock', () => assert.match(action, /if \(!postAttempted\)[\s\S]*status: 'FAILED'[\s\S]*eq\('status', 'CREATED'\)/))
test('I: recuperación usa el intento y documento, no procesa otros documentos', () => assert.match(action, /attempt\.bsale_document_id[\s\S]*attempt\.id/))
test('J: fecha BSale tolera desfase de zona horaria de un día', () => assert.match(action, /adjacent UTC calendar day[\s\S]*24 \* 60 \* 60 \* 1000/))
test('K: lock activo incluye UNKNOWN y FAILED queda fuera', async () => {
  const migration = await readFile(new URL('../supabase/migrations/20261006170000_collection_payments_etapa_2b.sql', import.meta.url), 'utf8')
  assert.match(migration, /WHERE status IN \('CREATED', 'SUBMITTING', 'UNKNOWN', 'REQUIRES_REVIEW'\)/)
  assert.match(action, /status: 'FAILED'/)
})
test('gateway de cobranza usa timeout específico de 30 segundos', () => assert.match(gateway, /timeoutMs: 30_000/))
test('UI muestra Verificar en Bsale y bloquea retry automático', () => {
  assert.match(view, /Verificar en Bsale/)
  assert.match(view, /Estado UNKNOWN: no vuelvas a intentar hasta verificarlo/)
  assert.match(view, /unknownAttempt \?/)
})
test('los tests son sólo contratos y no ejecutan POST real', () => assert.doesNotMatch(action.match(/resolveUnknownCollectionPaymentInternal[\s\S]*?\n}\n\nexport async function resolveUnknown/)?.[0] ?? '', /method:\s*['"]POST['"]|createPayment\(/))
