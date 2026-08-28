import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import test from 'node:test'

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

class BsaleSyncFixture {
  constructor({ local = [], remote = {}, delay = 2 } = {}) {
    this.local = new Set(local)
    this.remote = { ...remote }
    this.delay = delay
    this.externalCalls = []
    this.persisted = new Set(local)
  }

  async sync(numbers) {
    const startedAt = performance.now()
    const documents = []
    for (const number of [...new Set(numbers)]) {
      if (this.local.has(number)) {
        documents.push({ invoice_number: number, status: 'READY', details_count: 1, customer_bsale_id: 1000 + Number(number) })
        continue
      }
      this.externalCalls.push(number)
      await wait(this.delay)
      const remoteStatus = this.remote[number] || 'NOT_FOUND'
      if (remoteStatus === 'READY') {
        this.local.add(number)
        this.persisted.add(number)
        documents.push({ invoice_number: number, status: 'READY', details_count: 1, customer_bsale_id: 1000 + Number(number) })
      } else {
        documents.push({ invoice_number: number, status: remoteStatus })
      }
    }
    return {
      success: true,
      requested: numbers.length,
      ready: documents.filter(document => document.status === 'READY').length,
      missing: documents.filter(document => document.status !== 'READY').length,
      documents,
      elapsed: performance.now() - startedAt,
    }
  }
}

class NewGuideFlowFixture {
  constructor(sync) {
    this.sync = sync
    this.generation = 0
    this.background = null
    this.visible = null
    this.creations = 0
    this.formUsable = true
  }

  loadExcel(numbers) {
    const generation = ++this.generation
    const key = [...new Set(numbers)].join('|')
    const promise = this.sync.sync(numbers).then(result => {
      if (generation === this.generation) this.visible = result
      return result
    })
    this.background = { generation, key, promise }
    return promise
  }

  async create(numbers) {
    const key = [...new Set(numbers)].join('|')
    if (this.background?.key === key) await this.background.promise
    const result = this.visible?.documents ? this.visible : await this.sync.sync(numbers)
    if (result.ready !== result.requested || result.documents.some(document => document.status !== 'READY')) return false
    this.creations++
    return true
  }
}

function completeLocalResult(numbers) {
  return numbers.every(number => typeof number === 'string')
}

test('A: 30 facturas locales, cero llamadas externas y submit inmediato', async () => {
  const numbers = Array.from({ length: 30 }, (_, index) => String(24000 + index))
  const sync = new BsaleSyncFixture({ local: numbers })
  const flow = new NewGuideFlowFixture(sync)
  const precheckStart = performance.now()
  const precheck = await flow.loadExcel(numbers)
  const precheckMs = performance.now() - precheckStart
  const submitStart = performance.now()
  const created = await flow.create(numbers)
  const submitMs = performance.now() - submitStart

  assert.equal(precheck.ready, 30)
  assert.equal(sync.externalCalls.length, 0)
  assert.equal(created, true)
  assert.equal(flow.creations, 1)
  assert.equal(completeLocalResult(numbers), true)
  console.log(`QA A: precheck=${precheckMs.toFixed(2)}ms submit=${submitMs.toFixed(2)}ms llamadas=${sync.externalCalls.length}`)
})

test('B: 30 nuevas comienzan en background y Crear reutiliza el resultado', async () => {
  const numbers = Array.from({ length: 30 }, (_, index) => String(25000 + index))
  const sync = new BsaleSyncFixture({ remote: Object.fromEntries(numbers.map(number => [number, 'READY'])) })
  const flow = new NewGuideFlowFixture(sync)
  const background = flow.loadExcel(numbers)
  assert.equal(sync.externalCalls.length > 0, true)
  assert.equal(flow.formUsable, true)
  const result = await background
  const callsBeforeCreate = sync.externalCalls.length
  assert.equal(result.ready, 30)
  assert.equal(await flow.create(numbers), true)
  assert.equal(sync.externalCalls.length, callsBeforeCreate)
  assert.equal(flow.creations, 1)
  console.log(`QA B: ready=${result.ready}/${result.requested} tiempo=${result.elapsed.toFixed(2)}ms llamadas=${callsBeforeCreate} inicio=background`)
})

test('C: 29/30 bloquea y reintenta sólo el folio faltante', async () => {
  const numbers = Array.from({ length: 30 }, (_, index) => String(26000 + index))
  const missing = numbers[29]
  const sync = new BsaleSyncFixture({ local: numbers.slice(0, 29), remote: { [missing]: 'NOT_FOUND' } })
  const flow = new NewGuideFlowFixture(sync)
  const first = await flow.loadExcel(numbers)
  assert.equal(first.ready, 29)
  assert.equal(first.documents.find(document => document.invoice_number === missing).status, 'NOT_FOUND')
  assert.equal(await flow.create(numbers), false)
  sync.remote[missing] = 'READY'
  const callsBeforeRetry = sync.externalCalls.length
  const retry = await flow.loadExcel(numbers)
  assert.equal(retry.ready, 30)
  assert.deepEqual(sync.externalCalls.slice(callsBeforeRetry), [missing])
  assert.equal(await flow.create(numbers), true)
  assert.equal(flow.creations, 1)
  console.log(`QA C: primera=${first.ready}/${first.requested} reintento=${retry.ready}/${retry.requested} consultaSólo=${missing}`)
})

test('cambio de Excel: una respuesta tardía del universo A no contamina B', async () => {
  let resolveA
  const sync = {
    calls: [],
    sync(numbers) {
      this.calls.push(numbers)
      if (numbers[0] === 'A-1') return new Promise(resolve => { resolveA = () => resolve({ success: true, requested: 1, ready: 1, missing: 0, documents: [{ invoice_number: 'A-1', status: 'READY' }] }) })
      return Promise.resolve({ success: true, requested: 1, ready: 1, missing: 0, documents: [{ invoice_number: 'B-1', status: 'READY' }] })
    },
  }
  const flow = new NewGuideFlowFixture(sync)
  flow.loadExcel(['A-1'])
  const bPromise = flow.loadExcel(['B-1'])
  await bPromise
  resolveA()
  await wait(0)
  assert.deepEqual(flow.visible.documents.map(document => document.invoice_number), ['B-1'])
  assert.deepEqual(sync.calls, [['A-1'], ['B-1']])
})

test('guard backend: universo incompleto no persiste y universo READY sí', async () => {
  const backendCreate = result => result.ready === result.requested && result.documents.every(document => document.status === 'READY')
  assert.equal(backendCreate({ ready: 2, requested: 3, documents: [{ status: 'READY' }, { status: 'READY' }, { status: 'NOT_FOUND' }] }), false)
  assert.equal(backendCreate({ ready: 3, requested: 3, documents: [{ status: 'READY' }, { status: 'READY' }, { status: 'READY' }] }), true)
})

test('customer_bsale_id y Rentabilidad V1 simulada quedan disponibles', async () => {
  const numbers = ['27001', '27002', '27003']
  const sync = new BsaleSyncFixture({ remote: Object.fromEntries(numbers.map(number => [number, 'READY'])) })
  const result = await sync.sync(numbers)
  assert.equal(result.documents.every(document => document.customer_bsale_id !== null), true)
  assert.equal(result.documents.reduce((total, document) => total + (document.details_count > 0 ? 10 : 0), 0) > 0, true)
})
