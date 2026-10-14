import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20261014170000_collection_payment_batches_durable_model.sql', import.meta.url), 'utf8')
const workflow = await readFile(new URL('../src/app/actions/comercial/cobranza-workflow.ts', import.meta.url), 'utf8')

test('A: el flujo actual crea el batch directamente en PROCESSING', () => {
  assert.match(workflow, /collection_payment_batches'\)\.insert\(\{[\s\S]*status: 'PROCESSING'/)
})

test('B: el flujo actual crea attempts con batch_id pero sin sequence_number', () => {
  assert.match(workflow, /batch_id: input\.batchId \?\? null/)
  assert.doesNotMatch(workflow, /sequence_number: /)
})

test('C: sequence_number NULL sigue siendo válido durante Bloque A', () => {
  assert.match(migration, /CHECK \(sequence_number IS NULL OR sequence_number > 0\)/)
  assert.doesNotMatch(migration, /batch_id IS NOT NULL[\s\S]*sequence_number IS NOT NULL/)
})

test('D: varios batches PROCESSING actuales no tienen restricción global nueva', () => {
  assert.doesNotMatch(migration, /collection_payment_batches_single_processing_idx/)
  assert.doesNotMatch(migration, /WHERE status = 'PROCESSING'/)
})

test('E: la secuencia histórica se backfillea en orden estable', () => {
  assert.match(migration, /row_number\(\) OVER \(PARTITION BY batch_id ORDER BY created_at, id\)/)
  assert.match(migration, /SET sequence_number = numbered\.sequence_number/)
})

test('F: secuencia presente no puede repetirse dentro del batch', () => {
  assert.match(migration, /UNIQUE INDEX collection_payment_attempts_batch_sequence_idx[\s\S]*\(batch_id, sequence_number\)[\s\S]*WHERE batch_id IS NOT NULL/)
})

test('G: confirmed_total mayor que expected_total sigue rechazado', () => {
  assert.match(migration, /confirmed_total <= expected_total/)
})
