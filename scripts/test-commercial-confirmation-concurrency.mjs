import assert from 'node:assert/strict'
import pg from 'pg'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

const { PGHOST, PGPORT, PGDATABASE } = process.env
if (!PGHOST?.startsWith('/') || !PGPORT || !PGDATABASE) throw new Error('Se requiere PostgreSQL aislado explícito')
const options = { host: PGHOST, port: Number(PGPORT), database: PGDATABASE }
const company = '10000000-0000-0000-0000-000000000000', user = '40000000-0000-0000-0000-000000000001'

test('concurrent confirmation retries create one snapshot and one history entry', async () => {
  const a = new pg.Client(options), b = new pg.Client(options)
  await Promise.all([a.connect(), b.connect()])
  try {
    const payload = { supplier_id: '10000000-0000-0000-0000-000000000001', warehouse_id: '60000000-0000-0000-0000-000000000001', items: [{ item_type: 'SERVICE', product_description: 'Servicio', quantity: 1, unit_price: 10, tax_rate: 19 }] }
    const draft = (await a.query('SELECT adquisiciones.save_commercial_draft_request(NULL,$1::jsonb,$2,$3,$4,NULL) result', [JSON.stringify(payload), user, company, randomUUID()])).rows[0].result
    const id = draft.po_id
    await a.query('SELECT adquisiciones.emit_commercial_purchase_draft($1,1,$2,$3)', [id, user, company])
    await a.query('SELECT adquisiciones.send_commercial_purchase_order($1,$2,$3)', [id, user, company])
    const sql = 'SELECT adquisiciones.confirm_commercial_purchase_order($1,$2,$3,1) result'
    const results = await Promise.all([a.query(sql, [id, user, company]), b.query(sql, [id, user, company])])
    assert.equal(results[0].rows[0].result.snapshot_id, results[1].rows[0].result.snapshot_id)
    assert.deepEqual(results.map(r => r.rows[0].result.already_confirmed).sort(), [false, true])
    const counts = await a.query("SELECT (SELECT count(*)::int FROM adquisiciones.purchase_order_snapshots WHERE po_id=$1 AND snapshot_type='CONFIRMED') snapshots,(SELECT count(*)::int FROM adquisiciones.purchase_order_status_history WHERE po_id=$1 AND to_status='CONFIRMADA') history", [id])
    assert.deepEqual(counts.rows[0], { snapshots: 1, history: 1 })
  } finally { await Promise.all([a.end(), b.end()]) }
})

test('a review holding the order lock makes a concurrent confirmation stale', async () => {
  const a = new pg.Client(options), b = new pg.Client(options)
  await Promise.all([a.connect(), b.connect()])
  try {
    const payload = { supplier_id: '10000000-0000-0000-0000-000000000001', warehouse_id: '60000000-0000-0000-0000-000000000001', items: [{ item_type: 'SERVICE', product_description: 'Servicio', quantity: 1, unit_price: 10, tax_rate: 19 }] }
    const draft = (await a.query('SELECT adquisiciones.save_commercial_draft_request(NULL,$1::jsonb,$2,$3,$4,NULL) result', [JSON.stringify(payload), user, company, randomUUID()])).rows[0].result
    const id = draft.po_id
    await a.query('SELECT adquisiciones.emit_commercial_purchase_draft($1,1,$2,$3)', [id, user, company])
    await a.query('SELECT adquisiciones.send_commercial_purchase_order($1,$2,$3)', [id, user, company])
    await a.query('BEGIN')
    await a.query('SELECT adquisiciones.save_commercial_supplier_review($1,$2::jsonb,$3,$4,$5,1)', [id, JSON.stringify({ items: [{ ...payload.items[0], item_id: draft.lines[0].id, quantity: 2 }] }), user, company, randomUUID()])
    const confirmation = b.query('SELECT adquisiciones.confirm_commercial_purchase_order($1,$2,$3,1)', [id, user, company])
    await a.query('COMMIT')
    await assert.rejects(confirmation, /La revisión cambió/)
    const state = await a.query("SELECT status,commercial_draft_revision,(SELECT count(*)::int FROM adquisiciones.purchase_order_snapshots WHERE po_id=$1 AND snapshot_type='CONFIRMED') snapshots FROM adquisiciones.purchase_orders WHERE id=$1", [id])
    assert.deepEqual(state.rows[0], { status: 'ENVIADA_PROVEEDOR', commercial_draft_revision: '2', snapshots: 0 })
  } finally { await a.query('ROLLBACK').catch(() => {}); await Promise.all([a.end(), b.end()]) }
})
