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

  async function checkRes(res, step) {
    if (res.error) {
      console.error(`Error at ${step}:`, res.error);
      process.exit(1);
    }
  }

  console.log('--- STARTING CLEANUP ---');

  // 1. Cierres de Fondos
  console.log('Fetching route_fund_closures...');
  const { data: closures } = await cAdq.from('route_fund_closures').select('id').eq('company_id', cid);
  const closureIds = closures.map(c => c.id);

  if (closureIds.length > 0) {
    console.log('Deleting route_fund_closure_attachments...');
    await checkRes(await cAdq.from('route_fund_closure_attachments').delete().in('fund_closure_id', closureIds), 'route_fund_closure_attachments');
    
    console.log('Fetching route_fund_closure_expenses...');
    const { data: expenses } = await cAdq.from('route_fund_closure_expenses').select('id').in('fund_closure_id', closureIds);
    const expIds = expenses.map(e => e.id);
    
    if (expIds.length > 0) {
      console.log('Deleting route_fund_closure_expense_allocations...');
      await checkRes(await cAdq.from('route_fund_closure_expense_allocations').delete().in('expense_id', expIds), 'route_fund_closure_expense_allocations');
    }
    
    console.log('Deleting route_fund_closure_expenses...');
    await checkRes(await cAdq.from('route_fund_closure_expenses').delete().in('fund_closure_id', closureIds), 'route_fund_closure_expenses');
    
    console.log('Deleting route_fund_closure_deposits...');
    await checkRes(await cAdq.from('route_fund_closure_deposits').delete().in('fund_closure_id', closureIds), 'route_fund_closure_deposits');
    
    console.log('Deleting route_fund_closure_items...');
    await checkRes(await cAdq.from('route_fund_closure_items').delete().in('fund_closure_id', closureIds), 'route_fund_closure_items');
  }
  
  console.log('Deleting route_fund_closures...');
  await checkRes(await cAdq.from('route_fund_closures').delete().eq('company_id', cid), 'route_fund_closures');

  // 2. Rendiciones
  console.log('Fetching route_settlements...');
  const { data: settlements } = await cAdq.from('route_settlements').select('id').eq('company_id', cid);
  const settlementIds = settlements.map(s => s.id);

  if (settlementIds.length > 0) {
    console.log('Fetching route_settlement_items...');
    const { data: items } = await cAdq.from('route_settlement_items').select('id').in('settlement_id', settlementIds);
    const itemIds = items.map(i => i.id);
    
    if (itemIds.length > 0) {
      console.log('Deleting route_settlement_item_attachments...');
      await checkRes(await cAdq.from('route_settlement_item_attachments').delete().in('settlement_item_id', itemIds), 'route_settlement_item_attachments');
    }
    
    console.log('Deleting route_settlement_items...');
    await checkRes(await cAdq.from('route_settlement_items').delete().in('settlement_id', settlementIds), 'route_settlement_items');
  }
  
  console.log('Deleting route_settlements...');
  await checkRes(await cAdq.from('route_settlements').delete().eq('company_id', cid), 'route_settlements');

  // 3. Guías
  console.log('Fetching route_guides...');
  const { data: guides } = await cLog.from('route_guides').select('id').eq('company_id', cid);
  const guideIds = guides.map(g => g.id);

  if (guideIds.length > 0) {
    console.log('Deleting route_guide_items...');
    await checkRes(await cLog.from('route_guide_items').delete().in('route_guide_id', guideIds), 'route_guide_items');
  }
  
  console.log('Deleting route_guides...');
  await checkRes(await cLog.from('route_guides').delete().eq('company_id', cid), 'route_guides');

  // 4. Counters
  console.log('Updating route_guide_counters...');
  await checkRes(await cLog.from('route_guide_counters').update({ last_sequence: 0, updated_at: new Date().toISOString() }).eq('company_id', cid).eq('guide_year', 2026), 'route_guide_counters');

  console.log('Updating route_settlement_counters...');
  await checkRes(await cAdq.from('route_settlement_counters').update({ last_sequence: 0, updated_at: new Date().toISOString() }).eq('company_id', cid).eq('settlement_year', 2026), 'route_settlement_counters');

  console.log('Updating route_fund_closure_counters...');
  await checkRes(await cAdq.from('route_fund_closure_counters').update({ last_sequence: 0, updated_at: new Date().toISOString() }).eq('company_id', cid).eq('closure_year', 2026), 'route_fund_closure_counters');

  console.log('--- CLEANUP COMPLETE ---');
}
run().catch(console.error);
