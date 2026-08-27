import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const navigationPath = new URL('../src/modules/adquisiciones/lib/navigation.ts', import.meta.url)
const panelPath = new URL('../src/modules/adquisiciones/rendicion-rutas/route-settlements-panel.tsx', import.meta.url)
const [navigation, panel] = await Promise.all([
  readFile(navigationPath, 'utf8'),
  readFile(panelPath, 'utf8'),
])

test('Rendición de rutas expone sus tres vistas como hijos con URLs directas', () => {
  assert.match(navigation, /children: \[/)
  assert.match(navigation, /label: 'Bandeja de Rendiciones'/)
  assert.match(navigation, /query: \{ tab: 'tray' \}/)
  assert.match(navigation, /label: 'Cobros posteriores'/)
  assert.match(navigation, /query: \{ tab: 'post-collections' \}/)
  assert.match(navigation, /label: 'Cierre de Fondos'/)
  assert.match(navigation, /query: \{ tab: 'fund-closures' \}/)
  assert.match(navigation, /label: 'Cheques'/)
  assert.match(navigation, /query: \{ tab: 'checks' \}/)
  assert.match(navigation, /adquisiciones\.route_settlements\.view/)
})

test('la URL es la fuente de verdad de tabs y el padre sin query cae en Bandeja', () => {
  assert.match(panel, /useSearchParams\(\)/)
  assert.match(panel, /searchParams\.get\('tab'\)/)
  assert.match(panel, /if \(tab === 'post-collections'\)/)
  assert.match(panel, /if \(tab === 'fund-closures'\)/)
  assert.match(panel, /return 'TRAY'/)
  assert.match(panel, /router\.push\(`\$\{pathname\}\?tab=/)
  assert.doesNotMatch(panel, /useState<['"]TRAY['"] \| ['"]POST_COLLECTIONS['"] \| ['"]FUND_CLOSURES['"]>/)
})

test('un padre con hijo activo conserva contexto sin duplicar selección visual', async () => {
  const sidebarPath = new URL('../src/components/layout/module-sidebar.tsx', import.meta.url)
  const sidebar = await readFile(sidebarPath, 'utf8')
  assert.match(sidebar, /const childBranchActive = children\.some\(child => isBranchActive\(child, location\)\)/)
  assert.match(sidebar, /const active = isItemActive\(item, location\) && !childBranchActive/)
})
