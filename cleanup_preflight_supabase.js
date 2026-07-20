const fs = require('fs');
const env = fs.readFileSync('.env.local', 'utf-8');
const lines = env.split('\n');
let url = '', key = '';
lines.forEach(l => {
  if (l.startsWith('NEXT_PUBLIC_SUPABASE_URL=')) url = l.split('=')[1].trim().replace(/\"/g, '').replace(/'/g, '');
  if (l.startsWith('SUPABASE_SERVICE_ROLE_KEY=')) key = l.split('=')[1].trim().replace(/\"/g, '').replace(/'/g, '');
});

const { createClient } = require('@supabase/supabase-js');
const cLogistica = createClient(url, key, { db: { schema: 'logistica' }});
const cAdquisiciones = createClient(url, key, { db: { schema: 'adquisiciones' }});

async function run() {
  const company_id = 'd1000000-0000-0000-0000-000000000001';

  async function cnt(client, table, eqKey, eqVal) {
    const { count, error } = await client.from(table).select('*', { count: 'exact', head: true }).eq(eqKey, eqVal);
    if (error) console.error(table, error);
    else console.log(`${table}: ${count}`);
    return count;
  }

  console.log('--- PREFLIGHT COUNTS ---');
  await cnt(cLogistica, 'route_guides', 'company_id', company_id);
  // for route_guide_items we need to query via guides. Let's just fetch guides first.
  const { data: guides } = await cLogistica.from('route_guides').select('id').eq('company_id', company_id);
  const guideIds = guides.map(g => g.id);
  
  if (guideIds.length) {
    const { count: cItems } = await cLogistica.from('route_guide_items').select('*', { count: 'exact', head: true }).in('route_guide_id', guideIds);
    console.log(`route_guide_items: ${cItems}`);
  } else {
    console.log(`route_guide_items: 0`);
  }
  
  await cnt(cLogistica, 'route_guide_counters', 'company_id', company_id);

  // Settlements
  await cnt(cAdquisiciones, 'route_settlements', 'company_id', company_id);
  const { data: settlements } = await cAdquisiciones.from('route_settlements').select('id').eq('company_id', company_id);
  const settlementIds = settlements.map(s => s.id);

  let sItemIds = [];
  if (settlementIds.length) {
    const { count: sItems, data: itemsData } = await cAdquisiciones.from('route_settlement_items').select('id', { count: 'exact' }).in('settlement_id', settlementIds);
    console.log(`route_settlement_items: ${sItems}`);
    sItemIds = itemsData.map(i => i.id);
  } else {
    console.log(`route_settlement_items: 0`);
  }

  if (sItemIds.length) {
    const { count: sAtt } = await cAdquisiciones.from('route_settlement_item_attachments').select('*', { count: 'exact', head: true }).in('settlement_item_id', sItemIds);
    console.log(`route_settlement_item_attachments: ${sAtt}`);
  } else {
    console.log(`route_settlement_item_attachments: 0`);
  }
  
  await cnt(cAdquisiciones, 'route_settlement_counters', 'company_id', company_id);

  // Fund Closures
  await cnt(cAdquisiciones, 'route_fund_closures', 'company_id', company_id);
  const { data: closures } = await cAdquisiciones.from('route_fund_closures').select('id').eq('company_id', company_id);
  const closureIds = closures.map(c => c.id);

  if (closureIds.length) {
    const { count: cItems } = await cAdquisiciones.from('route_fund_closure_items').select('*', { count: 'exact', head: true }).in('fund_closure_id', closureIds);
    console.log(`route_fund_closure_items: ${cItems}`);
    
    const { count: cDep } = await cAdquisiciones.from('route_fund_closure_deposits').select('*', { count: 'exact', head: true }).in('fund_closure_id', closureIds);
    console.log(`route_fund_closure_deposits: ${cDep}`);
    
    const { count: cExp, data: expData } = await cAdquisiciones.from('route_fund_closure_expenses').select('id', { count: 'exact' }).in('fund_closure_id', closureIds);
    console.log(`route_fund_closure_expenses: ${cExp}`);
    
    if (expData && expData.length) {
      const expIds = expData.map(e => e.id);
      const { count: cAlloc } = await cAdquisiciones.from('route_fund_closure_expense_allocations').select('*', { count: 'exact', head: true }).in('expense_id', expIds);
      console.log(`route_fund_closure_expense_allocations: ${cAlloc}`);
    } else {
      console.log(`route_fund_closure_expense_allocations: 0`);
    }

    const { count: cAtt } = await cAdquisiciones.from('route_fund_closure_attachments').select('*', { count: 'exact', head: true }).in('fund_closure_id', closureIds);
    console.log(`route_fund_closure_attachments: ${cAtt}`);
  } else {
    console.log(`route_fund_closure_items: 0`);
    console.log(`route_fund_closure_deposits: 0`);
    console.log(`route_fund_closure_expenses: 0`);
    console.log(`route_fund_closure_expense_allocations: 0`);
    console.log(`route_fund_closure_attachments: 0`);
  }

  await cnt(cAdquisiciones, 'route_fund_closure_counters', 'company_id', company_id);

  console.log('--- MAESTRAS (NO TOCAR) ---');
  await cnt(cLogistica, 'delivery_routes', 'company_id', company_id);
  await cnt(cLogistica, 'route_personnel', 'company_id', company_id);
  await cnt(cLogistica, 'route_vehicles', 'company_id', company_id);
}

run().catch(console.error);
