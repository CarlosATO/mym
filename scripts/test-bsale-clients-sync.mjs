import assert from 'node:assert/strict'
import test from 'node:test'
import { canDeactivateAbsentClients, getAbsentBsaleClientIds } from '../src/lib/integraciones/bsale-clients-sync-logic.ts'
import { readFile } from 'node:fs/promises'

const syncSource = await readFile(new URL('../src/lib/integraciones/bsale-clients-sync.ts', import.meta.url), 'utf8')

test('sync completo calcula clientes locales ausentes', () => {
  assert.deepEqual(getAbsentBsaleClientIds([1, 2, 3], [1, 2]), [3])
  assert.equal(canDeactivateAbsentClients({ isDryRun: false, hasLimitOverride: false, fetchCompleted: true }), true)
})

test('clientes presentes siguen dependiendo de state === 0', () => {
  assert.match(syncSource, /is_active_bsale: client\.state === 0/)
  assert.match(syncSource, /is_active: client\.state === 0/)
})

test('desactivación por ausencia no borra ni altera el payload histórico', () => {
  assert.match(syncSource, /update\(\{ is_active_bsale: false \}\)/)
  assert.match(syncSource, /update\(\{ is_active: false \}\)/)
  assert.doesNotMatch(syncSource, /raw_payload:\s*null/)
  assert.doesNotMatch(syncSource, /raw_payload\.state\s*=\s*97/)
  assert.doesNotMatch(syncSource, /delete\(/)
})

test('limitOverride y dry-run nunca permiten desactivar ausentes', () => {
  assert.equal(canDeactivateAbsentClients({ isDryRun: false, hasLimitOverride: true, fetchCompleted: true }), false)
  assert.equal(canDeactivateAbsentClients({ isDryRun: true, hasLimitOverride: false, fetchCompleted: true }), false)
})

test('fetch incompleto por error nunca permite desactivar ausentes', () => {
  assert.equal(canDeactivateAbsentClients({ isDryRun: false, hasLimitOverride: false, fetchCompleted: false }), false)
  assert.match(syncSource, /throw new Error\('Bsale clients pagination ended before the complete list was fetched'\)/)
})

test('sync completo sin ausentes reporta cero desactivaciones', () => {
  assert.deepEqual(getAbsentBsaleClientIds([1, 2], [1, 2]), [])
})
