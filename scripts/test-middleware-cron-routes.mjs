import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const middleware = await readFile(new URL('../src/middleware.ts', import.meta.url), 'utf8')

const expectedCronRoutes = [
  '/api/integraciones/bsale/clients/sync',
  '/api/integraciones/bsale/product-types/sync',
  '/api/integraciones/bsale/products/sync',
  '/api/cron/sync-replenishment',
  '/api/cron/warehouse-incremental',
  '/api/cron/warehouse-operational',
  '/api/cron/receivables-snapshot',
]

test('middleware permite que todas las rutas cron lleguen a su autenticacion', () => {
  for (const route of expectedCronRoutes) {
    assert.match(middleware, new RegExp(`['"]${route.replaceAll('/', '\\/')}['"]`))
  }
})

test('middleware conserva la proteccion de APIs no incluidas', () => {
  assert.match(middleware, /if \(path\.startsWith\('\/api\/'\)\)/)
  assert.match(middleware, /NextResponse\.json\(\{ error: 'Unauthorized' \}, \{ status: 401 \}\)/)
})
