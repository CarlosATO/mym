import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const action = await readFile(new URL('../src/app/actions/comercial/cobranza-workflow.ts', import.meta.url), 'utf8')
const view = await readFile(new URL('../src/modules/analisis-comercial/views/cobranza.tsx', import.meta.url), 'utf8')
const card = view.match(/function ClientKanbanCard[\s\S]*?\n}\n\nfunction ClientKanbanColumn/)?.[0] ?? ''
const dialog = view.match(/function CommitmentDialog[\s\S]*?\n}\n\nfunction QuickInteractionDialog/)?.[0] ?? ''

test('server actions crean, editan y quitan compromiso en el workflow existente', () => {
  assert.match(action, /export async function setCollectionCommitment/)
  assert.match(action, /export async function clearCollectionCommitment/)
  assert.match(action, /collection_customer_workflow/)
  assert.match(action, /onConflict: 'company_id,client_id'/)
})

test('crear y quitar compromiso no cambia la etapa ni la columna del cliente', () => {
  assert.match(action, /const stage = \(previous\?\.stage as CollectionStage \| undefined\) \?\? 'TO_MANAGE'/)
  assert.doesNotMatch(action, /stage: 'PAYMENT_COMMITMENT'/)
  assert.doesNotMatch(action, /stage: 'IN_PROGRESS'/)
})

test('fecha de compromiso conserva la etapa y el seguimiento vigente', () => {
  assert.match(action, /next_action_at: previous\?\.next_action_at \?\? null/)
})

test('validación server-side exige fecha, permite monto vacío y limita monto a deuda', () => {
  assert.match(action, /function civilDate/)
  assert.match(action, /if \(amount === null\) return/)
  assert.match(action, /amount <= 0/)
  assert.match(action, /vw_customer_receivables/)
  assert.match(action, /amount > currentDebt/)
})

test('edición y eliminación conservan historial append-only', () => {
  assert.match(action, /event_type: 'COMMITMENT'/)
  assert.match(action, /previousCommitmentAt/)
  assert.match(action, /previousCommitmentAmount/)
  assert.match(action, /created_by: user\.id/)
  assert.doesNotMatch(action, /delete\(\).*collection_customer_events/)
})

test('tarjeta ofrece fecha o edición como tercera acción rápida', () => {
  assert.match(card, /onCommitment/)
  assert.match(card, /Fecha compromiso/)
  assert.match(card, /Editar compromiso/)
  assert.match(card, /onPointerDown=\{stopCardInteraction\}/)
  assert.match(card, /event\.stopPropagation\(\); onCommitment\(\)/)
})

test('diálogo permite fecha, monto opcional, comentario y quitar compromiso', () => {
  assert.match(dialog, /Fecha de compromiso \*/) 
  assert.match(dialog, /Monto comprometido.*opcional/)
  assert.match(dialog, /Comentario \/ nota.*opcional/)
  assert.match(dialog, /Quitar compromiso/)
  assert.match(dialog, /window\.confirm/)
})

test('tarjeta no presenta monto vacío como $0 o null', () => {
  assert.match(card, /workflow\.commitment_amount !== null && workflow\.commitment_amount !== undefined/)
  assert.match(card, /Compromiso \{dateLabel\(workflow\.commitment_at\)\}/)
})

test('historial etiqueta compromisos creados, actualizados y eliminados', () => {
  assert.match(view, /Compromiso de pago registrado/)
  assert.match(view, /Compromiso actualizado/)
  assert.match(view, /Compromiso eliminado/)
})
