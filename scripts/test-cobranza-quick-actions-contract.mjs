import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const view = await readFile(new URL('../src/modules/analisis-comercial/views/cobranza.tsx', import.meta.url), 'utf8')
const card = view.match(/function ClientKanbanCard[\s\S]*?\n}\n\nfunction ClientKanbanColumn/)?.[0] ?? ''
const quickDialog = view.match(/function QuickInteractionDialog[\s\S]*?\n}\n\nfunction ClientKanbanCard/)?.[0] ?? ''

test('tarjeta Cliente muestra Copiar mensaje y Agregar nota', () => {
  assert.match(card, /Copiar mensaje/)
  assert.match(card, /Agregar nota/)
})

test('Copiar mensaje reutiliza el generador y no abre drawer ni etapa', () => {
  assert.match(view, /buildCollectionMessage\(client\)/)
  assert.match(card, /navigator\.clipboard\.writeText\(buildCollectionMessage\(client\)\)/)
  assert.doesNotMatch(card, /selectClient|updateCollectionStage/)
})

test('Copiar mensaje muestra feedback temporal', () => {
  assert.match(card, /Mensaje copiado/)
  assert.match(card, /setCopied\(true\)/)
})

test('Agregar nota abre modal compacto sin abrir drawer', () => {
  assert.match(card, /onAddNote\(\)/)
  assert.match(view, /onAddNote=\{setQuickNoteClient\}/)
  assert.match(view, /<QuickInteractionDialog/)
  assert.match(quickDialog, /<DialogTitle>Agregar nota<\/DialogTitle>/)
  assert.doesNotMatch(quickDialog, /selectClient|updateCollectionStage/)
})

test('modal rápido soporta NOTE, CALL, MESSAGE y EMAIL', () => {
  for (const type of ['NOTE', 'CALL', 'MESSAGE', 'EMAIL']) assert.match(quickDialog, new RegExp(`value="${type}"`))
  assert.match(quickDialog, /registerCollectionInteraction|onSave/)
})

test('guardar nota usa registerCollectionInteraction y conserva etapa', () => {
  assert.match(view, /await registerCollectionInteraction\(\{ clientId: quickNoteClient\.clientId, \.\.\.input \}\)/)
  assert.match(view, /setQuickNoteClient\(null\)/)
  const saveBlock = view.match(/const saveQuickInteraction[\s\S]*?\n  }/)?.[0] ?? ''
  assert.doesNotMatch(saveBlock, /setWorkflow/)
})

test('Cancelar no escribe y botones bloquean doble submit', () => {
  assert.match(quickDialog, /onClick=\{\(\) => onOpenChange\(false\)\}/)
  assert.match(quickDialog, /if \(processing\) return/)
  assert.match(quickDialog, /disabled=\{processing\}/)
})

test('botones rápidos no activan drag ni doble clic', () => {
  assert.match(card, /onPointerDown=\{stopCardInteraction\}/)
  assert.match(card, /event\.stopPropagation\(\); onAddNote\(\)/)
  assert.match(card, /onDoubleClick=\{isOverlay \? undefined : onOpen\}/)
})

test('drag y doble clic de la tarjeta continúan disponibles', () => {
  assert.match(card, /useDraggable/)
  assert.match(card, /onDoubleClick=/)
  assert.match(view, /setPendingDrop\(\{ client, currentStage, nextStage \}\)/)
})

test('Vista Facturas no recibe acciones rápidas', () => {
  const invoiceBranch = view.match(/: <div className="mt-3 grid gap-2 overflow-x-auto pb-1 md:grid-cols-5">[\s\S]*?\n           <\/div>}\n/)?.[0] ?? ''
  assert.doesNotMatch(invoiceBranch, /Copiar mensaje|Agregar nota|ClientKanbanCard/)
})

test('drawer usa Agregar nota y Guardar nota', () => {
  assert.match(view, />Agregar nota</)
  assert.match(view, /<DialogTitle>Agregar nota<\/DialogTitle>/)
  assert.match(view, /Guardar nota/)
  assert.doesNotMatch(view, /Registrar gestión/)
})

test('generador de mensaje tiene una sola implementación', () => {
  assert.equal((view.match(/const buildCollectionMessage =/g) ?? []).length, 1)
  assert.equal((view.match(/const message = buildCollectionMessage\(client\)/g) ?? []).length, 1)
})
