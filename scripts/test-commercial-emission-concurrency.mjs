import assert from 'node:assert/strict'
import pg from 'pg'
import test from 'node:test'

const { PGHOST, PGPORT, PGDATABASE } = process.env
if (!PGHOST?.startsWith('/') || !PGPORT || !PGDATABASE) throw new Error('Se requiere un socket PostgreSQL aislado explícito')
const options = { host: PGHOST, port: Number(PGPORT), database: PGDATABASE }
const company = '10000000-0000-0000-0000-000000000000', user = '40000000-0000-0000-0000-000000000001'
const payload = { supplier_id: '10000000-0000-0000-0000-000000000001', warehouse_id: '60000000-0000-0000-0000-000000000001', items: [{ item_type: 'SERVICE', product_description: 'Servicio', quantity: 1, unit_price: 100, tax_rate: 19 }] }
const save = 'SELECT adquisiciones.save_commercial_draft_request($1,$2::jsonb,$3,$4,$5,$6) result'
const emit = 'SELECT adquisiciones.emit_commercial_purchase_draft($1,$2,$3,$4) result'

test('simultaneous emissions are idempotent and a concurrent save makes emission stale', async () => {
  const a = new pg.Client(options), b = new pg.Client(options)
  await Promise.all([a.connect(), b.connect()])
  try {
    const first = (await a.query(save, [null, JSON.stringify(payload), user, company, '50000000-0000-0000-0000-000000000040', null])).rows[0].result
    const results = await Promise.all([a.query(emit, [first.po_id, 1, user, company]), b.query(emit, [first.po_id, 1, user, company])])
    assert.ok(results.every(result => result.rows[0].result.status === 'EMITIDA'))
    assert.equal((await a.query("SELECT count(*)::int n FROM adquisiciones.purchase_order_status_history WHERE po_id=$1 AND to_status='EMITIDA'", [first.po_id])).rows[0].n, 1)
    const second = (await a.query(save, [null, JSON.stringify(payload), user, company, '50000000-0000-0000-0000-000000000041', null])).rows[0].result
    await a.query('BEGIN')
    const edit = { ...payload, notes: 'changed', items: [{ ...payload.items[0], item_id: second.lines[0].id }] }
    await a.query(save, [second.po_id, JSON.stringify(edit), user, company, '50000000-0000-0000-0000-000000000042', 1])
    const pending = b.query(emit, [second.po_id, 1, user, company])
    await a.query('COMMIT')
    await assert.rejects(pending, /cambió en otra sesión/)
    assert.equal((await a.query('SELECT status FROM adquisiciones.purchase_orders WHERE id=$1', [second.po_id])).rows[0].status, 'BORRADOR')
  } finally {
    await a.query('ROLLBACK').catch(() => {})
    await Promise.all([a.end(), b.end()])
  }
})
