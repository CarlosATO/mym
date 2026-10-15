import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const view = await readFile(new URL('../src/modules/analisis-comercial/views/cobranza.tsx', import.meta.url), 'utf8')
const tasks = await readFile(new URL('../src/modules/analisis-comercial/lib/cobranza-tasks.ts', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/app/globals.css', import.meta.url), 'utf8')

test('la agenda de tareas vive en el header y precede a los filtros', () => {
  assert.match(view, /const pendingTasks = buildCobranzaTasks\(clients, workflow, today\)/)
  assert.match(view, /<PendingTasksPanel tasks=\{pendingTasks\}/)
  assert.match(view, /No hay tareas pendientes para hoy\./)
  assert.ok(view.indexOf('<PendingTasksPanel') < view.indexOf('className="mt-2.5 flex flex-wrap items-center gap-1.5 border-b'))
})

test('seleccionar una tarea registra selectedTask y localiza, sin abrir drawer', () => {
  assert.match(view, /onSelectTask=\{selectTask\}/)
  assert.match(view, /const selectTask = \(task: CobranzaTask\) => \{\n\s*setSelectedTaskId\(task\.id\)\n\s*setLocatedClientId\(task\.clientId\)/)
  assert.doesNotMatch(view, /onSelect=\{selectClient\}/)
})

test('seleccionar no abre el ClientPanel; sólo Abrir cliente lo hace', () => {
  assert.match(view, /onOpenClient=\{openClientFromTask\}/)
  assert.match(view, /const openClientFromTask = \(clientId: number\) =>/)
  assert.match(view, /Abrir cliente/)
  assert.match(view, /const selectClient = \(client: CobranzaClient, documentId\?: number\)/)
  assert.match(view, /setSelectedClient\(client\)/)
  assert.match(view, /setSelectedClosed\(null\)/)
  assert.match(view, /setSelectedDocumentId\(documentId \?\? null\)/)
})

test('la tarjeta localizada recibe id, bandera locate y animación no agresiva', () => {
  assert.match(view, /id=\{isOverlay \? undefined : `collection-card-\$\{client\.clientId\}`\}/)
  assert.match(view, /locate=\{client\.clientId === selectedClientId\}/)
  assert.match(view, /const locateTone = locate && !isOverlay \? 'ring-2 ring-\[#72383D\] cobranza-locate' : ''/)
  assert.match(css, /\.cobranza-locate \{/)
  assert.match(css, /@keyframes cobranzaLocatePulse/)
  assert.match(css, /prefers-reduced-motion/)
})

test('la localización usa scrollIntoView hacia la tarjeta', () => {
  assert.match(view, /document\.getElementById\(`collection-card-\$\{locatedClientId\}`\)/)
  assert.match(view, /scrollIntoView\(\{ behavior: 'smooth', block: 'center', inline: 'center' \}\)/)
})

test('un cliente oculto por filtros se muestra temporalmente en su columna', () => {
  assert.match(view, /const includeLocated = locatedClient !== null && stage\.key !== 'CLOSED'/)
  assert.match(view, /includeLocated && locatedClient \? \[\.\.\.stageClients, locatedClient\] : stageClients/)
  assert.match(view, /const stageClients = sortedClients\.filter/)
})

test('el panel de tareas usa altura fija y scroll interno', () => {
  assert.match(view, /h-\[130px\] overflow-y-auto/)
  assert.match(view, /min-h-\[36px\] items-center border-t border-\[#EAE2D9\]/)
  assert.match(view, /grid h-\[26px\] w-full grid-cols-\[10px_minmax\(0,1fr\)_auto_auto\]/)
})

test('la columna depende sólo del workflow y no de la urgencia', () => {
  assert.match(view, /\(workflow\[client\.clientId\]\?\.stage \?\? 'TO_MANAGE'\) === stage\.key/)
  assert.match(view, /const orderedClients = prioritizeCobranzaColumn\(clients, workflow, today\)/)
})

test('prioridad visual Alta convive con la prioridad comercial y la selección', () => {
  assert.match(view, /effectivePriority\(client\.priority, task\)/)
  assert.match(view, /task\?\.urgency === 'OVERDUE'/)
  assert.match(view, /task\.urgency === 'OVERDUE' \? 'vencido' : 'hoy'/)
  assert.match(tasks, /export function effectivePriority/)
})

test('fecha civil y America/Santiago son explícitos', () => {
  assert.match(tasks, /timeZone: 'America\/Santiago'/)
  assert.match(tasks, /value\.match\(\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}/)
  assert.match(view, /setInterval\(\(\) => setToday[\s\S]*60_000\)/)
})

test('KPIs están en 2x2 con el orden solicitado', () => {
  assert.match(view, /grid grid-cols-2 grid-rows-2 gap-px bg-\[#EAE2D9\]/)
  assert.match(view, /tone="overdue"/)
  const total = view.indexOf('label="CxC total"')
  const saldo = view.indexOf('label="Clientes con saldo"')
  const vencida = view.indexOf('label="CxC vencida"')
  const deuda = view.indexOf('label="Clientes con deuda vencida"')
  assert.ok(total < vencida && vencida < saldo && saldo < deuda, 'orden 2x2 esperado')
})

test('el header es una sola banda responsive con grid y sync contenido', () => {
  assert.match(view, /overflow-hidden border border-\[#D1C7BD\] bg-white/)
  assert.match(view, /grid grid-cols-1 gap-px bg-\[#EAE2D9\] lg:grid-cols-2 2xl:grid-cols-\[minmax\(190px,1\.05fr\)_minmax\(280px,1\.15fr\)_minmax\(330px,1\.3fr\)_minmax\(200px,\.8fr\)\]/)
  assert.match(view, /flex min-w-0 flex-col gap-1\.5 bg-white p-3 text-\[10px\] text-\[#322D29\]\/55/)
})

test('vista Facturas conserva su orden y no se prioriza por tarea', () => {
  assert.match(view, /const sortedInvoices = \[\.\.\.visibleInvoices\]\.sort/)
  assert.match(view, /sortedInvoices\.filter/)
})
