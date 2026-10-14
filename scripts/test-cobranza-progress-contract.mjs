import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const action = await readFile(new URL('../src/app/actions/comercial/cobranza-workflow.ts', import.meta.url), 'utf8')
const view = await readFile(new URL('../src/modules/analisis-comercial/views/cobranza.tsx', import.meta.url), 'utf8')

const progressSource = action.slice(action.indexOf('export type CollectionPaymentDocumentProgress'), action.indexOf('async function upsertDirectedPayment'))
const detail = action.slice(action.indexOf('export async function getCollectionPaymentBatchProgress'), action.indexOf('export async function listCollectionPaymentBatchProgress'))
const listing = action.slice(action.indexOf('export async function listCollectionPaymentBatchProgress'), action.indexOf('async function upsertDirectedPayment'))

test('A/B: progreso deriva pending y confirmed desde attempts reales', () => {
  assert.match(progressSource, /select\('id,client_id,bsale_document_id,amount,status,sequence_number/)
  assert.match(progressSource, /pendingDocuments: count\('CREATED'\)/)
  assert.match(progressSource, /confirmedDocuments: count\('CONFIRMED'\)/)
  assert.match(progressSource, /confirmedTotalConsistent/)
  assert.doesNotMatch(progressSource, /metadata\.expected_documents/)
})

test('C/D/E: currentDocument prioriza SUBMITTING, luego revisión y luego CREATED', () => {
  assert.match(progressSource, /find\(document => document\.status === 'SUBMITTING'\)[\s\S]*find\(document => document\.status === 'UNKNOWN' \|\| document\.status === 'REQUIRES_REVIEW'\)[\s\S]*find\(document => document\.status === 'CREATED'/)
  assert.match(progressSource, /visualStatus: collectionProgressVisualStatus\(status\)/)
})

test('F/G/H/I: contadores y consistencia no escriben ni corrigen la base', () => {
  assert.match(progressSource, /failedDocuments: count\('FAILED'\)/)
  assert.match(progressSource, /cancelledDocuments: count\('CANCELLED'\)/)
  assert.match(progressSource, /confirmedTotal = documents\.filter\(document => document\.status === 'CONFIRMED'\)/)
  assert.doesNotMatch(progressSource, /\.update\(|\.insert\(|\.delete\(/)
})

test('J/K: detalle filtra empresa y sólo admite ASYNC_V1', () => {
  assert.match(progressSource, /eq\('company_id', companyId\)\.eq\('id', batchId\)/)
  assert.match(progressSource, /execution_mode.*ASYNC_V1/)
  assert.match(progressSource, /No tienes acceso a Cobranza/)
})

test('L/M: listado separa active, requiresReview y recent con límites/orden', () => {
  assert.match(listing, /status === 'CREATED' \|\| batch\.status === 'PROCESSING'/)
  assert.match(listing, /status === 'UNKNOWN'/)
  assert.match(listing, /COMPLETED', 'PARTIAL', 'FAILED'/)
  assert.match(listing, /24 \* 60 \* 60 \* 1000/)
  assert.match(listing, /slice\(0, 20\)/)
  assert.match(listing, /queuedCount/)
  assert.match(listing, /processingCount/)
  assert.match(listing, /requiresReviewCount/)
  assert.match(listing, /activeCount/)
})

test('N/O: contrato no expone secretos ni payloads técnicos', () => {
  assert.doesNotMatch(progressSource, /worker_token|request_payload|payment_response/)
  assert.match(progressSource, /message: collectionProgressMessage\[status\]/)
})

test('P/Q: no hay BSale ni escrituras en las actions de progreso', () => {
  assert.doesNotMatch(progressSource, /bsaleFetch|createPayment|payments\.json/)
  assert.doesNotMatch(progressSource, /\.update\(|\.insert\(|\.delete\(|claim_collection_payment_batch|mark_collection_payment_attempt_submitting/)
})

test('no modifica UI, polling, enqueue ni worker', () => {
  assert.doesNotMatch(view, /getCollectionPaymentBatchProgress|listCollectionPaymentBatchProgress/)
  assert.doesNotMatch(progressSource, /setInterval|setTimeout|enqueueCollectionCustomerBatch|runCollectionPaymentWorker/)
})
