require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { db: { schema: 'public' } });

async function run() {
  const { data, error } = await s.rpc('execute_sql', { 
    query: "SELECT pg_get_viewdef('integraciones.vw_bsale_sales_order_items_for_preparation') as view_def" 
  });
  if (error) {
    const s2 = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { db: { schema: 'portal' } });
    const { data: d2, error: e2 } = await s2.rpc('execute_sql', { 
      query: "SELECT pg_get_viewdef('integraciones.vw_bsale_sales_order_items_for_preparation') as view_def" 
    });
    console.log(d2 || e2);
  } else {
    console.log(data);
  }
}
run();
