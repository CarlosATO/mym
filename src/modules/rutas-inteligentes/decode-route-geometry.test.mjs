import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return nextResolve(`${specifier}.ts`, context)
  }
} })

const { decodeRouteGeometry } = await import('./decode-route-geometry.ts')

test('decodifica polyline VROOM en orden longitud, latitud', () => {
  assert.deepEqual(decodeRouteGeometry('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), [[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]])
})

test('rechaza geometrías truncadas o sin trayecto', () => {
  assert.throws(() => decodeRouteGeometry('_p~iF'))
  assert.throws(() => decodeRouteGeometry(''))
})
