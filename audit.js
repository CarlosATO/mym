require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const query1 = `
    SELECT
      p.oid::regprocedure AS signature,
      pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'logistica'
      AND p.proname = 'preview_sales_order_route_candidates';
  `;
  const query2 = `
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_schema = 'integraciones' 
      AND table_name = 'vw_bsale_sales_orders_for_preparation';
  `;

  // We can't run raw SQL easily without an RPC that executes arbitrary SQL.
  // Wait, does `s.rpc('exec_sql')` exist? I'm not sure. Let's try.
  const { data: d1, error: e1 } = await s.rpc('exec_sql', { sql: query1 });
  console.log('Query 1 error:', e1?.message);
  if (d1) console.log(d1);

  const { data: d2, error: e2 } = await s.rpc('exec_sql', { sql: query2 });
  if (d2) console.log(d2);
}
main();
