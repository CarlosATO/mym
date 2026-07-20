require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data, error } = await s.rpc('execute_sql', { query: `
    SELECT
      column_name,
      data_type,
      is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'logistica'
      AND table_name = 'sales_order_preparation_movements'
    ORDER BY ordinal_position;
  `});
  if (error) console.error(error);
  console.log(data);
}
run();
