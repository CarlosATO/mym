import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20260901160000_pending_route_fund_origin_status.sql', import.meta.url), 'utf8')
const types = await readFile(new URL('../src/modules/adquisiciones/rendicion-rutas/fund-closures-types.ts', import.meta.url), 'utf8')

test('el read-model expone READY y CARRY_FORWARD desde historial persistido', () => {
  assert.match(migration, /'pending_origin_status', pending_origin_status/)
  assert.match(migration, /THEN 'CARRY_FORWARD' ELSE 'READY'/)
  assert.match(migration, /history_item\.route_settlement_id = p\.settlement_id/)
  assert.match(migration, /history_item\.company_id = p_company_id/)
  assert.match(migration, /p\.received_at <= COALESCE\(history_closure\.closed_at, history_closure\.created_at\)/)
})

test('la señal no depende de montos, cheques, depósitos o heurísticas visuales', () => {
  assert.doesNotMatch(migration, /checks_received\s*>|amount\s*>|route_fund_closure_deposit_checks/)
  assert.match(migration, /history_item\.fund_closure_id/)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION adquisiciones\.get_pending_route_fund_groups\(uuid\)/)
  assert.match(types, /pending_origin_status: 'READY' \| 'CARRY_FORWARD'/)
})
