import assert from 'node:assert/strict'
import pg from 'pg'
import test from 'node:test'
const { PGHOST, PGPORT, PGDATABASE } = process.env
if (!PGHOST?.startsWith('/') || !PGPORT || !PGDATABASE) throw new Error('Se requiere un socket PostgreSQL aislado explícito')
const options = { host: PGHOST, port: Number(PGPORT), database: PGDATABASE }
const company = '10000000-0000-0000-0000-000000000000', user = '40000000-0000-0000-0000-000000000001'
test('simultaneous send retries create one immutable snapshot and one history entry', async () => {
  const a = new pg.Client(options), b = new pg.Client(options)
  await Promise.all([a.connect(), b.connect()])
  try {
    const data = { supplier_id: '10000000-0000-0000-0000-000000000001', warehouse_id: '60000000-0000-0000-0000-000000000001', items: [{ item_type: 'SERVICE', product_description: 'Servicio', quantity: 1, unit_price: 10, tax_rate: 19 }] }
    const save = await a.query('SELECT adquisiciones.save_commercial_draft_request(NULL,$1::jsonb,$2,$3,$4,NULL) result', [JSON.stringify(data), user, company, '50000000-0000-0000-0000-000000000060'])
    const id = save.rows[0].result.po_id
    await a.query('SELECT adquisiciones.emit_commercial_purchase_draft($1,1,$2,$3)', [id, user, company])
    const args = [id, user, company]
    const sql = 'SELECT adquisiciones.send_commercial_purchase_order($1,$2,$3) result'
    const results = await Promise.all([a.query(sql, args), b.query(sql, args)])
    assert.ok(results.every(result => result.rows[0].result.status === 'ENVIADA_PROVEEDOR'))
    assert.equal((await a.query("SELECT count(*)::int n FROM adquisiciones.purchase_order_snapshots WHERE po_id=$1 AND snapshot_type='ORIGINAL_SENT'", [id])).rows[0].n, 1)
    assert.equal((await a.query("SELECT count(*)::int n FROM adquisiciones.purchase_order_status_history WHERE po_id=$1 AND to_status='ENVIADA_PROVEEDOR'", [id])).rows[0].n, 1)
  } finally { await Promise.all([a.end(), b.end()]) }
})
