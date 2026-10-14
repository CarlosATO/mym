import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20261014170000_collection_payment_batches_durable_model.sql', import.meta.url), 'utf8')

test('A: sequence_number es positivo y único dentro del batch', () => {
  assert.match(migration, /ADD COLUMN sequence_number integer NULL/)
  assert.match(migration, /batch_sequence_check[\s\S]*sequence_number IS NULL OR sequence_number > 0/)
  assert.match(migration, /UNIQUE INDEX collection_payment_attempts_batch_sequence_idx[\s\S]*\(batch_id, sequence_number\)/)
})

test('B: reglas de concurrencia operativas quedan diferidas', () => {
  assert.doesNotMatch(migration, /collection_payment_batches_active_client_idx/)
  assert.doesNotMatch(migration, /collection_payment_batches_single_processing_idx/)
})

test('D: attempts individuales sin batch siguen permitidos', () => {
  assert.match(migration, /CHECK \(sequence_number IS NULL OR sequence_number > 0\)/)
  assert.match(migration, /WHERE batch_id IS NOT NULL/)
})

test('E: confirmed_total no puede superar expected_total', () => {
  assert.match(migration, /confirmed_total <= expected_total/)
})

test('F: lease durable del batch está modelado', () => {
  assert.match(migration, /ADD COLUMN processing_started_at timestamptz NULL/)
  assert.match(migration, /ADD COLUMN lease_expires_at timestamptz NULL/)
  assert.match(migration, /ADD COLUMN worker_token uuid NULL/)
  assert.match(migration, /ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now\(\)/)
})

test('G: intento conserva evidencia de inicio del POST', () => {
  assert.match(migration, /ADD COLUMN post_started_at timestamptz NULL/)
})

test('H: backfill histórico es determinista por created_at e id', () => {
  assert.match(migration, /row_number\(\) OVER \(PARTITION BY batch_id ORDER BY created_at, id\)/)
})

test('I: completed_at distingue estados terminales y no terminales', () => {
  assert.match(migration, /status NOT IN \('COMPLETED', 'PARTIAL', 'FAILED'\) OR completed_at IS NOT NULL/)
  assert.match(migration, /stricter[\s\S]*non-terminal completed_at rule must wait/)
})

test('J: claim futuro requiere lock transaccional y no se implementa todavía', () => {
  assert.match(migration, /FOR UPDATE SKIP LOCKED/)
  assert.match(migration, /intentionally not installed in this block/)
  assert.doesNotMatch(migration, /CREATE OR REPLACE FUNCTION .*claim/i)
})
