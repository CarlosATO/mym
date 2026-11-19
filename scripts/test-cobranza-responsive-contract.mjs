import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const view = await readFile(new URL('../src/modules/analisis-comercial/views/cobranza.tsx', import.meta.url), 'utf8')
const shell = await readFile(new URL('../src/components/layout/module-shell.tsx', import.meta.url), 'utf8')
const sidebar = await readFile(new URL('../src/components/layout/module-sidebar.tsx', import.meta.url), 'utf8')

test('el Kanban scrollea horizontalmente dentro de su propio viewport y mantiene títulos fijos por columna', () => {
  assert.match(view, /min-h-0 flex-1 overflow-x-auto overflow-y-hidden/)
  assert.match(view, /grid h-full min-w-\[1120px\] grid-cols-\[repeat\(5,minmax\(212px,1fr\)\)\] gap-2\.5/)
  assert.match(view, /<header className="sticky top-0 z-10 shrink-0 border-b border-slate-200/)
  assert.match(view, /<div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">/)
  assert.doesNotMatch(view, /min-w-\[1240px\]/)
})

test('las cinco columnas siempre están declaradas y no se ocultan', () => {
  assert.match(view, /const kanbanStages: Array<\{ key: CollectionStage; label: string \}> = \[\.\.\.stages, \{ key: 'CLOSED', label: 'Cerrados recientes' \}\]/)
  for (const label of ['Por gestionar', 'En gestión', 'Compromiso de pago', 'Seguimiento', 'Cerrados recientes']) {
    assert.ok(view.includes(label), `falta columna ${label}`)
  }
  assert.match(view, /kanbanStages\.map\(stage => \{/)
  assert.doesNotMatch(view, /kanbanStages\.slice/)
  assert.doesNotMatch(view, /hidden['"\s].*kanbanStages/)
})

test('el header de cobranza divide en 2 mitades (resumen/tareas y clientes más morosos)', () => {
  assert.match(view, /grid grid-cols-1 gap-px bg-slate-200 lg:grid-cols-2/)
  assert.match(view, /<MostOverdueClientsPanel clients=\{mostOverdueClients\} onOpenClient=\{client => selectClient\(client\)\}/)
})

test('los filtros permiten wrap sin generar overflow', () => {
  assert.match(view, /flex flex-none flex-wrap items-center gap-1\.5 border-b border-slate-200/)
})

test('el sidebar global conserva la preferencia de escritorio y el overlay temporal', () => {
  assert.match(shell, /const WIDE_VIEWPORT_QUERY = '\(min-width: 1536px\)'/)
  assert.match(shell, /const MOBILE_VIEWPORT_QUERY = '\(max-width: 767px\)'/)
  assert.match(shell, /const sidebarState = resolveSidebarState\(\{/)
  assert.doesNotMatch(shell, /const responsiveCollapsed = !isWideViewport/)
  assert.match(shell, /window\.localStorage\.setItem\(STORAGE_KEY/)
})

test('el sidebar usa el estado real y conserva accesibilidad en modo colapsado', () => {
  assert.match(sidebar, /const sidebarWidth = expanded \? 'md:w-\[244px\]' : 'md:w-\[68px\]'/)
  assert.match(sidebar, /const effectiveCollapsed = !expanded/)
  assert.match(sidebar, /aria-label=\{collapsed \? item\.label : undefined\}/)
  assert.match(sidebar, /aria-expanded=\{expanded\}/)
})
