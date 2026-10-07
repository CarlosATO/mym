import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const view = await readFile(new URL('../src/modules/analisis-comercial/views/cobranza.tsx', import.meta.url), 'utf8')

const card = view.match(/function ClientKanbanCard[\s\S]*?\n}\n\nfunction ClientKanbanColumn/)?.[0] ?? ''
const dragEnd = view.match(/const handleDragEnd[\s\S]*?\n  }\n  const saveDroppedStage/)?.[0] ?? ''
const invoiceBranch = view.match(/: <div className="mt-3 grid gap-2 overflow-x-auto pb-1 md:grid-cols-5">[\s\S]*?\n           <\/div>}\n/)?.[0] ?? ''

test('tarjeta de cliente es draggable', () => {
  assert.match(view, /DndContext/)
  assert.match(card, /useDraggable/)
  assert.match(card, /collection-client-\$\{client\.clientId\}/)
})

test('drop hacia otra etapa abre el modal', () => {
  assert.match(view, /setPendingDrop\(\{ client, currentStage, nextStage \}\)/)
  assert.match(view, /Actualizar etapa de cobranza/)
})

test('drop no llama backend antes de confirmar', () => {
  assert.doesNotMatch(dragEnd, /updateCollectionStage/)
  assert.match(view, /const saveDroppedStage = async/)
  assert.match(view, /await updateCollectionStage\(\{ clientId: pendingDrop\.client\.clientId/)
})

test('cancelar conserva la etapa original', () => {
  assert.match(view, /onOpenChange=\{open => \{ if \(!open\) setPendingDrop\(null\) \}\}/)
  assert.match(view, /currentStage: CollectionStage/)
})

test('guardar drop llama updateCollectionStage y luego actualiza workflow', () => {
  assert.match(view, /await updateCollectionStage\(\{ clientId: pendingDrop\.client\.clientId, \.\.\.input \}\)/)
  assert.match(view, /setWorkflow\(current => \(\{[\s\S]*pendingDrop\.client\.clientId[\s\S]*stage: input\.stage/)
})

test('error mantiene modal reintentable y evita doble submit', () => {
  assert.match(view, /catch \(cause\)[\s\S]*setError/)
  assert.match(view, /if \(!nextStage \|\| processing\) return/)
  assert.match(view, /disabled=\{processing\}/)
})

test('CLOSED no es destino de drag', () => {
  assert.match(view, /nextStage === 'CLOSED'/)
  assert.match(view, /disabled: stage\.key === 'CLOSED'/)
})

test('PAYMENT_COMMITMENT exige fecha y monto', () => {
  assert.match(view, /nextStage === 'PAYMENT_COMMITMENT'/)
  assert.match(view, /!commitmentAt \|\| !Number\.isFinite\(amount\) \|\| amount <= 0/)
  assert.match(view, /amount > clientTotal/)
})

test('FOLLOW_UP exige próxima fecha', () => assert.match(view, /nextStage === 'FOLLOW_UP' && !nextActionAt/))

test('TO_MANAGE e IN_PROGRESS aceptan nota opcional', () => {
  assert.match(view, /Comentario \/ nota de gestión.*opcional/)
  assert.match(view, /note,/)
})

test('doble clic abre drawer completo', () => {
  assert.match(card, /onDoubleClick=\{isOverlay \? undefined : onOpen\}/)
  assert.match(view, /<Sheet open=\{Boolean\(selectedClient\)\}/)
})

test('click simple de tarjeta no abre drawer', () => {
  assert.doesNotMatch(card, /onClick=\{\(\) => onOpen/)
})

test('drag no dispara apertura del drawer', () => {
  assert.match(card, /\.\.\.\(!isOverlay \? listeners : \{\}\)/)
  assert.match(card, /onDoubleClick=/)
  assert.doesNotMatch(card, /onClick=\{.*onOpen/)
})

test('Vista Facturas no usa draggable ni permite cambiar workflow', () => {
  assert.doesNotMatch(invoiceBranch, /useDraggable|DndContext|updateCollectionStage/)
})

test('feedback de arrastre eleva y atenúa tarjeta y resalta destino', () => {
  assert.match(card, /opacity-45 shadow-lg/)
  assert.match(view, /bg-\[#F1E4DD\]/)
})

test('bitácora da prioridad visual al mensaje', () => {
  assert.match(view, /whitespace-pre-wrap border-l-2 border-\[#72383D\] bg-\[#F5EDE9\]/)
  assert.match(view, /text-\[13px\] leading-5 text-\[#322D29\]/)
  assert.doesNotMatch(view, /italic text-\[#322D29\]/)
})

test('evento sin nota no genera bloque de contenido', () => assert.match(view, /event\.note && <p/))

test('gestiones NOTE/CALL/MESSAGE/EMAIL conservan body visible', () => {
  for (const eventType of ['NOTE', 'CALL', 'MESSAGE', 'EMAIL']) assert.match(view, new RegExp(`event\.eventType === '${eventType}'`))
  assert.match(view, /\{event\.note\}/)
})

test('selector del drawer continúa como fallback', () => {
  assert.match(view, /function StagePicker/)
  assert.match(view, /<StagePicker stage=\{stage\} onChange=\{requestStage\}/)
})

test('clientes son los únicos datos del contexto DnD', () => {
  assert.match(view, /viewMode === 'CLIENTS' \? <DndContext/)
  assert.match(view, /clients=\{sortedClients\.filter/)
  assert.match(view, /sortedInvoices\.filter/)
})

test('Kanban responsive conserva ancho y permite scroll horizontal', () => {
  assert.match(view, /overflow-x-auto pb-2/)
  assert.match(view, /min-w-\[1240px\]/)
  assert.match(view, /grid-cols-\[repeat\(5,minmax\(240px,1fr\)\)\]/)
  assert.match(view, /className=\{`min-w-\[240px\]/)
})

test('tarjeta conserva acciones rápidas sin comprimir controles', () => {
  assert.match(card, /flex flex-wrap gap-1 border/)
  assert.match(card, /min-w-\[100px\] flex-1 border.*Copiar mensaje/)
  assert.match(card, /min-w-\[100px\] flex-1 border.*Agregar nota/)
})

test('KPI usa cuatro columnas sólo cuando el ancho lo permite', () => {
  assert.match(view, /mt-4 grid gap-1\.5 sm:grid-cols-2 xl:grid-cols-4/)
})

test('toolbar admite wrap y mantiene búsqueda legible', () => {
  assert.match(view, /flex w-full flex-wrap items-center gap-1\.5 lg:w-auto/)
  assert.match(view, /w-full min-w-\[220px\].*sm:w-52/)
})

test('padding de Cobranza aprovecha mejor el ancho medio', () => {
  assert.match(view, /px-4 py-5 sm:px-5 sm:py-6 lg:px-6/)
  assert.match(view, /bg-\[#FCFBF9\] p-4 .* lg:p-5/)
})
