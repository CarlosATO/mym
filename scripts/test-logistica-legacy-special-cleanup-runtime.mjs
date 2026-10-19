import assert from 'node:assert/strict'
import test from 'node:test'

const ids = [
  { id: 83326, status: 'PENDING_ROUTE_PREP', movements: 2, covered: 0, remaining: 2, coverage: 'SIN_CIERRE', children: [] },
  { id: 83327, status: 'PENDING_ROUTE_PREP', movements: 0, covered: 0, remaining: 1, coverage: 'SIN_CIERRE', children: [] },
  { id: 83878, status: 'IN_PREPARATION', movements: 3, covered: 0, remaining: 4, coverage: 'SIN_CIERRE', children: [] },
  { id: 90045, status: 'PENDING_ROUTE_PREP', movements: 0, covered: 36, remaining: 2, coverage: 'PARCIAL', children: [51292] },
]

function cleanup(state, failureId = null) {
  const next = structuredClone(state)
  for (const card of next) {
    assert.equal(card.status, ids.find((expected) => expected.id === card.id).status)
    assert.equal(card.closedAt, null)
    assert.equal(card.locked, false)
    assert.equal(card.assigned, false)
    assert.equal(card.movements, card.baselineMovements)
    assert.equal(card.remaining > 0, true)
    assert.equal(card.children.length, card.id === 90045 ? 1 : 0)
    if (card.id === 90045) {
      assert.deepEqual(card.children, [51292])
      assert.deepEqual([card.covered, card.remaining, card.coverage], [36, 2, 'PARCIAL'])
    } else assert.deepEqual([card.covered, card.coverage], [0, 'SIN_CIERRE'])
  }
  for (const card of next) {
    if (card.id === failureId) throw new Error(`drift ${failureId}`)
    card.closedAt = 'batch-time'
    card.closureReason = 'LEGACY_BACKFILL_ARCHIVED'
    card.movements += 1
    card.batchMovements += 1
  }
  return next
}

function fixture() {
  return ids.map((card) => ({ ...card, baselineMovements: card.movements, closedAt: null, closureReason: null, locked: false, assigned: false, batchMovements: 0 }))
}

test('happy path produces four archives and one SYSTEM movement each', () => {
  const result = cleanup(fixture())
  assert.deepEqual(result.map((card) => [card.id, card.movements, card.batchMovements]), [[83326, 3, 1], [83327, 1, 1], [83878, 4, 1], [90045, 1, 1]])
  assert.equal(result.filter((card) => card.closedAt).length, 4)
})

test('drift aborts all changes, including earlier cards', () => {
  const before = fixture()
  assert.throws(() => cleanup(before, 90045), /drift 90045/)
  assert.deepEqual(before, fixture())
})

test('board simulation is 20 to 16 and valid cards remain untouched', () => {
  const board = { total: 20, valid: 16, special: cleanup(fixture()).length }
  assert.deepEqual(board, { total: 20, valid: 16, special: 4 })
})
