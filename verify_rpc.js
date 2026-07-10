const { Client } = require('pg');

async function check() {
  const client = new Client({ connectionString: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' });
  await client.connect();
  const res = await client.query(`SELECT pg_get_functiondef('adquisiciones.create_purchase_order(jsonb, uuid, uuid)'::regprocedure)`);
  const def = res.rows[0].pg_get_functiondef;
  console.log('--- RPC Content ---');
  console.log(def.includes("COALESCE(p_data->>'status', 'EMITIDA')") ? 'Has COALESCE' : 'Missing COALESCE');
  console.log(def.includes("NOT IN ('BORRADOR', 'EMITIDA')") ? 'Has NOT IN validation' : 'Missing validation');
  await client.end();
}

check().catch(console.error);
