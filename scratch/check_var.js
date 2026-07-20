require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { db: { schema: 'integraciones' } });
async function run() {
  const { data: vw } = await s.from('vw_bsale_sales_order_items_for_preparation').select('*').eq('nv_folio', 3496).limit(1);
  console.log('View item:', vw);
  const { data: v } = await s.from('bsale_variants').select('*').eq('code', '756146').limit(1);
  console.log('Variant:', v);
  if (v && v[0]) {
    const { data: p } = await s.from('bsale_products').select('*').eq('bsale_id', v[0].bsale_product_id).limit(1);
    console.log('Product:', p);
  }
}
run();
