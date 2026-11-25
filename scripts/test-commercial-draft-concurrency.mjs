import assert from 'node:assert/strict'
import pg from 'pg'
import test from 'node:test'

const { PGHOST, PGPORT, PGDATABASE } = process.env
if (!PGHOST?.startsWith('/') || !PGPORT || !PGDATABASE) throw new Error('Se requiere un socket PostgreSQL aislado explícito')
const options = { host: PGHOST, port: Number(PGPORT), database: PGDATABASE }
const company = '10000000-0000-0000-0000-000000000000'
const user = '40000000-0000-0000-0000-000000000001'
const payload = { supplier_id: '10000000-0000-0000-0000-000000000001', notes: 'concurrency-commercial-unique', items: [{ item_type: 'PRODUCT', product_id: '20000000-0000-0000-0000-000000000001', product_description: '513135', quantity: 600, unit_price: 1666.6667, purchase_unit_snapshot: 'DISPLAY', purchase_unit_factor_snapshot: 6, product_supplier_mapping_id: '30000000-0000-0000-0000-000000000001', commercial_unit_price: '10000', tax_rate: 19 }] }
const sql = 'SELECT adquisiciones.save_commercial_draft_request($1,$2::jsonb,$3,$4,$5,$6) AS result'

test('simultaneous retries create once and stale concurrent edits cannot overwrite', async () => {
  const a = new pg.Client(options), b = new pg.Client(options)
  await Promise.all([a.connect(), b.connect()])
  try {
    const key = '50000000-0000-0000-0000-000000000010'
    const args = [null, JSON.stringify(payload), user, company, key, null]
    const [first, second] = await Promise.all([a.query(sql, args), b.query(sql, args)])
    assert.deepEqual(first.rows[0].result, second.rows[0].result)
    const result = first.rows[0].result
    const count = await a.query('SELECT count(*)::int AS n FROM adquisiciones.commercial_draft_requests WHERE company_id=$1 AND user_id=$2 AND request_id=$3', [company, user, key])
    assert.equal(count.rows[0].n, 1)
    const orders = await a.query('SELECT count(*)::int AS n FROM adquisiciones.purchase_orders WHERE company_id=$1 AND notes=$2', [company, payload.notes])
    assert.equal(orders.rows[0].n, 1)
    const economics = await a.query('SELECT quantity,purchase_unit_snapshot,purchase_unit_factor_snapshot,commercial_gross_amount_snapshot FROM adquisiciones.purchase_order_items WHERE po_id=$1', [result.po_id])
    assert.equal(economics.rows[0].commercial_gross_amount_snapshot, '1000000.00')
    assert.equal(economics.rows[0].purchase_unit_snapshot, 'DISPLAY')
    const item = result.lines[0].id
    const edit = { ...payload, items: [{ ...payload.items[0], item_id: item }] }
    const changes = await Promise.allSettled([
      a.query(sql, [result.po_id, JSON.stringify(edit), user, company, '50000000-0000-0000-0000-000000000011', result.revision]),
      b.query(sql, [result.po_id, JSON.stringify(edit), user, company, '50000000-0000-0000-0000-000000000012', result.revision]),
    ])
    assert.equal(changes.filter(value => value.status === 'fulfilled').length, 1)
    const rejected = changes.find(value => value.status === 'rejected')
    assert.match(rejected.reason.message, /cambió en otra sesión/)
    const stored = await a.query('SELECT count(*)::int AS n FROM adquisiciones.purchase_order_items WHERE po_id=$1', [result.po_id])
    assert.equal(stored.rows[0].n, 1)
  } finally { await Promise.all([a.end(), b.end()]) }
})
