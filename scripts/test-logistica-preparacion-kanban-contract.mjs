import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../src/modules/logistica/preparacion-pedidos/', import.meta.url)
const panel = await readFile(new URL('sales-order-preparation-panel.tsx', root), 'utf8')
const card = await readFile(new URL('sales-order-card.tsx', root), 'utf8')
const rules = await readFile(new URL('movement-rules.ts', root), 'utf8')
const actions = await readFile(new URL('../../../app/actions/logistica/sales-order-preparation.ts', root), 'utf8')

test('el tablero sólo declara las tres columnas operacionales', () => {
  assert.deepEqual([...panel.matchAll(/id: '([^']+)'/g)].map(match => match[1]), [
    'PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT',
  ])
  assert.doesNotMatch(panel, /Facturada \/ Lista|Canceladas|INVOICED_READY_FOR_ROUTE|CANCELLED/)
  assert.match(panel, /grid-cols-\[repeat\(3,minmax\(320px,1fr\)\)\]/)
  assert.match(panel, /overflow-x-auto[^\n]*p-4/)
  assert.match(panel, /min-w-\[1000px\]/)
})

test('las transiciones operacionales y retrocesos conservan sus reglas', () => {
  assert.match(rules, /PENDING_ROUTE_PREP:[\s\S]*IN_PREPARATION: \{ allowed: true, backward: false/)
  assert.match(rules, /IN_PREPARATION:[\s\S]*IN_AUDIT: \{ allowed: true, backward: false/)
  assert.match(rules, /IN_PREPARATION:[\s\S]*PENDING_ROUTE_PREP: \{ allowed: true, backward: true/)
  assert.match(rules, /IN_AUDIT:[\s\S]*IN_PREPARATION: \{ allowed: true, backward: true/)
  assert.match(panel, /if \(rule\?\.backward\) \{[\s\S]*setPendingMovement/)
  assert.match(panel, /await executeMove\(card, toStatus\)/)
})

test('drag no abre accidentalmente el drawer y el detalle sigue accesible', () => {
  assert.match(card, /\.\.\.\(!isOverlay \? listeners : \{\}\)/)
  assert.match(card, /onDoubleClick={!isOverlay \? onDoubleClick : undefined}/)
  assert.match(card, /onKeyDown={!isOverlay/)
  assert.doesNotMatch(card, /onClick={!isOverlay \? onClick/)
})

test('el board no recibe company_id hardcodeado ni hace fetch por tarjeta', () => {
  assert.doesNotMatch(panel, /d1000000-0000-0000-0000-000000000001/)
  assert.match(actions, /export async function getSalesOrderPreparationBoard\(companyId: string\)/)
  assert.match(actions, /export async function getSalesOrderPreparationItems\(companyId: string, bsaleNvId: number\)/)
  assert.match(panel, /getActiveCompanyId\(\)/)
  assert.match(panel, /getSalesOrderPreparationBoard\(activeCompanyId\)/)
  const column = panel.match(/function DroppableColumn[\s\S]*?\n}\n\nexport function/)?.[0] ?? ''
  assert.doesNotMatch(column, /getSalesOrderPreparation/)
})
