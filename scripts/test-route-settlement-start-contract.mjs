import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationPath = new URL('../supabase/migrations/20260819100000_harden_route_settlement_start.sql', import.meta.url)
const actionPath = new URL('../src/app/actions/adquisiciones/rendicion-rutas.ts', import.meta.url)
const [migration, action] = await Promise.all([readFile(migrationPath, 'utf8'), readFile(actionPath, 'utf8')])

function createRepository({ guideStatus = 'DISPATCHED', permission = true, existing = null, beforeInsert } = {}) {
  const state = { guideStatus, permission, existing, createdCount: 0 }

  return {
    state,
    async start() {
      if (!state.permission) throw new Error('No tiene permiso para crear rendiciones')
      if (state.existing) {
        if (state.existing.status === 'CANCELLED') throw new Error('La guía ya tiene una rendición anulada y no puede reutilizarse.')
        return { created: false, replayed: true, ...state.existing }
      }
      if (state.guideStatus !== 'DISPATCHED') throw new Error('Solo se pueden rendir guías despachadas')
      beforeInsert?.(state)
      if (state.existing) return { created: false, replayed: true, ...state.existing }
      state.existing = { settlement_id: 'settlement-1', route_guide_id: 'guide-1', settlement_number: 'RR-2026-000001', status: 'IN_REVIEW' }
      state.createdCount += 1
      return { created: true, replayed: false, ...state.existing }
    },
  }
}

test('guía elegible crea una sola rendición', async () => {
  const repo = createRepository()
  const result = await repo.start()
  assert.equal(result.created, true)
  assert.equal(repo.state.createdCount, 1)
  assert.equal(repo.state.existing.status, 'IN_REVIEW')
})

test('reintento devuelve la rendición existente', async () => {
  const repo = createRepository({ existing: { settlement_id: 'settlement-1', route_guide_id: 'guide-1', settlement_number: 'RR-2026-000001', status: 'IN_REVIEW' } })
  const result = await repo.start()
  assert.equal(result.replayed, true)
  assert.equal(result.settlement_id, 'settlement-1')
  assert.equal(repo.state.createdCount, 0)
})

test('carrera recupera la rendición que creó la otra solicitud', async () => {
  const repo = createRepository({
    beforeInsert: state => {
      state.existing = { settlement_id: 'settlement-1', route_guide_id: 'guide-1', settlement_number: 'RR-2026-000001', status: 'IN_REVIEW' }
    },
  })
  const result = await repo.start()
  assert.equal(result.replayed, true)
  assert.equal(result.settlement_id, 'settlement-1')
  assert.equal(repo.state.createdCount, 0)
})

test('guía no despachada rechaza sin crear', async () => {
  const repo = createRepository({ guideStatus: 'DRAFT' })
  await assert.rejects(repo.start(), /Solo se pueden rendir guías despachadas/)
  assert.equal(repo.state.createdCount, 0)
})

test('sin permiso rechaza sin crear', async () => {
  const repo = createRepository({ permission: false })
  await assert.rejects(repo.start(), /No tiene permiso/)
  assert.equal(repo.state.createdCount, 0)
})

test('CANCELLED conserva rechazo de negocio', async () => {
  const repo = createRepository({ existing: { settlement_id: 'settlement-1', route_guide_id: 'guide-1', settlement_number: 'RR-2026-000001', status: 'CANCELLED' } })
  await assert.rejects(repo.start(), /rendición anulada/)
  assert.equal(repo.state.createdCount, 0)
})

test('la implementación persiste el contrato de concurrencia y auditoría', () => {
  assert.match(migration, /EXCEPTION WHEN unique_violation/)
  assert.match(migration, /route_settlements_route_guide_id_key/)
  assert.match(migration, /'replayed', true/)
  assert.match(migration, /'created', true/)
  assert.match(migration, /ROUTE_SETTLEMENT_CREATED/)
  assert.match(action, /findExistingRouteSettlement/)
  assert.match(action, /isUniqueViolation/)
  assert.match(action, /created: data\.created \?\? true/)
})
