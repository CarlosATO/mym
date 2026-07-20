require('dotenv').config({ path: '.env.local' });
const fs = require('fs');
const pg = require('pg');

async function test() {
  const pool = new pg.Pool({ connectionString: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const sql = fs.readFileSync('supabase/migrations/20260717000001_next_route_logic.sql', 'utf8');
    await c.query(sql);
    console.log('Migration OK');
    const res = await c.query("SELECT logistica.preview_next_route_candidates((SELECT id FROM public.companies LIMIT 1), '2026-06-01'::timestamptz) as r");
    console.log(JSON.stringify(res.rows[0].r, null, 2));
  } catch(e) {
    console.error(e);
  } finally {
    await c.query('ROLLBACK');
    c.release();
    pool.end();
  }
}
test();
