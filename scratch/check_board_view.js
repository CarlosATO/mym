require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function run() {
  const { data: vw } = await s.rpc('execute_sql', { query: "SELECT pg_get_viewdef('logistica.vw_sales_order_preparation_board') as view_def" });
  console.log(vw);
}
run();
