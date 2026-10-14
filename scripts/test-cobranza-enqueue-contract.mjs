import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20261014173000_enqueue_collection_payment_batch.sql', import.meta.url), 'utf8')
const workflow = await readFile(new URL('../src/app/actions/comercial/cobranza-workflow.ts', import.meta.url), 'utf8')
const view = await readFile(new URL('../src/modules/analisis-comercial/views/cobranza.tsx', import.meta.url), 'utf8')

test('A-C: RPC crea batch CREATED, attempts CREATED y total exacto', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION comercial\.enqueue_collection_payment_batch/)
  assert.match(migration, /'CREATED', p_created_by/)
  assert.match(migration, /'CREATED', v_batch_id/)
  assert.match(migration, /sum\(d\.amount\)/)
  assert.match(migration, /expected_total,\s*confirmed_total, status/)
})

test('D: batch y attempts están en una transacción atómica', () => {
  assert.match(migration, /INSERT INTO comercial\.collection_payment_batches[\s\S]*INSERT INTO comercial\.collection_payment_attempts/)
  assert.doesNotMatch(migration, /COMMIT|ROLLBACK/)
  assert.match(migration, /INSERT INTO portal\.audit_logs[\s\S]*RETURN jsonb_build_object/)
})

test('E-H: input valida documentos, montos, secuencias y huecos', () => {
  assert.match(migration, /COLLECTION_PAYMENT_DOCUMENT_DUPLICATE/)
  assert.match(migration, /COLLECTION_PAYMENT_SEQUENCE_DUPLICATE/)
  assert.match(migration, /COLLECTION_PAYMENT_SEQUENCE_GAP/)
  assert.match(migration, /d\.amount <= 0/)
  assert.match(migration, /d\."sequenceNumber" <= 0/)
})

test('I-J: conflictos activos abortan antes del insert y el lock evita carreras por cliente', () => {
  assert.match(migration, /pg_advisory_xact_lock/)
  assert.match(migration, /status IN \('CREATED', 'PROCESSING', 'UNKNOWN'\)/)
  assert.match(migration, /status IN \('CREATED', 'SUBMITTING', 'UNKNOWN', 'REQUIRES_REVIEW'\)/)
  assert.match(migration, /COLLECTION_PAYMENT_CLIENT_BATCH_ACTIVE/)
  assert.match(migration, /COLLECTION_PAYMENT_DOCUMENT_ACTIVE/)
})

test('K-L: batches terminados pueden coexistir y las claves de idempotencia son distintas', () => {
  assert.doesNotMatch(migration, /status IN \('COMPLETED', 'PARTIAL', 'FAILED'\)/)
  assert.match(migration, /v_batch_id::text \|\| ':' \|\| d\."sequenceNumber"::text/)
})

test('M: enqueue no llama POST de pagos Bsale', () => {
  const enqueue = workflow.slice(workflow.indexOf('export async function enqueueCollectionCustomerBatch'), workflow.indexOf('export async function registerCollectionCustomerBatch'))
  assert.doesNotMatch(enqueue, /payments\.json|registerCollectionPayment|bsaleFetch.*POST/i)
})

test('N-O: acción y UI síncronas permanecen intactas', () => {
  assert.match(workflow, /export async function registerCollectionCustomerBatch/)
  assert.match(workflow, /status: 'PROCESSING'/)
  assert.match(view, /registerCollectionCustomerBatch\(\{ clientId: client\.clientId, paymentTypeId: batchPreview\.paymentTypeId \}\)/)
  assert.doesNotMatch(view, /enqueueCollectionCustomerBatch/)
})

test('P: RPC solo es ejecutable por service_role', () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION comercial\.enqueue_collection_payment_batch[\s\S]*FROM PUBLIC, anon, authenticated/)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION comercial\.enqueue_collection_payment_batch[\s\S]*TO service_role/)
})
