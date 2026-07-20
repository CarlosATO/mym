const fs = require('fs');
const env = fs.readFileSync('.env.local', 'utf-8');
const lines = env.split('\n');
let url = '', key = '';
lines.forEach(l => {
  if (l.startsWith('NEXT_PUBLIC_SUPABASE_URL=')) url = l.split('=')[1].trim().replace(/\"/g, '').replace(/'/g, '');
  if (l.startsWith('SUPABASE_SERVICE_ROLE_KEY=')) key = l.split('=')[1].trim().replace(/\"/g, '').replace(/'/g, '');
});
const { createClient } = require('@supabase/supabase-js');
const c = createClient(url, key, { db: { schema: 'adquisiciones' }});
async function run() {
  let { data, error } = await c.rpc('exec_sql', { query: 'SELECT 1' }); // Check if we can get columns? No.
  // Instead, just query an empty row to see the keys.
  {
    const { data: cols } = await c.from('route_fund_closure_attachments').select('*').limit(1);
    console.log('route_fund_closure_attachments:', cols);
  }
  {
    const { data: cols } = await c.from('route_fund_closure_deposits').select('*').limit(1);
    console.log('route_fund_closure_deposits:', cols);
  }
  {
    const { data: cols } = await c.from('route_fund_closure_items').select('*').limit(1);
    console.log('route_fund_closure_items:', cols);
  }
  {
    const { data: cols } = await c.from('route_fund_closure_expenses').select('*').limit(1);
    console.log('route_fund_closure_expenses:', cols);
  }
}
run();
