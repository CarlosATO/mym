const fs = require('fs');
const env = fs.readFileSync('.env.local', 'utf-8');
const lines = env.split('\n');
let url = '', key = '';
lines.forEach(l => {
  if (l.startsWith('NEXT_PUBLIC_SUPABASE_URL=')) url = l.split('=')[1].trim().replace(/\"/g, '').replace(/'/g, '');
  if (l.startsWith('SUPABASE_SERVICE_ROLE_KEY=')) key = l.split('=')[1].trim().replace(/\"/g, '').replace(/'/g, '');
});
const { createClient } = require('@supabase/supabase-js');
const cLog = createClient(url, key, { db: { schema: 'logistica' }});
const cAdq = createClient(url, key, { db: { schema: 'adquisiciones' }});

async function run() {
  const cid = 'd1000000-0000-0000-0000-000000000001';
  let r = await cLog.from('route_guide_counters').select('last_sequence').eq('company_id', cid).eq('guide_year', 2026);
  console.log('guide counters:', r.data[0]);

  r = await cAdq.from('route_settlement_counters').select('last_sequence').eq('company_id', cid).eq('settlement_year', 2026);
  console.log('settlement counters:', r.data[0]);

  r = await cAdq.from('route_fund_closure_counters').select('last_sequence').eq('company_id', cid).eq('closure_year', 2026);
  console.log('closure counters:', r.data[0]);
}
run();
