import assert from 'node:assert/strict'
import test from 'node:test'
import { SalesNetDetailCache, salesNetDetailCacheKey } from '../src/lib/control-financiero/sales-net-detail-cache.ts'

const baseKey = {
  companyId: 'company-a',
  year: 2026,
  providerKey: 'brand:37',
  familyKey: 'brand:37|product_type:54',
  scope: 'MONTH',
  month: 1,
  page: 1,
  pageSize: 100,
}

function response(page = 1) {
  return { items: [{ document_id: page }], total: '1.00', total_net: '1.00', document_count: 1, documents_count: 1 }
}

function deferred() {
  let resolve
  const promise = new Promise(nextResolve => { resolve = nextResolve })
  return { promise, resolve }
}

test('serializes every detail dimension into the cache key', () => {
  const first = salesNetDetailCacheKey(baseKey)
  const second = salesNetDetailCacheKey({ ...baseKey, month: 2 })
  const third = salesNetDetailCacheKey({ ...baseKey, page: 2 })
  assert.notEqual(first, second)
  assert.notEqual(first, third)
  assert.match(first, /company-a\|2026\|brand:37\|brand:37\|product_type:54\|MONTH\|1\|1\|100/)
})

test('caches a completed page and does not load it twice', async () => {
  const cache = new SalesNetDetailCache()
  let calls = 0
  const loader = async () => { calls += 1; return response() }

  await cache.load(baseKey, loader)
  await cache.load(baseKey, loader)

  assert.equal(calls, 1)
  assert.deepEqual(cache.get(baseKey), response())
})

test('deduplicates simultaneous requests for the same page', async () => {
  const cache = new SalesNetDetailCache()
  const pending = deferred()
  let calls = 0
  const loader = () => { calls += 1; return pending.promise }

  const first = cache.load(baseKey, loader)
  const second = cache.load(baseKey, loader)
  assert.equal(first, second)
  assert.equal(calls, 1)

  pending.resolve(response())
  await Promise.all([first, second])
})

test('keeps pagination pages independent and invalidates all pages explicitly', async () => {
  const cache = new SalesNetDetailCache()
  const pageTwo = { ...baseKey, page: 2 }
  let calls = 0
  const loader = async () => { calls += 1; return response(calls) }

  await cache.load(baseKey, loader)
  await cache.load(pageTwo, loader)
  await cache.load(baseKey, loader)

  assert.equal(calls, 2)
  assert.equal(cache.get(pageTwo)?.items[0].document_id, 2)

  cache.clear()
  await cache.load(baseKey, loader)
  assert.equal(calls, 3)
})

test('different company and year keys do not reuse a response', async () => {
  const cache = new SalesNetDetailCache()
  const otherCompany = { ...baseKey, companyId: 'company-b' }
  const otherYear = { ...baseKey, year: 2027 }
  let calls = 0
  const loader = async () => { calls += 1; return response(calls) }

  await cache.load(baseKey, loader)
  await cache.load(otherCompany, loader)
  await cache.load(otherYear, loader)

  assert.equal(calls, 3)
})
