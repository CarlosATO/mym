require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function run() {
  console.log('--- VALIDATION 1: POST MIGRATION VIEW ---');
  const { data: vw } = await s.schema('integraciones').from('vw_bsale_sales_order_items_for_preparation').select('nv_folio, sku, product_name, quantity, unit_value, total_amount').eq('nv_folio', 3496).order('detail_id');
  console.log(vw);

  console.log('\n--- VALIDATION 5: INTEGRITY DB CHECK ---');
  const { count: c1 } = await s.schema('logistica').from('sales_order_preparation_cards').select('*', { count: 'exact', head: true });
  console.log('cards =', c1);
  const { data: c2 } = await s.schema('logistica').from('sales_order_preparation_cards').select('status');
  const grouped = c2.reduce((acc, row) => { acc[row.status] = (acc[row.status] || 0) + 1; return acc; }, {});
  console.log('cards group =', grouped);
  const { count: c3 } = await s.schema('logistica').from('sales_order_preparation_movements').select('*', { count: 'exact', head: true });
  console.log('movements =', c3);
}
run();
