import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/lib/integraciones/bsale-receptions-sync.ts', import.meta.url), 'utf8')

test('define delta con overlap de tres días y watermark persistente', () => {
  assert.match(source, /params\.overlapDays \?\? OVERLAP_DAYS/)
  assert.match(source, /watermark_admission_date: window\.to/)
  assert.match(source, /eq\('status', 'SUCCESS'\)/)
})

test('no inventa un delta inicial y permite backfill explícito', () => {
  assert.match(source, /if \(!params\.watermark\) return null/)
  assert.match(source, /backfill: true/)
  assert.match(source, /params\.to > params\.today/)
})

test('aplica cooldown y lock antes de tocar Bsale', () => {
  assert.match(source, /COOLDOWN_MINUTES = 10/)
  assert.match(source, /status: 'SKIPPED_FRESH'/)
  assert.match(source, /status: 'SKIPPED_LOCKED'/)
  assert.ok(source.indexOf('isWithinCooldown') < source.indexOf('acquire(options.companyId'))
})

test('divide persistencia en chunks pequeños', () => {
  assert.match(source, /HEADER_CHUNK_SIZE = 250/)
  assert.match(source, /DETAIL_CHUNK_SIZE = 500/)
  assert.match(source, /onConflict: 'company_id,bsale_id'/)
  assert.doesNotMatch(source, /upsert\(allDetails/)
})
