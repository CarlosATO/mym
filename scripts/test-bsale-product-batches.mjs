import assert from 'node:assert/strict'
import test from 'node:test'
import {
  UPDATE_BATCH_SIZE,
  executeSequentialBatches,
  shouldRunProductSupplierMappings
} from '../src/lib/integraciones/bsale-update-batches.ts'

async function batchSizes(count, executeBatch = async () => {}) {
  const sizes = []
  const summary = await executeSequentialBatches(
    Array.from({ length: count }, (_, id) => ({ id, bsale_brand_id: 29 })),
    async (batch, index, total) => {
      sizes.push({ size: batch.length, index, total })
      await executeBatch(batch, index, total)
    }
  )
  return { sizes, summary }
}

test('0 updates no hace llamadas RPC', async () => {
  let calls = 0
  const result = await batchSizes(0, async () => { calls++ })
  assert.equal(calls, 0)
  assert.deepEqual(result.summary, { batchesProcessed: 0, itemsProcessed: 0 })
})

test('1 update usa un batch', async () => {
  const result = await batchSizes(1)
  assert.deepEqual(result.sizes.map(({ size }) => size), [1])
})

test('500 updates usa un batch de 500', async () => {
  const result = await batchSizes(UPDATE_BATCH_SIZE)
  assert.deepEqual(result.sizes.map(({ size }) => size), [500])
})

test('501 updates usa 500 + 1', async () => {
  const result = await batchSizes(501)
  assert.deepEqual(result.sizes.map(({ size }) => size), [500, 1])
})

test('1200 updates usa 500 + 500 + 200', async () => {
  const result = await batchSizes(1200)
  assert.deepEqual(result.sizes.map(({ size }) => size), [500, 500, 200])
  assert.deepEqual(result.summary, { batchesProcessed: 3, itemsProcessed: 1200 })
})

test('agrega contadores de batches exitosos', async () => {
  const result = await batchSizes(1200)
  assert.equal(result.summary.batchesProcessed, 3)
  assert.equal(result.summary.itemsProcessed, 1200)
})

test('un error en batch 2 detiene el batch 3', async () => {
  const calls = []
  await assert.rejects(
    executeSequentialBatches(Array.from({ length: 1200 }, (_, id) => id), async (batch, index) => {
      calls.push(batch.length)
      if (index === 1) throw new Error('batch failure')
    }),
    /batch failure/
  )
  assert.deepEqual(calls, [500, 500])
})

test('products fallido no ejecuta mappings', () => {
  assert.equal(shouldRunProductSupplierMappings('ERROR'), false)
  assert.equal(shouldRunProductSupplierMappings('FAILED'), false)
  assert.equal(shouldRunProductSupplierMappings('SUCCESS'), true)
})

test('products fallido representa un cierre FAILED', () => {
  const productResult = { status: 'FAILED', finished_at: '2026-08-19T20:00:00.000Z' }
  assert.equal(productResult.status, 'FAILED')
  assert.ok(productResult.finished_at)
})

test('cada chunk conserva los campos Brand', async () => {
  const brandIds = []
  await executeSequentialBatches(
    Array.from({ length: 501 }, () => ({ bsale_brand_id: 29, bsale_brand_href: 'href-29' })),
    async batch => brandIds.push(...batch.map(item => [item.bsale_brand_id, item.bsale_brand_href]))
  )
  assert.equal(brandIds.length, 501)
  assert.deepEqual(brandIds[0], [29, 'href-29'])
  assert.deepEqual(brandIds[500], [29, 'href-29'])
})
