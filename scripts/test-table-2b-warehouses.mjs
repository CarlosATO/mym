import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const panelPath = new URL('../src/modules/adquisiciones/bodegas/warehouses-panel.tsx', import.meta.url)
const actionPath = new URL('../src/app/actions/adquisiciones/warehouses.ts', import.meta.url)
const [panel, action] = await Promise.all([
  readFile(panelPath, 'utf8'),
  readFile(actionPath, 'utf8'),
])

test('Bodegas usa Operational Table con tableKey exclusivo y defaults explícitos', () => {
  assert.match(panel, /useOperationalTableWidths\(WAREHOUSES_TABLE_KEY, WAREHOUSES_COLUMNS\)/)
  assert.match(panel, /mym:table:adquisiciones:bodegas/)
  assert.match(panel, /id: 'code', defaultWidth: 135, minWidth: 105, maxWidth: 220/)
  assert.match(panel, /id: 'name', defaultWidth: 300, minWidth: 200, maxWidth: 520/)
  assert.match(panel, /id: 'capacity', defaultWidth: 145, minWidth: 110, maxWidth: 220/)
})

test('todas las columnas operativas tienen resize y existe reset persistente', () => {
  assert.equal((panel.match(/resizeHandle\('/g) ?? []).length, 7)
  assert.match(panel, /OperationalTableResizeHandle/)
  assert.match(panel, /onResizeEnd=\{persist\}/)
  assert.match(panel, /resetWidths/)
  assert.match(panel, /Restablecer anchos/)
})

test('no muestra sorting falso sobre una colección paginada server-side', () => {
  assert.doesNotMatch(panel, /useOperationalTableSort/)
  assert.doesNotMatch(panel, /OperationalTableSortIndicator/)
  assert.doesNotMatch(panel, /sortOperationalRows/)
  assert.match(action, /\.range\(\(p - 1\) \* ps, p \* ps - 1\)/)
  assert.match(action, /\.order\('code'\)/)
})

test('refresh diferencia carga inicial, conserva filas y descarta respuestas antiguas', () => {
  assert.match(panel, /initialLoading/)
  assert.match(panel, /refreshing/)
  assert.match(panel, /requestSequence\.current/)
  assert.match(panel, /if \(requestId !== requestSequence\.current\) return/)
  assert.match(panel, /LoaderCircle.*animate-spin/)
  assert.match(panel, /Actualizando\.\.\./)
  assert.match(panel, /pointer-events-none/)
  assert.doesNotMatch(panel, /refreshing \? \(/)
})

test('búsqueda, filtros, estado y paginación existentes permanecen intactos', () => {
  assert.match(panel, /setFilter\('search'/)
  assert.match(panel, /setFilter\('warehouse_type'/)
  assert.match(panel, /setFilter\('status'/)
  assert.match(panel, /\{w\.status\}/)
  assert.match(panel, /Anterior/)
  assert.match(panel, /Siguiente/)
})

test('mantiene scroll, truncado y no inventa acciones o doble clic', () => {
  assert.match(panel, /table-fixed whitespace-nowrap/)
  assert.match(panel, /min-w-\[1370px\]/)
  assert.match(panel, /title=\{w\.name\}/)
  assert.doesNotMatch(panel, /onDoubleClick/)
  assert.doesNotMatch(panel, /sticky right-0/)
  assert.doesNotMatch(panel, /reposicion/i)
})
