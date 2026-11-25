import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import test from 'node:test'

const { PGHOST, PGPORT, PGDATABASE } = process.env
if (!PGHOST?.startsWith('/') || !PGPORT || !PGDATABASE) throw new Error('Se requiere un socket PostgreSQL aislado explícito')
const options = { host: PGHOST, port: Number(PGPORT), database: PGDATABASE }
const company = '10000000-0000-0000-0000-000000000000'
const user = '40000000-0000-0000-0000-000000000001'
const payload = { supplier_id: '10000000-0000-0000-0000-000000000001', items: [{ item_type: 'SERVICE', product_description: 'Servicio', quantity: 1, unit_price: 10, tax_rate: 19 }] }
const commercial = 'SELECT adquisiciones.save_commercial_draft_request(NULL,$1::jsonb,$2,$3,$4,NULL) AS result'

async function waitForAdvisoryLock(monitor, pid) {
  for (let i = 0; i < 100; i++) {
    const result = await monitor.query("SELECT wait_event FROM pg_stat_activity WHERE pid=$1", [pid])
    if (result.rows[0]?.wait_event === 'advisory') return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('La segunda creación no esperó el bloqueo del correlativo')
}

test('different requests and traditional creation share a transaction-safe unique sequence', async () => {
  const a = new pg.Client(options), b = new pg.Client(options), monitor = new pg.Client(options)
  await Promise.all([a.connect(), b.connect(), monitor.connect()])
  try {
    // Install the actual traditional RPC in this disposable fixture.
    const migration = await readFile(new URL('../supabase/migrations/20261014210000_adquisiciones_purchase_order_unit_discount.sql', import.meta.url), 'utf8')
    const start = migration.indexOf('CREATE OR REPLACE FUNCTION adquisiciones.create_purchase_order(p_data jsonb, p_user_id uuid, p_company_id uuid)')
    assert.notEqual(start, -1)
    await monitor.query('CREATE FUNCTION portal.has_permission(text) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$')
    await monitor.query(migration.slice(start))

    const pid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    await a.query('BEGIN')
    const first = await a.query(commercial, [JSON.stringify(payload), user, company, '50000000-0000-0000-0000-000000000020'])
    const second = b.query(commercial, [JSON.stringify(payload), user, company, '50000000-0000-0000-0000-000000000021'])
    await waitForAdvisoryLock(monitor, pid)
    await a.query('COMMIT')
    const secondResult = await second
    const ids = [first.rows[0].result.po_id, secondResult.rows[0].result.po_id]
    assert.notEqual(ids[0], ids[1])
    const saved = await monitor.query('SELECT correlative FROM adquisiciones.purchase_orders WHERE id=ANY($1::uuid[]) ORDER BY correlative', [ids])
    assert.equal(new Set(saved.rows.map(row => row.correlative)).size, 2)
    assert.match(saved.rows[0].correlative, /^OC-\d{4}-\d{6}$/)
    await assert.rejects(monitor.query('INSERT INTO adquisiciones.purchase_orders(company_id,correlative) VALUES ($1,$2)', [company, saved.rows[0].correlative]), error => error.code === '23505')
    await monitor.query('INSERT INTO adquisiciones.purchase_orders(company_id,correlative) VALUES ($1,$2)', ['10000000-0000-0000-0000-000000000099', saved.rows[0].correlative])

    await a.query('BEGIN')
    await a.query(commercial, [JSON.stringify(payload), user, company, '50000000-0000-0000-0000-000000000022'])
    const traditional = b.query('SELECT adquisiciones.create_purchase_order($1::jsonb,$2,$3) AS result', [JSON.stringify({ ...payload, status: 'BORRADOR' }), user, company])
    await waitForAdvisoryLock(monitor, pid)
    await a.query('COMMIT')
    assert.equal((await traditional).rows[0].result.success, true)
    const duplicates = await monitor.query('SELECT correlative FROM adquisiciones.purchase_orders WHERE company_id=$1 GROUP BY correlative HAVING count(*)>1', [company])
    assert.equal(duplicates.rowCount, 0)
  } finally {
    await a.query('ROLLBACK').catch(() => {})
    await Promise.all([a.end(), b.end(), monitor.end()])
  }
})
