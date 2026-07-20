require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  console.log('--- 1. ITEMS NV 3496 ---');
  let { data: items } = await s.schema('integraciones').from('vw_bsale_sales_order_items_for_preparation').select('nv_folio, sku, product_name, quantity, unit_value, total_amount, unit_net_value, line_net_amount, line_tax_amount, line_gross_amount').eq('nv_folio', '3496').order('detail_id');
  console.log(items);

  console.log('\n--- 2. CABECERA NV 3496 ---');
  let { data: cabecera } = await s.schema('integraciones').from('vw_bsale_sales_orders_for_preparation').select('nv_folio, client_name, net_amount, tax_amount, gross_amount, total_amount').eq('nv_folio', '3496');
  console.log(cabecera);

  console.log('\n--- 3. BOARD NV 3496 ---');
  let { data: board } = await s.schema('logistica').from('vw_sales_order_preparation_board').select('nv_folio, client_name, net_amount, tax_amount, gross_amount, total_amount, route_date, status').eq('nv_folio', '3496');
  console.log(board);

  console.log('\n--- 7. CONTEOS ---');
  let { data: cards, count: c1 } = await s.schema('logistica').from('sales_order_preparation_cards').select('status', { count: 'exact' });
  console.log('cards =', c1);
  const statusCounts = (cards || []).reduce((acc, c) => { acc[c.status] = (acc[c.status] || 0) + 1; return acc; }, {});
  console.log('status counts =', statusCounts);

  let { count: c3 } = await s.schema('logistica').from('sales_order_preparation_movements').select('*', { head: true, count: 'exact' });
  console.log('movements =', c3);
}
run();
