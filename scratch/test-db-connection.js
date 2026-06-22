const { Client } = require('pg');

const host = 'aws-1-us-east-2.pooler.supabase.com';
const user = 'postgres.oekmztbfasmildyuajji';
const database = 'postgres';
const port = 6543;

const passwords = [
  'Mym\\$77154972',
  'Mym$77154972',
  'MymProduccion2026!',
  'MymProduccion2026',
  'Mym77154972'
];

async function test() {
  for (const pw of passwords) {
    console.log(`Testing password: ${pw}`);
    const client = new Client({
      host,
      user,
      database,
      password: pw,
      port,
      ssl: {
        rejectUnauthorized: false
      }
    });

    try {
      await client.connect();
      console.log(`SUCCESS! Connected with password: ${pw}`);
      const res = await client.query('SELECT 1;');
      console.log('Query result:', res.rows);
      await client.end();
      return;
    } catch (err) {
      console.log(`FAILED with password ${pw}: ${err.message}`);
    }
  }
}

test().catch(console.error);
