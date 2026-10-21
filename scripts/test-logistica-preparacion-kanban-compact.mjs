import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { summarizePreparationBoard } from '../src/modules/logistica/preparacion-pedidos/preparation-board-utils.ts'

const root = new URL('../src/modules/logistica/preparacion-pedidos/', import.meta.url)
const panel = await readFile(new URL('sales-order-preparation-panel.tsx', root), 'utf8')
const card = await readFile(new URL('sales-order-card.tsx', root), 'utf8')
const drawer = await readFile(new URL('sales-order-drawer.tsx', root), 'utf8')
const auditDrawer = await readFile(new URL('../auditoria/sales-order-audit-drawer.tsx', root), 'utf8')
const rules = await readFile(new URL('movement-rules.ts', root), 'utf8')
const packageJson = JSON.parse(await readFile(new URL('../../../../package.json', root), 'utf8'))

test('1. mantiene las columnas operacionales y agrega readiness derivado', () => {
  assert.deepEqual([...panel.matchAll(/id: '([^']+)'/g)].map(match => match[1]), [
    'PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT', 'INCIDENTS', 'READY_TO_INVOICE', 'INVOICED_READY_FOR_ROUTE',
  ])
})

test('2. columna con ancho compacto de 300px', () => {
  assert.match(panel, /w-\[300px\] min-w-\[300px\] max-w-\[300px\] shrink-0/)
})

test('3. la columna no crece fluidamente', () => {
  assert.doesNotMatch(panel, /minmax\(300px,1fr\)/)
  assert.match(panel, /max-w-\[300px\]/)
})

test('4. scroll horizontal preparado con columnas fijas', () => {
  assert.match(panel, /overflow-x-auto overflow-y-hidden/)
  assert.match(panel, /flex h-full w-max min-w-full items-stretch gap-3/)
})

test('5. header de columna compacto y sticky', () => {
  assert.match(panel, /sticky top-0 z-10 border-b/)
  assert.match(panel, /px-2\.5 py-1\.5/)
  assert.match(panel, /flex items-center justify-between gap-1\.5/)
  assert.match(panel, /text-\[10px\] font-bold uppercase tracking-wider/)
})

test('6. contador por columna', () => {
  assert.match(panel, /\{colCards\.length\}/)
})

test('7. tarjeta compacta sin line-clamp ni padding grande', () => {
  assert.match(card, /px-2\.5 py-2/)
  assert.doesNotMatch(card, /p-3\.5/)
  assert.doesNotMatch(card, /line-clamp-2/)
})

