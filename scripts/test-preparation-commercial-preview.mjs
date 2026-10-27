import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const page = await readFile(new URL('../src/app/dev/logistica/preparation-commercial-preview/page.tsx', import.meta.url), 'utf8')
const preview = await readFile(new URL('../src/modules/logistica/preparacion-pedidos/preparation-commercial-preview.tsx', import.meta.url), 'utf8')

test('la ruta del preview está bloqueada fuera de desarrollo', () => {
  assert.match(page, /process\.env\.NODE_ENV !== 'development'/)
  assert.match(page, /notFound\(\)/)
})

test('el preview reutiliza tarjeta, drawer y fixture comercial de NV 5129', () => {
  assert.match(preview, /SalesOrderCard/)
  assert.match(preview, /SalesOrderDrawer/)
  assert.match(preview, /nv_folio: '5129'/)
  assert.match(preview, /MGMYM/)
  assert.match(preview, /MUESTRA/)
  assert.match(preview, /PW12401/)
  assert.match(preview, /totalDelta: 16893/)
  assert.match(preview, /setStatus/)
  assert.doesNotMatch(preview, /getSalesOrderPreparationCommercialAlert|createClient|supabase|fetch\(/)
})

test('el fixture está aislado en modo lectura', () => {
  assert.match(preview, /locked_by_user_id: 'preview-lock'/)
  assert.match(preview, /onTransition=\{async \(\) => \(\{ ok: false/)
  assert.match(preview, /onPreparationLineChange=\{\(\) => undefined\}/)
})
