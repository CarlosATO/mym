// Only a disposable local PostgreSQL database may be used by this test.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import pg from 'pg'

const connection = { host: '/var/folders/fv/h7c_389x6xd7_yc8z8dfs6940000gn/T/opencode', port: 56467, database: 'audit_bulk_test' }
const migration = await readFile(new URL('../supabase/migrations/20261112181649_audit_register_pending_line.sql', import.meta.url), 'utf8')
const base = await readFile(new URL('../supabase/migrations/20261020150000_logistica_sales_order_audit_base.sql', import.meta.url), 'utf8')
const original = base.slice(base.indexOf('CREATE OR REPLACE FUNCTION logistica.confirm_sales_order_audit_line('), base.indexOf('REVOKE ALL ON FUNCTION logistica.confirm_sales_order_audit_line('))
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const [company, audit, card, actor, line, prep] = [1, 2, 3, 4, 5, 6].map(id)
const client = new pg.Client(connection)

test('registro masivo atómico en PostgreSQL aislado', async t => {
  await client.connect()
  try {
    await client.query(`
      CREATE SCHEMA auth; CREATE SCHEMA core; CREATE SCHEMA logistica;
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
      END $$;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT current_setting('test.actor')::uuid $$;
      CREATE FUNCTION core.has_company_access(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT current_setting('test.access')::boolean $$;
      CREATE FUNCTION core.has_permission_for_company(uuid,uuid,text) RETURNS boolean LANGUAGE sql AS $$ SELECT current_setting('test.permission')::boolean $$;
      CREATE TABLE logistica.sales_order_audits (id uuid PRIMARY KEY, company_id uuid, card_id uuid, status text, locked_by_user_id uuid);
      CREATE TABLE logistica.sales_order_preparation_cards (id uuid PRIMARY KEY, company_id uuid, status text);
      CREATE TABLE logistica.sales_order_audit_lines (id uuid PRIMARY KEY, company_id uuid, audit_id uuid, card_id uuid, preparation_line_id uuid, requested_quantity_snapshot numeric, prepared_quantity_snapshot numeric, audit_quantity numeric, line_status text, confirmed_by uuid, confirmed_at timestamptz, updated_at timestamptz);
      CREATE TABLE logistica.sales_order_audit_incidents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid, audit_id uuid, audit_line_id uuid REFERENCES logistica.sales_order_audit_lines(id), card_id uuid, preparation_line_id uuid, requested_quantity_snapshot numeric, prepared_quantity_snapshot numeric, audit_quantity numeric, difference_vs_prepared numeric, incident_type text, observation text, status text, detected_by uuid, updated_at timestamptz);
      CREATE TABLE evidence(id uuid PRIMARY KEY, incident_id uuid REFERENCES logistica.sales_order_audit_incidents(id));
    `)
    await client.query(original)
    const definition = async () => (await client.query("SELECT pg_get_functiondef('logistica.confirm_sales_order_audit_line(uuid,uuid,numeric,text,text)'::regprocedure) AS d")).rows[0].d
    const before = await definition()
    await client.query(migration)
    assert.equal(await definition(), before)
    const auth = c => c.query("SELECT set_config('test.actor',$1,false), set_config('test.access','true',false), set_config('test.permission','true',false)", [actor])
    await auth(client)
    await client.query('INSERT INTO logistica.sales_order_preparation_cards VALUES ($1,$2,$3)', [card, company, 'IN_AUDIT'])
    await client.query('INSERT INTO logistica.sales_order_audits VALUES ($1,$2,$3,$4,$5)', [audit, company, card, 'OPEN', actor])
    const createLine = key => client.query('INSERT INTO logistica.sales_order_audit_lines (id,company_id,audit_id,card_id,preparation_line_id,requested_quantity_snapshot,prepared_quantity_snapshot,line_status) VALUES ($1,$2,$3,$4,$5,10,5,$6)', [key, company, audit, card, prep, 'PENDING'])
    const bulk = (c, key) => c.query('SELECT logistica.register_pending_sales_order_audit_line($1,$2,$3) AS result', [company, audit, key])
    await t.test('línea pendiente usa preparado y luego no se sobrescribe', async () => {
      await createLine(line)
      const result = (await bulk(client, line)).rows[0].result
      assert.equal(result.line.audit_quantity, 5)
      assert.equal(result.line.line_status, 'CONFIRMED')
      await assert.rejects(bulk(client, line), /AUDIT_BULK_LINE_NOT_PENDING/)
    })
    await t.test('incidencia abierta y evidencia quedan intactas', async () => {
      const key = id(7), incident = id(8), photo = id(9)
      await createLine(key)
      await client.query('INSERT INTO logistica.sales_order_audit_incidents (id,company_id,audit_id,audit_line_id,status) VALUES ($1,$2,$3,$4,$5)', [incident, company, audit, key, 'OPEN'])
      await client.query('INSERT INTO evidence VALUES ($1,$2)', [photo, incident])
      await assert.rejects(bulk(client, key), /AUDIT_BULK_OPEN_INCIDENT/)
      assert.deepEqual((await client.query('SELECT status FROM logistica.sales_order_audit_incidents WHERE id=$1', [incident])).rows[0], { status: 'OPEN' })
      assert.equal((await client.query('SELECT count(*)::int AS n FROM evidence WHERE incident_id=$1', [incident])).rows[0].n, 1)
    })
    await t.test('permisos, propiedad y estado vigentes', async () => {
      const key = id(10); await createLine(key)
      await client.query("SELECT set_config('test.permission','false',false)")
      await assert.rejects(bulk(client, key), /No tienes permiso/)
      await client.query("SELECT set_config('test.permission','true',false)")
      await client.query('UPDATE logistica.sales_order_audits SET locked_by_user_id=$1', [prep])
      await assert.rejects(bulk(client, key), /asignada a otro usuario/)
      await client.query('UPDATE logistica.sales_order_audits SET locked_by_user_id=$1', [actor])
      await assert.rejects(client.query('SELECT logistica.register_pending_sales_order_audit_line($1,$2,$3)', [company, id(20), key]), /no encontrada/)
    })
    await t.test('dos llamadas simultáneas no sobrescriben', async () => {
      const key = id(11), other = new pg.Client(connection); await createLine(key); await other.connect(); await auth(other)
      try {
        await client.query('BEGIN'); await bulk(client, key)
        const pending = bulk(other, key)
        await new Promise(resolve => setTimeout(resolve, 30)); await client.query('COMMIT')
        await assert.rejects(pending, /AUDIT_BULK_LINE_NOT_PENDING/)
      } finally { await other.end() }
    })
    await t.test('una confirmación individual anterior no es sobrescrita por el masivo', async () => {
      const key = id(16), other = new pg.Client(connection); await createLine(key); await other.connect(); await auth(other)
      try {
        await client.query('BEGIN')
        await client.query('SELECT logistica.confirm_sales_order_audit_line($1,$2,0,NULL,NULL)', [company, key])
        const pending = bulk(other, key)
        await new Promise(resolve => setTimeout(resolve, 30)); await client.query('COMMIT')
        await assert.rejects(pending, /AUDIT_BULK_LINE_NOT_PENDING/)
        const row = (await client.query('SELECT audit_quantity,line_status FROM logistica.sales_order_audit_lines WHERE id=$1', [key])).rows[0]
        assert.deepEqual(row, { audit_quantity: '0', line_status: 'INCIDENT' })
      } finally { await other.end() }
    })
    await t.test('incidencia histórica bloqueada falla sin espera ni mutación', async () => {
      const key = id(12), incident = id(13), other = new pg.Client(connection); await createLine(key); await other.connect()
      try {
        await client.query('INSERT INTO logistica.sales_order_audit_incidents (id,company_id,audit_id,audit_line_id,status) VALUES ($1,$2,$3,$4,$5)', [incident, company, audit, key, 'SUPERSEDED'])
        await other.query('BEGIN'); await other.query('UPDATE logistica.sales_order_audit_incidents SET status=$1 WHERE id=$2', ['OPEN', incident])
        await assert.rejects(bulk(client, key), error => error.code === '55P03')
        await other.query('ROLLBACK')
        assert.equal((await client.query('SELECT line_status FROM logistica.sales_order_audit_lines WHERE id=$1', [key])).rows[0].line_status, 'PENDING')
      } finally { await other.end() }
    })
    await t.test('el FK impide insertar incidencias durante la confirmación', async () => {
      const key = id(15), other = new pg.Client(connection); await createLine(key); await other.connect()
      try {
        await client.query('BEGIN'); await bulk(client, key)
        await other.query("SET statement_timeout = '100ms'")
        await assert.rejects(other.query('INSERT INTO logistica.sales_order_audit_incidents (company_id,audit_id,audit_line_id,status) VALUES ($1,$2,$3,$4)', [company, audit, key, 'OPEN']), error => error.code === '57014')
        await client.query('ROLLBACK')
        assert.equal((await client.query('SELECT line_status FROM logistica.sales_order_audit_lines WHERE id=$1', [key])).rows[0].line_status, 'PENDING')
      } finally { await other.end() }
    })
    await t.test('una incidencia histórica no puede reabrirse durante el masivo', async () => {
      const key = id(17), incident = id(18), other = new pg.Client(connection); await createLine(key); await other.connect()
      try {
        await client.query('INSERT INTO logistica.sales_order_audit_incidents (id,company_id,audit_id,audit_line_id,status) VALUES ($1,$2,$3,$4,$5)', [incident, company, audit, key, 'SUPERSEDED'])
        await client.query('BEGIN'); await bulk(client, key)
        await other.query("SET statement_timeout = '100ms'")
        await assert.rejects(other.query('UPDATE logistica.sales_order_audit_incidents SET status=$1 WHERE id=$2', ['OPEN', incident]), error => error.code === '57014')
        await client.query('ROLLBACK')
        assert.equal((await client.query('SELECT status FROM logistica.sales_order_audit_incidents WHERE id=$1', [incident])).rows[0].status, 'SUPERSEDED')
      } finally { await other.end() }
    })
    await t.test('aislamiento distinto se rechaza', async () => {
      const key = id(14); await createLine(key)
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await assert.rejects(bulk(client, key), /AUDIT_BULK_ISOLATION_UNSUPPORTED/)
      await client.query('ROLLBACK')
    })
  } finally { await client.end() }
})