test('8. folio NV visible y jerarquizado', () => {
  assert.match(card, /NV #\{card\.nv_folio\}/)
  assert.match(card, /text-\[12px\] font-bold tracking-tight/)
})

test('9. cliente en una línea con truncate y tooltip', () => {
  assert.match(card, /truncate text-\[11\.5px\] font-semibold leading-snug/)
  assert.match(card, /title=\{card\.client_name\}/)
})

test('10. comuna y fecha compactas en una línea', () => {
  assert.match(card, /const primaryDate = routeDate/)
  assert.match(card, /\{comuna\}/)
  assert.match(card, /<span className="px-0\.5 text-\[#322D29\]\/30">·<\/span>/)
  assert.match(card, /title=\{`\$\{comuna\} · \$\{primaryDate\.title\}`\}/)
})

test('11. unidades compactas con texto accesible', () => {
  assert.match(card, /\{card\.total_quantity\} un\./)
  assert.match(card, /title=\{`\$\{card\.total_quantity\} \$\{card\.total_quantity === 1 \? 'unidad' : 'unidades'\}`\}/)
})

test('12. monto visible y compacto', () => {
  assert.match(card, /formatPreparationClp\(invoiceDisplayAmount\)/)
  assert.match(card, /text-\[11px\] font-bold tabular-nums/)
})

test('13. responsable, auditoría y readiness de Auditada visibles', () => {
  assert.match(card, /getPreparationLockLabel/)
  assert.match(card, /Tu auditoría/)
  assert.match(card, /Audita: /)
  assert.match(card, /isFinalized \? getPreparationReadinessLabel/)
  assert.match(card, /✓ /)
})

test('14. checkbox de selección existente', () => {
  assert.match(card, /role="checkbox"/)
  assert.match(card, /aria-checked=\{selected\}/)
  assert.match(card, /onToggleSelected\?\.\(card\)/)
})

test('15. AUDITED no es arrastrable', () => {
  assert.match(panel, /dragDisabled=\{card\.status === 'AUDITED' \|\| card\.status === 'INVOICED_READY_FOR_ROUTE' \|\| isPreparationReadOnly\(/)
  assert.match(card, /disabled: isOverlay \|\| isPending \|\| dragDisabled/)
})

test('16. empty state compacto y con área de drop', () => {
  assert.match(panel, /min-h-\[72px\] items-center justify-center/)
  assert.match(panel, /Sin pedidos/)
  assert.doesNotMatch(panel, /h-32 items-center justify-center rounded-lg border border-dashed/)
})

test('17. drawers siguen abriendo desde la tarjeta', () => {
  assert.match(panel, /onOpen=\{\(\) => onOpenCardDetails\(card\)\}/)
  assert.match(panel, /<SalesOrderDrawer/)
  assert.match(panel, /<SalesOrderAuditDrawer/)
})

test('18. búsqueda intacta', () => {
  assert.match(panel, /placeholder="Buscar NV, cliente, comuna, fecha\.\.\."/)
  assert.match(panel, /value=\{searchTerm\}/)
})

test('19. filtros y orden intactos', () => {
  assert.match(panel, /<option value="default">Orden normal<\/option>/)
  assert.match(panel, /<option value="comuna">Ordenar por comuna<\/option>/)
  assert.match(panel, /setShowAdvanced\(v => !v\)/)
  assert.match(panel, /Seleccionar todas/)
})

test('20. drag & drop y reglas no se reimplementan', () => {
  assert.match(card, /useDraggable\(\{/)
  assert.match(panel, /<DndContext/)
  assert.match(panel, /onDragEnd=\{handleDragEnd\}/)
  assert.match(panel, /getMovementRule\(fromStatus, toStatus\)/)
  assert.match(panel, /await transitionCard\(card, toStatus\)/)
  assert.match(rules, /toStatus === 'AUDITED'/)
  assert.match(rules, /fromStatus === 'AUDITED'/)
})

test('21. valorización por columna usa filteredCards y el monto canónico', () => {
  assert.match(panel, /const colCards = filteredCards\.filter\(card => \(/)
  assert.match(panel, /getPreparationColumnId\(card\.status, readinessByCardId\[card\.card_id\]/)
  assert.match(panel, /summarizePreparationBoard\(colCards\)/)
  assert.match(panel, /formatPreparationClp\(columnSummary\.amount\)/)
  assert.doesNotMatch(panel, /getPreparationCardAmount\(card\)/)
})

test('22. valorización respeta gross_amount ?? total_amount y columna vacía = $ 0', () => {
  const summary = summarizePreparationBoard([
    { card_id: 'a', nv_folio: '1', client_name: 'A', gross_amount: 1000, total_amount: 900 },
    { card_id: 'b', nv_folio: '2', client_name: 'B', gross_amount: null, total_amount: 500 },
  ])
  assert.equal(summary.amount, 1500)
  assert.equal(summary.nvCount, 2)
  assert.equal(summarizePreparationBoard([]).amount, 0)
  assert.equal(summarizePreparationBoard([]).nvCount, 0)
})

test('23. SalesOrderDrawer usa el mismo ancho base que AuditDrawer', () => {
  const widthClasses = /w-\[96vw\] max-w-\[1550px\][^\n]*lg:w-\[86vw\] xl:w-\[80vw\]/
  assert.match(drawer, widthClasses)
  assert.match(auditDrawer, widthClasses)
  assert.match(panel, /import \{ SalesOrderAuditDrawer \}/)
})

test('24. script de test registrado con strip types', () => {
  assert.equal(
    packageJson.scripts['test:logistica-preparacion-kanban-compact'],
    'node --experimental-strip-types --test scripts/test-logistica-preparacion-kanban-compact.mjs',
  )
})
