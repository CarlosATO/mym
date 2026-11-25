import assert from 'node:assert/strict'
import pg from 'pg'
import test from 'node:test'
const { PGHOST, PGPORT, PGDATABASE } = process.env
if (!PGHOST?.startsWith('/') || !PGPORT || !PGDATABASE) throw new Error('Se requiere PostgreSQL aislado explícito')
const options = { host: PGHOST, port: Number(PGPORT), database: PGDATABASE }
const company = '10000000-0000-0000-0000-000000000000', user = '40000000-0000-0000-0000-000000000001'
const save = 'SELECT adquisiciones.save_commercial_supplier_review($1,$2::jsonb,$3,$4,$5,$6) result'
test('concurrent retries are idempotent and competing revisions cannot overwrite', async () => {
  const a = new pg.Client(options), b = new pg.Client(options)
  await Promise.all([a.connect(), b.connect()])
  try {
    const data = { supplier_id: '10000000-0000-0000-0000-000000000001', warehouse_id: '60000000-0000-0000-0000-000000000001', items: [{ item_type: 'SERVICE', product_description: 'Servicio', quantity: 1, unit_price: 10, tax_rate: 19 }] }
    const draft = (await a.query('SELECT adquisiciones.save_commercial_draft_request(NULL,$1::jsonb,$2,$3,$4,NULL) result', [JSON.stringify(data), user, company, '50000000-0000-0000-0000-000000000080'])).rows[0].result
    const id = draft.po_id
    await a.query('SELECT adquisiciones.emit_commercial_purchase_draft($1,1,$2,$3)', [id,user,company])
    await a.query('SELECT adquisiciones.send_commercial_purchase_order($1,$2,$3)', [id,user,company])
    const payload = { items: [{ ...data.items[0], item_id: draft.lines[0].id, quantity: 2 }] }
    const args = [id,JSON.stringify(payload),user,company,'50000000-0000-0000-0000-000000000081',1]
    const [first, second] = await Promise.all([a.query(save,args), b.query(save,args)])
    assert.deepEqual(first.rows[0].result, second.rows[0].result)
    assert.equal(first.rows[0].result.revision,2)
    const changes = await Promise.allSettled([
      a.query(save,[id,JSON.stringify(payload),user,company,'50000000-0000-0000-0000-000000000082',2]),
      b.query(save,[id,JSON.stringify(payload),user,company,'50000000-0000-0000-0000-000000000083',2]),
    ])
    assert.equal(changes.filter(result => result.status === 'fulfilled').length,1)
    assert.match(changes.find(result => result.status === 'rejected').reason.message,/cambió en otra sesión/)
    assert.equal((await a.query('SELECT commercial_draft_revision FROM adquisiciones.purchase_orders WHERE id=$1',[id])).rows[0].commercial_draft_revision,'3')
  } finally { await Promise.all([a.end(),b.end()]) }
})

test('a concurrent zero-quantity receipt is observed before review can remove its line', async () => {
  const a = new pg.Client(options), b = new pg.Client(options), monitor = new pg.Client(options)
  await Promise.all([a.connect(),b.connect(),monitor.connect()])
  try {
    const data = { supplier_id: '10000000-0000-0000-0000-000000000001', warehouse_id: '60000000-0000-0000-0000-000000000001', items: [{ item_type: 'SERVICE', product_description: 'Servicio', quantity: 1, unit_price: 10, tax_rate: 19 }] }
    const draft = (await a.query('SELECT adquisiciones.save_commercial_draft_request(NULL,$1::jsonb,$2,$3,$4,NULL) result', [JSON.stringify(data),user,company,'50000000-0000-0000-0000-000000000084'])).rows[0].result
    await a.query('SELECT adquisiciones.emit_commercial_purchase_draft($1,1,$2,$3)',[draft.po_id,user,company])
    await a.query('SELECT adquisiciones.send_commercial_purchase_order($1,$2,$3)',[draft.po_id,user,company])
    const pid = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid
    await a.query('BEGIN')
    const receipt = (await a.query('INSERT INTO logistica.purchase_receipts(company_id,purchase_order_id) VALUES($1,$2) RETURNING id',[company,draft.po_id])).rows[0].id
    await a.query('INSERT INTO logistica.purchase_receipt_items(company_id,receipt_id,purchase_order_item_id,quantity_received) VALUES($1,$2,$3,0)',[company,receipt,draft.lines[0].id])
    const review = b.query(save,[draft.po_id,JSON.stringify({ items: [{ item_type: 'SERVICE',product_description: 'Reemplazo',quantity: 1,unit_price: 10,tax_rate: 19 }] }),user,company,'50000000-0000-0000-0000-000000000085',1])
    let blocked = false
    for (let n=0; n<100; n++) {
      const state = await monitor.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])
      if (state.rows[0]?.wait_event_type === 'Lock') { blocked=true; break }
      await new Promise(resolve => setTimeout(resolve,20))
    }
    assert.equal(blocked,true,'review must wait for the receipt transaction')
    await a.query('COMMIT')
    await assert.rejects(review,/La orden tiene recepciones/)
    assert.equal((await monitor.query('SELECT count(*)::int n FROM logistica.purchase_receipt_items WHERE receipt_id=$1',[receipt])).rows[0].n,1)
    assert.equal((await monitor.query('SELECT count(*)::int n FROM adquisiciones.purchase_order_items WHERE id=$1',[draft.lines[0].id])).rows[0].n,1)
  } finally { await a.query('ROLLBACK').catch(() => {}); await Promise.all([a.end(),b.end(),monitor.end()]) }
})
