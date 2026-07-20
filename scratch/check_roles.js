require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  // Use execute_sql in logistica schema (we know this exists)
  const { data, error } = await s.schema('logistica').rpc('execute_sql', {
    query: `SELECT u.id, u.email, r.name as role_name 
            FROM public.users u 
            LEFT JOIN public.roles r ON r.id = u.role_id 
            LIMIT 5`
  });
  console.log('Error:', error?.message);
  if (data) console.log(JSON.stringify(data, null, 2));
}
run();
