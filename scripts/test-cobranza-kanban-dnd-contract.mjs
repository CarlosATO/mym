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

test('PAYMENT_COMMITMENT exige fecha y permite monto opcional', () => {
  assert.match(view, /nextStage === 'PAYMENT_COMMITMENT'/)
  assert.match(view, /if \(!commitmentAt\)/)
  assert.match(view, /amount !== null && \(!Number\.isFinite\(amount\) \|\| amount <= 0\)/)
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
  assert.match(view, /border-sky-500 bg-sky-50\/70/)
})

test('bitácora da prioridad visual al mensaje', () => {
  assert.match(view, /whitespace-pre-wrap rounded-r border-l-2 border-sky-600 bg-sky-50\/70/)
  assert.match(view, /text-\[13px\] leading-5 text-slate-900/)
  assert.doesNotMatch(view, /italic text-slate-900/)
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
  assert.match(view, /const stageClients = sortedClients\.filter/)
  assert.match(view, /clients=\{includeLocated && locatedClient/)
  assert.match(view, /sortedInvoices\.filter/)
})

test('Kanban conserva ancho mínimo legible y scroll horizontal local', () => {
  assert.match(view, /min-h-0 flex-1 overflow-x-auto overflow-y-hidden/)
  assert.match(view, /min-w-\[1120px\]/)
  assert.match(view, /grid-cols-\[repeat\(5,minmax\(212px,1fr\)\)\]/)
  assert.match(view, /className=\{`flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border/)
})

test('tarjeta conserva acciones rápidas utilizables en ancho compacto', () => {
  assert.match(card, /flex flex-wrap gap-1 border/)
  assert.match(card, /min-w-\[84px\] flex-1 rounded border.*Copiar mensaje/)
  assert.match(card, /min-w-\[84px\] flex-1 rounded border.*Agregar nota/)
})

test('KPIs compactos viven en el header y desaparece la fila independiente', () => {
  assert.match(view, /grid shrink-0 grid-cols-2 gap-px border-b border-slate-200 bg-slate-200 sm:grid-cols-4/)
  assert.doesNotMatch(view, /mt-4 grid gap-1\.5 sm:grid-cols-2 xl:grid-cols-4/)
  assert.doesNotMatch(view, /Cobranza priorizada/)
})

test('toolbar admite wrap y mantiene búsqueda legible', () => {
  assert.match(view, /flex flex-none flex-wrap items-center gap-1\.5 border-b border-slate-200/)
  assert.match(view, /w-full min-w-\[220px\].*sm:w-56/)
})

test('contenedor principal de Cobranza fija altura al viewport como Preparación de Pedidos', () => {
  assert.match(view, /flex h-\[calc\(100vh-110px\)\] min-h-\[520px\] w-full flex-col overflow-hidden rounded-xl border border-slate-200/)
})
