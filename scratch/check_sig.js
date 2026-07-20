require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const query = `
    SELECT
      p.oid::regprocedure AS signature,
      pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'logistica'
      AND p.proname = 'sync_sales_order_preparation_cards_for_route';
  `;
  const { data, error } = await s.rpc('execute_sql', { query });
  console.log('Error:', error);
  console.log(JSON.stringify(data, null, 2));
}
run();
