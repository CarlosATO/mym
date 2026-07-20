require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

async function testSQL() {
  const sql = fs.readFileSync('supabase/migrations/20260717000001_next_route_logic.sql', 'utf8');
  const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  
  // To avoid permanently modifying the DB if we don't have transaction wrappers in supabase JS client, 
  // we'll run a simpler validation: we just execute it. Wait, the user said "NO db push", but said "validar que la migración SQL compila en entorno local o shadow/local DB".
  // Since we don't want to actually apply it, we can run it inside a transaction and rollback.
  
  const pg = require('pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    console.log("SQL Migration parsed and executed successfully (in transaction).");
    
    // Let's also test the preview function to generate the JSON.
    const res = await client.query(`SELECT logistica.preview_next_route_candidates((SELECT id FROM public.companies LIMIT 1), '2026-06-01'::timestamptz)`);
    console.log("Preview Function Output:");
    console.log(JSON.stringify(res.rows[0].preview_next_route_candidates, null, 2));

  } catch (err) {
    console.error("Error running SQL:", err);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    pool.end();
  }
}
testSQL();
