require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  console.log('--- A. bsale_document_details ---');
  let { data: nv } = await s.schema('integraciones').from('bsale_documents').select('bsale_id').eq('number', 3496).eq('document_type_id', 23).limit(1);
  if (nv && nv.length) {
    let { data: det } = await s.schema('integraciones').from('bsale_document_details').select('*').eq('bsale_document_id', nv[0].bsale_id).limit(5);
    console.log('samples:', det);
  }

  console.log('\n--- B. bsale_documents ---');
  let { data: doc } = await s.schema('integraciones').from('bsale_documents').select('*').eq('number', 3496).eq('document_type_id', 23).limit(1);
  console.log('sample:', doc);

  console.log('\n--- E. sales_order_preparation_cards ---');
  let { data: cards } = await s.schema('logistica').from('sales_order_preparation_cards').select('bsale_nv_folio, total_amount, route_date, status').in('bsale_nv_folio', ['3496','3497','3498','3499']).order('bsale_nv_folio');
  console.log('cards:', cards);
}
run();
