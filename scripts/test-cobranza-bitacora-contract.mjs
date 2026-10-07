import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const action = await readFile(new URL('../src/app/actions/comercial/cobranza-workflow.ts', import.meta.url), 'utf8')
const view = await readFile(new URL('../src/modules/analisis-comercial/views/cobranza.tsx', import.meta.url), 'utf8')
const migration = await readFile(new URL('../supabase/migrations/20261007120000_collection_interaction_message.sql', import.meta.url), 'utf8')

test('TO_MANAGE pasa por el modal y acepta nota o vacío', () => {
  assert.doesNotMatch(view, /if \(nextStage === 'TO_MANAGE'\)/)
  assert.match(view, /setPendingStage\(nextStage\)/)
  assert.match(view, /Comentario \/ nota de gestión.*opcional/)
})

test('las etapas conservan sus requisitos', () => {
  assert.match(view, /pendingStage === 'PAYMENT_COMMITMENT'/)
  assert.match(view, /!commitmentAt \|\| !Number\.isFinite\(amount\) \|\| amount <= 0/)
  assert.match(view, /pendingStage === 'FOLLOW_UP'/)
  assert.match(view, /!nextActionAt/)
  assert.match(view, /stage: pendingStage, note: stageNote/)
})

test('registrar gestión valida whitelist y descripción server-side', () => {
  assert.match(action, /export async function registerCollectionInteraction/)
  assert.match(action, /\['NOTE', 'CALL', 'MESSAGE', 'EMAIL'\]\.includes\(input\.type\)/)
  assert.match(action, /const body = input\.body\.trim\(\)/)
  assert.match(action, /if \(!body\)/)
  assert.match(action, /body\.length > 2000/)
  assert.match(action, /created_by: user\.id/)
})

test('MESSAGE está permitido sin tocar filas existentes', () => {
  assert.match(migration, /'NOTE', 'CALL', 'MESSAGE', 'EMAIL'/)
  for (const eventType of ['BSALE_PAYMENT_DETECTED', 'BSALE_DEBT_UPDATED', 'COLLECTION_CLOSED_FROM_BSALE']) assert.match(migration, new RegExp(`'${eventType}'`))
  assert.match(migration, /DROP CONSTRAINT collection_customer_events_event_type_check/)
  assert.doesNotMatch(migration, /DELETE FROM|UPDATE comercial\.collection_customer_events/)
})

test('gestión independiente sólo inserta evento y no cambia etapa', () => {
  const interaction = action.match(/export async function registerCollectionInteraction[\s\S]*?\n}\n\ntype Bsale/)?.[0] ?? ''
  assert.match(interaction, /from\('collection_customer_events'\)/)
  assert.doesNotMatch(interaction, /collection_customer_workflow/)
})

test('bitácora etiqueta MESSAGE y no dibuja flecha para gestiones', () => {
  assert.match(view, /event\.eventType === 'MESSAGE'.*Mensaje \/ WhatsApp/)
  assert.match(view, /event\.eventType === 'STAGE_CHANGED' &&/)
  assert.match(view, /event\.note &&/)
})

test('UI evita doble submit y refresca después de guardar gestión', () => {
  assert.match(view, /if \(interactionProcessing\) return/)
  assert.match(view, /await registerCollectionInteraction/)
  assert.match(view, /await refreshHistory\(\)/)
  assert.match(view, /Guardar gestión/)
})
