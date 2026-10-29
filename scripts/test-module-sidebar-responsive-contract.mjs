import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { resolveSidebarState } from '../src/components/layout/module-sidebar-state.ts'

const shell = await readFile(new URL('../src/components/layout/module-shell.tsx', import.meta.url), 'utf8')
const sidebar = await readFile(new URL('../src/components/layout/module-sidebar.tsx', import.meta.url), 'utf8')

const state = (input) => resolveSidebarState({
  viewport: 'medium',
  desktopCollapsed: false,
  temporaryExpanded: false,
  mobileOpen: false,
  ...input,
})

test('1. >=1536 usa la preferencia persistida de escritorio', () => {
  assert.deepEqual(state({ viewport: 'wide' }), { expanded: true, reserveCollapsed: false, overlay: false })
  assert.deepEqual(state({ viewport: 'wide', desktopCollapsed: true }), { expanded: false, reserveCollapsed: true, overlay: false })
  assert.match(shell, /const WIDE_VIEWPORT_QUERY = '\(min-width: 1536px\)'/)
  assert.match(shell, /const collapsed = useSidebarCollapsedPreference\(legacySidebarStorageKey\)/)
})

test('2. >=1536 permite expandir y contraer actualizando la preferencia', () => {
  const toggle = shell.slice(shell.indexOf('function toggleSidebar()'), shell.indexOf('if (!activeCompany)'))
  assert.match(toggle, /if \(viewport === 'wide'\) \{[\s\S]*?localStorage\.setItem\(STORAGE_KEY, String\(!collapsed\)\)[\s\S]*?PREFERENCE_EVENT/)
  assert.deepEqual(state({ viewport: 'wide', desktopCollapsed: true }), { expanded: false, reserveCollapsed: true, overlay: false })
  assert.deepEqual(state({ viewport: 'wide', desktopCollapsed: false }), { expanded: true, reserveCollapsed: false, overlay: false })
})

test('3. 768-1535 inicia compacto', () => {
  assert.match(shell, /const MOBILE_VIEWPORT_QUERY = '\(max-width: 767px\)'/)
  assert.deepEqual(state({ viewport: 'medium' }), { expanded: false, reserveCollapsed: true, overlay: false })
})

test('4. 768-1535 permite expansión manual', () => {
  assert.deepEqual(state({ viewport: 'medium', temporaryExpanded: true }), { expanded: true, reserveCollapsed: true, overlay: true })
  assert.match(shell, /setTemporaryExpanded\(value => !value\)/)
})

test('5. la expansión mediana usa overlay', () => {
  assert.equal(state({ viewport: 'medium', temporaryExpanded: true }).overlay, true)
  assert.match(shell, /mediumOverlayOpen && <button aria-label="Cerrar navegación"/)
})

test('6. la expansión mediana NO aumenta la reserva de contenido', () => {
  const collapsed = state({ viewport: 'medium' })
  const expanded = state({ viewport: 'medium', temporaryExpanded: true })
  assert.equal(collapsed.reserveCollapsed, true)
  assert.equal(expanded.reserveCollapsed, true)
  assert.match(shell, /sidebarState\.reserveCollapsed \? 'md:pl-\[92px\]' : 'md:pl-\[268px\]'/)
})

test('7. cerrar manualmente funciona', () => {
  assert.match(shell, /function closeOverlays\(\) \{\n    setTemporaryExpanded\(false\)\n    setMobileOpen\(false\)/)
  assert.equal(state({ viewport: 'medium', temporaryExpanded: false }).expanded, false)
})

test('8. navegar cierra el overlay temporal', () => {
  assert.match(shell, /const navigationKey = `\$\{pathname\}\|\$\{viewport\}`/)
  assert.match(shell, /if \(navigationKey !== lastNavigationKey\) \{[\s\S]*?setTemporaryExpanded\(false\)[\s\S]*?setMobileOpen\(false\)/)
  assert.match(shell, /onNavigate=\{closeOverlays\}/)
})

test('9. Escape cierra el overlay temporal', () => {
  assert.match(shell, /window\.addEventListener\('keydown', handleKeyDown\)/)
  assert.match(shell, /if \(event\.key !== 'Escape'\) return[\s\S]*?setTemporaryExpanded\(false\)/)
})

test('10. click fuera cierra el overlay temporal', () => {
  assert.match(shell, /mediumOverlayOpen && <button[^>]*?onClick=\{\(\) => setTemporaryExpanded\(false\)\}/)
})

test('11. la apertura temporal NO escribe la preferencia de escritorio', () => {
  const toggle = shell.slice(shell.indexOf('function toggleSidebar()'), shell.indexOf('if (!activeCompany)'))
  assert.equal((shell.match(/localStorage\.setItem\(STORAGE_KEY/g) ?? []).length, 1)
  assert.match(toggle, /setTemporaryExpanded\(value => !value\)/)
  assert.doesNotMatch(toggle, /setTemporaryExpanded\(value => !value\)[\s\S]*localStorage\.setItem/)
})

test('12. <768 conserva el comportamiento móvil', () => {
  assert.deepEqual(state({ viewport: 'mobile' }), { expanded: false, reserveCollapsed: true, overlay: false })
  assert.deepEqual(state({ viewport: 'mobile', mobileOpen: true }), { expanded: true, reserveCollapsed: true, overlay: true })
  assert.match(shell, /mobileDrawerOpen && <button aria-label="Cerrar navegación" className="fixed inset-0 z-30 bg-theme-sidebar-bg\/70 md:hidden"/)
})

test('13. resize limpia los estados incompatibles', () => {
  assert.deepEqual(
    state({ viewport: 'wide', temporaryExpanded: true, mobileOpen: true }),
    { expanded: true, reserveCollapsed: false, overlay: false },
  )
  assert.deepEqual(
    state({ viewport: 'mobile', temporaryExpanded: true, mobileOpen: false }),
    { expanded: false, reserveCollapsed: true, overlay: false },
  )
  assert.match(shell, /const navigationKey = `\$\{pathname\}\|\$\{viewport\}`/)
  assert.match(shell, /if \(navigationKey !== lastNavigationKey\) \{[\s\S]*?setTemporaryExpanded\(false\)[\s\S]*?setMobileOpen\(false\)/)
  assert.match(shell, /const mobileDrawerOpen = !hideSidebar && viewport === 'mobile' && mobileOpen/)
})

test('14. aria-expanded refleja el estado real', () => {
  assert.match(sidebar, /aria-expanded=\{expanded\}/)
  assert.match(shell, /aria-expanded=\{mobileDrawerOpen\}/)
  assert.match(sidebar, /aria-controls="module-sidebar"/)
})

test('15. el evento mym:sidebar-change sigue soportado', () => {
  assert.match(shell, /new CustomEvent\('mym:sidebar-change'/)
  assert.match(shell, /collapsed: hideSidebar \? false : sidebarState\.reserveCollapsed/)
})

test('16. el contenido no queda comprimido a 1366', () => {
  const expandedAt1366 = state({ viewport: 'medium', temporaryExpanded: true })
  assert.equal(expandedAt1366.overlay, true)
  assert.equal(expandedAt1366.reserveCollapsed, true)
  assert.doesNotMatch(shell, /const effectiveCollapsed = collapsed \|\| responsiveCollapsed/)
})

test('17. el sidebar tiene scroll vertical propio', () => {
  assert.match(sidebar, /className="min-h-0 flex-1 overflow-y-auto px-3 py-4"/)
  assert.match(sidebar, /'shrink-0 border-t p-3'/)
})

test('18. no hay mensaje que indique compactación obligatoria', () => {
  assert.doesNotMatch(sidebar, /Navegación compacta en este ancho/)
  assert.match(sidebar, /const toggleLabel = expanded \? 'Contraer navegación' : 'Expandir navegación'/)
})
