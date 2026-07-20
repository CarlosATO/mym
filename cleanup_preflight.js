const fs = require('fs');
const env = fs.readFileSync('.env.local', 'utf-8');
const lines = env.split('\n');
let dbUrl = '';
lines.forEach(l => {
  if (l.startsWith('DATABASE_URL=')) dbUrl = l.split('=')[1].trim().replace(/\"/g, '').replace(/'/g, '');
});

const { Client } = require('pg');
const client = new Client({ connectionString: dbUrl });

async function run() {
  await client.connect();
  const company_id = 'd1000000-0000-0000-0000-000000000001';

  async function cnt(table, filter = '') {
    const q = filter ? `SELECT COUNT(*) FROM ${table} WHERE ${filter}` : `SELECT COUNT(*) FROM ${table}`;
    const res = await client.query(q);
    console.log(`${table}: ${res.rows[0].count}`);
  }

  console.log('--- PREFLIGHT COUNTS ---');
  await cnt('logistica.route_guides', `company_id = '${company_id}'`);
  await cnt('logistica.route_guide_items', `route_guide_id IN (SELECT id FROM logistica.route_guides WHERE company_id = '${company_id}')`);
  await cnt('logistica.route_guide_counters', `company_id = '${company_id}'`);
  
  await cnt('adquisiciones.route_settlements', `company_id = '${company_id}'`);
  await cnt('adquisiciones.route_settlement_items', `settlement_id IN (SELECT id FROM adquisiciones.route_settlements WHERE company_id = '${company_id}')`);
  await cnt('adquisiciones.route_settlement_item_attachments', `settlement_item_id IN (SELECT id FROM adquisiciones.route_settlement_items WHERE settlement_id IN (SELECT id FROM adquisiciones.route_settlements WHERE company_id = '${company_id}'))`);
  await cnt('adquisiciones.route_settlement_counters', `company_id = '${company_id}'`);

  await cnt('adquisiciones.route_fund_closures', `company_id = '${company_id}'`);
  await cnt('adquisiciones.route_fund_closure_items', `closure_id IN (SELECT id FROM adquisiciones.route_fund_closures WHERE company_id = '${company_id}')`);
  await cnt('adquisiciones.route_fund_closure_deposits', `closure_id IN (SELECT id FROM adquisiciones.route_fund_closures WHERE company_id = '${company_id}')`);
  await cnt('adquisiciones.route_fund_closure_expenses', `closure_id IN (SELECT id FROM adquisiciones.route_fund_closures WHERE company_id = '${company_id}')`);
  await cnt('adquisiciones.route_fund_closure_expense_allocations', `expense_id IN (SELECT id FROM adquisiciones.route_fund_closure_expenses WHERE closure_id IN (SELECT id FROM adquisiciones.route_fund_closures WHERE company_id = '${company_id}'))`);
  await cnt('adquisiciones.route_fund_closure_attachments', `closure_id IN (SELECT id FROM adquisiciones.route_fund_closures WHERE company_id = '${company_id}')`);
  await cnt('adquisiciones.route_fund_closure_counters', `company_id = '${company_id}'`);

  console.log('--- MAESTRAS (NO TOCAR) ---');
  await cnt('logistica.delivery_routes', `company_id = '${company_id}'`);
  await cnt('logistica.route_personnel', `company_id = '${company_id}'`);
  await cnt('logistica.route_vehicles', `company_id = '${company_id}'`);

  await client.end();
}
run().catch(console.error);
